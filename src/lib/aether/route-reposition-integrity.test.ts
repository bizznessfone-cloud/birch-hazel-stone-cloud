/**
 * Gate 2 Stage 5C. Disposable PostgreSQL through migration 0072.
 * Fails closed when STAGE_G2S5_PG_URL is unset. Not Neon and not checkout.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";

const ADMIN_URL = process.env.STAGE_G2S5_PG_URL;
const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
}

async function resetCluster(adminUrl: URL): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const databases = await admin.query<{ datname: string }>(
      `select datname from pg_database
        where datallowconn and datname not in ('postgres', 'template0', 'template1')`,
    );
    for (const row of databases.rows) {
      if (!/^[a-z0-9_]+$/.test(row.datname)) continue;
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()`,
        [row.datname],
      );
      await admin.query(`drop database if exists ${row.datname}`);
    }
    for (const role of [
      "sbg_fleet_writer",
      "aether_payment_gateway",
      "aether_expiry_runner",
      "aether_expiry",
      "aether_app",
      "aether_runtime",
      "aether_webhook",
      "aether_mailer",
      "sbg_capacity_writer",
    ]) {
      const exists = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
      if (exists.rowCount === 0) continue;
      await admin.query(`drop owned by ${role}`);
      await admin.query(`revoke ${role} from postgres`).catch((err: { code?: string }) => {
        if (err.code !== "42704" && err.code !== "0LP01") throw err;
      });
      await admin.query(`drop role ${role}`);
    }
    await admin.query("create database neondb");
  } finally {
    await admin.end();
  }
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = "/neondb";
  return dbUrl.toString();
}

test("stage 5C source reuses the fleet writer and does not open checkout", () => {
  const files = migrationFiles();
  assert.equal(files.at(-1), "0079_gate2_bound_payee_test_mode.sql");
  assert.equal(files.includes("0072_gate2_route_reposition_integrity.sql"), true);
  const sql = readFileSync(new URL("0072_gate2_route_reposition_integrity.sql", MIGRATIONS), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  const booking = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
  assert.equal(preflight.includes("0072_gate2_route_reposition_integrity.sql"), false);
  assert.equal(preflight.includes("0073_gate2_hours_exception_integrity.sql"), false);
  assert.equal(preflight.includes("0074_gate2_location_integrity.sql"), false);
  assert.equal(preflight.includes("0075_gate2_guest_destination_binding.sql"), false);
  assert.equal(preflight.includes("0076_gate2_provider_reservation_mode.sql"), false);
  assert.equal(preflight.includes("0077_gate2_capacity_guest_payment.sql"), false);
  assert.equal(preflight.includes("0078_gate2_capacity_checkout_claim_generation.sql"), false);
  assert.equal(preflight.includes("0079_gate2_bound_payee_test_mode.sql"), false);
  assert.equal(preflight.includes("AUTHORISED_PENDING = []"), true);
  assert.match(sql, /sbg_fleet_writer/);
  assert.doesNotMatch(sql, /create role /);
  assert.match(sql, /sbg_capacity_lock_vehicle/);
  assert.match(sql, /sbg_fleet_lock_assignments/);
  assert.match(sql, /hashtextextended\(vehicle_id::text, 20260302\)/);
  assert.match(sql, /Neither hole is closed/);
  assert.match(sql, /revoke sbg_fleet_writer from current_user/);
  assert.doesNotMatch(sql, /grant sbg_fleet_writer to aether_/);
  assert.doesNotMatch(sql, /grant sbg_capacity_writer to sbg_fleet_writer/);
  assert.doesNotMatch(sql, /grant execute on function public\.sbg_reserve_capacity/);
  assert.doesNotMatch(sql, /grant execute on function public\.sbg_capacity_settle/);
  assert.doesNotMatch(sql, /sbg_accept_verified_payment_event/);
  assert.doesNotMatch(sql, /create or replace function public\.sbg_reserve_capacity/);
  assert.doesNotMatch(sql, /^\s*commit\s*;/im);
  assert.doesNotMatch(sql, /grant (insert|update|delete)[\s\S]{0,80}to aether_(app|runtime|webhook|mailer|payment_gateway)/);
  assert.match(booking, /openFreshHold/);
  assert.match(booking, /sbg_reserve_capacity/);
  assert.doesNotMatch(booking, /sbg_fleet_upsert_route/);
  assert.doesNotMatch(booking, /sbg_fleet_upsert_reposition/);
});

test("route and reposition integrity, isolation, and two-session races", { timeout: 180_000 }, async () => {
  if (!ADMIN_URL) assert.fail("BLOCKED — LOCAL POSTGRESQL TEST NOT RUN");
  const adminUrl = new URL(ADMIN_URL);
  if (adminUrl.hostname !== "127.0.0.1" && adminUrl.hostname !== "localhost") {
    assert.fail(`BLOCKED — refusing non-local host ${adminUrl.hostname}`);
  }
  adminUrl.pathname = "/postgres";
  const dbUrl = await resetCluster(adminUrl);
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  const left = new pg.Client({ connectionString: dbUrl });
  const right = new pg.Client({ connectionString: dbUrl });
  await left.connect();
  await right.connect();
  try {
    for (const name of migrationFiles()) {
      await root.query(readFileSync(new URL(name, MIGRATIONS), "utf8"));
    }

    const role = await root.query<{ rolcanlogin: boolean; rolpassword: string | null }>(
      `select rolcanlogin, rolpassword from pg_authid where rolname = 'sbg_fleet_writer'`,
    );
    assert.equal(role.rows[0]!.rolcanlogin, false);
    assert.equal(role.rows[0]!.rolpassword, null);
    const owners = await root.query<{ proname: string; owner: string }>(
      `select p.proname, r.rolname as owner
         from pg_proc p
         join pg_roles r on r.oid = p.proowner
        where p.proname in (
          'sbg_fleet_upsert_route', 'sbg_fleet_upsert_reposition',
          'sbg_fleet_lock_provider_vehicles', 'sbg_fleet_lock_route', 'sbg_fleet_lock_reposition',
          'sbg_capacity_lock_vehicle', 'sbg_capacity_lock_scope', 'sbg_reserve_capacity'
        )`,
    );
    const ownerOf = Object.fromEntries(owners.rows.map((row) => [row.proname, row.owner]));
    assert.equal(ownerOf.sbg_fleet_upsert_route, "sbg_fleet_writer");
    assert.equal(ownerOf.sbg_fleet_upsert_reposition, "sbg_fleet_writer");
    assert.equal(ownerOf.sbg_fleet_lock_provider_vehicles, "sbg_fleet_writer");
    assert.equal(ownerOf.sbg_fleet_lock_route, "postgres");
    assert.equal(ownerOf.sbg_fleet_lock_reposition, "postgres");
    assert.equal(ownerOf.sbg_capacity_lock_vehicle, "sbg_capacity_writer");
    assert.equal(ownerOf.sbg_capacity_lock_scope, "postgres");
    assert.equal(ownerOf.sbg_reserve_capacity, "sbg_capacity_writer");
    const member = await root.query<{ bad: boolean }>(
      `select exists (
         select 1
           from pg_auth_members m
           join pg_roles who on who.oid = m.member
           join pg_roles granted on granted.oid = m.roleid
          where (who.rolname = 'sbg_fleet_writer' and granted.rolname = 'sbg_capacity_writer')
             or (who.rolname = 'sbg_capacity_writer' and granted.rolname = 'sbg_fleet_writer')
             or (granted.rolname = 'sbg_fleet_writer' and who.rolname in (
               'postgres', 'aether_app', 'aether_runtime', 'aether_webhook',
               'aether_mailer', 'aether_payment_gateway', 'aether_expiry', 'aether_expiry_runner'
             ))
       ) as bad`,
    );
    assert.equal(member.rows[0]!.bad, false);
    const hole = await root.query<{ comment: string }>(
      `select obj_description('public.sbg_fleet_lock_provider_vehicles(uuid)'::regprocedure) as comment`,
    );
    assert.match(hole.rows[0]!.comment, /operated_by/);

    await root.query(
      `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
       values ('user-1','Ada','ada@example.com',true,now(),now())`,
    );
    const hotelOrg = (await root.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Hotel', 'user-1', 'hotel') returning id`,
    )).rows[0]!.id;
    const hotel = (await root.query<{ id: string }>(
      `insert into hotels (code, name, iana_timezone, organisation_id)
       values ('s5c', 'Route Hotel', 'Europe/Athens', $1::uuid) returning id`,
      [hotelOrg],
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity)
       values ($1::uuid, 'active', 1)`,
      [hotelOrg],
    );
    await root.query(
      `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
       values ($1::uuid, $2::uuid, 'user-1')`,
      [hotelOrg, hotel],
    );
    const provider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s5cp', 'Route Provider', 'in_house') returning id`,
    )).rows[0]!.id;
    const otherProvider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s5co', 'Other Provider', 'external') returning id`,
    )).rows[0]!.id;
    await root.query(
      `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
      [hotel, provider],
    );
    const airport = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, code, name)
       values ($1::uuid, 'airport', 'ath', 'Athens Airport') returning id`,
      [provider],
    )).rows[0]!.id;
    const door = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
       values ($1::uuid, 'hotel', $2::uuid, 'door', 'Stage Door') returning id`,
      [provider, hotel],
    )).rows[0]!.id;
    const port = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, code, name)
       values ($1::uuid, 'airport', 'pir', 'Piraeus') returning id`,
      [provider],
    )).rows[0]!.id;
    const marina = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, code, name)
       values ($1::uuid, 'airport', 'mar', 'Marina') returning id`,
      [provider],
    )).rows[0]!.id;
    const routeAirportDoor = (await root.query<{ id: string }>(
      `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 45) returning id`,
      [provider, airport, door],
    )).rows[0]!.id;
    const routeDoorAirport = (await root.query<{ id: string }>(
      `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 45) returning id`,
      [provider, door, airport],
    )).rows[0]!.id;
    const routePortAirport = (await root.query<{ id: string }>(
      `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 40) returning id`,
      [provider, port, airport],
    )).rows[0]!.id;
    const routeMarinaAirport = (await root.query<{ id: string }>(
      `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 30) returning id`,
      [provider, marina, airport],
    )).rows[0]!.id;
    const routeDoorPort = (await root.query<{ id: string }>(
      `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 30) returning id`,
      [provider, door, port],
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 20)`,
      [provider, port, marina],
    );
    const repositionDoorPort = (await root.query<{ id: string }>(
      `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 4) returning id`,
      [provider, door, port],
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
       values
         ($1::uuid, $2::uuid, $3::uuid, 30),
         ($1::uuid, $3::uuid, $2::uuid, 30),
         ($1::uuid, $4::uuid, $2::uuid, 20),
         ($1::uuid, $4::uuid, $3::uuid, 20)`,
      [provider, door, airport, port],
    );
    for (let isodow = 1; isodow <= 7; isodow += 1) {
      await root.query(
        `insert into sbg_provider_hours (provider_id, isodow, opens_local, closes_local)
         values ($1::uuid, $2, '08:00', '20:00')`,
        [provider, isodow],
      );
    }
    async function vehicle(name: string, owner: string): Promise<string> {
      return (await root.query<{ id: string }>(
        `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
         values ($1, 7, 4, true, $2::uuid, $2::uuid) returning id`,
        [name, owner],
      )).rows[0]!.id;
    }
    const routeVan = await vehicle("Route Van", provider);
    const repoVan = await vehicle("Repo Van", provider);
    const legacyVan = await vehicle("Legacy Van", provider);
    const raceVan = await vehicle("Race Van", provider);
    const spareVan = await vehicle("Spare Van", provider);
    let n = 0;
    async function booking(date: string, time: string, minutes = 60): Promise<string> {
      n += 1;
      return (await root.query<{ id: string }>(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, passenger_count, luggage_count,
           pickup_text, destination_text, human_reference, confirmation_token
         ) values (
           $1::uuid, $2::uuid, $3::date, $4::time, $5,
           'Ada', '+302100000000', 'ada@example.com', 2, 1,
           'Door', 'Airport', $6, $7
         ) returning id`,
        [hotel, provider, date, time, minutes, `S5C-${n}`, `token-s5c-${n}`],
      )).rows[0]!.id;
    }
    const reserveSql = `select * from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`;
    const routeSql = `select * from public.sbg_fleet_upsert_route($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6::boolean)`;
    const repoSql = `select * from public.sbg_fleet_upsert_reposition($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer)`;

    async function shot(ids: string[]) {
      const rows = await root.query(
        `select id::text, vehicle_id::text, lifecycle_state, capacity_managed,
                duration_minutes, occupies::text
           from bookings
          where id = any($1::uuid[])
          order by id`,
        [ids],
      );
      return rows.rows;
    }
    async function routeRow(id: string) {
      return (await root.query<{ duration_minutes: number; active: boolean }>(
        `select duration_minutes, active from sbg_fleet_routes where id = $1::uuid`,
        [id],
      )).rows[0]!;
    }
    async function repoRow(id: string) {
      return (await root.query<{ duration_minutes: number }>(
        `select duration_minutes from sbg_fleet_repositions where id = $1::uuid`,
        [id],
      )).rows[0]!;
    }
    async function asRole(roleName: string, sqlText: string, params: unknown[] = []) {
      await root.query("begin");
      try {
        await root.query(`set local session authorization ${roleName}`);
        const result = await root.query(sqlText, params);
        await root.query("rollback");
        return { ok: true as const, rows: result.rows };
      } catch (err) {
        await root.query("rollback");
        return { ok: false as const, code: (err as { code?: string }).code ?? "" };
      }
    }

    const legacyTrip = await booking("2026-07-02", "10:00", 40);
    const legacyNext = await booking("2026-07-02", "11:00", 45);
    const legacyBare = await booking("2026-07-02", "18:00", 45);
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [legacyTrip, legacyVan]);
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [legacyNext, legacyVan]);
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [legacyBare, legacyVan]);
    await root.query(
      `insert into sbg_booking_itinerary (booking_id, origin_location_id, destination_location_id)
       values ($1::uuid, $2::uuid, $3::uuid), ($4::uuid, $5::uuid, $6::uuid)`,
      [legacyTrip, port, airport, legacyNext, airport, door],
    );
    const legacyBefore = await shot([legacyTrip, legacyNext, legacyBare]);
    const legacyBreak = await root.query(routeSql, [provider, routePortAirport, port, airport, 80, true]);
    assert.equal(legacyBreak.rows[0]!.fleet_outcome, "rejected", JSON.stringify(legacyBreak.rows[0]));
    assert.equal(legacyBreak.rows[0]!.fleet_rejection, "route_duration");
    assert.equal((await routeRow(routePortAirport)).duration_minutes, 40);
    assert.deepEqual(await shot([legacyTrip, legacyNext, legacyBare]), legacyBefore);

    const bareBefore = await shot([legacyBare]);
    const unusedExisting = await root.query(routeSql, [provider, routeMarinaAirport, marina, airport, 80, true]);
    assert.equal(unusedExisting.rows[0]!.fleet_outcome, "updated", JSON.stringify(unusedExisting.rows[0]));
    assert.equal((await routeRow(routeMarinaAirport)).duration_minutes, 80);
    assert.deepEqual(await shot([legacyBare]), bareBefore);
    const insertedRoute = await root.query(routeSql, [provider, null, airport, marina, 25, true]);
    assert.equal(insertedRoute.rows[0]!.fleet_outcome, "inserted", JSON.stringify(insertedRoute.rows[0]));
    const insertedRouteId = insertedRoute.rows[0]!.fleet_route_id as string;
    const duplicateRoute = await root.query(routeSql, [provider, null, airport, marina, 90, true]);
    assert.equal(duplicateRoute.rows[0]!.fleet_outcome, "duplicate");
    assert.equal(duplicateRoute.rows[0]!.fleet_route_id, insertedRouteId);
    assert.equal((await routeRow(insertedRouteId)).duration_minutes, 25);
    const sameRoute = await root.query(routeSql, [provider, insertedRouteId, airport, marina, 25, true]);
    assert.equal(sameRoute.rows[0]!.fleet_outcome, "unchanged");

    const held = await booking("2026-07-01", "10:00");
    const adjacent = await booking("2026-07-01", "12:00");
    const reserved = await root.query(reserveSql, [held, airport, door, routeVan]);
    assert.equal(reserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(reserved.rows[0]));
    assert.equal(reserved.rows[0]!.reserve_duration_minutes, 45);
    const reservedNext = await root.query(reserveSql, [adjacent, door, airport, routeVan]);
    assert.equal(reservedNext.rows[0]!.reserve_outcome, "reserved", JSON.stringify(reservedNext.rows[0]));
    const protectedBefore = await shot([held, adjacent]);
    const fitting = await root.query(routeSql, [provider, routeAirportDoor, airport, door, 50, true]);
    assert.equal(fitting.rows[0]!.fleet_outcome, "updated", JSON.stringify(fitting.rows[0]));
    assert.equal((await routeRow(routeAirportDoor)).duration_minutes, 50);
    assert.deepEqual(await shot([held, adjacent]), protectedBefore);
    const breaking = await root.query(routeSql, [provider, routeAirportDoor, airport, door, 120, true]);
    assert.equal(breaking.rows[0]!.fleet_outcome, "rejected", JSON.stringify(breaking.rows[0]));
    assert.equal(breaking.rows[0]!.fleet_rejection, "route_duration");
    assert.equal((await routeRow(routeAirportDoor)).duration_minutes, 50);
    assert.equal((await routeRow(routeAirportDoor)).active, true);
    assert.deepEqual(await shot([held, adjacent]), protectedBefore);
    const deactivate = await root.query(routeSql, [provider, routeAirportDoor, airport, door, 50, false]);
    assert.equal(deactivate.rows[0]!.fleet_outcome, "rejected", JSON.stringify(deactivate.rows[0]));
    assert.equal(deactivate.rows[0]!.fleet_rejection, "route_inactive");
    assert.equal((await routeRow(routeAirportDoor)).active, true);
    assert.deepEqual(await shot([held, adjacent]), protectedBefore);

    await root.query(`select public.sbg_capacity_settle($1::uuid, 'confirm')`, [held]);
    const confirmedBefore = await shot([held, adjacent]);
    assert.equal(confirmedBefore.find((row) => row.id === held)!.lifecycle_state, "confirmed_paid");
    const confirmedBreak = await root.query(routeSql, [provider, routeAirportDoor, airport, door, 120, true]);
    assert.equal(confirmedBreak.rows[0]!.fleet_outcome, "rejected");
    assert.equal(confirmedBreak.rows[0]!.fleet_rejection, "route_duration");
    assert.deepEqual(await shot([held, adjacent]), confirmedBefore);
    assert.equal((await routeRow(routeAirportDoor)).duration_minutes, 50);

    const proofVan = await vehicle("Proof Van", provider);
    const proofTrip = await booking("2026-07-08", "10:00", 30);
    const proofNext = await booking("2026-07-08", "11:20", 30);
    const proofReserved = await root.query(reserveSql, [proofTrip, door, port, proofVan]);
    assert.equal(proofReserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(proofReserved.rows[0]));
    assert.equal(proofReserved.rows[0]!.reserve_duration_minutes, 30);
    const proofNextReserved = await root.query(reserveSql, [proofNext, marina, airport, proofVan]);
    assert.equal(proofNextReserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(proofNextReserved.rows[0]));
    const proofBefore = await shot([proofTrip, proofNext]);
    const proofFit = await root.query(routeSql, [provider, routeDoorPort, door, port, 40, true]);
    assert.equal(proofFit.rows[0]!.fleet_outcome, "updated", JSON.stringify(proofFit.rows[0]));
    assert.equal((await routeRow(routeDoorPort)).duration_minutes, 40);
    assert.deepEqual(await shot([proofTrip, proofNext]), proofBefore);
    const gapMath = await root.query<{
      revised_ready: string;
      next_pickup: string;
      too_late: boolean;
      buffer_only_too_late: boolean;
    }>(
      `select (pg_catalog.lower(curr.occupies)
                 + pg_catalog.make_interval(mins => 50 + repo.duration_minutes + 15))::text as revised_ready,
              pg_catalog.lower(nxt.occupies)::text as next_pickup,
              pg_catalog.lower(curr.occupies)
                + pg_catalog.make_interval(mins => 50 + repo.duration_minutes + 15)
                > pg_catalog.lower(nxt.occupies) as too_late,
              pg_catalog.lower(curr.occupies)
                + pg_catalog.make_interval(mins => 50 + 15)
                > pg_catalog.lower(nxt.occupies) as buffer_only_too_late
         from bookings curr
         join bookings nxt on nxt.id = $2::uuid
         join sbg_fleet_repositions repo
           on repo.from_location_id = $3::uuid
          and repo.to_location_id = $4::uuid
        where curr.id = $1::uuid`,
      [proofTrip, proofNext, port, marina],
    );
    assert.equal(gapMath.rows[0]!.too_late, true, JSON.stringify(gapMath.rows[0]));
    assert.equal(gapMath.rows[0]!.buffer_only_too_late, false, JSON.stringify(gapMath.rows[0]));
    const proofBreak = await root.query(routeSql, [provider, routeDoorPort, door, port, 50, true]);
    assert.equal(proofBreak.rows[0]!.fleet_outcome, "rejected", JSON.stringify(proofBreak.rows[0]));
    assert.equal(proofBreak.rows[0]!.fleet_rejection, "route_duration");
    assert.equal((await routeRow(routeDoorPort)).duration_minutes, 40);
    assert.deepEqual(await shot([proofTrip, proofNext]), proofBefore);

    const alreadyVan = await vehicle("Already Van", provider);
    const alreadyTrip = await booking("2026-07-09", "10:00", 55);
    const alreadyNext = await booking("2026-07-09", "11:20", 30);
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [alreadyTrip, alreadyVan]);
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [alreadyNext, alreadyVan]);
    await root.query(
      `insert into sbg_booking_itinerary (booking_id, origin_location_id, destination_location_id)
       values ($1::uuid, $2::uuid, $3::uuid), ($4::uuid, $5::uuid, $6::uuid)`,
      [alreadyTrip, door, port, alreadyNext, marina, airport],
    );
    const alreadyBefore = await shot([alreadyTrip, alreadyNext]);
    const alreadyWorse = await root.query(routeSql, [provider, routeDoorPort, door, port, 70, true]);
    assert.equal(alreadyWorse.rows[0]!.fleet_outcome, "rejected", JSON.stringify(alreadyWorse.rows[0]));
    assert.equal(alreadyWorse.rows[0]!.fleet_rejection, "route_duration");
    assert.equal((await routeRow(routeDoorPort)).duration_minutes, 40);
    assert.deepEqual(await shot([alreadyTrip, alreadyNext]), alreadyBefore);

    const repoFirst = await booking("2026-07-03", "10:00");
    const repoSecond = await booking("2026-07-03", "13:00");
    const repoReserved = await root.query(reserveSql, [repoFirst, airport, door, repoVan]);
    assert.equal(repoReserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(repoReserved.rows[0]));
    const repoNext = await root.query(reserveSql, [repoSecond, port, airport, repoVan]);
    assert.equal(repoNext.rows[0]!.reserve_outcome, "reserved", JSON.stringify(repoNext.rows[0]));
    await root.query(
      `insert into sbg_vehicle_unavailability (vehicle_id, starts_at, ends_at, kind)
       values ($1::uuid, '2026-07-03 11:00:00+03', '2026-07-03 11:10:00+03', 'maintenance')`,
      [repoVan],
    );
    const repoBefore = await shot([repoFirst, repoSecond]);
    const gapBreak = await root.query(repoSql, [provider, repositionDoorPort, door, port, 200]);
    assert.equal(gapBreak.rows[0]!.fleet_outcome, "rejected", JSON.stringify(gapBreak.rows[0]));
    assert.equal(gapBreak.rows[0]!.fleet_rejection, "reposition_gap");
    assert.equal((await repoRow(repositionDoorPort)).duration_minutes, 4);
    assert.deepEqual(await shot([repoFirst, repoSecond]), repoBefore);
    const maintenanceBreak = await root.query(repoSql, [provider, repositionDoorPort, door, port, 20]);
    assert.equal(maintenanceBreak.rows[0]!.fleet_outcome, "rejected", JSON.stringify(maintenanceBreak.rows[0]));
    assert.equal(maintenanceBreak.rows[0]!.fleet_rejection, "reposition_maintenance");
    assert.equal((await repoRow(repositionDoorPort)).duration_minutes, 4);
    const maintenanceFit = await root.query(repoSql, [provider, repositionDoorPort, door, port, 5]);
    assert.equal(maintenanceFit.rows[0]!.fleet_outcome, "updated", JSON.stringify(maintenanceFit.rows[0]));
    assert.equal((await repoRow(repositionDoorPort)).duration_minutes, 5);
    assert.deepEqual(await shot([repoFirst, repoSecond]), repoBefore);
    const repoSame = await root.query(repoSql, [provider, repositionDoorPort, door, port, 5]);
    assert.equal(repoSame.rows[0]!.fleet_outcome, "unchanged");
    const repoDuplicate = await root.query(repoSql, [provider, null, door, port, 9]);
    assert.equal(repoDuplicate.rows[0]!.fleet_outcome, "duplicate");
    assert.equal((await repoRow(repositionDoorPort)).duration_minutes, 5);

    const legacyFromDoor = await booking("2026-07-04", "10:00", 45);
    const legacyToMarina = await booking("2026-07-04", "12:00", 30);
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [legacyFromDoor, spareVan]);
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [legacyToMarina, spareVan]);
    await root.query(
      `insert into sbg_booking_itinerary (booking_id, origin_location_id, destination_location_id)
       values ($1::uuid, $2::uuid, $3::uuid), ($4::uuid, $5::uuid, $6::uuid)`,
      [legacyFromDoor, airport, door, legacyToMarina, marina, airport],
    );
    const missingBefore = await shot([legacyFromDoor, legacyToMarina]);
    const tooLongInsert = await root.query(repoSql, [provider, null, door, marina, 200]);
    assert.equal(tooLongInsert.rows[0]!.fleet_outcome, "rejected", JSON.stringify(tooLongInsert.rows[0]));
    assert.equal(tooLongInsert.rows[0]!.fleet_rejection, "reposition_gap");
    const missingCount = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_fleet_repositions
        where from_location_id = $1::uuid and to_location_id = $2::uuid`,
      [door, marina],
    );
    assert.equal(missingCount.rows[0]!.n, 0);
    assert.deepEqual(await shot([legacyFromDoor, legacyToMarina]), missingBefore);
    const fittingInsert = await root.query(repoSql, [provider, null, door, marina, 30]);
    assert.equal(fittingInsert.rows[0]!.fleet_outcome, "inserted", JSON.stringify(fittingInsert.rows[0]));
    assert.deepEqual(await shot([legacyFromDoor, legacyToMarina]), missingBefore);

    const missingReserve = await booking("2026-07-01", "15:00");
    const missingHeld = await root.query(reserveSql, [missingReserve, marina, airport, routeVan]);
    assert.equal(missingHeld.rows[0]!.reserve_outcome, "unavailable", JSON.stringify(missingHeld.rows[0]));
    assert.equal(missingHeld.rows[0]!.reserve_rejection, "reposition_missing");
    assert.equal((await shot([missingReserve]))[0]!.vehicle_id, null);
    const zeroRows = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_fleet_repositions where from_location_id = to_location_id`,
    );
    assert.equal(zeroRows.rows[0]!.n, 0);
    const sameEndpoint = await root.query(repoSql, [provider, null, door, door, 15]);
    assert.equal(sameEndpoint.rows[0]!.fleet_outcome, "invalid");
    assert.equal(sameEndpoint.rows[0]!.fleet_rejection, "invalid_endpoints");
    const zeroAfter = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_fleet_repositions where from_location_id = to_location_id`,
    );
    assert.equal(zeroAfter.rows[0]!.n, 0);
    const activeColumn = await root.query<{ n: number }>(
      `select count(*)::int as n
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'sbg_fleet_repositions'
          and column_name = 'active'`,
    );
    assert.equal(activeColumn.rows[0]!.n, 0);
    const deleteFn = await root.query<{ present: string | null }>(
      `select to_regprocedure('public.sbg_fleet_delete_reposition(uuid, uuid)')::text as present`,
    );
    assert.equal(deleteFn.rows[0]!.present, null);

    const foreignRoute = await root.query(routeSql, [otherProvider, routeAirportDoor, airport, door, 12, false]);
    assert.equal(foreignRoute.rows[0]!.fleet_outcome, "wrong_provider", JSON.stringify(foreignRoute.rows[0]));
    assert.equal((await routeRow(routeAirportDoor)).duration_minutes, 50);
    assert.equal((await routeRow(routeAirportDoor)).active, true);
    const foreignInsert = await root.query(routeSql, [otherProvider, null, airport, door, 12, true]);
    assert.equal(foreignInsert.rows[0]!.fleet_outcome, "wrong_provider");
    const missingRoute = await root.query(routeSql, [
      provider,
      "00000000-0000-4000-8000-000000000099",
      airport,
      door,
      12,
      true,
    ]);
    assert.equal(missingRoute.rows[0]!.fleet_outcome, "not_found");
    const badDuration = await root.query(routeSql, [provider, routeMarinaAirport, marina, airport, 0, true]);
    assert.equal(badDuration.rows[0]!.fleet_outcome, "invalid");
    assert.equal(badDuration.rows[0]!.fleet_rejection, "invalid_duration");
    assert.equal((await routeRow(routeMarinaAirport)).duration_minutes, 80);
    const otherRoutes = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_fleet_routes where provider_id = $1::uuid`,
      [otherProvider],
    );
    assert.equal(otherRoutes.rows[0]!.n, 0);

    const directUpdate = await asRole(
      "aether_runtime",
      "update sbg_fleet_routes set duration_minutes = 12 where id = $1::uuid",
      [routeAirportDoor],
    );
    assert.equal(directUpdate.ok, false);
    if (!directUpdate.ok) assert.equal(directUpdate.code, "42501");
    const directDelete = await asRole(
      "aether_app",
      "delete from sbg_fleet_repositions where id = $1::uuid",
      [repositionDoorPort],
    );
    assert.equal(directDelete.ok, false);
    if (!directDelete.ok) assert.equal(directDelete.code, "42501");
    const directInsert = await asRole(
      "aether_app",
      `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 15)`,
      [provider, port, door],
    );
    assert.equal(directInsert.ok, false);
    if (!directInsert.ok) assert.equal(directInsert.code, "42501");
    const gatewayCall = await asRole(
      "aether_payment_gateway",
      routeSql,
      [provider, routeMarinaAirport, marina, airport, 70, true],
    );
    assert.equal(gatewayCall.ok, false);
    if (!gatewayCall.ok) assert.equal(gatewayCall.code, "42501");
    const runtimeCall = await asRole(
      "aether_runtime",
      routeSql,
      [provider, routeMarinaAirport, marina, airport, 70, true],
    );
    assert.equal(runtimeCall.ok, true);
    assert.equal((await routeRow(routeMarinaAirport)).duration_minutes, 80);
    const writerSettle = await asRole(
      "sbg_fleet_writer",
      `select public.sbg_capacity_settle($1::uuid, 'expire')`,
      [adjacent],
    );
    assert.equal(writerSettle.ok, false);
    if (!writerSettle.ok) assert.equal(writerSettle.code, "42501");
    const writerReserve = await asRole("sbg_fleet_writer", reserveSql, [missingReserve, airport, door, routeVan]);
    assert.equal(writerReserve.ok, false);
    if (!writerReserve.ok) assert.equal(writerReserve.code, "42501");
    assert.equal((await shot([adjacent]))[0]!.lifecycle_state, "awaiting_payment");
    assert.equal((await repoRow(repositionDoorPort)).duration_minutes, 5);

    const priv = (await root.query<{
      app_route_update: boolean;
      runtime_route_insert: boolean;
      app_repo_delete: boolean;
      app_upsert: boolean;
      runtime_lock: boolean;
      gateway_upsert: boolean;
      public_upsert: boolean;
      capacity_upsert: boolean;
      fleet_reserve: boolean;
      fleet_settle: boolean;
      fleet_accept: boolean;
      fleet_booking_update: boolean;
      app_operated: boolean;
    }>(
      `select
         has_table_privilege('aether_app', 'public.sbg_fleet_routes', 'update') as app_route_update,
         has_table_privilege('aether_runtime', 'public.sbg_fleet_routes', 'insert') as runtime_route_insert,
         has_table_privilege('aether_app', 'public.sbg_fleet_repositions', 'delete') as app_repo_delete,
         has_function_privilege('aether_app', 'public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean)', 'execute') as app_upsert,
         has_function_privilege('aether_runtime', 'public.sbg_fleet_lock_provider_vehicles(uuid)', 'execute') as runtime_lock,
         has_function_privilege('aether_payment_gateway', 'public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer)', 'execute') as gateway_upsert,
         has_function_privilege('public', 'public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean)', 'execute') as public_upsert,
         has_function_privilege('sbg_capacity_writer', 'public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean)', 'execute') as capacity_upsert,
         has_function_privilege('sbg_fleet_writer', 'public.sbg_reserve_capacity(uuid, uuid, uuid, uuid)', 'execute') as fleet_reserve,
         has_function_privilege('sbg_fleet_writer', 'public.sbg_capacity_settle(uuid, text)', 'execute') as fleet_settle,
         has_function_privilege('sbg_fleet_writer', 'public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text)', 'execute') as fleet_accept,
         has_table_privilege('sbg_fleet_writer', 'public.bookings', 'update') as fleet_booking_update,
         has_column_privilege('aether_app', 'public.vehicles', 'operated_by_provider_id', 'update') as app_operated`,
    )).rows[0]!;
    assert.equal(priv.app_route_update, false);
    assert.equal(priv.runtime_route_insert, false);
    assert.equal(priv.app_repo_delete, false);
    assert.equal(priv.app_upsert, true);
    assert.equal(priv.runtime_lock, false);
    assert.equal(priv.gateway_upsert, false);
    assert.equal(priv.public_upsert, false);
    assert.equal(priv.capacity_upsert, false);
    assert.equal(priv.fleet_reserve, false);
    assert.equal(priv.fleet_settle, false);
    assert.equal(priv.fleet_accept, false);
    assert.equal(priv.fleet_booking_update, false);
    assert.equal(priv.app_operated, false);

    const raceBooking = await booking("2026-07-05", "10:00");
    const beforeRaceRoute = await routeRow(routeMarinaAirport);
    await left.query("begin");
    const openHold = await left.query(reserveSql, [raceBooking, airport, door, raceVan]);
    assert.equal(openHold.rows[0]!.reserve_outcome, "reserved", JSON.stringify(openHold.rows[0]));
    await right.query("begin");
    const started = Date.now();
    const blockedEdit = await right.query(routeSql, [provider, routeMarinaAirport, marina, airport, 90, true]);
    const waited = Date.now() - started;
    assert.equal(blockedEdit.rows[0]!.fleet_outcome, "rejected", JSON.stringify(blockedEdit.rows[0]));
    assert.equal(blockedEdit.rows[0]!.fleet_rejection, "lock_busy");
    assert.ok(waited >= 1500 && waited < 8000, String(waited));
    await right.query("rollback");
    assert.deepEqual(await routeRow(routeMarinaAirport), beforeRaceRoute);
    await left.query("commit");
    assert.equal((await shot([raceBooking]))[0]!.vehicle_id, raceVan);
    assert.equal((await shot([raceBooking]))[0]!.duration_minutes, 50);

    const openBefore = await routeRow(routeAirportDoor);
    await left.query("begin");
    const openEdit = await left.query(routeSql, [provider, routeAirportDoor, airport, door, openBefore.duration_minutes - 2, true]);
    assert.equal(openEdit.rows[0]!.fleet_outcome, "updated", JSON.stringify(openEdit.rows[0]));
    const raceTwo = await booking("2026-07-06", "10:00");
    await right.query("begin");
    await right.query("set local lock_timeout = '1500ms'");
    try {
      await right.query(reserveSql, [raceTwo, airport, door, raceVan]);
      assert.fail("reservation should wait on the open route edit");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "55P03", (err as Error).message);
    } finally {
      await right.query("rollback");
    }
    assert.equal((await shot([raceTwo]))[0]!.vehicle_id, null);
    await left.query("commit");
    assert.equal((await routeRow(routeAirportDoor)).duration_minutes, openBefore.duration_minutes - 2);
    const afterEdit = await root.query(reserveSql, [raceTwo, airport, door, raceVan]);
    assert.equal(afterEdit.rows[0]!.reserve_outcome, "reserved", JSON.stringify(afterEdit.rows[0]));
    assert.equal(afterEdit.rows[0]!.reserve_duration_minutes, openBefore.duration_minutes - 2);
    assert.equal((await shot([held]))[0]!.duration_minutes, 45);
    assert.equal((await shot([held]))[0]!.lifecycle_state, "confirmed_paid");
    assert.equal((await shot([held]))[0]!.vehicle_id, routeVan);

    const moved = await root.query(
      `update vehicles
          set operated_by_provider_id = $2::uuid
        where id = $1::uuid
        returning operated_by_provider_id::text`,
      [spareVan, otherProvider],
    );
    assert.equal(moved.rows[0]!.operated_by_provider_id, otherProvider);
    const appMove = await asRole(
      "aether_app",
      "update vehicles set operated_by_provider_id = $2::uuid where id = $1::uuid",
      [spareVan, provider],
    );
    assert.equal(appMove.ok, false);
    if (!appMove.ok) assert.equal(appMove.code, "42501");
  } finally {
    await left.end().catch(() => undefined);
    await right.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
});
