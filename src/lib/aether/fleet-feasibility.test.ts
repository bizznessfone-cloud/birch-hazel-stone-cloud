/**
 * Gate 2 Stage 2. Real PostgreSQL only. Refuses a non-local host.
 * Fails closed when STAGE_G2S2_PG_URL is unset. Not Neon and not a reservation.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";
import {
  FEASIBILITY_BUFFER_MINUTES,
  assessFleetFeasibility,
  type FeasibilityDb,
  type FeasibilityRequest,
  type FeasibilityResult,
} from "./fleet-feasibility.ts";
import type { OpsScope } from "./tenancy.ts";

const ADMIN_URL = process.env.STAGE_G2S2_PG_URL;
const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function assertLocal(url: URL): void {
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    assert.fail(`BLOCKED — LOCAL POSTGRESQL TEST NOT RUN: refusing non-local host ${url.hostname}`);
  }
}

async function apply(client: pg.Client, names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await client.query(readFileSync(new URL(name, MIGRATIONS), "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${name}: ${message}`);
    }
  }
}

async function resetCluster(adminUrl: URL): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = 'neondb' and pid <> pg_backend_pid()`,
  );
  await admin.query("drop database if exists neondb");
  for (const role of ["aether_app", "aether_runtime", "aether_webhook", "aether_mailer"]) {
    const exists = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) continue;
    await admin.query(`drop owned by ${role}`);
    await admin.query(
      `alter default privileges for role postgres in schema public revoke all on tables from ${role};
       alter default privileges for role postgres in schema public revoke all on sequences from ${role};
       alter default privileges for role postgres in schema public revoke all on functions from ${role};
       alter default privileges for role postgres in schema public revoke all on types from ${role}`,
    );
    await admin.query(`revoke ${role} from postgres`).catch((err: { code?: string }) => {
      if (err.code !== "42704" && err.code !== "0LP01") throw err;
    });
    await admin.query(`drop role ${role}`);
  }
  await admin.query("create database neondb");
  await admin.end();
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = "/neondb";
  return dbUrl.toString();
}

function adapter(client: pg.Client): FeasibilityDb {
  return {
    query: async <T>(text: string, params?: unknown[]) => {
      const result = await client.query<T>(text, params);
      return result.rows;
    },
  };
}

test("stage 2 source is read-only and is not a reservation", () => {
  const files = migrationFiles();
  assert.equal(files.includes("0066_gate2_fleet_feasibility.sql"), true);
  assert.equal(files.includes("0067_gate2_vehicle_column_privileges.sql"), true);
  assert.equal(files.includes("0068_gate2_vehicle_delete_privilege.sql"), true);
  assert.equal(files.includes("0065_gate2_vehicle_dispatch_boundary.sql"), true);
  const sql = readFileSync(new URL("0066_gate2_fleet_feasibility.sql", MIGRATIONS), "utf8");
  const narrowed = readFileSync(new URL("0067_gate2_vehicle_column_privileges.sql", MIGRATIONS), "utf8");
  const deleted = readFileSync(new URL("0068_gate2_vehicle_delete_privilege.sql", MIGRATIONS), "utf8");
  const earlier = readFileSync(new URL("0065_gate2_vehicle_dispatch_boundary.sql", MIGRATIONS), "utf8");
  const service = readFileSync(new URL("./fleet-feasibility.ts", import.meta.url), "utf8");
  const guest = readFileSync(new URL("./guest-payment-fns.ts", import.meta.url), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  assert.equal(preflight.includes("0066_gate2_fleet_feasibility.sql"), false);
  assert.equal(preflight.includes("0067_gate2_vehicle_column_privileges.sql"), false);
  assert.equal(preflight.includes("0068_gate2_vehicle_delete_privilege.sql"), false);
  assert.match(sql, /grant select on table public\.sbg_fleet_routes to aether_app/);
  assert.match(sql, /grant select on table public\.sbg_fleet_routes to aether_runtime/);
  assert.doesNotMatch(sql, /grant (insert|update|delete)/i);
  assert.match(sql, /Null is unknown and is not unlimited/);
  assert.match(sql, /Missing is infeasible/);
  assert.match(narrowed, /revoke insert, update on table public\.vehicles from aether_runtime/);
  assert.match(narrowed, /grant update \(name, capacity, active\) on table public\.vehicles to aether_runtime/);
  const narrowedSql = narrowed.replace(/--.*$/gm, "");
  assert.doesNotMatch(narrowedSql, /luggage_capacity/);
  assert.doesNotMatch(narrowedSql, /stripe|checkout|sbg_dispatch_set_vehicle/i);
  const deletedSql = deleted.replace(/--.*$/gm, "");
  assert.match(deletedSql, /revoke delete on table public\.vehicles from aether_runtime/);
  assert.match(deletedSql, /revoke delete on table public\.vehicles from aether_app/);
  assert.doesNotMatch(deletedSql, /grant /i);
  assert.doesNotMatch(deletedSql, /stripe|checkout|sbg_dispatch_set_vehicle/i);
  assert.match(service, /journeyInsideCoverage/);
  const executable = sql.replace(/--.*$/gm, "");
  assert.doesNotMatch(executable, /stripe|checkout|sbg_dispatch_set_vehicle/i);
  assert.match(earlier, /capacity_managed is immutable/);
  assert.equal(FEASIBILITY_BUFFER_MINUTES, 15);
  assert.match(service, /FEASIBILITY_BUFFER_MINUTES/);
  assert.doesNotMatch(service, /insert into|update bookings|delete from/i);
  assert.doesNotMatch(guest, /assessFleetFeasibility|fleet-feasibility/);
});

test("local postgres feasibility covers route, fleet, hours, and repositioning", { timeout: 180_000 }, async () => {
  if (!ADMIN_URL) assert.fail("BLOCKED — LOCAL POSTGRESQL TEST NOT RUN");
  const adminUrl = new URL(ADMIN_URL);
  assertLocal(adminUrl);
  adminUrl.pathname = "/postgres";
  const dbUrl = await resetCluster(adminUrl);
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await apply(root, migrationFiles());
  const db = adapter(root);

  const hotel = (
    await root.query<{ id: string }>(
      `insert into hotels (code, name, iana_timezone) values ('gate2s2', 'Stage Hotel', 'Europe/Athens') returning id`,
    )
  ).rows[0]!.id;
  const otherHotel = (
    await root.query<{ id: string }>(
      `insert into hotels (code, name, iana_timezone) values ('gate2s2b', 'Other Hotel', 'Europe/Athens') returning id`,
    )
  ).rows[0]!.id;
  const provider = (
    await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s2prov', 'Stage Provider', 'in_house') returning id`,
    )
  ).rows[0]!.id;
  const otherProvider = (
    await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s2other', 'Other Provider', 'external') returning id`,
    )
  ).rows[0]!.id;
  const scope: OpsScope = {
    operatorId: "00000000-0000-4000-8000-000000000001",
    login: "desk",
    sessionId: "stage2",
    membershipId: "00000000-0000-4000-8000-000000000002",
    accessClass: "provider_dispatcher",
    hotelId: null,
    providerId: provider,
  };
  const airport = (
    await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, code, name)
       values ($1::uuid, 'airport', 'ath', 'Athens Airport') returning id`,
      [provider],
    )
  ).rows[0]!.id;
  const hotelStop = (
    await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
       values ($1::uuid, 'hotel', $2::uuid, 'gate', 'Stage Door') returning id`,
      [provider, hotel],
    )
  ).rows[0]!.id;
  const looseStop = (
    await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
       values ($1::uuid, 'hotel', $2::uuid, 'loose', 'Unlinked Door') returning id`,
      [provider, otherHotel],
    )
  ).rows[0]!.id;
  await root.query(
    `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
     values ($1::uuid, $2::uuid, $3::uuid, 45), ($1::uuid, $3::uuid, $2::uuid, 40)`,
    [provider, airport, hotelStop],
  );
  await root.query(
    `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
     values ($1::uuid, $2::uuid, $3::uuid, 35), ($1::uuid, $3::uuid, $2::uuid, 30)`,
    [provider, airport, hotelStop],
  );
  for (let isodow = 1; isodow <= 7; isodow += 1) {
    await root.query(
      `insert into sbg_provider_hours (provider_id, isodow, opens_local, closes_local)
       values ($1::uuid, $2, '08:00', '20:00')`,
      [provider, isodow],
    );
  }
  const van = (
    await root.query<{ id: string }>(
      `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Van', 7, 4, true, $1::uuid, $1::uuid) returning id`,
      [provider],
    )
  ).rows[0]!.id;
  const small = (
    await root.query<{ id: string }>(
      `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Small', 3, 1, true, $1::uuid, $1::uuid) returning id`,
      [provider],
    )
  ).rows[0]!.id;
  const unknownLuggage = (
    await root.query<{ id: string }>(
      `insert into vehicles (name, capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Unknown', 4, true, $1::uuid, $1::uuid) returning id`,
      [provider],
    )
  ).rows[0]!.id;
  const inactive = (
    await root.query<{ id: string }>(
      `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Idle', 7, 4, false, $1::uuid, $1::uuid) returning id`,
      [provider],
    )
  ).rows[0]!.id;
  const foreign = (
    await root.query<{ id: string }>(
      `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Foreign', 7, 4, true, $1::uuid, $1::uuid) returning id`,
      [otherProvider],
    )
  ).rows[0]!.id;

  async function assess(
    patch: Partial<FeasibilityRequest> & { scope?: OpsScope },
  ): Promise<FeasibilityResult> {
    const request: FeasibilityRequest = {
      providerId: provider,
      hotelId: hotel,
      originLocationId: airport,
      destinationLocationId: hotelStop,
      transferDate: "2026-06-03",
      pickupTime: "10:00",
      passengerCount: 2,
      luggageCount: 1,
      ...patch,
    };
    return assessFleetFeasibility(db, request, patch.scope ?? scope);
  }

  let sequence = 0;
  async function commit(
    vehicleId: string,
    date: string,
    time: string,
    duration: number,
    origin: string | null,
    destination: string | null,
  ): Promise<string> {
    sequence += 1;
    const id = (
      await root.query<{ id: string }>(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, pickup_text, destination_text,
           human_reference, confirmation_token, vehicle_id
         ) values (
           $1::uuid, $2::uuid, $3::date, $4::time, $5,
           'Guest', '+302100000000', 'guest@example.com', 'Door', 'Stop',
           $6, $7, $8::uuid
         ) returning id`,
        [hotel, provider, date, time, duration, `S2-${sequence}`, `token-s2-${sequence}`, vehicleId],
      )
    ).rows[0]!.id;
    if (origin && destination) {
      await root.query(
        `insert into sbg_booking_itinerary (booking_id, origin_location_id, destination_location_id)
         values ($1::uuid, $2::uuid, $3::uuid)`,
        [id, origin, destination],
      );
    }
    return id;
  }

  async function clearCommits(): Promise<void> {
    await root.query("delete from sbg_booking_itinerary");
    await root.query("delete from bookings");
  }

  const denied = await assess({
    scope: { ...scope, accessClass: "hotel_desk", hotelId: hotel, providerId: null },
  });
  assert.deepEqual(denied.rejections, ["forbidden"]);
  assert.deepEqual(denied.vehicleIds, []);
  assert.equal(denied.route, null);

  const toHotel = await assess({ vehicleId: van });
  assert.equal(toHotel.feasible, true);
  assert.deepEqual(toHotel.vehicleIds, [van]);
  assert.equal(toHotel.route?.durationMinutes, 45);
  assert.equal(toHotel.schedule.bufferMinutes, 15);

  const toAirport = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
  });
  assert.equal(toAirport.feasible, true);
  assert.equal(toAirport.route?.durationMinutes, 40);

  const unsupported = await assess({
    vehicleId: van,
    originLocationId: airport,
    destinationLocationId: looseStop,
  });
  assert.equal(unsupported.feasible, false);
  assert.deepEqual(unsupported.rejections, ["route_missing"]);

  const seats = await assess({ vehicleId: small, passengerCount: 4, luggageCount: 0 });
  assert.equal(seats.feasible, false);
  assert.ok(seats.rejections.includes("seats"));

  const luggage = await assess({ vehicleId: small, passengerCount: 1, luggageCount: 2 });
  assert.equal(luggage.feasible, false);
  assert.ok(luggage.rejections.includes("luggage"));

  const unknown = await assess({ vehicleId: unknownLuggage, passengerCount: 1, luggageCount: 1 });
  assert.equal(unknown.feasible, false);
  assert.ok(unknown.rejections.includes("luggage_unknown"));
  const unknownEmpty = await assess({ vehicleId: unknownLuggage, passengerCount: 1, luggageCount: 0 });
  assert.equal(unknownEmpty.feasible, true);

  const idle = await assess({ vehicleId: inactive });
  assert.equal(idle.feasible, false);
  assert.ok(idle.rejections.includes("inactive"));

  const other = await assess({ vehicleId: foreign });
  assert.equal(other.feasible, false);
  assert.ok(other.rejections.includes("vehicle_provider"));
  assert.equal(JSON.stringify(other).includes("Foreign"), false);

  const before = await root.query<{ vehicle_id: string | null; capacity_managed: boolean }>(
    "select vehicle_id, capacity_managed from bookings",
  );
  assert.equal(before.rowCount, 0);

  await root.query(
    `insert into sbg_vehicle_unavailability (vehicle_id, starts_at, ends_at, kind)
     values ($1::uuid, aether_civil_instant('2026-06-03', '09:30', 'Europe/Athens'),
             aether_civil_instant('2026-06-03', '11:00', 'Europe/Athens'), 'maintenance')`,
    [van],
  );
  const maintained = await assess({ vehicleId: van });
  assert.equal(maintained.feasible, false);
  assert.ok(maintained.rejections.includes("maintenance"));
  await root.query("delete from sbg_vehicle_unavailability");

  const closed = await assess({ vehicleId: van, pickupTime: "07:00" });
  assert.equal(closed.feasible, false);
  assert.ok(closed.rejections.includes("outside_hours"));
  await root.query(
    `insert into sbg_provider_hour_exceptions (provider_id, service_date, closed)
     values ($1::uuid, '2026-06-04', true)`,
    [provider],
  );
  const exception = await assess({ vehicleId: van, transferDate: "2026-06-04", pickupTime: "10:00" });
  assert.equal(exception.feasible, false);
  assert.ok(exception.rejections.includes("outside_hours"));

  await root.query(
    `insert into sbg_provider_hour_exceptions (provider_id, service_date, closed, opens_local, closes_local)
     values ($1::uuid, '2026-06-09', false, '22:00', '06:00'),
            ($1::uuid, '2026-06-10', false, '22:00', '06:00')`,
    [provider],
  );
  const overnight = await assess({ vehicleId: van, transferDate: "2026-06-10", pickupTime: "23:00" });
  assert.equal(overnight.feasible, true, overnight.rejections.join(","));
  const earlyTail = await assess({ vehicleId: van, transferDate: "2026-06-10", pickupTime: "05:00" });
  assert.equal(earlyTail.feasible, true, earlyTail.rejections.join(","));
  const midday = await assess({ vehicleId: van, transferDate: "2026-06-10", pickupTime: "12:00" });
  assert.equal(midday.feasible, false);
  assert.ok(midday.rejections.includes("outside_hours"));

  const crossesMidnight = await assess({ vehicleId: van, transferDate: "2026-06-10", pickupTime: "23:30" });
  assert.equal(crossesMidnight.feasible, true, crossesMidnight.rejections.join(","));
  const pastClose = await assess({ vehicleId: van, transferDate: "2026-06-10", pickupTime: "05:30" });
  assert.equal(pastClose.feasible, false);
  assert.ok(pastClose.rejections.includes("outside_hours"));
  const pastDaytimeClose = await assess({ vehicleId: van, transferDate: "2026-06-03", pickupTime: "19:30" });
  assert.equal(pastDaytimeClose.feasible, false);
  assert.ok(pastDaytimeClose.rejections.includes("outside_hours"));

  await root.query(
    `insert into sbg_provider_hour_exceptions (provider_id, service_date, closed, opens_local, closes_local)
     values ($1::uuid, '2026-06-16', false, '22:00', '06:00'),
            ($1::uuid, '2026-06-17', false, '06:00', '20:00'),
            ($1::uuid, '2026-06-18', false, '22:00', '06:00'),
            ($1::uuid, '2026-06-19', false, '06:30', '20:00')`,
    [provider],
  );
  const adjacent = await assess({ vehicleId: van, transferDate: "2026-06-17", pickupTime: "05:50" });
  assert.equal(adjacent.feasible, true, adjacent.rejections.join(","));
  const splitByGap = await assess({ vehicleId: van, transferDate: "2026-06-19", pickupTime: "05:50" });
  assert.equal(splitByGap.feasible, false, "endpoints are inside different windows");
  assert.ok(splitByGap.rejections.includes("outside_hours"));

  await root.query(
    `insert into sbg_provider_hour_exceptions (provider_id, service_date, closed, opens_local, closes_local)
     values ($1::uuid, '2026-06-23', false, '22:00', '06:00')`,
    [provider],
  );
  await root.query(
    `insert into sbg_provider_hour_exceptions (provider_id, service_date, closed)
     values ($1::uuid, '2026-06-24', true)`,
    [provider],
  );
  const tailUnderClosedDay = await assess({ vehicleId: van, transferDate: "2026-06-24", pickupTime: "05:00" });
  assert.equal(tailUnderClosedDay.feasible, true, tailUnderClosedDay.rejections.join(","));
  const tailThenClosed = await assess({ vehicleId: van, transferDate: "2026-06-24", pickupTime: "05:30" });
  assert.equal(tailThenClosed.feasible, false);
  assert.ok(tailThenClosed.rejections.includes("outside_hours"));

  const gap = await assess({ transferDate: "2026-03-29", pickupTime: "03:30" });
  assert.deepEqual(gap.rejections, ["time_nonexistent"]);
  const fold = await assess({ transferDate: "2026-10-25", pickupTime: "03:30" });
  assert.deepEqual(fold.rejections, ["time_ambiguous"]);

  await commit(van, "2026-06-03", "09:00", 60, hotelStop, airport);
  const previousShort = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
    pickupTime: "10:49",
  });
  assert.equal(previousShort.feasible, false);
  assert.ok(previousShort.rejections.includes("previous_reposition"));
  assert.equal(previousShort.assessments[0]?.previousReposition?.durationMinutes, 35);
  const previousExact = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
    pickupTime: "10:50",
  });
  assert.equal(previousExact.feasible, true, previousExact.rejections.join(","));
  assert.equal(previousExact.schedule.bufferMinutes, 15);
  await clearCommits();

  await commit(van, "2026-06-03", "09:00", 60, airport, hotelStop);
  const samePlaceShort = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
    pickupTime: "10:00",
  });
  assert.equal(samePlaceShort.feasible, false);
  assert.ok(samePlaceShort.rejections.includes("previous_reposition"));
  const bufferExact = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
    pickupTime: "10:15",
  });
  assert.equal(bufferExact.feasible, true, bufferExact.rejections.join(","));
  assert.equal(bufferExact.assessments[0]?.previousReposition?.durationMinutes, 0);
  const adjacentOverlap = await root.query<{ overlap: boolean }>(
    `select occupies && tstzrange(
        aether_civil_instant('2026-06-03', '10:15', 'Europe/Athens'),
        aether_civil_instant('2026-06-03', '10:55', 'Europe/Athens'),
        '[)'
      ) as overlap
       from bookings`,
  );
  assert.equal(adjacentOverlap.rows[0]!.overlap, false);
  await clearCommits();

  await commit(van, "2026-06-03", "11:29", 30, airport, hotelStop);
  const nextShort = await assess({ vehicleId: van, pickupTime: "10:00" });
  assert.equal(nextShort.feasible, false);
  assert.ok(nextShort.rejections.includes("next_reposition"));
  assert.equal(nextShort.assessments[0]?.nextReposition?.durationMinutes, 30);
  await clearCommits();
  await commit(van, "2026-06-03", "11:30", 30, airport, hotelStop);
  const nextExact = await assess({ vehicleId: van, pickupTime: "10:00" });
  assert.equal(nextExact.feasible, true, nextExact.rejections.join(","));
  await clearCommits();

  async function block(start: string, end: string, kind = "maintenance"): Promise<void> {
    await root.query(
      `insert into sbg_vehicle_unavailability (vehicle_id, starts_at, ends_at, kind)
       values ($1::uuid, aether_civil_instant('2026-06-03', $2::time, 'Europe/Athens'),
               aether_civil_instant('2026-06-03', $3::time, 'Europe/Athens'), $4)`,
      [van, start, end, kind],
    );
  }
  async function clearBlocks(): Promise<void> {
    await root.query("delete from sbg_vehicle_unavailability");
  }

  await commit(van, "2026-06-03", "09:00", 60, hotelStop, airport);
  await block("12:00", "13:00");
  const movementClear = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
    pickupTime: "10:50",
  });
  assert.equal(movementClear.feasible, true, movementClear.rejections.join(","));
  await clearBlocks();
  await block("10:20", "10:30");
  const movementOverlap = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
    pickupTime: "10:50",
  });
  assert.equal(movementOverlap.feasible, false);
  assert.ok(movementOverlap.rejections.includes("maintenance"));
  await clearBlocks();
  await block("09:00", "10:00");
  const movementStartsAtBlockEnd = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
    pickupTime: "10:50",
  });
  assert.equal(movementStartsAtBlockEnd.feasible, true, movementStartsAtBlockEnd.rejections.join(","));
  await clearBlocks();
  await block("10:35", "10:50");
  const bufferOnly = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
    pickupTime: "10:50",
  });
  assert.equal(bufferOnly.feasible, true, bufferOnly.rejections.join(","));
  await clearBlocks();
  await block("10:34", "10:36");
  const movementOneMinute = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
    pickupTime: "10:50",
  });
  assert.equal(movementOneMinute.feasible, false);
  assert.ok(movementOneMinute.rejections.includes("maintenance"));
  await clearBlocks();
  await clearCommits();

  await commit(van, "2026-06-03", "11:30", 30, airport, hotelStop);
  await block("11:00", "11:10", "unavailable");
  const outboundOverlap = await assess({ vehicleId: van, pickupTime: "10:00" });
  assert.equal(outboundOverlap.feasible, false);
  assert.ok(outboundOverlap.rejections.includes("maintenance"));
  await clearBlocks();
  await block("11:15", "11:30");
  const outboundExact = await assess({ vehicleId: van, pickupTime: "10:00" });
  assert.equal(outboundExact.feasible, true, outboundExact.rejections.join(","));
  await clearBlocks();
  await block("11:14", "11:16");
  const outboundOneMinute = await assess({ vehicleId: van, pickupTime: "10:00" });
  assert.equal(outboundOneMinute.feasible, false);
  assert.ok(outboundOneMinute.rejections.includes("maintenance"));
  await clearBlocks();
  await clearCommits();

  await block("09:00", "10:00");
  const passengerExactStart = await assess({ vehicleId: van, pickupTime: "10:00" });
  assert.equal(passengerExactStart.feasible, true, passengerExactStart.rejections.join(","));
  await clearBlocks();
  await block("10:45", "11:00");
  const passengerExactEnd = await assess({ vehicleId: van, pickupTime: "10:00" });
  assert.equal(passengerExactEnd.feasible, true, passengerExactEnd.rejections.join(","));
  await clearBlocks();
  await block("10:44", "10:46");
  const passengerOneMinute = await assess({ vehicleId: van, pickupTime: "10:00" });
  assert.equal(passengerOneMinute.feasible, false);
  assert.ok(passengerOneMinute.rejections.includes("maintenance"));
  await clearBlocks();

  const legacyId = await commit(van, "2026-06-03", "08:00", 60, null, null);
  const legacy = await assess({ vehicleId: van, pickupTime: "12:00" });
  assert.equal(legacy.feasible, false);
  assert.ok(legacy.rejections.includes("previous_endpoint_unknown"));
  assert.equal(legacy.assessments[0]?.previousReposition, null);
  const legacyRow = await root.query<{ vehicle_id: string; capacity_managed: boolean }>(
    "select vehicle_id, capacity_managed from bookings where id = $1::uuid",
    [legacyId],
  );
  assert.equal(legacyRow.rows[0]!.vehicle_id, van);
  assert.equal(legacyRow.rows[0]!.capacity_managed, false);
  await clearCommits();

  await commit(van, "2026-06-03", "08:00", 60, airport, looseStop);
  const missing = await assess({
    vehicleId: van,
    originLocationId: hotelStop,
    destinationLocationId: airport,
    pickupTime: "12:00",
  });
  assert.equal(missing.feasible, false);
  assert.ok(missing.rejections.includes("reposition_missing"));
  assert.equal(missing.assessments[0]?.previousReposition?.durationMinutes, null);
  await clearCommits();

  await commit(van, "2026-06-03", "10:30", 45, airport, hotelStop);
  const occupied = await assess({ vehicleId: van, pickupTime: "10:00" });
  assert.equal(occupied.feasible, false);
  assert.ok(occupied.rejections.includes("occupancy"));
  const gist = await root.query<{ name: string }>(
    `select conname as name from pg_constraint where conname = 'bookings_vehicle_occupancy_excl'`,
  );
  assert.equal(gist.rowCount, 1);

  const privileges = await root.query<{
    rolname: string;
    sel: boolean;
    ins: boolean;
    upd: boolean;
    del: boolean;
    lug_sel: boolean;
    lug_upd: boolean;
  }>(
    `select r.rolname,
            has_table_privilege(r.rolname, 'public.sbg_fleet_locations', 'SELECT')
              and has_table_privilege(r.rolname, 'public.sbg_fleet_routes', 'SELECT')
              and has_table_privilege(r.rolname, 'public.sbg_fleet_repositions', 'SELECT')
              and has_table_privilege(r.rolname, 'public.sbg_provider_hours', 'SELECT')
              and has_table_privilege(r.rolname, 'public.sbg_provider_hour_exceptions', 'SELECT')
              and has_table_privilege(r.rolname, 'public.sbg_vehicle_unavailability', 'SELECT')
              and has_table_privilege(r.rolname, 'public.sbg_booking_itinerary', 'SELECT') as sel,
            has_table_privilege(r.rolname, 'public.sbg_fleet_locations', 'INSERT')
              or has_table_privilege(r.rolname, 'public.sbg_fleet_routes', 'INSERT')
              or has_table_privilege(r.rolname, 'public.sbg_fleet_repositions', 'INSERT')
              or has_table_privilege(r.rolname, 'public.sbg_provider_hours', 'INSERT')
              or has_table_privilege(r.rolname, 'public.sbg_provider_hour_exceptions', 'INSERT')
              or has_table_privilege(r.rolname, 'public.sbg_vehicle_unavailability', 'INSERT')
              or has_table_privilege(r.rolname, 'public.sbg_booking_itinerary', 'INSERT') as ins,
            has_table_privilege(r.rolname, 'public.sbg_fleet_locations', 'UPDATE')
              or has_table_privilege(r.rolname, 'public.sbg_fleet_routes', 'UPDATE')
              or has_table_privilege(r.rolname, 'public.sbg_fleet_repositions', 'UPDATE')
              or has_table_privilege(r.rolname, 'public.sbg_provider_hours', 'UPDATE')
              or has_table_privilege(r.rolname, 'public.sbg_provider_hour_exceptions', 'UPDATE')
              or has_table_privilege(r.rolname, 'public.sbg_vehicle_unavailability', 'UPDATE')
              or has_table_privilege(r.rolname, 'public.sbg_booking_itinerary', 'UPDATE') as upd,
            has_table_privilege(r.rolname, 'public.sbg_fleet_locations', 'DELETE')
              or has_table_privilege(r.rolname, 'public.sbg_fleet_routes', 'DELETE')
              or has_table_privilege(r.rolname, 'public.sbg_fleet_repositions', 'DELETE')
              or has_table_privilege(r.rolname, 'public.sbg_provider_hours', 'DELETE')
              or has_table_privilege(r.rolname, 'public.sbg_provider_hour_exceptions', 'DELETE')
              or has_table_privilege(r.rolname, 'public.sbg_vehicle_unavailability', 'DELETE')
              or has_table_privilege(r.rolname, 'public.sbg_booking_itinerary', 'DELETE') as del,
            has_column_privilege(r.rolname, 'public.vehicles', 'luggage_capacity', 'SELECT') as lug_sel,
            has_column_privilege(r.rolname, 'public.vehicles', 'luggage_capacity', 'UPDATE') as lug_upd
       from pg_roles r
      where r.rolname in ('aether_app', 'aether_runtime', 'aether_webhook', 'aether_mailer')
      order by r.rolname`,
  );
  const byRole = new Map(privileges.rows.map((row) => [row.rolname, row]));
  for (const role of ["aether_app", "aether_runtime"] as const) {
    const row = byRole.get(role);
    assert.ok(row, role);
    assert.equal(row.sel, true, role);
    assert.equal(row.ins, false, role);
    assert.equal(row.upd, false, role);
    assert.equal(row.del, false, role);
    assert.equal(row.lug_sel, true, role);
  }
  assert.equal(byRole.get("aether_app")!.lug_upd, false);
  assert.equal(byRole.get("aether_runtime")!.lug_upd, false);
  const vehicleDelete = await root.query<{ rolname: string; del: boolean }>(
    `select r.rolname, has_table_privilege(r.rolname, 'public.vehicles', 'DELETE') as del
       from pg_roles r
      where r.rolname in ('aether_app', 'aether_runtime', 'aether_webhook', 'aether_mailer')
      order by r.rolname`,
  );
  for (const row of vehicleDelete.rows) assert.equal(row.del, false, row.rolname);
  for (const role of ["aether_webhook", "aether_mailer"] as const) {
    const row = byRole.get(role);
    assert.ok(row, role);
    assert.equal(row.sel, false, role);
    assert.equal(row.ins, false, role);
    assert.equal(row.upd, false, role);
    assert.equal(row.del, false, role);
  }

  const deniedWrite = await root.query("begin");
  assert.ok(deniedWrite);
  try {
    await root.query("set local session authorization aether_app");
    await root.query(
      `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 10)`,
      [provider, airport, looseStop],
    );
    assert.fail("application insert should be denied");
  } catch (err) {
    const code = (err as { code?: string }).code;
    assert.equal(code, "42501");
  } finally {
    await root.query("rollback");
  }
  await root.query("begin");
  try {
    await root.query("set local session authorization aether_runtime");
    await root.query(
      `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 10)`,
      [provider, airport, looseStop],
    );
    assert.fail("runtime insert should be denied");
  } catch (err) {
    const code = (err as { code?: string }).code;
    assert.equal(code, "42501");
  } finally {
    await root.query("rollback");
  }

  async function asRole(
    role: "aether_app" | "aether_runtime",
    sqlText: string,
    params: unknown[] = [],
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    await root.query("begin");
    try {
      await root.query(`set local session authorization ${role}`);
      await root.query(sqlText, params);
      await root.query("rollback");
      return { ok: true };
    } catch (err) {
      await root.query("rollback");
      return { ok: false, code: (err as { code?: string }).code ?? "" };
    }
  }
  const deskUpdate = await asRole(
    "aether_runtime",
    "update vehicles set name = 'Van 2', capacity = 6, active = true where id = $1::uuid",
    [van],
  );
  assert.equal(deskUpdate.ok, true);
  const luggageUpdate = await asRole(
    "aether_runtime",
    "update vehicles set luggage_capacity = 2 where id = $1::uuid",
    [van],
  );
  assert.equal(luggageUpdate.ok, false);
  if (!luggageUpdate.ok) assert.equal(luggageUpdate.code, "42501");
  const ownerUpdate = await asRole(
    "aether_runtime",
    "update vehicles set operated_by_provider_id = $2::uuid where id = $1::uuid",
    [van, otherProvider],
  );
  assert.equal(ownerUpdate.ok, false);
  if (!ownerUpdate.ok) assert.equal(ownerUpdate.code, "42501");
  const deskInsert = await asRole(
    "aether_runtime",
    `insert into vehicles (name, capacity, active, owned_by_provider_id, operated_by_provider_id)
     values ('Temp', 4, true, $1::uuid, $1::uuid)`,
    [provider],
  );
  assert.equal(deskInsert.ok, true);
  const luggageInsert = await asRole(
    "aether_runtime",
    `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
     values ('Temp', 4, 2, true, $1::uuid, $1::uuid)`,
    [provider],
  );
  assert.equal(luggageInsert.ok, false);
  if (!luggageInsert.ok) assert.equal(luggageInsert.code, "42501");
  const appLuggage = await asRole("aether_app", "update vehicles set luggage_capacity = 2 where id = $1::uuid", [van]);
  assert.equal(appLuggage.ok, false);
  if (!appLuggage.ok) assert.equal(appLuggage.code, "42501");
  const appDesk = await asRole(
    "aether_app",
    "update vehicles set name = 'Van', capacity = 7, active = true where id = $1::uuid",
    [van],
  );
  assert.equal(appDesk.ok, true);
  const appInsert = await asRole(
    "aether_app",
    `insert into vehicles (name, capacity, active, owned_by_provider_id, operated_by_provider_id)
     values ('Desk', 4, true, $1::uuid, $1::uuid)`,
    [provider],
  );
  assert.equal(appInsert.ok, true);
  for (const role of ["aether_app", "aether_runtime"] as const) {
    const removed = await asRole(role, "delete from vehicles where id = $1::uuid", [van]);
    assert.equal(removed.ok, false, role);
    if (!removed.ok) assert.equal(removed.code, "42501", role);
  }

  await root.end();
});
