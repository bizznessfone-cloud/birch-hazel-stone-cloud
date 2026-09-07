/**
 * Operator inventory assignment. Vehicle and driver are independent.
 * Occupies remains trigger-maintained. GiST EXCLUDE is the overlap authority.
 * Map 23P01 to a readable unavailable error — never return raw SQL.
 */
import type { BookingDb } from "./booking.ts";

export type InventoryDb = BookingDb;

export type InventoryErrorCode =
  | "not_found"
  | "cancelled"
  | "unusable"
  | "unavailable"
  | "invalid_status";

export class InventoryError extends Error {
  readonly code: InventoryErrorCode;
  readonly status: number;
  constructor(code: InventoryErrorCode, status: number, message: string) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
    this.status = status;
  }
}

export type AssignmentSnapshot = {
  bookingId: string;
  vehicleId: string | null;
  driverId: string | null;
  status: string;
  cancelled: boolean;
};

type BookingLock = {
  id: string;
  vehicle_id: string | null;
  driver_id: string | null;
  status: string;
  cancelled_at: string | null;
};

function isOverlap(err: unknown): boolean {
  return (err as { code?: string }).code === "23P01";
}

function throwUnavailable(kind: "vehicle" | "driver"): never {
  const message =
    kind === "vehicle"
      ? "That vehicle is not available for this time."
      : "That driver is not available for this time.";
  throw new InventoryError("unavailable", 409, message);
}

