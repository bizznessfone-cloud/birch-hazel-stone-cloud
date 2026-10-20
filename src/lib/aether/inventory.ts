/**
 * Operator inventory assignment. Vehicle and driver are independent.
 * Occupies remains trigger-maintained. GiST EXCLUDE is the overlap authority.
 * Map 23P01 to a readable unavailable error — never return raw SQL.
 */
import type { BookingDb } from "./booking.ts";
import {
  auditOrgPayload,
  isHotelDesk,
  isProviderDispatcher,
  type OpsScope,
} from "./tenancy.ts";

export type InventoryDb = BookingDb;

export type InventoryErrorCode =
  | "not_found"
  | "cancelled"
  | "unusable"
  | "unavailable"
  | "invalid_status"
  | "forbidden";

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
  hotel_id: string;
  executing_provider_id: string;
  vehicle_id: string | null;
  driver_id: string | null;
  status: string;
  cancelled_at: string | null;
};

function isOverlap(err: unknown): boolean {
  return (err as { code?: string }).code === "23P01";
}

function isCapacityRetry(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  if (code === "40P01") return true;
  const message = err instanceof Error ? err.message : String(err);
  return code === "40001" && message.includes("capacity_lock_retry");
}

async function retryCapacityLock<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isCapacityRetry(err)) throw err;
    return await run();
  }
}

function throwUnavailable(kind: "vehicle" | "driver"): never {
  const message =
    kind === "vehicle"
      ? "That vehicle is not available for this time."
      : "That driver is not available for this time.";
  throw new InventoryError("unavailable", 409, message);
}

function rethrowAssignment(err: unknown, kind: "vehicle" | "driver"): never {
  if (isOverlap(err)) throwUnavailable(kind);
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("dispatch_not_admitted")) {
    throw new InventoryError("forbidden", 403, "This booking cannot be dispatched.");
  }
  throw err instanceof Error ? err : new Error(message);
}

