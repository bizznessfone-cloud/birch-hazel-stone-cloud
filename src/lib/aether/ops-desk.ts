/**
 * Operator desk queries. Privileged — HTTP adapters must call requireOps.
 * Does not write occupies. Assignment stays in inventory.ts.
 */
import { hotelIdentity, type HotelIdentity } from "./hotel.ts";
import { athensToday, type TimeDb } from "./time.ts";
import {
  isHotelDesk,
  isProviderDispatcher,
  type OpsScope,
} from "./tenancy.ts";

export type OpsDeskDb = TimeDb;

export type OpsDeskErrorCode = "not_found" | "conflict" | "invalid" | "forbidden";

export class OpsDeskError extends Error {
  readonly code: OpsDeskErrorCode;
  readonly status: number;
  constructor(code: OpsDeskErrorCode, status: number, message: string) {
    super(message);
    this.name = "OpsDeskError";
    this.code = code;
    this.status = status;
  }
}

export type OpsBookingRow = {
  id: string;
  humanReference: string;
  hotelCode: string;
  hotelName: string;
  transferDate: string;
  pickupTime: string;
  durationMinutes: number;
  guestName: string;
  guestPhone: string;
  guestEmail: string;
  passengerCount: number;
  luggageCount: number;
  pickupText: string;
  destinationText: string;
  specialRequirements: string | null;
  internalNotes: string | null;
  status: string;
  cancelled: boolean;
  vehicleId: string | null;
  vehicleName: string | null;
  driverId: string | null;
  driverName: string | null;
  needsVehicle: boolean;
  needsDriver: boolean;
};

export type TodayBoard = {
  athensDate: string;
  next: OpsBookingRow | null;
  feed: OpsBookingRow[];
  attention: {
    unassignedVehicle: number;
    unassignedDriver: number;
    cancelled: number;
  };
};

export type OpsVehicle = {
  id: string;
  name: string;
  capacity: number;
  active: boolean;
};

export type OpsDriver = {
  id: string;
  name: string;
  active: boolean;
};

export type OpsHotel = HotelIdentity & {
  id: string;
};

export type OpsAudit = {
  at: string;
  actorType: string;
  action: string;
  payload: string;
};

function timeText(value: unknown): string {
  const text = String(value);
  return text.length >= 5 ? text.slice(0, 5) : text;
}

function dateText(value: unknown): string {
  return String(value).slice(0, 10);
}

function mapBooking(row: Record<string, unknown>): OpsBookingRow {
  const cancelled = row.cancelled_at != null;
  return {
    id: String(row.id),
    humanReference: String(row.human_reference),
    hotelCode: String(row.hotel_code),
    hotelName: String(row.hotel_name),
    transferDate: dateText(row.transfer_date),
    pickupTime: timeText(row.pickup_time),
    durationMinutes: Number(row.duration_minutes),
    guestName: String(row.guest_name),
    guestPhone: String(row.guest_phone ?? ""),
    guestEmail: String(row.guest_email ?? ""),
    passengerCount: Number(row.passenger_count),
    luggageCount: Number(row.luggage_count),
    pickupText: String(row.pickup_text ?? ""),
    destinationText: String(row.destination_text ?? ""),
    specialRequirements: (row.special_requirements as string | null) ?? null,
    internalNotes: (row.internal_notes as string | null) ?? null,
    status: String(row.status),
    cancelled,
    vehicleId: (row.vehicle_id as string | null) ?? null,
    vehicleName: (row.vehicle_name as string | null) ?? null,
    driverId: (row.driver_id as string | null) ?? null,
    driverName: (row.driver_name as string | null) ?? null,
    needsVehicle: !cancelled && row.vehicle_id == null,
    needsDriver: !cancelled && row.driver_id == null,
  };
}

function assertDeskOrDispatcher(scope: OpsScope): void {
  if (!isHotelDesk(scope) && !isProviderDispatcher(scope)) {
    throw new OpsDeskError("forbidden", 403, "Not allowed.");
  }
}

function bookingScopeClause(scope: OpsScope): { sql: string; param: string } {
  if (isHotelDesk(scope) && scope.hotelId) {
    return { sql: "b.hotel_id = $IDX::uuid", param: scope.hotelId };
  }
  if (isProviderDispatcher(scope) && scope.providerId) {
    return { sql: "b.executing_provider_id = $IDX::uuid", param: scope.providerId };
  }
  throw new OpsDeskError("forbidden", 403, "Not allowed.");
}