async function audit(
  db: InventoryDb,
  operatorId: string,
  action: string,
  bookingId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into audit_events (actor_type, actor_id, action, booking_id, payload)
     values ('operator', $1::uuid, $2, $3::uuid, $4::jsonb)`,
    [operatorId, action, bookingId, JSON.stringify(payload)],
  );
}

async function loadSnapshot(db: InventoryDb, bookingId: string): Promise<AssignmentSnapshot> {
  const rows = await db.query<{
    id: string;
    vehicle_id: string | null;
    driver_id: string | null;
    status: string;
    cancelled_at: string | null;
  }>(
    `select id, vehicle_id, driver_id, status, cancelled_at
     from bookings where id = $1::uuid`,
    [bookingId],
  );
  const row = rows[0];
  if (!row) throw new InventoryError("not_found", 404, "Booking not found.");
  return {
    bookingId: row.id,
    vehicleId: row.vehicle_id,
    driverId: row.driver_id,
    status: row.status,
    cancelled: row.cancelled_at != null,
  };
}

async function lockBooking(db: InventoryDb, bookingId: string): Promise<BookingLock> {
  const rows = await db.query<BookingLock>(
    `select id, vehicle_id, driver_id, status, cancelled_at
     from bookings where id = $1::uuid for update`,
    [bookingId],
  );
  const row = rows[0];
  if (!row) throw new InventoryError("not_found", 404, "Booking not found.");
  return row;
}

function assertNotCancelled(row: BookingLock): void {
  if (row.cancelled_at != null) {
    throw new InventoryError("cancelled", 409, "This booking is cancelled.");
  }
}

async function requireVehicle(db: InventoryDb, vehicleId: string): Promise<void> {
  const rows = await db.query<{ id: string; active: boolean }>(
    "select id, active from vehicles where id = $1::uuid",
    [vehicleId],
  );
  const row = rows[0];
  if (!row) throw new InventoryError("not_found", 404, "Vehicle not found.");
  if (row.active === false) {
    throw new InventoryError("unusable", 409, "That vehicle is not available.");
  }
}

async function requireDriver(db: InventoryDb, driverId: string): Promise<void> {
  const rows = await db.query<{ id: string; active: boolean }>(
    "select id, active from drivers where id = $1::uuid",
    [driverId],
  );
  const row = rows[0];
  if (!row) throw new InventoryError("not_found", 404, "Driver not found.");
  if (row.active === false) {
    throw new InventoryError("unusable", 409, "That driver is not available.");
  }
}

export async function assignVehicle(
  db: InventoryDb,
  args: { bookingId: string; vehicleId: string; operatorId: string },
): Promise<AssignmentSnapshot> {
  return db.transaction(async (txn) => {
    const booking = await lockBooking(txn, args.bookingId);
    assertNotCancelled(booking);
    await requireVehicle(txn, args.vehicleId);
    try {
      await txn.query(
        "update bookings set vehicle_id = $1::uuid where id = $2::uuid",
        [args.vehicleId, args.bookingId],
      );
    } catch (err) {
      if (isOverlap(err)) throwUnavailable("vehicle");
      throw err;
    }
    await audit(txn, args.operatorId, "vehicle.assign", args.bookingId, {
      vehicle_id: args.vehicleId,
    });
    return loadSnapshot(txn, args.bookingId);
  });
}

export async function unassignVehicle(
  db: InventoryDb,
  args: { bookingId: string; operatorId: string },
): Promise<AssignmentSnapshot> {
  return db.transaction(async (txn) => {
    const booking = await lockBooking(txn, args.bookingId);
    assertNotCancelled(booking);
    await txn.query("update bookings set vehicle_id = null where id = $1::uuid", [
      args.bookingId,
    ]);
    await audit(txn, args.operatorId, "vehicle.unassign", args.bookingId, {
      vehicle_id: booking.vehicle_id,
    });
    return loadSnapshot(txn, args.bookingId);
  });
}

export async function assignDriver(
  db: InventoryDb,
  args: { bookingId: string; driverId: string; operatorId: string },
): Promise<AssignmentSnapshot> {
  return db.transaction(async (txn) => {
    const booking = await lockBooking(txn, args.bookingId);
    assertNotCancelled(booking);
    await requireDriver(txn, args.driverId);
    try {
      await txn.query(
        "update bookings set driver_id = $1::uuid where id = $2::uuid",
        [args.driverId, args.bookingId],
      );
    } catch (err) {
      if (isOverlap(err)) throwUnavailable("driver");
      throw err;
    }
    await audit(txn, args.operatorId, "driver.assign", args.bookingId, {
      driver_id: args.driverId,
    });
    return loadSnapshot(txn, args.bookingId);
  });
}

export async function unassignDriver(
  db: InventoryDb,
  args: { bookingId: string; operatorId: string },
): Promise<AssignmentSnapshot> {
  return db.transaction(async (txn) => {
    const booking = await lockBooking(txn, args.bookingId);
    assertNotCancelled(booking);
    await txn.query("update bookings set driver_id = null where id = $1::uuid", [
      args.bookingId,
    ]);
    await audit(txn, args.operatorId, "driver.unassign", args.bookingId, {
      driver_id: booking.driver_id,
    });
    return loadSnapshot(txn, args.bookingId);
  });
}

export async function cancelBooking(
  db: InventoryDb,
  args: { bookingId: string; operatorId: string },
): Promise<AssignmentSnapshot> {
  return db.transaction(async (txn) => {
    const booking = await lockBooking(txn, args.bookingId);
    if (booking.cancelled_at == null) {
      await txn.query(
        "update bookings set cancelled_at = now() where id = $1::uuid",
        [args.bookingId],
      );
      await audit(txn, args.operatorId, "booking.cancel", args.bookingId, {});
    }
    return loadSnapshot(txn, args.bookingId);
  });
}

export async function setBookingStatus(
  db: InventoryDb,
  args: { bookingId: string; status: string; operatorId: string },
): Promise<AssignmentSnapshot> {
  const status = args.status.trim();
  if (!status || status.length > 40) {
    throw new InventoryError("invalid_status", 400, "Invalid status.");
  }
  return db.transaction(async (txn) => {
    await lockBooking(txn, args.bookingId);
    await txn.query("update bookings set status = $1 where id = $2::uuid", [
      status,
      args.bookingId,
    ]);
    await audit(txn, args.operatorId, "booking.status", args.bookingId, {
      status,
    });
    return loadSnapshot(txn, args.bookingId);
  });
}