async function audit(
  db: InventoryDb,
  scope: OpsScope,
  action: string,
  bookingId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into audit_events (actor_type, actor_id, action, booking_id, payload)
     values ('operator', $1::uuid, $2, $3::uuid, $4::jsonb)`,
    [scope.operatorId, action, bookingId, JSON.stringify({ ...auditOrgPayload(scope), ...payload })],
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

async function peekBooking(db: InventoryDb, bookingId: string): Promise<BookingLock> {
  const rows = await db.query<BookingLock>(
    `select id, hotel_id, executing_provider_id, vehicle_id, driver_id, status, cancelled_at
     from bookings where id = $1::uuid`,
    [bookingId],
  );
  const row = rows[0];
  if (!row) throw new InventoryError("not_found", 404, "Booking not found.");
  return row;
}

async function isCapacityManaged(db: InventoryDb, bookingId: string): Promise<boolean> {
  const present = await db.query<{ present: boolean }>(
    `select exists (
       select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'bookings'
          and column_name = 'capacity_managed'
     ) as present`,
  );
  if (present[0]?.present !== true) return false;
  const rows = await db.query<{ capacity_managed: boolean }>(
    `select capacity_managed from bookings where id = $1::uuid`,
    [bookingId],
  );
  return rows[0]?.capacity_managed === true;
}

async function lockBooking(db: InventoryDb, bookingId: string): Promise<BookingLock> {
  const rows = await db.query<BookingLock>(
    `select id, hotel_id, executing_provider_id, vehicle_id, driver_id, status, cancelled_at
     from bookings where id = $1::uuid for update`,
    [bookingId],
  );
  const row = rows[0];
  if (!row) throw new InventoryError("not_found", 404, "Booking not found.");
  return row;
}

function assertDispatcher(scope: OpsScope, booking: BookingLock): void {
  // Operator authority is enforced here. aether_app and aether_runtime are
  // shared database roles, and sbg_dispatch_set_vehicle does not authenticate
  // an operator. A direct SQL call can still assign a compatible vehicle on
  // another tenant's admitted booking.
  if (!isProviderDispatcher(scope) || booking.executing_provider_id !== scope.providerId) {
    throw new InventoryError("forbidden", 403, "Not allowed.");
  }
}

function assertCancel(scope: OpsScope, booking: BookingLock): void {
  if (isHotelDesk(scope) && booking.hotel_id === scope.hotelId) return;
  if (isProviderDispatcher(scope) && booking.executing_provider_id === scope.providerId) return;
  throw new InventoryError("not_found", 404, "Booking not found.");
}

function assertNotCancelled(row: BookingLock): void {
  if (row.cancelled_at != null) {
    throw new InventoryError("cancelled", 409, "This booking is cancelled.");
  }
}

async function requireVehicle(
  db: InventoryDb,
  vehicleId: string,
  providerId: string,
): Promise<void> {
  const rows = await db.query<{ id: string; active: boolean; operated_by_provider_id: string }>(
    "select id, active, operated_by_provider_id from vehicles where id = $1::uuid",
    [vehicleId],
  );
  const row = rows[0];
  if (!row || row.operated_by_provider_id !== providerId) {
    throw new InventoryError("not_found", 404, "Vehicle not found.");
  }
  if (row.active === false) {
    throw new InventoryError("unusable", 409, "That vehicle is not available.");
  }
}

async function requireDriver(
  db: InventoryDb,
  driverId: string,
  providerId: string,
): Promise<void> {
  const rows = await db.query<{ id: string; active: boolean; dispatched_by_provider_id: string }>(
    "select id, active, dispatched_by_provider_id from drivers where id = $1::uuid",
    [driverId],
  );
  const row = rows[0];
  if (!row || row.dispatched_by_provider_id !== providerId) {
    throw new InventoryError("not_found", 404, "Driver not found.");
  }
  if (row.active === false) {
    throw new InventoryError("unusable", 409, "That driver is not available.");
  }
}

async function setDispatchVehicle(
  db: InventoryDb,
  bookingId: string,
  vehicleId: string | null,
): Promise<void> {
  const present = await db.query<{ signature: string | null }>(
    `select to_regprocedure('public.sbg_dispatch_set_vehicle(uuid, uuid)')::text as signature`,
  );
  if (present[0]?.signature) {
    await db.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [
      bookingId,
      vehicleId,
    ]);
    return;
  }
  await db.query(`update bookings set vehicle_id = $1::uuid where id = $2::uuid`, [
    vehicleId,
    bookingId,
  ]);
}

export async function assignVehicle(
  db: InventoryDb,
  args: { bookingId: string; vehicleId: string; scope: OpsScope },
): Promise<AssignmentSnapshot> {
  return retryCapacityLock(() => db.transaction(async (txn) => {
    const booking = await peekBooking(txn, args.bookingId);
    assertDispatcher(args.scope, booking);
    assertNotCancelled(booking);
    await requireVehicle(txn, args.vehicleId, args.scope.providerId!);
    if (await isCapacityManaged(txn, args.bookingId)) {
      const rows = await txn.query<{ reserve_outcome: string }>(
        `select reserve_outcome from public.sbg_reassign_capacity_vehicle($1::uuid, $2::uuid)`,
        [args.bookingId, args.vehicleId],
      );
      if (rows[0]?.reserve_outcome !== "reassigned") {
        throw new InventoryError("unavailable", 409, "That vehicle is not available.");
      }
    } else {
      try {
        await setDispatchVehicle(txn, args.bookingId, args.vehicleId);
      } catch (err) {
        rethrowAssignment(err, "vehicle");
      }
    }
    await audit(txn, args.scope, "vehicle.assign", args.bookingId, {
      vehicle_id: args.vehicleId,
    });
    return loadSnapshot(txn, args.bookingId);
  }));
}

export async function unassignVehicle(
  db: InventoryDb,
  args: { bookingId: string; scope: OpsScope },
): Promise<AssignmentSnapshot> {
  return retryCapacityLock(() => db.transaction(async (txn) => {
    const booking = await peekBooking(txn, args.bookingId);
    assertDispatcher(args.scope, booking);
    assertNotCancelled(booking);
    if (await isCapacityManaged(txn, args.bookingId)) {
      throw new InventoryError("unavailable", 409, "That vehicle is not available.");
    }
    try {
      await setDispatchVehicle(txn, args.bookingId, null);
    } catch (err) {
      rethrowAssignment(err, "vehicle");
    }
    await audit(txn, args.scope, "vehicle.unassign", args.bookingId, {
      vehicle_id: booking.vehicle_id,
    });
    return loadSnapshot(txn, args.bookingId);
  }));
}

export async function assignDriver(
  db: InventoryDb,
  args: { bookingId: string; driverId: string; scope: OpsScope },
): Promise<AssignmentSnapshot> {
  return retryCapacityLock(() => db.transaction(async (txn) => {
    const booking = await peekBooking(txn, args.bookingId);
    assertDispatcher(args.scope, booking);
    assertNotCancelled(booking);
    await requireDriver(txn, args.driverId, args.scope.providerId!);
    if (await isCapacityManaged(txn, args.bookingId)) {
      const rows = await txn.query<{ reserve_outcome: string }>(
        `select reserve_outcome from public.sbg_assign_capacity_driver($1::uuid, $2::uuid)`,
        [args.bookingId, args.driverId],
      );
      if (rows[0]?.reserve_outcome !== "assigned") {
        throw new InventoryError("unavailable", 409, "That driver is not available.");
      }
    } else {
      const locked = await lockBooking(txn, args.bookingId);
      if (await isCapacityManaged(txn, args.bookingId)) {
        throw new InventoryError("unavailable", 409, "That driver is not available.");
      }
      assertNotCancelled(locked);
      try {
        await txn.query(
          "update bookings set driver_id = $1::uuid where id = $2::uuid",
          [args.driverId, args.bookingId],
        );
      } catch (err) {
        rethrowAssignment(err, "driver");
      }
    }
    await audit(txn, args.scope, "driver.assign", args.bookingId, {
      driver_id: args.driverId,
    });
    return loadSnapshot(txn, args.bookingId);
  }));
}

export async function unassignDriver(
  db: InventoryDb,
  args: { bookingId: string; scope: OpsScope },
): Promise<AssignmentSnapshot> {
  return retryCapacityLock(() => db.transaction(async (txn) => {
    const booking = await peekBooking(txn, args.bookingId);
    assertDispatcher(args.scope, booking);
    assertNotCancelled(booking);
    if (await isCapacityManaged(txn, args.bookingId)) {
      const rows = await txn.query<{ reserve_outcome: string }>(
        `select reserve_outcome from public.sbg_assign_capacity_driver($1::uuid, $2::uuid)`,
        [args.bookingId, null],
      );
      if (rows[0]?.reserve_outcome !== "assigned") {
        throw new InventoryError("unavailable", 409, "That driver is not available.");
      }
    } else {
      await lockBooking(txn, args.bookingId);
      if (await isCapacityManaged(txn, args.bookingId)) {
        throw new InventoryError("unavailable", 409, "That driver is not available.");
      }
      await txn.query("update bookings set driver_id = null where id = $1::uuid", [
        args.bookingId,
      ]);
    }
    await audit(txn, args.scope, "driver.unassign", args.bookingId, {
      driver_id: booking.driver_id,
    });
    return loadSnapshot(txn, args.bookingId);
  }));
}

export async function cancelBooking(
  db: InventoryDb,
  args: { bookingId: string; scope: OpsScope },
): Promise<AssignmentSnapshot> {
  return retryCapacityLock(() => db.transaction(async (txn) => {
    const booking = await peekBooking(txn, args.bookingId);
    assertCancel(args.scope, booking);
    if (await isCapacityManaged(txn, args.bookingId)) {
      const rows = await txn.query<{ reserve_outcome: string }>(
        `select reserve_outcome from public.sbg_release_capacity($1::uuid)`,
        [args.bookingId],
      );
      if (rows[0]?.reserve_outcome !== "released") {
        throw new InventoryError("unavailable", 409, "This booking cannot be cancelled.");
      }
      await audit(txn, args.scope, "booking.cancel", args.bookingId, {});
    } else if (booking.cancelled_at == null) {
      const locked = await lockBooking(txn, args.bookingId);
      if (await isCapacityManaged(txn, args.bookingId)) {
        throw new InventoryError("unavailable", 409, "This booking cannot be cancelled.");
      }
      if (locked.cancelled_at == null) {
        await txn.query(
          "update bookings set cancelled_at = now() where id = $1::uuid",
          [args.bookingId],
        );
        await audit(txn, args.scope, "booking.cancel", args.bookingId, {});
      }
    }
    return loadSnapshot(txn, args.bookingId);
  }));
}

export async function setBookingStatus(
  db: InventoryDb,
  args: { bookingId: string; status: string; scope: OpsScope },
): Promise<AssignmentSnapshot> {
  const status = args.status.trim();
  if (!status || status.length > 40) {
    throw new InventoryError("invalid_status", 400, "Invalid status.");
  }
  return retryCapacityLock(() => db.transaction(async (txn) => {
    const booking = await lockBooking(txn, args.bookingId);
    assertDispatcher(args.scope, booking);
    await txn.query("update bookings set status = $1 where id = $2::uuid", [
      status,
      args.bookingId,
    ]);
    await audit(txn, args.scope, "booking.status", args.bookingId, {
      status,
    });
    return loadSnapshot(txn, args.bookingId);
  }));
}
