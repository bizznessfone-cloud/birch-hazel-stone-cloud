/**
 * Gate 2 Stage 5B. Disposable PostgreSQL through migration 0071.
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

test("stage 5B source is additive and does not open checkout", () => {
  const files = migrationFiles();
  assert.equal(files.at(-1), "0071_gate2_vehicle_integrity.sql");
  assert.equal(files.includes("0070_gate2_isolated_payment_authority.sql"), true);
  const sql = readFileSync(new URL("0071_gate2_vehicle_integrity.sql", MIGRATIONS), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  const booking = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
  assert.equal(preflight.includes("0071_gate2_vehicle_integrity.sql"), false);
  assert.equal(preflight.includes("AUTHORISED_PENDING = []"), true);
  assert.match(sql, /create role sbg_fleet_writer/);
  assert.match(sql, /nologin/);
  assert.match(sql, /revoke sbg_fleet_writer from current_user/);
  assert.match(sql, /revoke sbg_capacity_writer from current_user/);
  assert.match(sql, /revoke update \(capacity, active\) on table public\.vehicles from aether_app/);
  assert.match(sql, /revoke update \(capacity, active\) on table public\.vehicles from aether_runtime/);
  assert.doesNotMatch(sql, /grant sbg_fleet_writer to aether_/);
  assert.doesNotMatch(sql, /grant sbg_capacity_writer to sbg_fleet_writer/);
  assert.doesNotMatch(sql, /grant sbg_fleet_writer to sbg_capacity_writer/);
  assert.doesNotMatch(sql, /grant execute on function public\.sbg_reserve_capacity/);
  assert.doesNotMatch(sql, /grant execute on function public\.sbg_capacity_settle/);
  assert.doesNotMatch(sql, /sbg_accept_verified_payment_event/);
  assert.doesNotMatch(sql, /^\s*commit\s*;/im);
  assert.match(booking, /openFreshHold/);
  assert.doesNotMatch(booking, /sbg_reserve_capacity/);
  assert.doesNotMatch(booking, /sbg_fleet_configure_vehicle/);
});

test("desk update uses the fleet writer when it exists and the old update otherwise", async () => {
  const { upsertVehicle, OpsDeskError } = await import("./ops-desk.ts");
  const scope = {
    operatorId: "op",
    login: "desk",
    sessionId: "s",
    membershipId: "m",
    accessClass: "provider_dispatcher" as const,
    hotelId: null,
    providerId: "11111111-1111-4111-8111-111111111111",
  };
  const calls: string[] = [];
  const fallback = {
    async query(text: string) {
      calls.push(text);
      if (text.includes("to_regprocedure")) return [{ present: false }];
      if (text.includes("update vehicles")) {
        return [{ id: "veh", name: "Van", capacity: 4, active: true }];
      }
      return [];
    },
  };
  const saved = await upsertVehicle(fallback, scope, { id: "veh", name: "Van", capacity: 4, active: true });
  assert.equal(saved.capacity, 4);
  assert.equal(calls.some((text) => text.includes("from public.sbg_fleet_configure_vehicle")), false);
  assert.equal(calls.some((text) => text.includes("update vehicles")), true);

  let writes = 0;
  const writer = {
    async query(text: string, params?: unknown[]) {
      if (text.includes("to_regprocedure")) return [{ present: true }];
      if (text.includes("sbg_fleet_configure_vehicle")) {
        writes += 1;
        assert.equal(params?.[0], scope.providerId);
        assert.equal(params?.[1], "veh");
        if (writes === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        return [{ fleet_outcome: "updated", fleet_rejection: null }];
      }
      if (text.includes("select id, name, capacity, active")) {
        return [{ id: "veh", name: "Van 2", capacity: 5, active: true }];
      }
      return [];
    },
  };
  const renamed = await upsertVehicle(writer, scope, { id: "veh", name: "Van 2", capacity: 5, active: true });
  assert.equal(renamed.name, "Van 2");
  assert.equal(writes, 2);

  const rejected = {
    async query(text: string) {
      if (text.includes("to_regprocedure")) return [{ present: true }];
      if (text.includes("sbg_fleet_configure_vehicle")) {
        return [{ fleet_outcome: "rejected", fleet_rejection: "seats" }];
      }
      return [];
    },
  };
  await assert.rejects(
    () => upsertVehicle(rejected, scope, { id: "veh", name: "Van", capacity: 1, active: true }),
    (err: unknown) => err instanceof OpsDeskError && err.code === "conflict" && err.status === 409,
  );
  const foreign = {
    async query(text: string) {
      if (text.includes("to_regprocedure")) return [{ present: true }];
      if (text.includes("sbg_fleet_configure_vehicle")) {
        return [{ fleet_outcome: "wrong_provider", fleet_rejection: "wrong_provider" }];
      }
      return [];
    },
  };
  await assert.rejects(
    () => upsertVehicle(foreign, scope, { id: "veh", name: "Van", capacity: 4, active: true }),
    (err: unknown) => err instanceof OpsDeskError && err.code === "not_found" && err.status === 404,
  );
  let exclusions = 0;
  const exclusion = {
    async query(text: string) {
      if (text.includes("to_regprocedure")) return [{ present: true }];
      if (text.includes("sbg_fleet_configure_vehicle")) {
        exclusions += 1;
        throw Object.assign(new Error("exclusion"), { code: "23P01" });
      }
      return [];
    },
  };
  await assert.rejects(() => upsertVehicle(exclusion, scope, { id: "veh", name: "Van", capacity: 4, active: true }));
  assert.equal(exclusions, 1);

  let timeouts = 0;
  const timedOut = {
    async query(text: string) {
      if (text.includes("to_regprocedure")) return [{ present: true }];
      if (text.includes("sbg_fleet_configure_vehicle")) {
        timeouts += 1;
        throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      }
      return [];
    },
  };
  await assert.rejects(
    () => upsertVehicle(timedOut, scope, { id: "veh", name: "Van", capacity: 4, active: true }),
    (err: unknown) =>
      err instanceof OpsDeskError &&
      err.code === "conflict" &&
      err.status === 409 &&
      err.message === "That vehicle is busy. Try again.",
  );
  assert.equal(timeouts, 1);
  const busyRow = {
    async query(text: string) {
      if (text.includes("to_regprocedure")) return [{ present: true }];
      if (text.includes("sbg_fleet_configure_vehicle")) {
        return [{ fleet_outcome: "rejected", fleet_rejection: "lock_busy" }];
      }
      return [];
    },
  };
  await assert.rejects(
    () => upsertVehicle(busyRow, scope, { id: "veh", name: "Van", capacity: 4, active: true }),
    (err: unknown) => err instanceof OpsDeskError && err.status === 409 && err.message === "That vehicle is busy. Try again.",
  );
});

test("vehicle integrity, maintenance, privileges, and two-session races", { timeout: 180_000 }, async () => {
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
          'sbg_fleet_insert_unavailability', 'sbg_fleet_configure_vehicle',
          'sbg_capacity_lock_vehicle', 'sbg_capacity_lock_scope', 'sbg_reserve_capacity', 'sbg_capacity_settle'
        )`,
    );
    const ownerOf = Object.fromEntries(owners.rows.map((row) => [row.proname, row.owner]));
    assert.equal(ownerOf.sbg_fleet_insert_unavailability, "sbg_fleet_writer");
    assert.equal(ownerOf.sbg_fleet_configure_vehicle, "sbg_fleet_writer");
    assert.equal(ownerOf.sbg_capacity_lock_vehicle, "sbg_capacity_writer");
    assert.equal(ownerOf.sbg_capacity_lock_scope, "postgres");
    assert.equal(ownerOf.sbg_reserve_capacity, "sbg_capacity_writer");
    assert.equal(ownerOf.sbg_capacity_settle, "sbg_capacity_writer");
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
       values ('s5', 'Stage Hotel', 'Europe/Athens', $1::uuid) returning id`,
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
      `insert into providers (code, name, kind) values ('s5p', 'Stage Provider', 'in_house') returning id`,
    )).rows[0]!.id;
    const otherProvider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s5o', 'Other Provider', 'external') returning id`,
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
    async function vehicle(name: string, owner: string): Promise<string> {
      return (await root.query<{ id: string }>(
        `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
         values ($1, 7, 4, true, $2::uuid, $2::uuid) returning id`,
        [name, owner],
      )).rows[0]!.id;
    }
    const van = await vehicle("Van", provider);
    const raceVan = await vehicle("Race", provider);
    const configVan = await vehicle("Config", provider);
    const foreign = await vehicle("Foreign", otherProvider);
    let n = 0;
    async function booking(date: string, time: string, passengers = 2, luggage = 1): Promise<string> {
      n += 1;
      return (await root.query<{ id: string }>(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, passenger_count, luggage_count,
           pickup_text, destination_text, human_reference, confirmation_token
         ) values (
           $1::uuid, $2::uuid, $3::date, $4::time, 60,
           'Ada', '+302100000000', 'ada@example.com', $5, $6,
           'Door', 'Airport', $7, $8
         ) returning id`,
        [hotel, provider, date, time, passengers, luggage, `S5-${n}`, `token-s5-${n}`],
      )).rows[0]!.id;
    }
    const reserveSql = `select * from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`;
    const blockSql = `select * from public.sbg_fleet_insert_unavailability($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5)`;
    const configSql = `select * from public.sbg_fleet_configure_vehicle($1::uuid, $2::uuid, $3::integer, $4::boolean, $5::integer, $6::boolean, $7)`;

    async function blocks(vehicleId: string): Promise<number> {
      const row = await root.query<{ n: number }>(
        `select count(*)::int as n from sbg_vehicle_unavailability where vehicle_id = $1::uuid`,
        [vehicleId],
      );
      return row.rows[0]!.n;
    }
    async function shot(ids: string[]) {
      const rows = await root.query(
        `select id::text, vehicle_id::text, lifecycle_state, capacity_managed,
                passenger_count, luggage_count, cancelled_at::text, occupies::text, duration_minutes
           from bookings
          where id = any($1::uuid[])
          order by id`,
        [ids],
      );
      return rows.rows;
    }
    async function vanRow(id: string) {
      return (await root.query<{ name: string; capacity: number; active: boolean; luggage: number | null }>(
        `select name, capacity, active, luggage_capacity as luggage from vehicles where id = $1::uuid`,
        [id],
      )).rows[0]!;
    }

    const previous = await booking("2026-06-03", "08:00");
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [previous, van]);
    await root.query(
      `insert into sbg_booking_itinerary (booking_id, origin_location_id, destination_location_id)
       values ($1::uuid, $2::uuid, $3::uuid)`,
      [previous, airport, door],
    );
    const held = await booking("2026-06-03", "10:00", 4, 3);
    const reserved = await root.query(reserveSql, [held, airport, door, van]);
    assert.equal(reserved.rows[0]!.reserve_outcome, "reserved", JSON.stringify(reserved.rows[0]));
    const before = await shot([previous, held]);

    const reposition = await root.query(blockSql, [provider, van, "2026-06-03T06:10:00Z", "2026-06-03T06:20:00Z", "maintenance"]);
    assert.equal(reposition.rows[0]!.fleet_outcome, "rejected", JSON.stringify(reposition.rows[0]));
    assert.equal(reposition.rows[0]!.fleet_rejection, "protected_booking");
    assert.equal(await blocks(van), 0);
    assert.deepEqual(await shot([previous, held]), before);

    const overlap = await root.query(blockSql, [provider, van, "2026-06-03T07:10:00Z", "2026-06-03T07:20:00Z", "unavailable"]);
    assert.equal(overlap.rows[0]!.fleet_outcome, "rejected");
    assert.equal(overlap.rows[0]!.fleet_rejection, "protected_booking");
    assert.equal(await blocks(van), 0);
    assert.deepEqual(await shot([previous, held]), before);

    await root.query(`select public.sbg_capacity_settle($1::uuid, 'confirm')`, [held]);
    const confirmed = await shot([held]);
    assert.equal(confirmed[0]!.lifecycle_state, "confirmed_paid");
    const confirmedOverlap = await root.query(blockSql, [provider, van, "2026-06-03T07:10:00Z", "2026-06-03T07:20:00Z", "maintenance"]);
    assert.equal(confirmedOverlap.rows[0]!.fleet_outcome, "rejected");
    assert.equal(confirmedOverlap.rows[0]!.fleet_rejection, "protected_booking");
    assert.deepEqual(await shot([held]), confirmed);
    assert.equal(await blocks(van), 0);

    const legacy = await booking("2026-06-06", "10:00", 6, 4);
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [legacy, van]);
    const legacyBefore = await shot([legacy]);
    const legacyBlock = await root.query(blockSql, [provider, van, "2026-06-06T07:00:00Z", "2026-06-06T08:00:00Z", "maintenance"]);
    assert.equal(legacyBlock.rows[0]!.fleet_outcome, "rejected", JSON.stringify(legacyBlock.rows[0]));
    assert.equal(legacyBlock.rows[0]!.fleet_rejection, "legacy_assignment");
    assert.deepEqual(await shot([legacy]), legacyBefore);
    assert.equal(await blocks(van), 0);

    const clear = await root.query(blockSql, [provider, van, "2026-06-03T12:00:00Z", "2026-06-03T12:30:00Z", "maintenance"]);
    assert.equal(clear.rows[0]!.fleet_outcome, "inserted", JSON.stringify(clear.rows[0]));
    assert.equal(await blocks(van), 1);
    const again = await root.query(blockSql, [provider, van, "2026-06-03T12:00:00Z", "2026-06-03T12:30:00Z", "maintenance"]);
    assert.equal(again.rows[0]!.fleet_outcome, "duplicate");
    assert.equal(again.rows[0]!.fleet_block_id, clear.rows[0]!.fleet_block_id);
    assert.equal(await blocks(van), 1);
    const clash = await root.query(blockSql, [provider, van, "2026-06-03T12:15:00Z", "2026-06-03T12:45:00Z", "unavailable"]);
    assert.equal(clash.rows[0]!.fleet_outcome, "rejected");
    assert.equal(clash.rows[0]!.fleet_rejection, "maintenance_overlap");
    assert.equal(await blocks(van), 1);
    const intoBlock = await booking("2026-06-03", "15:00");
    const blockedReserve = await root.query(reserveSql, [intoBlock, airport, door, van]);
    assert.equal(blockedReserve.rows[0]!.reserve_outcome, "unavailable");
    const intoShot = await shot([intoBlock]);
    assert.equal(intoShot[0]!.vehicle_id, null);
    assert.equal(intoShot[0]!.capacity_managed, false);

    const invalid = await root.query(blockSql, [provider, van, "2026-06-07T12:00:00Z", "2026-06-07T11:00:00Z", "maintenance"]);
    assert.equal(invalid.rows[0]!.fleet_outcome, "invalid");
    const foreignBlock = await root.query(blockSql, [otherProvider, van, "2026-06-07T12:00:00Z", "2026-06-07T13:00:00Z", "maintenance"]);
    assert.equal(foreignBlock.rows[0]!.fleet_outcome, "wrong_provider");
    assert.equal(await blocks(van), 1);
    const bookingBeforeConfig = await shot([previous, held, legacy]);
    const beforeConfig = await vanRow(van);
    const seats = await root.query(configSql, [provider, van, 3, true, null, false, null]);
    assert.equal(seats.rows[0]!.fleet_outcome, "rejected");
    assert.equal(seats.rows[0]!.fleet_rejection, "seats");
    const bags = await root.query(configSql, [provider, van, 7, true, 2, true, null]);
    assert.equal(bags.rows[0]!.fleet_outcome, "rejected");
    assert.equal(bags.rows[0]!.fleet_rejection, "luggage");
    const off = await root.query(configSql, [provider, van, 7, false, null, false, null]);
    assert.equal(off.rows[0]!.fleet_outcome, "rejected");
    assert.equal(off.rows[0]!.fleet_rejection, "inactive");
    assert.deepEqual(await vanRow(van), beforeConfig);
    assert.deepEqual(await shot([previous, held, legacy]), bookingBeforeConfig);
    const named = await root.query(configSql, [provider, van, 7, true, null, false, "Van Named"]);
    assert.equal(named.rows[0]!.fleet_outcome, "updated");
    assert.equal((await vanRow(van)).name, "Van Named");
    assert.equal((await vanRow(van)).capacity, 7);
    assert.equal((await vanRow(van)).active, true);
    const same = await root.query(configSql, [provider, van, 7, true, null, false, "Van Named"]);
    assert.equal(same.rows[0]!.fleet_outcome, "unchanged");
    const stolen = await root.query(configSql, [otherProvider, van, 3, false, 0, true, "Stolen"]);
    assert.equal(stolen.rows[0]!.fleet_outcome, "wrong_provider");
    assert.equal((await vanRow(van)).name, "Van Named");
    assert.equal((await vanRow(foreign)).name, "Foreign");

    const freeBefore = await vanRow(configVan);
    const shrunk = await root.query(configSql, [provider, configVan, 3, false, 1, true, "Idle"]);
    assert.equal(shrunk.rows[0]!.fleet_outcome, "updated", JSON.stringify(shrunk.rows[0]));
    const idle = await vanRow(configVan);
    assert.equal(idle.capacity, 3);
    assert.equal(idle.active, false);
    assert.equal(idle.luggage, 1);
    assert.notDeepEqual(idle, freeBefore);
    const idleBlock = await root.query(blockSql, [provider, configVan, "2026-06-08T09:00:00Z", "2026-06-08T10:00:00Z", "maintenance"]);
    assert.equal(idleBlock.rows[0]!.fleet_outcome, "inserted");

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
    const directSeat = await asRole("aether_runtime", "update vehicles set capacity = 6 where id = $1::uuid", [van]);
    assert.equal(directSeat.ok, false);
    if (!directSeat.ok) assert.equal(directSeat.code, "42501");
    const directActive = await asRole("aether_app", "update vehicles set active = false where id = $1::uuid", [van]);
    assert.equal(directActive.ok, false);
    if (!directActive.ok) assert.equal(directActive.code, "42501");
    const directName = await asRole("aether_runtime", "update vehicles set name = 'Still Named' where id = $1::uuid", [van]);
    assert.equal(directName.ok, true);
    const directBlock = await asRole(
      "aether_app",
      `insert into sbg_vehicle_unavailability (vehicle_id, starts_at, ends_at, kind)
       values ($1::uuid, '2026-06-09T09:00:00Z', '2026-06-09T10:00:00Z', 'maintenance')`,
      [configVan],
    );
    assert.equal(directBlock.ok, false);
    if (!directBlock.ok) assert.equal(directBlock.code, "42501");
    const runtimeBlock = await asRole(
      "aether_runtime",
      `select * from public.sbg_fleet_insert_unavailability($1::uuid, $2::uuid, '2026-06-09T11:00:00Z', '2026-06-09T12:00:00Z', 'maintenance')`,
      [provider, configVan],
    );
    assert.equal(runtimeBlock.ok, true);
    const gatewayBlock = await asRole(
      "aether_payment_gateway",
      `insert into sbg_vehicle_unavailability (vehicle_id, starts_at, ends_at, kind)
       values ($1::uuid, '2026-06-09T13:00:00Z', '2026-06-09T14:00:00Z', 'maintenance')`,
      [van],
    );
    assert.equal(gatewayBlock.ok, false);
    if (!gatewayBlock.ok) assert.equal(gatewayBlock.code, "42501");
    const gatewayCall = await asRole(
      "aether_payment_gateway",
      `select * from public.sbg_fleet_configure_vehicle($1::uuid, $2::uuid, 7, true, null, false, null)`,
      [provider, van],
    );
    assert.equal(gatewayCall.ok, false);
    if (!gatewayCall.ok) assert.equal(gatewayCall.code, "42501");
    const writerSettle = await asRole(
      "sbg_fleet_writer",
      `select public.sbg_capacity_settle($1::uuid, 'expire')`,
      [held],
    );
    assert.equal(writerSettle.ok, false);
    if (!writerSettle.ok) assert.equal(writerSettle.code, "42501");
    const writerReserve = await asRole("sbg_fleet_writer", reserveSql, [intoBlock, airport, door, van]);
    assert.equal(writerReserve.ok, false);
    if (!writerReserve.ok) assert.equal(writerReserve.code, "42501");
    assert.equal((await shot([held]))[0]!.lifecycle_state, "confirmed_paid");
    assert.equal(await blocks(van), 1);

    const priv = (await root.query<{
      app_capacity: boolean;
      app_active: boolean;
      app_name: boolean;
      runtime_capacity: boolean;
      fleet_settle: boolean;
      fleet_reserve: boolean;
      fleet_accept: boolean;
      fleet_booking_update: boolean;
      gateway_insert: boolean;
      gateway_fleet: boolean;
      app_operated: boolean;
    }>(
      `select
         has_column_privilege('aether_app', 'public.vehicles', 'capacity', 'update') as app_capacity,
         has_column_privilege('aether_app', 'public.vehicles', 'active', 'update') as app_active,
         has_column_privilege('aether_app', 'public.vehicles', 'name', 'update') as app_name,
         has_column_privilege('aether_runtime', 'public.vehicles', 'capacity', 'update') as runtime_capacity,
         has_function_privilege('sbg_fleet_writer', 'public.sbg_capacity_settle(uuid, text)', 'execute') as fleet_settle,
         has_function_privilege('sbg_fleet_writer', 'public.sbg_reserve_capacity(uuid, uuid, uuid, uuid)', 'execute') as fleet_reserve,
         has_function_privilege('sbg_fleet_writer', 'public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text)', 'execute') as fleet_accept,
         has_table_privilege('sbg_fleet_writer', 'public.bookings', 'update') as fleet_booking_update,
         has_table_privilege('aether_payment_gateway', 'public.sbg_vehicle_unavailability', 'insert') as gateway_insert,
         has_function_privilege('aether_payment_gateway', 'public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text)', 'execute') as gateway_fleet,
         has_column_privilege('aether_app', 'public.vehicles', 'operated_by_provider_id', 'update') as app_operated`,
    )).rows[0]!;
    assert.equal(priv.app_capacity, false);
    assert.equal(priv.app_active, false);
    assert.equal(priv.app_name, true);
    assert.equal(priv.runtime_capacity, false);
    assert.equal(priv.fleet_settle, false);
    assert.equal(priv.fleet_reserve, false);
    assert.equal(priv.fleet_accept, false);
    assert.equal(priv.fleet_booking_update, false);
    assert.equal(priv.gateway_insert, false);
    assert.equal(priv.gateway_fleet, false);
    assert.equal(priv.app_operated, false);

    const raceBooking = await booking("2026-06-04", "10:00");
    await left.query("begin");
    const openHold = await left.query(reserveSql, [raceBooking, airport, door, raceVan]);
    assert.equal(openHold.rows[0]!.reserve_outcome, "reserved", JSON.stringify(openHold.rows[0]));
    await right.query("begin");
    const maintenanceStarted = Date.now();
    const blockedMaintenance = await right.query(blockSql, [
      provider,
      raceVan,
      "2026-06-04T07:00:00Z",
      "2026-06-04T08:00:00Z",
      "maintenance",
    ]);
    const maintenanceWaited = Date.now() - maintenanceStarted;
    assert.equal(blockedMaintenance.rows[0]!.fleet_outcome, "rejected");
    assert.equal(blockedMaintenance.rows[0]!.fleet_rejection, "lock_busy");
    assert.ok(maintenanceWaited >= 1500 && maintenanceWaited < 8000, String(maintenanceWaited));
    await right.query("rollback");
    assert.equal(await blocks(raceVan), 0);
    await left.query("commit");
    const afterHold = await root.query(blockSql, [provider, raceVan, "2026-06-04T07:00:00Z", "2026-06-04T08:00:00Z", "maintenance"]);
    assert.equal(afterHold.rows[0]!.fleet_outcome, "rejected");
    assert.equal(afterHold.rows[0]!.fleet_rejection, "protected_booking");
    assert.equal(await blocks(raceVan), 0);
    assert.equal((await shot([raceBooking]))[0]!.vehicle_id, raceVan);

    const raceTwo = await booking("2026-06-04", "16:00");
    await left.query("begin");
    const openBlock = await left.query(blockSql, [provider, raceVan, "2026-06-04T13:00:00Z", "2026-06-04T14:00:00Z", "maintenance"]);
    assert.equal(openBlock.rows[0]!.fleet_outcome, "inserted");
    await right.query("begin");
    await right.query("set local lock_timeout = '1500ms'");
    try {
      await right.query(reserveSql, [raceTwo, airport, door, raceVan]);
      assert.fail("reservation should wait on the open maintenance block");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "55P03", (err as Error).message);
    } finally {
      await right.query("rollback");
    }
    assert.equal((await shot([raceTwo]))[0]!.vehicle_id, null);
    await left.query("commit");
    const afterBlock = await root.query(reserveSql, [raceTwo, airport, door, raceVan]);
    assert.equal(afterBlock.rows[0]!.reserve_outcome, "unavailable", JSON.stringify(afterBlock.rows[0]));
    assert.equal((await shot([raceTwo]))[0]!.vehicle_id, null);
    assert.equal((await shot([raceTwo]))[0]!.capacity_managed, false);
    assert.equal(await blocks(raceVan), 1);

    const raceThree = await booking("2026-06-05", "10:00");
    const configRace = await vehicle("Config Race", provider);
    await left.query("begin");
    const openConfig = await left.query(reserveSql, [raceThree, airport, door, configRace]);
    assert.equal(openConfig.rows[0]!.reserve_outcome, "reserved");
    await right.query("begin");
    const configStarted = Date.now();
    const blockedConfig = await right.query(configSql, [provider, configRace, 7, false, null, false, null]);
    const configWaited = Date.now() - configStarted;
    assert.equal(blockedConfig.rows[0]!.fleet_outcome, "rejected");
    assert.equal(blockedConfig.rows[0]!.fleet_rejection, "lock_busy");
    assert.ok(configWaited >= 1500 && configWaited < 8000, String(configWaited));
    assert.equal((await vanRow(configRace)).active, true);
    await right.query("rollback");
    await left.query("commit");
    const afterConfig = await root.query(configSql, [provider, configRace, 7, false, null, false, null]);
    assert.equal(afterConfig.rows[0]!.fleet_outcome, "rejected");
    assert.equal(afterConfig.rows[0]!.fleet_rejection, "inactive");
    assert.equal((await vanRow(configRace)).active, true);
    assert.equal((await shot([raceThree]))[0]!.vehicle_id, configRace);
    assert.equal((await shot([raceThree]))[0]!.lifecycle_state, "awaiting_payment");
  } finally {
    await left.end().catch(() => undefined);
    await right.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
});
