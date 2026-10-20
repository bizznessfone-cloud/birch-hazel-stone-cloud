/**
 * Stage 2 operational feasibility. Read-only.
 * Does not reserve a vehicle, write a booking, or authenticate an operator.
 * The caller passes an OpsScope already established by the desk. A shared
 * database role is not operator authority. Guests do not call this.
 *
 * Route duration is the passenger interval. Repositioning is separate.
 * A missing route or reposition row is infeasible, never zero minutes.
 * The same endpoint is the only zero. GiST overlap is necessary and not
 * sufficient: a 15-minute buffer is added to each reposition.
 * Unavailability must miss the passenger interval and every non-zero
 * reposition this proposal requires. The idle buffer is not movement.
 * Hours must cover the whole journey continuously. Valid pickup and
 * drop-off times do not prove the middle is open.
 */
import { civilInstant, type TimeDb } from "./time.ts";
import { isProviderDispatcher, type OpsScope } from "./tenancy.ts";

export const FEASIBILITY_BUFFER_MINUTES = 15;

export type FeasibilityDb = TimeDb;

export type FeasibilityRequest = {
  providerId: string;
  hotelId: string;
  originLocationId: string;
  destinationLocationId: string;
  transferDate: string;
  pickupTime: string;
  passengerCount: number;
  luggageCount: number;
  vehicleId?: string;
};

export type RejectionCode =
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "time_nonexistent"
  | "time_ambiguous"
  | "invalid_time"
  | "route_missing"
  | "outside_hours"
  | "inactive"
  | "vehicle_provider"
  | "seats"
  | "luggage"
  | "luggage_unknown"
  | "maintenance"
  | "occupancy"
  | "previous_endpoint_unknown"
  | "next_endpoint_unknown"
  | "reposition_missing"
  | "previous_reposition"
  | "next_reposition";

export type RepositionNeed = {
  fromLocationId: string;
  toLocationId: string;
  durationMinutes: number | null;
};

export type ScheduleBounds = {
  pickupAt: string | null;
  dropoffAt: string | null;
  bufferMinutes: number;
  previousEndsAt: string | null;
  earliestPickupAt: string | null;
  nextStartsAt: string | null;
  latestDropoffAt: string | null;
};

export type VehicleAssessment = {
  vehicleId: string;
  eligible: boolean;
  rejections: RejectionCode[];
  previousReposition: RepositionNeed | null;
  nextReposition: RepositionNeed | null;
  bounds: ScheduleBounds;
};

export type FeasibilityResult = {
  feasible: boolean;
  vehicleIds: string[];
  rejections: RejectionCode[];
  route: {
    originLocationId: string;
    destinationLocationId: string;
    durationMinutes: number;
  } | null;
  assessments: VehicleAssessment[];
  schedule: ScheduleBounds;
};

type LocationRow = {
  id: string;
  provider_id: string;
  active: boolean;
};

type HoursRow = {
  isodow: number;
  opens_local: string;
  closes_local: string;
};

type ExceptionRow = {
  service_date: string;
  closed: boolean;
  opens_local: string | null;
  closes_local: string | null;
};

type VehicleRow = {
  id: string;
  active: boolean;
  capacity: number;
  luggage_capacity: number | null;
  operated_by_provider_id: string;
};

type Commitment = {
  id: string;
  starts_at: string;
  ends_at: string;
  origin_location_id: string | null;
  destination_location_id: string | null;
};

type BlockRow = {
  starts_at: string;
  ends_at: string;
};

function emptyBounds(): ScheduleBounds {
  return {
    pickupAt: null,
    dropoffAt: null,
    bufferMinutes: FEASIBILITY_BUFFER_MINUTES,
    previousEndsAt: null,
    earliestPickupAt: null,
    nextStartsAt: null,
    latestDropoffAt: null,
  };
}

function emptyResult(rejections: RejectionCode[]): FeasibilityResult {
  return {
    feasible: false,
    vehicleIds: [],
    rejections,
    route: null,
    assessments: [],
    schedule: emptyBounds(),
  };
}

