/**
 * Stage 2 operational feasibility. Read-only.
 * sbg_assess_capacity is the only feasibility authority. This module checks
 * the desk scope, then returns that SQL result. It does not reserve a vehicle,
 * write a booking, or authenticate an operator. A shared database role is not
 * operator authority. Guests do not call this.
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
import { isProviderDispatcher, type OpsScope } from "./tenancy.ts";
import type { TimeDb } from "./time.ts";

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

type InstantInterval = { start: number; end: number };

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

  const rows = await db.query<{ result: FeasibilityResult }>(
    `select public.sbg_assess_capacity(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::date, $6::time, $7::integer, $8::integer, $9::uuid
     ) as result`,
    [
      request.providerId,
      request.hotelId,
      request.originLocationId,
      request.destinationLocationId,
      request.transferDate,
      request.pickupTime,
      request.passengerCount,
      request.luggageCount,
      request.vehicleId ?? null,
    ],
  );
  const result = rows[0]?.result;
  if (!result || typeof result !== "object") return emptyResult(["not_found"]);
  return result;
}