function withScope(sql: string, scope: OpsScope, extra: unknown[] = []): { text: string; params: unknown[] } {
  const clause = bookingScopeClause(scope);
  const idx = extra.length + 1;
  return {
    text: sql.replaceAll("$IDX", `$${idx}`),
    params: [...extra, clause.param],
  };
}

const BOOKING_SELECT = `
  select
    b.id,
    b.human_reference,
    h.code as hotel_code,
    h.name as hotel_name,
    b.transfer_date::text as transfer_date,
    b.pickup_time::text as pickup_time,
    b.duration_minutes,
    b.guest_name,
    b.guest_phone,
    b.guest_email,
    b.passenger_count,
    b.luggage_count,
    b.pickup_text,
    b.destination_text,
    b.special_requirements,
    b.internal_notes,
    b.status,
    b.cancelled_at,
    b.vehicle_id,
    v.name as vehicle_name,
    b.driver_id,
    d.name as driver_name
  from bookings b
  join hotels h on h.id = b.hotel_id
  left join vehicles v on v.id = b.vehicle_id
  left join drivers d on d.id = b.driver_id
`;

export async function loadTodayBoard(db: OpsDeskDb, scope: OpsScope): Promise<TodayBoard> {
  assertDeskOrDispatcher(scope);
  const athensDate = await athensToday(db);
  const scoped = withScope(
    `${BOOKING_SELECT}
     where b.transfer_date = $1::date
       and ${bookingScopeClause(scope).sql}
     order by b.pickup_time, b.created_at`,
    scope,
    [athensDate],
  );
  const rows = await db.query<Record<string, unknown>>(scoped.text, scoped.params);
  const feed = rows.map(mapBooking);
  const remainingSql = withScope(
    `select b.id
     from bookings b
     where b.transfer_date = $1::date
       and b.cancelled_at is null
       and ${bookingScopeClause(scope).sql}
       and lower(b.occupies) >= now()
     order by b.pickup_time, b.created_at
     limit 1`,
    scope,
    [athensDate],
  );
  const remaining = await db.query<{ id: string }>(remainingSql.text, remainingSql.params);
  const nextId = remaining[0]?.id;
  return {
    athensDate,
    next: feed.find((row) => row.id === nextId) ?? null,
    feed,
    attention: {
      unassignedVehicle: feed.filter((row) => row.needsVehicle).length,
      unassignedDriver: feed.filter((row) => row.needsDriver).length,
      cancelled: feed.filter((row) => row.cancelled).length,
    },
  };
}

export async function listOpsBookings(db: OpsDeskDb, scope: OpsScope): Promise<OpsBookingRow[]> {
  assertDeskOrDispatcher(scope);
  const scoped = withScope(
    `${BOOKING_SELECT} where ${bookingScopeClause(scope).sql}
     order by b.transfer_date desc, b.pickup_time, b.created_at`,
    scope,
  );
  const rows = await db.query<Record<string, unknown>>(scoped.text, scoped.params);
  return rows.map(mapBooking);
}

export async function getOpsBooking(
  db: OpsDeskDb,
  scope: OpsScope,
  bookingId: string,
): Promise<OpsBookingRow> {
  assertDeskOrDispatcher(scope);
  const scoped = withScope(
    `${BOOKING_SELECT} where b.id = $1::uuid and ${bookingScopeClause(scope).sql}`,
    scope,
    [bookingId],
  );
  const rows = await db.query<Record<string, unknown>>(scoped.text, scoped.params);
  const row = rows[0];
  if (!row) throw new OpsDeskError("not_found", 404, "Booking not found.");
  return mapBooking(row);
}

export async function listOpsAudit(
  db: OpsDeskDb,
  scope: OpsScope,
  bookingId: string,
): Promise<OpsAudit[]> {
  await getOpsBooking(db, scope, bookingId);
  const rows = await db.query<{ at: unknown; actor_type: string; action: string; payload: unknown }>(
    `select at, actor_type, action, payload
     from audit_events
     where booking_id = $1::uuid
     order by at`,
    [bookingId],
  );
  return rows.map((row) => ({
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
    actorType: row.actor_type,
    action: row.action,
    payload: JSON.stringify(row.payload ?? {}),
  }));
}

export async function listOpsVehicles(db: OpsDeskDb, scope: OpsScope): Promise<OpsVehicle[]> {
  if (!isProviderDispatcher(scope) || !scope.providerId) {
    throw new OpsDeskError("forbidden", 403, "Not allowed.");
  }
  const rows = await db.query<{ id: string; name: string; capacity: number; active: boolean }>(
    `select id, name, capacity, active
       from vehicles
      where operated_by_provider_id = $1::uuid
      order by name`,
    [scope.providerId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    capacity: Number(row.capacity),
    active: row.active !== false,
  }));
}