function asText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  throw new Error("unexpected sql value");
}

function asTime(value: unknown): string {
  const text = asText(value);
  const match = text.match(/(\d{2}:\d{2}:\d{2})/);
  return match ? match[1]! : text.slice(0, 8);
}

function asInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) throw new Error("expected integer");
  return n;
}

function asNullableInt(value: unknown): number | null {
  if (value == null) return null;
  return asInt(value);
}

function isoDow(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day));
  const weekday = utc.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day! + days));
  return utc.toISOString().slice(0, 10);
}

function addMinutes(instant: string, minutes: number): string {
  return new Date(new Date(instant).getTime() + minutes * 60_000).toISOString();
}

function instantMs(instant: string): number {
  return new Date(instant).getTime();
}

type Window = { opens: string; closes: string };

function windowFor(
  date: string,
  weekly: Map<number, Window>,
  exceptions: Map<string, ExceptionRow>,
): Window | null {
  const exception = exceptions.get(date);
  if (exception) {
    if (exception.closed || !exception.opens_local || !exception.closes_local) return null;
    return { opens: exception.opens_local, closes: exception.closes_local };
  }
  return weekly.get(isoDow(date)) ?? null;
}

type InstantInterval = { start: number; end: number };

function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to && dates.length < 5) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function mergeIntervals(intervals: InstantInterval[]): InstantInterval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: InstantInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end) merged.push({ start: interval.start, end: interval.end });
    else if (interval.end > last.end) last.end = interval.end;
  }
  return merged;
}

export function journeyInsideCoverage(coverage: InstantInterval[], start: number, end: number): boolean {
  if (!(end > start)) return false;
  return mergeIntervals(coverage).some((interval) => interval.start <= start && interval.end >= end);
}

function rangesOverlap(start: string, end: string, otherStart: string, otherEnd: string): boolean {
  return instantMs(start) < instantMs(otherEnd) && instantMs(otherStart) < instantMs(end);
}

function mapTimeFailure(err: unknown): RejectionCode {
  const message = err instanceof Error ? err.message : String(err);
  if (/does not exist/i.test(message)) return "time_nonexistent";
  if (/ambiguous/i.test(message)) return "time_ambiguous";
  return "invalid_time";
}

