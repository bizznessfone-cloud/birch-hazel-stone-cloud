/**
 * Gate 2 Stage 5E. Disposable PostgreSQL through migration 0074.
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

test("stage 5E source reuses the fleet writer and does not open checkout", () => {
  const files = migrationFiles();
  assert.equal(files.at(-1), "0074_gate2_location_integrity.sql");
  assert.equal(files.includes("0073_gate2_hours_exception_integrity.sql"), true);
  const sql = readFileSync(new URL("0074_gate2_location_integrity.sql", MIGRATIONS), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  const booking = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
  assert.equal(preflight.includes("0074_gate2_location_integrity.sql"), false);
  assert.equal(preflight.includes("AUTHORISED_PENDING = []"), true);
  assert.match(sql, /sbg_fleet_writer/);
  assert.doesNotMatch(sql, /create role /);
  assert.match(sql, /hashtextextended\(vehicle_id::text, 20260302\)/);
  assert.match(sql, /That hole is not closed/);
  assert.match(sql, /display name only/);
  assert.match(sql, /A missing itinerary is not a reference/);
  assert.doesNotMatch(sql, /delete from public\.sbg_fleet_locations/);
  assert.doesNotMatch(sql, /grant delete on table public\.sbg_fleet_locations/);
  assert.match(sql, /revoke sbg_fleet_writer from current_user/);
  assert.doesNotMatch(sql, /grant sbg_fleet_writer to aether_/);
  assert.doesNotMatch(sql, /grant execute on function public\.sbg_reserve_capacity/);
  assert.doesNotMatch(sql, /create or replace function public\.sbg_reserve_capacity/);
  assert.doesNotMatch(sql, /^\s*commit\s*;/im);
  assert.match(booking, /openFreshHold/);
  assert.doesNotMatch(booking, /sbg_fleet_deactivate_location/);
  assert.doesNotMatch(booking, /sbg_reserve_capacity/);
});

test("location integrity, isolation, and two-session races", { timeout: 180_000 }, async () => {
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
       values ('s5e', 'Location Hotel', 'Europe/Athens', $1::uuid) returning id`,
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
      `insert into providers (code, name, kind) values ('s5ep', 'Location Provider', 'in_house') returning id`,
    )).rows[0]!.id;
    const otherProvider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s5eo', 'Other Location', 'external') returning id`,
    )).rows[0]!.id;
    const airport = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, code, name)
       values ($1::uuid, 'airport', 'ath', 'Athens Airport') returning id`,
      [provider],
    )).rows[0]!.id;
    const door = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
       values ($1::uuid, 'hotel', $2::uuid, 'door', 'Hours Door') returning id`,
      [provider, hotel],
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 45)`,
      [provider, airport, door],
    );
    await root.query(
      `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 30), ($1::uuid, $3::uuid, $2::uuid, 30)`,
      [provider, door, airport],
    );
    for (let isodow = 1; isodow <= 7; isodow += 1) {
      await root.query(
        `insert into sbg_provider_hours (provider_id, isodow, opens_local, closes_local)
         values ($1::uuid, $2, '08:00', '20:00')`,
        [provider, isodow],
      );
    }
    const van = (await root.query<{ id: string }>(
      `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Location Van', 7, 4, true, $1::uuid, $1::uuid) returning id`,
      [provider],
    )).rows[0]!.id;
    const raceVan = (await root.query<{ id: string }>(
      `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Race Van', 7, 4, true, $1::uuid, $1::uuid) returning id`,
      [provider],
    )).rows[0]!.id;
    const legacyVan = (await root.query<{ id: string }>(
      `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Legacy Van', 7, 4, true, $1::uuid, $1::uuid) returning id`,
      [provider],
    )).rows[0]!.id;
    let n = 0;
    async function booking(date: string): Promise<string> {
      n += 1;
      return (await root.query<{ id: string }>(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, passenger_count, luggage_count,
           pickup_text, destination_text, human_reference, confirmation_token
         ) values (
           $1::uuid, $2::uuid, $3::date, '10:00', 60,
           'Ada', '+302100000000', 'ada@example.com', 2, 1,
           'Door', 'Airport', $4, $5
         ) returning id`,
        [hotel, provider, date, `S5E-${n}`, `token-s5e-${n}`],
      )).rows[0]!.id;
    }
    const insertSql = `select * from public.sbg_fleet_insert_location($1::uuid, $2::text, $3::uuid, $4::text, $5::text)`;
    const renameSql = `select * from public.sbg_fleet_rename_location($1::uuid, $2::uuid, $3::text)`;
    const deactivateSql = `select * from public.sbg_fleet_deactivate_location($1::uuid, $2::uuid)`;
    const reserveSql = `select * from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`;
    async function place(origin: string, dest: string) {
      await root.query(
        `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
         values ($1::uuid, $2::uuid, $3::uuid, 45)`,
        [provider, origin, dest],
      );
      await root.query(
        `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
         values ($1::uuid, $2::uuid, $3::uuid, 30), ($1::uuid, $3::uuid, $2::uuid, 30)`,
        [provider, dest, origin],
      );
    }
    async function loc(id: string) {
      return (await root.query<{
        id: string;
        provider_id: string;
        kind: string;
        hotel_id: string | null;
        code: string;
        name: string;
        active: boolean;
      }>(
        `select id::text, provider_id::text, kind, hotel_id::text, code, name, active
           from sbg_fleet_locations where id = $1::uuid`,
        [id],
      )).rows[0];
    }
    async function shot(ids: string[]) {
      return (await root.query(
        `select id::text, vehicle_id::text, lifecycle_state, duration_minutes, occupies::text, capacity_managed
           from bookings where id = any($1::uuid[]) order by id`,
        [ids],
      )).rows;
    }
    async function itinerary(id: string) {
      return (await root.query(
        `select origin_location_id::text, destination_location_id::text
           from sbg_booking_itinerary where booking_id = $1::uuid`,
        [id],
      )).rows;
    }
    async function asRole(roleName: string, sqlText: string, params: unknown[] = []) {
      await root.query("begin");
      try {
        await root.query(`set local session authorization ${roleName}`);
        await root.query(sqlText, params);
        await root.query("rollback");
        return { ok: true as const };
      } catch (err) {
        await root.query("rollback");
        return { ok: false as const, code: (err as { code?: string }).code ?? "" };
      }
    }

    const pier = await root.query(insertSql, [provider, "airport", null, " pier ", " North Pier "]);
    assert.equal(pier.rows[0]!.fleet_outcome, "inserted", JSON.stringify(pier.rows[0]));
    const pierId = pier.rows[0]!.fleet_location_id as string;
    assert.equal((await loc(pierId))!.code, "pier");
    assert.equal((await loc(pierId))!.name, "North Pier");
    assert.equal((await loc(pierId))!.active, true);
    assert.equal((await loc(pierId))!.kind, "airport");
    assert.equal((await loc(pierId))!.provider_id, provider);
    const duplicate = await root.query(insertSql, [provider, "airport", null, "pier", "Other Pier"]);
    assert.equal(duplicate.rows[0]!.fleet_outcome, "duplicate");
    assert.equal(duplicate.rows[0]!.fleet_location_id, null);
    const sameHotel = await root.query(insertSql, [provider, "hotel", hotel, "door-2", "Second Door"]);
    assert.equal(sameHotel.rows[0]!.fleet_outcome, "duplicate");
    const badKind = await root.query(insertSql, [provider, "port", null, "port", "Port"]);
    assert.equal(badKind.rows[0]!.fleet_rejection, "invalid_location");
    const hotelShape = await root.query(insertSql, [provider, "hotel", null, "bare", "Bare Hotel"]);
    assert.equal(hotelShape.rows[0]!.fleet_rejection, "invalid_location");
    const airportShape = await root.query(insertSql, [provider, "airport", hotel, "with-hotel", "Airport Hotel"]);
    assert.equal(airportShape.rows[0]!.fleet_rejection, "invalid_location");
    const blank = await root.query(insertSql, [provider, "airport", null, "   ", "Blank"]);
    assert.equal(blank.rows[0]!.fleet_rejection, "invalid_location");
    const missingProvider = await root.query(insertSql, [
      "00000000-0000-4000-8000-000000000001",
      "airport",
      null,
      "ghost",
      "Ghost",
    ]);
    assert.equal(missingProvider.rows[0]!.fleet_outcome, "not_found");

    const renamed = await root.query(renameSql, [provider, pierId, "Marina Pier"]);
    assert.equal(renamed.rows[0]!.fleet_outcome, "updated", JSON.stringify(renamed.rows[0]));
    assert.equal((await loc(pierId))!.id, pierId);
    assert.equal((await loc(pierId))!.code, "pier");
    assert.equal((await loc(pierId))!.name, "Marina Pier");
    const sameName = await root.query(renameSql, [provider, pierId, " Marina Pier "]);
    assert.equal(sameName.rows[0]!.fleet_outcome, "unchanged");
    const blankName = await root.query(renameSql, [provider, pierId, "  "]);
    assert.equal(blankName.rows[0]!.fleet_rejection, "invalid_location");
    assert.equal((await loc(pierId))!.name, "Marina Pier");

    const held = await booking("2026-08-03");
    const reserved = await root.query(reserveSql, [held, airport, door, van]);
    assert.equal(reserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(reserved.rows[0]));
    const before = await shot([held]);
    const itineraryBefore = await itinerary(held);
    assert.deepEqual(itineraryBefore, [{ origin_location_id: airport, destination_location_id: door }]);
    const closeDoor = await root.query(deactivateSql, [provider, door]);
    assert.equal(closeDoor.rows[0]!.fleet_outcome, "rejected", JSON.stringify(closeDoor.rows[0]));
    assert.equal(closeDoor.rows[0]!.fleet_rejection, "location_in_use");
    assert.equal((await loc(door))!.active, true);
    const closeAirport = await root.query(deactivateSql, [provider, airport]);
    assert.equal(closeAirport.rows[0]!.fleet_rejection, "location_in_use");
    assert.equal((await loc(airport))!.active, true);
    assert.deepEqual(await shot([held]), before);
    assert.deepEqual(await itinerary(held), itineraryBefore);
    const routeBefore = await root.query(
      `select origin_location_id::text, destination_location_id::text, duration_minutes, active
         from sbg_fleet_routes
        where provider_id = $1::uuid and origin_location_id = $2::uuid and destination_location_id = $3::uuid`,
      [provider, airport, door],
    );
    const renamedDoor = await root.query(renameSql, [provider, door, "Renamed Door"]);
    assert.equal(renamedDoor.rows[0]!.fleet_outcome, "updated", JSON.stringify(renamedDoor.rows[0]));
    assert.equal((await loc(door))!.id, door);
    assert.equal((await loc(door))!.code, "door");
    assert.equal((await loc(door))!.kind, "hotel");
    assert.equal((await loc(door))!.hotel_id, hotel);
    assert.equal((await loc(door))!.provider_id, provider);
    assert.equal((await loc(door))!.name, "Renamed Door");
    assert.deepEqual(await shot([held]), before);
    assert.deepEqual(await itinerary(held), itineraryBefore);
    const routeAfter = await root.query(
      `select origin_location_id::text, destination_location_id::text, duration_minutes, active
         from sbg_fleet_routes
        where provider_id = $1::uuid and origin_location_id = $2::uuid and destination_location_id = $3::uuid`,
      [provider, airport, door],
    );
    assert.deepEqual(routeAfter.rows, routeBefore.rows);

    const closePier = await root.query(deactivateSql, [provider, pierId]);
    assert.equal(closePier.rows[0]!.fleet_outcome, "updated", JSON.stringify(closePier.rows[0]));
    assert.equal((await loc(pierId))!.active, false);
    assert.equal((await loc(pierId))!.id, pierId);
    const pierAgain = await root.query(deactivateSql, [provider, pierId]);
    assert.equal(pierAgain.rows[0]!.fleet_outcome, "unchanged");
    const pierAssess = await root.query<{ a: { feasible?: boolean; rejections?: string[] } }>(
      `select public.sbg_assess_capacity(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-08-03'::date, '11:00'::time, 2, 1, null, null, null
       ) as a`,
      [provider, hotel, airport, pierId],
    );
    assert.equal(pierAssess.rows[0]!.a.feasible, false);
    assert.deepEqual(pierAssess.rows[0]!.a.rejections, ["not_found"]);

    await root.query(`select public.sbg_capacity_settle($1::uuid, 'confirm')`, [held]);
    const confirmed = await shot([held]);
    assert.equal(confirmed[0]!.lifecycle_state, "confirmed_paid");
    const closeConfirmed = await root.query(deactivateSql, [provider, door]);
    assert.equal(closeConfirmed.rows[0]!.fleet_rejection, "location_in_use");
    assert.equal((await loc(door))!.active, true);
    assert.deepEqual(await shot([held]), confirmed);
    assert.deepEqual(await itinerary(held), itineraryBefore);

    const gate = await root.query(insertSql, [provider, "airport", null, "gate", "Processing Gate"]);
    assert.equal(gate.rows[0]!.fleet_outcome, "inserted", JSON.stringify(gate.rows[0]));
    const gateId = gate.rows[0]!.fleet_location_id as string;
    await place(airport, gateId);
    const processingId = await booking("2026-08-04");
    const processingReserved = await root.query(reserveSql, [processingId, airport, gateId, van]);
    assert.equal(processingReserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(processingReserved.rows[0]));
    await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
    try {
      const labeled = await root.query(
        `update public.bookings
            set lifecycle_state = 'payment_processing'
          where id = $1::uuid
            and capacity_managed is true
            and vehicle_id is not null
            and cancelled_at is null
            and not isempty(occupies)
            and lifecycle_state = 'awaiting_payment'
          returning id`,
        [processingId],
      );
      assert.equal(labeled.rowCount, 1);
    } finally {
      await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    }
    const processingBefore = await shot([processingId]);
    assert.equal(processingBefore[0]!.lifecycle_state, "payment_processing");
    assert.equal(processingBefore[0]!.capacity_managed, true);
    assert.equal(processingBefore[0]!.vehicle_id, van);
    const processingItinerary = await itinerary(processingId);
    const paymentsBefore = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_booking_payments where booking_id = $1::uuid`,
      [processingId],
    );
    const closeGate = await root.query(deactivateSql, [provider, gateId]);
    assert.equal(closeGate.rows[0]!.fleet_outcome, "rejected", JSON.stringify(closeGate.rows[0]));
    assert.equal(closeGate.rows[0]!.fleet_rejection, "location_in_use");
    assert.equal((await loc(gateId))!.active, true);
    assert.deepEqual(await shot([processingId]), processingBefore);
    assert.deepEqual(await itinerary(processingId), processingItinerary);
    const paymentsAfter = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_booking_payments where booking_id = $1::uuid`,
      [processingId],
    );
    assert.equal(paymentsAfter.rows[0]!.n, paymentsBefore.rows[0]!.n);
    try {
      await root.query("begin");
      await root.query(
        `update bookings set lifecycle_state = 'awaiting_payment' where id = $1::uuid`,
        [processingId],
      );
      await root.query("rollback");
      assert.fail("capacity guard should reject a direct lifecycle rewrite");
    } catch (err) {
      await root.query("rollback");
      assert.equal((err as { code?: string }).code, "42501");
    }

    const legacy = await booking("2026-08-05");
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [legacy, legacyVan]);
    const legacyStop = await root.query(insertSql, [provider, "airport", null, "legacy", "Legacy Stop"]);
    assert.equal(legacyStop.rows[0]!.fleet_outcome, "inserted");
    const legacyStopId = legacyStop.rows[0]!.fleet_location_id as string;
    await place(airport, legacyStopId);
    const legacyBefore = await shot([legacy]);
    assert.equal(legacyBefore[0]!.vehicle_id, legacyVan);
    assert.equal(legacyBefore[0]!.capacity_managed, false);
    assert.equal((await itinerary(legacy)).length, 0);
    const closeLegacy = await root.query(deactivateSql, [provider, legacyStopId]);
    assert.equal(closeLegacy.rows[0]!.fleet_outcome, "updated", JSON.stringify(closeLegacy.rows[0]));
    assert.equal((await loc(legacyStopId))!.active, false);
    assert.deepEqual(await shot([legacy]), legacyBefore);
    const legacyRoutes = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_fleet_routes
        where destination_location_id = $1::uuid`,
      [legacyStopId],
    );
    assert.equal(legacyRoutes.rows[0]!.n, 1);

    const other = await root.query(insertSql, [otherProvider, "airport", null, "oth", "Other Airport"]);
    assert.equal(other.rows[0]!.fleet_outcome, "inserted");
    const otherId = other.rows[0]!.fleet_location_id as string;
    assert.equal((await loc(otherId))!.provider_id, otherProvider);
    assert.equal((await loc(door))!.name, "Renamed Door");
    const crossRename = await root.query(renameSql, [otherProvider, door, "Stolen Door"]);
    assert.equal(crossRename.rows[0]!.fleet_outcome, "not_found");
    assert.equal((await loc(door))!.name, "Renamed Door");
    assert.equal((await loc(door))!.provider_id, provider);
    const crossClose = await root.query(deactivateSql, [otherProvider, door]);
    assert.equal(crossClose.rows[0]!.fleet_outcome, "not_found");
    assert.equal((await loc(door))!.active, true);
    const ourCount = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_fleet_locations where provider_id = $1::uuid`,
      [provider],
    );
    const otherCount = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_fleet_locations where provider_id = $1::uuid`,
      [otherProvider],
    );
    assert.equal(otherCount.rows[0]!.n, 1);
    assert.ok(ourCount.rows[0]!.n >= 4);

    const directUpdate = await asRole(
      "aether_runtime",
      `update sbg_fleet_locations set name = 'Nope' where id = $1::uuid`,
      [door],
    );
    assert.equal(directUpdate.ok, false);
    if (!directUpdate.ok) assert.equal(directUpdate.code, "42501");
    const directDelete = await asRole(
      "aether_app",
      `delete from sbg_fleet_locations where id = $1::uuid`,
      [pierId],
    );
    assert.equal(directDelete.ok, false);
    if (!directDelete.ok) assert.equal(directDelete.code, "42501");
    const directInsert = await asRole(
      "aether_app",
      `insert into sbg_fleet_locations (provider_id, kind, code, name) values ($1::uuid, 'airport', 'app', 'App')`,
      [provider],
    );
    assert.equal(directInsert.ok, false);
    if (!directInsert.ok) assert.equal(directInsert.code, "42501");
    const appExecute = await asRole("aether_app", insertSql, [provider, "airport", null, "appier", "App Pier"]);
    assert.equal(appExecute.ok, true);
    const gateway = await asRole("aether_payment_gateway", deactivateSql, [provider, door]);
    assert.equal(gateway.ok, false);
    if (!gateway.ok) assert.equal(gateway.code, "42501");
    const writerReserve = await asRole("sbg_fleet_writer", reserveSql, [held, airport, door, van]);
    assert.equal(writerReserve.ok, false);
    if (!writerReserve.ok) assert.equal(writerReserve.code, "42501");
    const writerConfirm = await asRole(
      "sbg_fleet_writer",
      `select public.sbg_capacity_settle($1::uuid, 'confirm')`,
      [held],
    );
    assert.equal(writerConfirm.ok, false);
    if (!writerConfirm.ok) assert.equal(writerConfirm.code, "42501");
    const privileges = await root.query<{
      del: boolean;
      code_upd: boolean;
      name_upd: boolean;
      active_upd: boolean;
      app_lock: boolean;
      app_writer: boolean;
      public_writer: boolean;
      no_delete_fn: number;
    }>(
      `select has_table_privilege('sbg_fleet_writer', 'public.sbg_fleet_locations', 'DELETE') as del,
              has_column_privilege('sbg_fleet_writer', 'public.sbg_fleet_locations', 'code', 'UPDATE') as code_upd,
              has_column_privilege('sbg_fleet_writer', 'public.sbg_fleet_locations', 'name', 'UPDATE') as name_upd,
              has_column_privilege('sbg_fleet_writer', 'public.sbg_fleet_locations', 'active', 'UPDATE') as active_upd,
              has_function_privilege('aether_app', 'public.sbg_fleet_lock_location(uuid)', 'execute') as app_lock,
              has_function_privilege('aether_app', 'public.sbg_fleet_deactivate_location(uuid, uuid)', 'execute') as app_writer,
              has_function_privilege('public', 'public.sbg_fleet_deactivate_location(uuid, uuid)', 'execute') as public_writer,
              (select count(*)::int from pg_proc where proname = 'sbg_fleet_delete_location') as no_delete_fn`,
    );
    assert.equal(privileges.rows[0]!.del, false);
    assert.equal(privileges.rows[0]!.code_upd, false);
    assert.equal(privileges.rows[0]!.name_upd, true);
    assert.equal(privileges.rows[0]!.active_upd, true);
    assert.equal(privileges.rows[0]!.app_lock, false);
    assert.equal(privileges.rows[0]!.app_writer, true);
    assert.equal(privileges.rows[0]!.public_writer, false);
    assert.equal(privileges.rows[0]!.no_delete_fn, 0);
    const acls = await root.query<{ proname: string; acl: string | null }>(
      `select proname, proacl::text as acl
         from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in (
            'sbg_fleet_insert_location',
            'sbg_fleet_rename_location',
            'sbg_fleet_deactivate_location',
            'sbg_fleet_lock_location'
          )`,
    );
    assert.equal(acls.rowCount, 4);
    for (const row of acls.rows) {
      assert.ok(row.acl, row.proname);
      const publicGrant = row.acl!.replace(/[{}]/g, "").split(",").some((entry) => entry.startsWith("="));
      assert.equal(publicGrant, false, `${row.proname} ${row.acl}`);
    }

    const raceStop = await root.query(insertSql, [provider, "airport", null, "race", "Race Stop"]);
    const raceStopId = raceStop.rows[0]!.fleet_location_id as string;
    await place(airport, raceStopId);
    const raceBooking = await booking("2026-08-11");
    await left.query("begin");
    const openHold = await left.query(reserveSql, [raceBooking, airport, raceStopId, raceVan]);
    assert.equal(openHold.rows[0]!.reserve_outcome, "reserved", JSON.stringify(openHold.rows[0]));
    await right.query("begin");
    const started = Date.now();
    const busy = await right.query(deactivateSql, [provider, raceStopId]);
    const waited = Date.now() - started;
    assert.equal(busy.rows[0]!.fleet_outcome, "rejected", JSON.stringify(busy.rows[0]));
    assert.equal(busy.rows[0]!.fleet_rejection, "lock_busy");
    assert.ok(waited >= 1500 && waited < 8000, String(waited));
    assert.equal((await loc(raceStopId))!.active, true);
    await right.query("rollback");
    assert.equal((await loc(raceStopId))!.active, true);
    await left.query("commit");
    const afterHold = await root.query(deactivateSql, [provider, raceStopId]);
    assert.equal(afterHold.rows[0]!.fleet_rejection, "location_in_use");
    assert.equal((await loc(raceStopId))!.active, true);
    assert.equal((await shot([raceBooking]))[0]!.vehicle_id, raceVan);
    assert.deepEqual(await itinerary(raceBooking), [
      { origin_location_id: airport, destination_location_id: raceStopId },
    ]);

    const quietStop = await root.query(insertSql, [provider, "airport", null, "quiet", "Quiet Stop"]);
    const quietStopId = quietStop.rows[0]!.fleet_location_id as string;
    await place(airport, quietStopId);
    const quietBooking = await booking("2026-08-12");
    await left.query("begin");
    const openEdit = await left.query(deactivateSql, [provider, quietStopId]);
    assert.equal(openEdit.rows[0]!.fleet_outcome, "updated", JSON.stringify(openEdit.rows[0]));
    await right.query("begin");
    await right.query("set local lock_timeout = '1500ms'");
    try {
      await right.query(reserveSql, [quietBooking, airport, quietStopId, raceVan]);
      assert.fail("reservation should wait on the open deactivation");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "55P03", (err as Error).message);
    } finally {
      await right.query("rollback");
    }
    assert.equal((await shot([quietBooking]))[0]!.vehicle_id, null);
    await left.query("commit");
    assert.equal((await loc(quietStopId))!.active, false);
    const afterEdit = await root.query(reserveSql, [quietBooking, airport, quietStopId, raceVan]);
    assert.equal(afterEdit.rows[0]!.reserve_outcome, "unavailable", JSON.stringify(afterEdit.rows[0]));
    assert.equal(afterEdit.rows[0]!.reserve_rejection, "not_found");
    assert.equal((await shot([quietBooking]))[0]!.vehicle_id, null);
    assert.equal((await itinerary(quietBooking)).length, 0);
  } finally {
    await left.end().catch(() => undefined);
    await right.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
});
