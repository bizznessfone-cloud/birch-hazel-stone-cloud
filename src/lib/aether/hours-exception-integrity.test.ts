/**
 * Gate 2 Stage 5D. Disposable PostgreSQL through the latest migration.
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

test("stage 5D source reuses the fleet writer and does not open checkout", () => {
  const files = migrationFiles();
  assert.equal(files.at(-1), "0074_gate2_location_integrity.sql");
  assert.equal(files.includes("0073_gate2_hours_exception_integrity.sql"), true);
  assert.equal(files.includes("0072_gate2_route_reposition_integrity.sql"), true);
  const sql = readFileSync(new URL("0073_gate2_hours_exception_integrity.sql", MIGRATIONS), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  const booking = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
  assert.equal(preflight.includes("0073_gate2_hours_exception_integrity.sql"), false);
  assert.equal(preflight.includes("0074_gate2_location_integrity.sql"), false);
  assert.equal(preflight.includes("AUTHORISED_PENDING = []"), true);
  assert.match(sql, /sbg_fleet_writer/);
  assert.doesNotMatch(sql, /create role /);
  assert.match(sql, /hashtextextended\(vehicle_id::text, 20260302\)/);
  assert.match(sql, /That hole is not closed/);
  assert.match(sql, /missing exception is not a closed day/);
  assert.match(sql, /revoke sbg_fleet_writer from current_user/);
  assert.doesNotMatch(sql, /grant sbg_fleet_writer to aether_/);
  assert.doesNotMatch(sql, /grant execute on function public\.sbg_reserve_capacity/);
  assert.doesNotMatch(sql, /create or replace function public\.sbg_reserve_capacity/);
  assert.doesNotMatch(sql, /^\s*commit\s*;/im);
  assert.match(booking, /openFreshHold/);
  assert.doesNotMatch(booking, /sbg_fleet_upsert_hours/);
  assert.doesNotMatch(booking, /sbg_reserve_capacity/);
});

test("hours and exception integrity, DST boundaries, and two-session races", { timeout: 180_000 }, async () => {
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
       values ('s5d', 'Hours Hotel', 'Europe/Athens', $1::uuid) returning id`,
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
      `insert into providers (code, name, kind) values ('s5dp', 'Hours Provider', 'in_house') returning id`,
    )).rows[0]!.id;
    const otherProvider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s5do', 'Other Hours', 'external') returning id`,
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
       values ('Hours Van', 7, 4, true, $1::uuid, $1::uuid) returning id`,
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
        [hotel, provider, date, time, minutes, `S5D-${n}`, `token-s5d-${n}`],
      )).rows[0]!.id;
    }
    async function dow(date: string): Promise<number> {
      return (await root.query<{ d: number }>(
        `select extract(isodow from $1::date)::int as d`,
        [date],
      )).rows[0]!.d;
    }
    const hoursSql = `select * from public.sbg_fleet_upsert_hours($1::uuid, $2::int, $3::time, $4::time)`;
    const clearHoursSql = `select * from public.sbg_fleet_clear_hours($1::uuid, $2::int)`;
    const exceptionSql = `select * from public.sbg_fleet_upsert_hour_exception($1::uuid, $2::date, $3::boolean, $4::time, $5::time)`;
    const clearExceptionSql = `select * from public.sbg_fleet_clear_hour_exception($1::uuid, $2::date)`;
    const reserveSql = `select * from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`;
    async function shot(ids: string[]) {
      return (await root.query(
        `select id::text, vehicle_id::text, lifecycle_state, duration_minutes, occupies::text
           from bookings where id = any($1::uuid[]) order by id`,
        [ids],
      )).rows;
    }
    async function hoursRow(isodow: number) {
      return (await root.query<{ opens_local: string; closes_local: string }>(
        `select opens_local::text, closes_local::text
           from sbg_provider_hours
          where provider_id = $1::uuid and isodow = $2`,
        [provider, isodow],
      )).rows[0];
    }
    async function exceptionRow(date: string) {
      return (await root.query<{ closed: boolean; opens_local: string | null; closes_local: string | null }>(
        `select closed, opens_local::text, closes_local::text
           from sbg_provider_hour_exceptions
          where provider_id = $1::uuid and service_date = $2::date`,
        [provider, date],
      )).rows[0];
    }
    async function assess(date: string, time: string) {
      const row = await root.query<{ a: { rejections?: string[]; feasible?: boolean } }>(
        `select public.sbg_assess_capacity(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::time, 2, 1, null, null, null
         ) as a`,
        [provider, hotel, airport, door, date, time],
      );
      return row.rows[0]!.a;
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

    const holdDate = "2026-07-01";
    const holdDow = await dow(holdDate);
    const same = await root.query(hoursSql, [provider, holdDow, "08:00", "20:00"]);
    assert.equal(same.rows[0]!.fleet_outcome, "unchanged");
    const missing = await assess(holdDate, "10:00");
    assert.equal(missing.feasible, true, JSON.stringify(missing.rejections));
    assert.equal(await exceptionRow(holdDate), undefined);

    const held = await booking(holdDate, "10:00");
    const reserved = await root.query(reserveSql, [held, airport, door, van]);
    assert.equal(reserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(reserved.rows[0]));
    assert.equal(reserved.rows[0]!.reserve_duration_minutes, 45);
    const before = await shot([held]);
    const narrow = await root.query(hoursSql, [provider, holdDow, "11:00", "20:00"]);
    assert.equal(narrow.rows[0]!.fleet_outcome, "rejected", JSON.stringify(narrow.rows[0]));
    assert.equal(narrow.rows[0]!.fleet_rejection, "outside_hours");
    assert.deepEqual(await hoursRow(holdDow), { opens_local: "08:00:00", closes_local: "20:00:00" });
    assert.deepEqual(await shot([held]), before);
    const widened = await root.query(hoursSql, [provider, holdDow, "07:00", "21:00"]);
    assert.equal(widened.rows[0]!.fleet_outcome, "updated", JSON.stringify(widened.rows[0]));
    assert.deepEqual(await shot([held]), before);
    const openExact = await root.query(hoursSql, [provider, holdDow, "10:00", "21:00"]);
    assert.equal(openExact.rows[0]!.fleet_outcome, "updated", JSON.stringify(openExact.rows[0]));
    const closeExact = await root.query(hoursSql, [provider, holdDow, "10:00", "10:45"]);
    assert.equal(closeExact.rows[0]!.fleet_outcome, "updated", JSON.stringify(closeExact.rows[0]));
    assert.deepEqual(await shot([held]), before);
    const openLate = await root.query(hoursSql, [provider, holdDow, "10:01", "10:45"]);
    assert.equal(openLate.rows[0]!.fleet_rejection, "outside_hours");
    const closeEarly = await root.query(hoursSql, [provider, holdDow, "10:00", "10:44"]);
    assert.equal(closeEarly.rows[0]!.fleet_rejection, "outside_hours");
    assert.deepEqual(await hoursRow(holdDow), { opens_local: "10:00:00", closes_local: "10:45:00" });
    assert.deepEqual(await shot([held]), before);
    const invalid = await root.query(hoursSql, [provider, holdDow, "10:00", "10:00"]);
    assert.equal(invalid.rows[0]!.fleet_outcome, "invalid");
    assert.equal(invalid.rows[0]!.fleet_rejection, "invalid_window");

    await root.query(`select public.sbg_capacity_settle($1::uuid, 'confirm')`, [held]);
    const confirmed = await shot([held]);
    assert.equal(confirmed[0]!.lifecycle_state, "confirmed_paid");
    const closed = await root.query(exceptionSql, [provider, holdDate, true, null, null]);
    assert.equal(closed.rows[0]!.fleet_outcome, "rejected", JSON.stringify(closed.rows[0]));
    assert.equal(closed.rows[0]!.fleet_rejection, "outside_hours");
    assert.equal(await exceptionRow(holdDate), undefined);
    assert.deepEqual(await shot([held]), confirmed);
    const widerException = await root.query(exceptionSql, [provider, holdDate, false, "09:00", "12:00"]);
    assert.equal(widerException.rows[0]!.fleet_outcome, "inserted", JSON.stringify(widerException.rows[0]));
    const shorterException = await root.query(exceptionSql, [provider, holdDate, false, "10:30", "18:00"]);
    assert.equal(shorterException.rows[0]!.fleet_rejection, "outside_hours");
    assert.deepEqual(await exceptionRow(holdDate), { closed: false, opens_local: "09:00:00", closes_local: "12:00:00" });
    const repeatException = await root.query(exceptionSql, [provider, holdDate, false, "09:00", "12:00"]);
    assert.equal(repeatException.rows[0]!.fleet_outcome, "unchanged");
    assert.deepEqual(await shot([held]), confirmed);
    const weekdayBehindException = await root.query(hoursSql, [provider, holdDow, "12:00", "18:00"]);
    assert.equal(weekdayBehindException.rows[0]!.fleet_outcome, "updated", JSON.stringify(weekdayBehindException.rows[0]));
    const clearBlocked = await root.query(clearExceptionSql, [provider, holdDate]);
    assert.equal(clearBlocked.rows[0]!.fleet_outcome, "rejected", JSON.stringify(clearBlocked.rows[0]));
    assert.equal(clearBlocked.rows[0]!.fleet_rejection, "outside_hours");
    assert.equal((await exceptionRow(holdDate))!.opens_local, "09:00:00");
    assert.deepEqual(await shot([held]), confirmed);
    const missingClear = await root.query(clearExceptionSql, [provider, "2026-07-02"]);
    assert.equal(missingClear.rows[0]!.fleet_outcome, "not_found");

    const nightDate = "2026-07-10";
    const night = await root.query(exceptionSql, [provider, nightDate, false, "22:00", "06:00"]);
    assert.equal(night.rows[0]!.fleet_outcome, "inserted", JSON.stringify(night.rows[0]));
    const overnight = await booking(nightDate, "23:30");
    const overnightReserved = await root.query(reserveSql, [overnight, airport, door, van]);
    assert.equal(overnightReserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(overnightReserved.rows[0]));
    const overnightBefore = await shot([overnight]);
    const cutMidnight = await root.query(exceptionSql, [provider, nightDate, false, "22:00", "00:00"]);
    assert.equal(cutMidnight.rows[0]!.fleet_rejection, "outside_hours", JSON.stringify(cutMidnight.rows[0]));
    assert.deepEqual(await exceptionRow(nightDate), { closed: false, opens_local: "22:00:00", closes_local: "06:00:00" });
    assert.deepEqual(await shot([overnight]), overnightBefore);
    const stillCrosses = await root.query(exceptionSql, [provider, nightDate, false, "22:00", "00:15"]);
    assert.equal(stillCrosses.rows[0]!.fleet_outcome, "updated", JSON.stringify(stillCrosses.rows[0]));
    assert.equal((await shot([overnight]))[0]!.duration_minutes, 45);

    const tailDate = "2026-07-16";
    const morningDate = "2026-07-17";
    const tail = await root.query(exceptionSql, [provider, tailDate, false, "22:00", "06:00"]);
    assert.equal(tail.rows[0]!.fleet_outcome, "inserted", JSON.stringify(tail.rows[0]));
    const early = await booking(morningDate, "05:00");
    const earlyReserved = await root.query(reserveSql, [early, airport, door, van]);
    assert.equal(earlyReserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(earlyReserved.rows[0]));
    const earlyBefore = await shot([early]);
    const closeMorning = await root.query(exceptionSql, [provider, morningDate, true, null, null]);
    assert.equal(closeMorning.rows[0]!.fleet_outcome, "inserted", JSON.stringify(closeMorning.rows[0]));
    assert.equal((await exceptionRow(morningDate))!.closed, true);
    assert.deepEqual(await shot([early]), earlyBefore);
    const daytime = await booking(morningDate, "10:00");
    const daytimeReserved = await root.query(reserveSql, [daytime, airport, door, van]);
    assert.equal(daytimeReserved.rows[0]!.reserve_outcome, "unavailable", JSON.stringify(daytimeReserved.rows[0]));
    assert.equal((await shot([daytime]))[0]!.vehicle_id, null);

    const legacyDate = "2026-07-06";
    const legacyDow = await dow(legacyDate);
    const legacy = await booking(legacyDate, "09:00", 45);
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [legacy, legacyVan]);
    const later = await booking(legacyDate, "12:00");
    const laterReserved = await root.query(reserveSql, [later, airport, door, van]);
    assert.equal(laterReserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(laterReserved.rows[0]));
    const legacyBefore = await shot([legacy, later]);
    const narrowPastLegacy = await root.query(hoursSql, [provider, legacyDow, "11:00", "20:00"]);
    assert.equal(narrowPastLegacy.rows[0]!.fleet_outcome, "updated", JSON.stringify(narrowPastLegacy.rows[0]));
    assert.deepEqual(await shot([legacy, later]), legacyBefore);

    const gap = await assess("2026-03-29", "03:30");
    assert.deepEqual(gap.rejections, ["time_nonexistent"]);
    const fold = await assess("2026-10-25", "03:30");
    assert.deepEqual(fold.rejections, ["time_ambiguous"]);
    assert.equal((await shot([held]))[0]!.occupies, confirmed[0]!.occupies);

    const springDate = "2026-03-29";
    const autumnDate = "2026-10-25";
    const sundayDow = await dow(springDate);
    assert.equal(sundayDow, 7);
    assert.equal(await dow(autumnDate), 7);
    const sundayHours = await hoursRow(sundayDow);
    const gapStored = await root.query(exceptionSql, [provider, springDate, false, "03:30", "12:00"]);
    assert.equal(gapStored.rows[0]!.fleet_outcome, "inserted", JSON.stringify(gapStored.rows[0]));
    assert.deepEqual(await exceptionRow(springDate), {
      closed: false,
      opens_local: "03:30:00",
      closes_local: "12:00:00",
    });
    const gapEarly = await assess(springDate, "04:00");
    assert.equal(gapEarly.feasible, false, JSON.stringify(gapEarly.rejections));
    assert.deepEqual(gapEarly.rejections, ["outside_hours"]);
    const gapMidday = await assess(springDate, "10:00");
    assert.equal(gapMidday.feasible, false, JSON.stringify(gapMidday.rejections));
    const gapCleared = await root.query(clearExceptionSql, [provider, springDate]);
    assert.equal(gapCleared.rows[0]!.fleet_outcome, "deleted", JSON.stringify(gapCleared.rows[0]));
    assert.equal((await assess(springDate, "10:00")).feasible, true);
    const foldStored = await root.query(exceptionSql, [provider, autumnDate, false, "03:30", "12:00"]);
    assert.equal(foldStored.rows[0]!.fleet_outcome, "inserted", JSON.stringify(foldStored.rows[0]));
    assert.equal((await exceptionRow(autumnDate))!.opens_local, "03:30:00");
    const foldEarly = await assess(autumnDate, "04:00");
    assert.equal(foldEarly.feasible, false, JSON.stringify(foldEarly.rejections));
    assert.deepEqual(foldEarly.rejections, ["outside_hours"]);
    const foldCleared = await root.query(clearExceptionSql, [provider, autumnDate]);
    assert.equal(foldCleared.rows[0]!.fleet_outcome, "deleted", JSON.stringify(foldCleared.rows[0]));
    assert.equal(await exceptionRow(autumnDate), undefined);
    const springHeld = await booking(springDate, "10:00");
    const springReserved = await root.query(reserveSql, [springHeld, airport, door, van]);
    assert.equal(springReserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(springReserved.rows[0]));
    const springBefore = await shot([springHeld]);
    const gapWindow = await root.query(hoursSql, [provider, sundayDow, "03:30", "20:00"]);
    assert.equal(gapWindow.rows[0]!.fleet_outcome, "rejected", JSON.stringify(gapWindow.rows[0]));
    assert.equal(gapWindow.rows[0]!.fleet_rejection, "outside_hours");
    assert.deepEqual(await hoursRow(sundayDow), sundayHours);
    const gapAgain = await root.query(exceptionSql, [provider, springDate, false, "03:30", "12:00"]);
    assert.equal(gapAgain.rows[0]!.fleet_rejection, "outside_hours");
    assert.equal(await exceptionRow(springDate), undefined);
    assert.deepEqual(await shot([springHeld]), springBefore);
    const autumnHeld = await booking(autumnDate, "10:00");
    const autumnReserved = await root.query(reserveSql, [autumnHeld, airport, door, van]);
    assert.equal(autumnReserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(autumnReserved.rows[0]));
    const autumnBefore = await shot([autumnHeld]);
    const foldWindow = await root.query(hoursSql, [provider, sundayDow, "03:30", "20:00"]);
    assert.equal(foldWindow.rows[0]!.fleet_rejection, "outside_hours");
    const foldAgain = await root.query(exceptionSql, [provider, autumnDate, false, "03:30", "12:00"]);
    assert.equal(foldAgain.rows[0]!.fleet_rejection, "outside_hours");
    assert.equal(await exceptionRow(autumnDate), undefined);
    assert.deepEqual(await hoursRow(sundayDow), sundayHours);
    assert.deepEqual(await shot([autumnHeld]), autumnBefore);
    assert.equal((await assess(springDate, "04:00")).feasible, false);

    const payDate = "2026-07-04";
    const payDow = await dow(payDate);
    assert.equal(payDow, 6);
    const payHoursBefore = await hoursRow(payDow);
    const processingId = await booking(payDate, "10:00");
    const processingReserved = await root.query(reserveSql, [processingId, airport, door, van]);
    assert.equal(processingReserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(processingReserved.rows[0]));
    // The capacity guard admits awaiting_payment and confirmed_paid. It does not
    // admit a move to payment_processing. This disposable label is the CHECK-legal
    // state the hours predicate must still protect. The guard is back on before
    // any schedule write.
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
          returning id::text`,
        [processingId],
      );
      assert.equal(labeled.rowCount, 1);
    } finally {
      await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    }
    try {
      await root.query("begin");
      await root.query(
        `update public.bookings set lifecycle_state = 'awaiting_payment' where id = $1::uuid`,
        [processingId],
      );
      await root.query("rollback");
      assert.fail("capacity guard should reject a direct lifecycle rewrite");
    } catch (err) {
      await root.query("rollback");
      assert.equal((err as { code?: string }).code, "42501");
    }
    const processingBefore = await shot([processingId]);
    assert.equal(processingBefore[0]!.lifecycle_state, "payment_processing");
    assert.equal(processingBefore[0]!.vehicle_id, van);
    assert.match(String(processingBefore[0]!.occupies), /\[/);
    const processingFacts = await root.query<{ capacity_managed: boolean; empty: boolean }>(
      `select capacity_managed, isempty(occupies) as empty from bookings where id = $1::uuid`,
      [processingId],
    );
    assert.equal(processingFacts.rows[0]!.capacity_managed, true);
    assert.equal(processingFacts.rows[0]!.empty, false);
    const itineraryBefore = await root.query(
      `select origin_location_id::text, destination_location_id::text
         from sbg_booking_itinerary where booking_id = $1::uuid`,
      [processingId],
    );
    assert.deepEqual(itineraryBefore.rows, [{
      origin_location_id: airport,
      destination_location_id: door,
    }]);
    const paymentsBefore = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_booking_payments where booking_id = $1::uuid`,
      [processingId],
    );
    const narrowProcessing = await root.query(hoursSql, [provider, payDow, "11:00", "20:00"]);
    assert.equal(narrowProcessing.rows[0]!.fleet_outcome, "rejected", JSON.stringify(narrowProcessing.rows[0]));
    assert.equal(narrowProcessing.rows[0]!.fleet_rejection, "outside_hours");
    assert.deepEqual(await hoursRow(payDow), payHoursBefore);
    const closeProcessing = await root.query(exceptionSql, [provider, payDate, true, null, null]);
    assert.equal(closeProcessing.rows[0]!.fleet_outcome, "rejected", JSON.stringify(closeProcessing.rows[0]));
    assert.equal(closeProcessing.rows[0]!.fleet_rejection, "outside_hours");
    assert.equal(await exceptionRow(payDate), undefined);
    assert.deepEqual(await shot([processingId]), processingBefore);
    const itineraryAfter = await root.query(
      `select origin_location_id::text, destination_location_id::text
         from sbg_booking_itinerary where booking_id = $1::uuid`,
      [processingId],
    );
    assert.deepEqual(itineraryAfter.rows, itineraryBefore.rows);
    const paymentsAfter = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_booking_payments where booking_id = $1::uuid`,
      [processingId],
    );
    assert.equal(paymentsAfter.rows[0]!.n, paymentsBefore.rows[0]!.n);

    const otherHours = await root.query(hoursSql, [otherProvider, 1, "09:00", "17:00"]);
    assert.equal(otherHours.rows[0]!.fleet_outcome, "inserted");
    assert.equal((await hoursRow(legacyDow))!.opens_local, "11:00:00");
    const otherCount = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_provider_hours where provider_id = $1::uuid`,
      [provider],
    );
    assert.equal(otherCount.rows[0]!.n, 7);
    const direct = await asRole(
      "aether_runtime",
      `update sbg_provider_hours set opens_local = '06:00' where provider_id = $1::uuid and isodow = 1`,
      [provider],
    );
    assert.equal(direct.ok, false);
    if (!direct.ok) assert.equal(direct.code, "42501");
    const directDelete = await asRole(
      "aether_app",
      `delete from sbg_provider_hour_exceptions where provider_id = $1::uuid`,
      [provider],
    );
    assert.equal(directDelete.ok, false);
    if (!directDelete.ok) assert.equal(directDelete.code, "42501");
    const gateway = await asRole(
      "aether_payment_gateway",
      hoursSql,
      [provider, 1, "08:00", "20:00"],
    );
    assert.equal(gateway.ok, false);
    if (!gateway.ok) assert.equal(gateway.code, "42501");
    const writerReserve = await asRole("sbg_fleet_writer", reserveSql, [daytime, airport, door, van]);
    assert.equal(writerReserve.ok, false);
    if (!writerReserve.ok) assert.equal(writerReserve.code, "42501");
    const writerSettle = await asRole(
      "sbg_fleet_writer",
      `select public.sbg_capacity_settle($1::uuid, 'expire')`,
      [later],
    );
    assert.equal(writerSettle.ok, false);
    if (!writerSettle.ok) assert.equal(writerSettle.code, "42501");
    const writerConfirm = await asRole(
      "sbg_fleet_writer",
      `select public.sbg_capacity_settle($1::uuid, 'confirm')`,
      [held],
    );
    assert.equal(writerConfirm.ok, false);
    if (!writerConfirm.ok) assert.equal(writerConfirm.code, "42501");
    const publicAcl = await root.query<{ proname: string; acl: string | null }>(
      `select proname, proacl::text as acl
         from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in (
            'sbg_fleet_upsert_hours',
            'sbg_fleet_clear_hours',
            'sbg_fleet_upsert_hour_exception',
            'sbg_fleet_clear_hour_exception',
            'sbg_fleet_hours_blocked',
            'sbg_fleet_lock_hours',
            'sbg_fleet_lock_hour_exception'
          )`,
    );
    assert.equal(publicAcl.rowCount, 7);
    for (const row of publicAcl.rows) {
      assert.ok(row.acl, row.proname);
      const publicEntry = row.acl!.replace(/[{}]/g, "").split(",").some((entry) => entry.startsWith("="));
      assert.equal(publicEntry, false, `${row.proname} ${row.acl}`);
    }
    const cleared = await root.query(clearHoursSql, [provider, 8]);
    assert.equal(cleared.rows[0]!.fleet_outcome, "invalid");

    const raceDate = "2026-07-14";
    const raceDow = await dow(raceDate);
    const raceBefore = await hoursRow(raceDow);
    const raceBooking = await booking(raceDate, "10:00");
    await left.query("begin");
    const openHold = await left.query(reserveSql, [raceBooking, airport, door, raceVan]);
    assert.equal(openHold.rows[0]!.reserve_outcome, "reserved", JSON.stringify(openHold.rows[0]));
    await right.query("begin");
    const started = Date.now();
    const busy = await right.query(hoursSql, [provider, raceDow, "12:00", "20:00"]);
    const waited = Date.now() - started;
    assert.equal(busy.rows[0]!.fleet_outcome, "rejected");
    assert.equal(busy.rows[0]!.fleet_rejection, "lock_busy");
    assert.ok(waited >= 1500 && waited < 8000, String(waited));
    await right.query("rollback");
    assert.deepEqual(await hoursRow(raceDow), raceBefore);
    await left.query("commit");
    const afterHold = await root.query(hoursSql, [provider, raceDow, "12:00", "20:00"]);
    assert.equal(afterHold.rows[0]!.fleet_rejection, "outside_hours");
    assert.deepEqual(await hoursRow(raceDow), raceBefore);
    assert.equal((await shot([raceBooking]))[0]!.vehicle_id, raceVan);

    const quietDow = await dow("2026-07-12");
    const quietBefore = await hoursRow(quietDow);
    await left.query("begin");
    const openEdit = await left.query(hoursSql, [provider, quietDow, "07:00", "21:00"]);
    assert.equal(openEdit.rows[0]!.fleet_outcome, "updated", JSON.stringify(openEdit.rows[0]));
    const quietBooking = await booking("2026-07-12", "07:30");
    await right.query("begin");
    await right.query("set local lock_timeout = '1500ms'");
    try {
      await right.query(reserveSql, [quietBooking, airport, door, raceVan]);
      assert.fail("reservation should wait on the open hours edit");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "55P03", (err as Error).message);
    } finally {
      await right.query("rollback");
    }
    assert.equal((await shot([quietBooking]))[0]!.vehicle_id, null);
    await left.query("commit");
    assert.equal((await hoursRow(quietDow))!.opens_local, "07:00:00");
    const afterEdit = await root.query(reserveSql, [quietBooking, airport, door, raceVan]);
    assert.equal(afterEdit.rows[0]!.reserve_outcome, "reserved", JSON.stringify(afterEdit.rows[0]));
    assert.equal(afterEdit.rows[0]!.reserve_duration_minutes, 45);
    assert.notDeepEqual(await hoursRow(quietDow), quietBefore);
  } finally {
    await left.end().catch(() => undefined);
    await right.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
});