export async function assessFleetFeasibility(
  db: FeasibilityDb,
  request: FeasibilityRequest,
  scope: OpsScope,
): Promise<FeasibilityResult> {
  if (!isProviderDispatcher(scope) || scope.providerId !== request.providerId) {
    return emptyResult(["forbidden"]);
  }
  if (
    !Number.isInteger(request.passengerCount) ||
    request.passengerCount < 1 ||
    request.passengerCount > 20 ||
    !Number.isInteger(request.luggageCount) ||
    request.luggageCount < 0 ||
    request.luggageCount > 40
  ) {
    return emptyResult(["invalid_request"]);
  }

  const hotels = await db.query<{ iana_timezone: string }>(
    `select iana_timezone from hotels where id = $1::uuid`,
    [request.hotelId],
  );
  const timezone = hotels[0]?.iana_timezone?.trim();
  if (!timezone) return emptyResult(["not_found"]);

  let pickupAt: string;
  try {
    pickupAt = await civilInstant(db, request.transferDate, request.pickupTime, timezone);
  } catch (err) {
    return emptyResult([mapTimeFailure(err)]);
  }

  const locations = await db.query<LocationRow>(
    `select id, provider_id, active
       from sbg_fleet_locations
      where id = any($1::uuid[])`,
    [[request.originLocationId, request.destinationLocationId]],
  );
  const origin = locations.find((row) => row.id === request.originLocationId);
  const destination = locations.find((row) => row.id === request.destinationLocationId);
  if (
    !origin ||
    !destination ||
    origin.provider_id !== request.providerId ||
    destination.provider_id !== request.providerId
  ) {
    return emptyResult(["not_found"]);
  }
  if (!origin.active || !destination.active) return emptyResult(["not_found"]);

  const routes = await db.query<{ duration_minutes: number }>(
    `select duration_minutes
       from sbg_fleet_routes
      where provider_id = $1::uuid
        and origin_location_id = $2::uuid
        and destination_location_id = $3::uuid
        and active`,
    [request.providerId, request.originLocationId, request.destinationLocationId],
  );
  const durationMinutes = routes[0] ? asInt(routes[0].duration_minutes) : null;
  if (durationMinutes == null) return emptyResult(["route_missing"]);
  const dropoffAt = addMinutes(pickupAt, durationMinutes);
  const route = {
    originLocationId: request.originLocationId,
    destinationLocationId: request.destinationLocationId,
    durationMinutes,
  };

  const civil = await db.query<{ edge: string; service_date: string; civil_time: string }>(
    `select points.edge, civil.service_date, civil.civil_time
       from (values
         ('pickup'::text, $1::timestamptz),
         ('dropoff'::text, $2::timestamptz)
       ) as points(edge, instant)
       cross join lateral (
         select to_char(points.instant at time zone $3, 'YYYY-MM-DD') as service_date,
                to_char(points.instant at time zone $3, 'HH24:MI:SS') as civil_time
       ) as civil`,
    [pickupAt, dropoffAt, timezone],
  );
  const pickupCivil = civil.find((row) => row.edge === "pickup");
  const dropoffCivil = civil.find((row) => row.edge === "dropoff");
  if (!pickupCivil || !dropoffCivil) return emptyResult(["invalid_time"]);

  const dates = eachDate(addDays(pickupCivil.service_date, -1), dropoffCivil.service_date);
  const weeklyRows = await db.query<HoursRow>(
    `select isodow, opens_local::text as opens_local, closes_local::text as closes_local
       from sbg_provider_hours
      where provider_id = $1::uuid`,
    [request.providerId],
  );
  const exceptionRows = await db.query<ExceptionRow>(
    `select service_date::text as service_date, closed,
            opens_local::text as opens_local, closes_local::text as closes_local
       from sbg_provider_hour_exceptions
      where provider_id = $1::uuid
        and service_date = any($2::date[])`,
    [request.providerId, [...new Set(dates)]],
  );
  const weekly = new Map<number, Window>();
  for (const row of weeklyRows) {
    weekly.set(asInt(row.isodow), { opens: asTime(row.opens_local), closes: asTime(row.closes_local) });
  }
  const exceptions = new Map<string, ExceptionRow>();
  for (const row of exceptionRows) {
    exceptions.set(row.service_date, {
      service_date: row.service_date,
      closed: row.closed,
      opens_local: row.opens_local ? asTime(row.opens_local) : null,
      closes_local: row.closes_local ? asTime(row.closes_local) : null,
    });
  }
  const coverage: InstantInterval[] = [];
  for (const date of dates) {
    const window = windowFor(date, weekly, exceptions);
    if (!window) continue;
    const closeDate = window.opens < window.closes ? date : addDays(date, 1);
    try {
      const openAt = await civilInstant(db, date, window.opens, timezone);
      const closeAt = await civilInstant(db, closeDate, window.closes, timezone);
      coverage.push({ start: instantMs(openAt), end: instantMs(closeAt) });
    } catch {
      // A gap or fold on a window boundary covers nothing.
    }
  }
  if (!journeyInsideCoverage(coverage, instantMs(pickupAt), instantMs(dropoffAt))) {
    return {
      ...emptyResult(["outside_hours"]),
      route,
      schedule: { ...emptyBounds(), pickupAt, dropoffAt },
    };
  }

  const vehicles = await db.query<VehicleRow>(
    request.vehicleId
      ? `select id, active, capacity, luggage_capacity, operated_by_provider_id
           from vehicles
          where id = $1::uuid`
      : `select id, active, capacity, luggage_capacity, operated_by_provider_id
           from vehicles
          where operated_by_provider_id = $1::uuid
          order by id`,
    [request.vehicleId ?? request.providerId],
  );
  if (vehicles.length === 0) {
    return {
      ...emptyResult(["not_found"]),
      route,
      schedule: { ...emptyBounds(), pickupAt, dropoffAt },
    };
  }

  const vehicleIds = vehicles.map((row) => row.id);
  const commitments = vehicleIds.length
    ? await db.query<Commitment & { vehicle_id: string }>(
        `select b.vehicle_id, b.id,
                lower(b.occupies) as starts_at,
                upper(b.occupies) as ends_at,
                i.origin_location_id, i.destination_location_id
           from bookings b
           left join sbg_booking_itinerary i on i.booking_id = b.id
          where b.vehicle_id = any($1::uuid[])
            and b.cancelled_at is null
            and not isempty(b.occupies)`,
        [vehicleIds],
      )
    : [];
  const blocks = vehicleIds.length
    ? await db.query<BlockRow & { vehicle_id: string }>(
        `select vehicle_id, starts_at, ends_at
           from sbg_vehicle_unavailability
          where vehicle_id = any($1::uuid[])`,
        [vehicleIds],
      )
    : [];
  const repositionRows = await db.query<{
    from_location_id: string;
    to_location_id: string;
    duration_minutes: number;
  }>(
    `select from_location_id, to_location_id, duration_minutes
       from sbg_fleet_repositions
      where provider_id = $1::uuid`,
    [request.providerId],
  );
  const repositionMinutes = new Map<string, number>();
  for (const row of repositionRows) {
    repositionMinutes.set(`${row.from_location_id}:${row.to_location_id}`, asInt(row.duration_minutes));
  }

  const assessments: VehicleAssessment[] = [];
  for (const vehicle of vehicles) {
    const rejections: RejectionCode[] = [];
    if (vehicle.operated_by_provider_id !== request.providerId) rejections.push("vehicle_provider");
    if (vehicle.active === false) rejections.push("inactive");
    if (request.passengerCount > asInt(vehicle.capacity)) rejections.push("seats");
    const luggage = asNullableInt(vehicle.luggage_capacity);
    if (request.luggageCount > 0 && luggage == null) rejections.push("luggage_unknown");
    else if (luggage != null && request.luggageCount > luggage) rejections.push("luggage");

    const vehicleCommitments = commitments
      .filter((row) => row.vehicle_id === vehicle.id)
      .map((row) => ({
        ...row,
        starts_at: asText(row.starts_at),
        ends_at: asText(row.ends_at),
      }));
    const vehicleBlocks = blocks
      .filter((row) => row.vehicle_id === vehicle.id)
      .map((row) => ({ starts_at: asText(row.starts_at), ends_at: asText(row.ends_at) }));

    if (vehicleCommitments.some((row) => rangesOverlap(pickupAt, dropoffAt, row.starts_at, row.ends_at))) {
      rejections.push("occupancy");
    }

    const previous = vehicleCommitments
      .filter((row) => instantMs(row.ends_at) <= instantMs(pickupAt))
      .sort((a, b) => instantMs(b.ends_at) - instantMs(a.ends_at))[0];
    const next = vehicleCommitments
      .filter((row) => instantMs(row.starts_at) >= instantMs(dropoffAt))
      .sort((a, b) => instantMs(a.starts_at) - instantMs(b.starts_at))[0];

    const previousReposition = repositionNeed(
      previous?.destination_location_id ?? null,
      request.originLocationId,
      repositionMinutes,
      previous ? rejections : null,
      "previous_endpoint_unknown",
      "previous_reposition",
      previous?.ends_at ?? null,
      pickupAt,
    );
    const nextReposition = repositionNeed(
      request.destinationLocationId,
      next?.origin_location_id ?? null,
      repositionMinutes,
      next ? rejections : null,
      "next_endpoint_unknown",
      "next_reposition",
      dropoffAt,
      next?.starts_at ?? null,
    );
    const movement: { start: string; end: string }[] = [{ start: pickupAt, end: dropoffAt }];
    const previousTravel = previousReposition.durationMinutes;
    if (previous && previousTravel != null && previousTravel > 0) {
      movement.push({
        start: previous.ends_at,
        end: addMinutes(previous.ends_at, previousTravel),
      });
    }
    const nextTravel = nextReposition.durationMinutes;
    if (next && nextTravel != null && nextTravel > 0) {
      movement.push({
        start: dropoffAt,
        end: addMinutes(dropoffAt, nextTravel),
      });
    }
    if (vehicleBlocks.some((block) => movement.some((span) => rangesOverlap(span.start, span.end, block.starts_at, block.ends_at)))) {
      rejections.push("maintenance");
    }

    const bounds: ScheduleBounds = {
      pickupAt,
      dropoffAt,
      bufferMinutes: FEASIBILITY_BUFFER_MINUTES,
      previousEndsAt: previous?.ends_at ?? null,
      earliestPickupAt:
        previous && previousReposition.durationMinutes != null
          ? addMinutes(previous.ends_at, previousReposition.durationMinutes + FEASIBILITY_BUFFER_MINUTES)
          : null,
      nextStartsAt: next?.starts_at ?? null,
      latestDropoffAt:
        next && nextReposition.durationMinutes != null
          ? addMinutes(next.starts_at, -(nextReposition.durationMinutes + FEASIBILITY_BUFFER_MINUTES))
          : null,
    };
    const unique = [...new Set(rejections)];
    assessments.push({
      vehicleId: vehicle.id,
      eligible: unique.length === 0,
      rejections: unique,
      previousReposition: previous ? previousReposition.need : null,
      nextReposition: next ? nextReposition.need : null,
      bounds,
    });
  }

  const eligible = assessments.filter((row) => row.eligible).map((row) => row.vehicleId).sort();
  const rejections = eligible.length
    ? []
    : [...new Set(assessments.flatMap((row) => row.rejections))].sort();
  const shared = { ...emptyBounds(), pickupAt, dropoffAt };
  const schedule = request.vehicleId ? (assessments[0]?.bounds ?? shared) : shared;
  return {
    feasible: eligible.length > 0,
    vehicleIds: eligible,
    rejections,
    route,
    assessments: assessments.sort((a, b) => a.vehicleId.localeCompare(b.vehicleId)),
    schedule,
  };
}