export async function upsertVehicle(
  db: OpsDeskDb,
  scope: OpsScope,
  input: { id?: string | null; name: string; capacity: number; active: boolean },
): Promise<OpsVehicle> {
  if (!isProviderDispatcher(scope) || !scope.providerId) {
    throw new OpsDeskError("forbidden", 403, "Not allowed.");
  }
  const name = input.name.trim();
  if (!name) throw new OpsDeskError("invalid", 400, "Vehicle name is required.");
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 20) {
    throw new OpsDeskError("invalid", 400, "Capacity must be 1–20.");
  }
  if (input.id) {
    const rows = await db.query<OpsVehicle>(
      `update vehicles
          set name = $1, capacity = $2, active = $3
        where id = $4::uuid
          and operated_by_provider_id = $5::uuid
          and owned_by_provider_id = $5::uuid
        returning id, name, capacity, active`,
      [name, input.capacity, input.active, input.id, scope.providerId],
    );
    if (!rows[0]) throw new OpsDeskError("not_found", 404, "Vehicle not found.");
    return { ...rows[0], capacity: Number(rows[0].capacity), active: rows[0].active !== false };
  }
  const rows = await db.query<OpsVehicle>(
    `insert into vehicles (
       name, capacity, active, owned_by_provider_id, operated_by_provider_id
     ) values ($1, $2, $3, $4::uuid, $4::uuid)
     returning id, name, capacity, active`,
    [name, input.capacity, input.active, scope.providerId],
  );
  const row = rows[0]!;
  return { ...row, capacity: Number(row.capacity), active: row.active !== false };
}

export async function listOpsDrivers(db: OpsDeskDb, scope: OpsScope): Promise<OpsDriver[]> {
  if (!isProviderDispatcher(scope) || !scope.providerId) {
    throw new OpsDeskError("forbidden", 403, "Not allowed.");
  }
  const rows = await db.query<{ id: string; name: string; active: boolean }>(
    `select id, name, active
       from drivers
      where dispatched_by_provider_id = $1::uuid
      order by name`,
    [scope.providerId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active !== false,
  }));
}

export async function upsertDriver(
  db: OpsDeskDb,
  scope: OpsScope,
  input: { id?: string | null; name: string; active: boolean },
): Promise<OpsDriver> {
  if (!isProviderDispatcher(scope) || !scope.providerId) {
    throw new OpsDeskError("forbidden", 403, "Not allowed.");
  }
  const name = input.name.trim();
  if (!name) throw new OpsDeskError("invalid", 400, "Driver name is required.");
  if (input.id) {
    const rows = await db.query<OpsDriver>(
      `update drivers set name = $1, active = $2
        where id = $3::uuid
          and dispatched_by_provider_id = $4::uuid
          and employed_by_provider_id = $4::uuid
        returning id, name, active`,
      [name, input.active, input.id, scope.providerId],
    );
    if (!rows[0]) throw new OpsDeskError("not_found", 404, "Driver not found.");
    return { ...rows[0], active: rows[0].active !== false };
  }
  const rows = await db.query<OpsDriver>(
    `insert into drivers (name, active, employed_by_provider_id, dispatched_by_provider_id)
     values ($1, $2, $3::uuid, $3::uuid)
     returning id, name, active`,
    [name, input.active, scope.providerId],
  );
  const row = rows[0]!;
  return { ...row, active: row.active !== false };
}

export async function listOpsHotels(db: OpsDeskDb, scope: OpsScope): Promise<OpsHotel[]> {
  assertDeskOrDispatcher(scope);
  if (isHotelDesk(scope) && scope.hotelId) {
    const rows = await db.query<{ id: string; code: string; name: string }>(
      "select id, code, name from hotels where id = $1::uuid order by name",
      [scope.hotelId],
    );
    return rows.map((row) => ({ id: row.id, ...hotelIdentity(row) }));
  }
  const rows = await db.query<{ id: string; code: string; name: string }>(
    `select h.id, h.code, h.name
       from hotels h
       join hotel_provider_agreements a on a.hotel_id = h.id
      where a.provider_id = $1::uuid and a.active
      order by h.name`,
    [scope.providerId],
  );
  return rows.map((row) => ({ id: row.id, ...hotelIdentity(row) }));
}

export async function upsertHotel(
  _db: OpsDeskDb,
  _scope: OpsScope,
  _input: { id?: string | null; code: string; name: string },
): Promise<OpsHotel> {
  throw new OpsDeskError("forbidden", 403, "Not allowed.");
}