function repositionNeed(
  fromLocationId: string | null,
  toLocationId: string | null,
  matrix: Map<string, number>,
  rejections: RejectionCode[] | null,
  unknownCode: RejectionCode,
  shortCode: RejectionCode,
  departAt: string | null,
  arriveBy: string | null,
): { need: RepositionNeed | null; durationMinutes: number | null } {
  if (!fromLocationId || !toLocationId) {
    if (rejections) rejections.push(unknownCode);
    return { need: null, durationMinutes: null };
  }
  if (fromLocationId === toLocationId) {
    const durationMinutes = 0;
    if (rejections && departAt && arriveBy) {
      const ready = instantMs(departAt) + FEASIBILITY_BUFFER_MINUTES * 60_000;
      if (ready > instantMs(arriveBy)) rejections.push(shortCode);
    }
    return {
      need: { fromLocationId, toLocationId, durationMinutes },
      durationMinutes,
    };
  }
  const durationMinutes = matrix.get(`${fromLocationId}:${toLocationId}`);
  if (durationMinutes == null) {
    if (rejections) rejections.push("reposition_missing");
    return {
      need: { fromLocationId, toLocationId, durationMinutes: null },
      durationMinutes: null,
    };
  }
  if (rejections && departAt && arriveBy) {
    const ready = instantMs(departAt) + (durationMinutes + FEASIBILITY_BUFFER_MINUTES) * 60_000;
    if (ready > instantMs(arriveBy)) rejections.push(shortCode);
  }
  return {
    need: { fromLocationId, toLocationId, durationMinutes },
    durationMinutes,
  };
}
