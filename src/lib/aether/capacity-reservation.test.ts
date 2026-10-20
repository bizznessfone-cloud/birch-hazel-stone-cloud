/**
 * Gate 2 Stage 3. Disposable PostgreSQL, two sessions, committed rows.
 * Fails closed when STAGE_G2S3_PG_URL is unset. Not Neon and not checkout.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";

const ADMIN_URL = process.env.STAGE_G2S3_PG_URL;
const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
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
    for (const role of ["aether_payment_gateway", "aether_expiry_runner", "aether_expiry", "aether_app", "aether_runtime", "aether_webhook", "aether_mailer", "sbg_capacity_writer"]) {
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

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

async function once(client: pg.Client, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  try {
    return await client.query(sql, params);
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "40P01" || (code === "40001" && message.includes("capacity_lock_retry"))) {
      return await client.query(sql, params);
    }
    throw err;
  }
}

test("stage 3 source is additive and does not open checkout", () => {
  const files = migrationFiles();
  assert.equal(files.includes("0069_gate2_capacity_reservation.sql"), true);
  assert.equal(files.filter((name) => name < "0069").length >= 68, true);
  const sql = readFileSync(new URL("0069_gate2_capacity_reservation.sql", MIGRATIONS), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  assert.equal(preflight.includes("0069_gate2_capacity_reservation.sql"), false);
  assert.match(sql, /create role sbg_capacity_writer nologin/);
  assert.match(sql, /owner to sbg_capacity_writer/);
  assert.match(sql, /revoke sbg_capacity_writer from current_user/);
  assert.doesNotMatch(sql, /current_setting|set_config/);
  assert.match(sql, /capacity_managed is not true/);
  const booking = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
  const guest = readFileSync(new URL("./guest-create.ts", import.meta.url), "utf8");
  assert.doesNotMatch(booking, /sbg_reserve_capacity/);
  assert.match(booking, /openFreshHold/);
  assert.doesNotMatch(guest, /sbg_reserve_capacity/);
  assert.doesNotMatch(sql, /grant update \(capacity_managed\) on table public\.bookings to aether_app/);
  assert.doesNotMatch(sql, /stripe_checkout_session|GuestCheckoutClosed/);
});

test("callers retry a capacity lock once and do not retry exclusion or payment conflict", async () => {
  const { assignVehicle } = await import("./inventory.ts");
  const { acceptVerifiedPaymentEvent } = await import("./verified-payment.ts");
  const { expireProvisionalHolds } = await import("./provisional-hold.ts");
  const scope = {
    operatorId: "00000000-0000-4000-8000-000000000001",
    login: "desk",
    sessionId: "stage3d",
    membershipId: "00000000-0000-4000-8000-000000000002",
    accessClass: "provider_dispatcher" as const,
    hotelId: null,
    providerId: "00000000-0000-4000-8000-000000000003",
  };
  const lock = Object.assign(new Error("capacity_lock_retry"), { code: "40001" });
  const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  const overlap = Object.assign(new Error("exclusion"), { code: "23P01" });
  const conflict = Object.assign(new Error("payment_transition_conflict"), { code: "40001" });
  let calls = 0;
  const snap = await assignVehicle({
    async query() {
      return [];
    },
    async transaction() {
      calls += 1;
      if (calls === 1) throw lock;
      return {
        bookingId: "00000000-0000-4000-8000-000000000010",
        vehicleId: null,
        driverId: null,
        status: "confirmed",
        cancelled: false,
      };
    },
  }, {
    bookingId: "00000000-0000-4000-8000-000000000010",
    vehicleId: "00000000-0000-4000-8000-000000000011",
    scope,
  });
  assert.equal(calls, 2);
  assert.equal(snap.bookingId, "00000000-0000-4000-8000-000000000010");
  calls = 0;
  await assert.rejects(() => assignVehicle({
    async query() {
      return [];
    },
    async transaction() {
      calls += 1;
      throw overlap;
    },
  }, {
    bookingId: "00000000-0000-4000-8000-000000000010",
    vehicleId: "00000000-0000-4000-8000-000000000011",
    scope,
  }));
  assert.equal(calls, 1);

  const claim = {
    signatureVerified: true,
    eventId: "evt_retry",
    eventType: "checkout.session.completed",
    bookingId: "00000000-0000-4000-8000-000000000010",
    paymentId: "00000000-0000-4000-8000-000000000012",
    executingProviderId: "00000000-0000-4000-8000-000000000003",
    accountId: "acct_retry",
    sessionId: "cs_retry",
    amountMinor: 4500,
    currency: "EUR",
    paymentStatus: "paid",
    paymentIntentId: "pi_retry",
  };
  let accepts = 0;
  const accepted = await acceptVerifiedPaymentEvent({
    async query() {
      accepts += 1;
      if (accepts === 1) throw deadlock;
      return [{
        transition_outcome: "confirmed_paid",
        transition_lifecycle: "confirmed_paid",
        transition_payment_status: "paid",
        transition_event_recorded: true,
      }];
    },
  }, claim);
  assert.equal(accepts, 2);
  assert.equal(accepted.outcome, "confirmed_paid");
  accepts = 0;
  await assert.rejects(() => acceptVerifiedPaymentEvent({
    async query() {
      accepts += 1;
      throw conflict;
    },
  }, claim));
  assert.equal(accepts, 1);

  let expiries = 0;
  const expired = await expireProvisionalHolds({
    async query() {
      expiries += 1;
      if (expiries === 1) throw lock;
      return [{
        expired_booking_id: "00000000-0000-4000-8000-000000000010",
        previous_lifecycle: "awaiting_payment",
        observed_payment_status: null,
      }];
    },
  }, 1);
  assert.equal(expiries, 2);
  assert.equal(expired[0]?.bookingId, "00000000-0000-4000-8000-000000000010");
});

test("capacity reservations are atomic under concurrent sessions", { timeout: 180_000 }, async () => {
  if (!ADMIN_URL) assert.fail("BLOCKED — LOCAL POSTGRESQL TEST NOT RUN");
  const adminUrl = new URL(ADMIN_URL);
  if (adminUrl.hostname !== "127.0.0.1" && adminUrl.hostname !== "localhost") {
    assert.fail(`BLOCKED — refusing non-local host ${adminUrl.hostname}`);
  }
  adminUrl.pathname = "/postgres";
  const dbUrl = await resetCluster(adminUrl);
  const root = await connect(dbUrl);
  let left: pg.Client | undefined;
  let right: pg.Client | undefined;
  try {
  await apply(root, migrationFiles());
  await root.query(
    `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
     values ('user-1','Ada','ada-s3@example.com',true,now(),now())`,
  );

  const hotelOrg = (await root.query<{ id: string }>(
    `insert into sbg_organisations (name, created_by_user_id, organisation_type)
     values ('Hotel', 'user-1', 'hotel') returning id`,
  )).rows[0]!.id;
  const hotel = (await root.query<{ id: string }>(
    `insert into hotels (code, name, iana_timezone, organisation_id)
     values ('s3', 'Stage Hotel', 'Europe/Athens', $1::uuid) returning id`,
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
    `insert into providers (code, name, kind) values ('s3p', 'Stage Provider', 'in_house') returning id`,
  )).rows[0]!.id;
  const otherProvider = (await root.query<{ id: string }>(
    `insert into providers (code, name, kind) values ('s3o', 'Other Provider', 'external') returning id`,
  )).rows[0]!.id;
  await root.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
    [hotel, provider],
  );
  await root.query(
    `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode) values ($1::uuid, 'acct_legacy_s3', false)`,
    [hotel],
  );
  await root.query(
    `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
     values ($1::uuid, 'acct_hotel_s3', false)`,
    [hotelOrg],
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
     values ($1::uuid, $2::uuid, $3::uuid, 35), ($1::uuid, $3::uuid, $2::uuid, 30)`,
    [provider, airport, door],
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
     values ('Van', 7, 4, true, $1::uuid, $1::uuid) returning id`,
    [provider],
  )).rows[0]!.id;
  const otherVan = (await root.query<{ id: string }>(
    `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
     values ('Other', 7, 4, true, $1::uuid, $1::uuid) returning id`,
    [provider],
  )).rows[0]!.id;
  const foreign = (await root.query<{ id: string }>(
    `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
     values ('Foreign', 7, 4, true, $1::uuid, $1::uuid) returning id`,
    [otherProvider],
  )).rows[0]!.id;

  let n = 0;
  async function booking(date = "2026-06-03", time = "10:00"): Promise<string> {
    n += 1;
    const id = (await root.query<{ id: string }>(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, passenger_count, luggage_count,
         pickup_text, destination_text, human_reference, confirmation_token
       ) values (
         $1::uuid, $2::uuid, $3::date, $4::time, 60,
         'Ada', '+302100000000', 'ada@example.com', 2, 1,
         'Door', 'Airport', $5, $6
       ) returning id`,
      [hotel, provider, date, time, `S3-${n}`, `token-s3-${n}`],
    )).rows[0]!.id;
    return id;
  }

  const reserveSql = `select * from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`;

  left = await connect(dbUrl);
  right = await connect(dbUrl);
  const first = await booking();
  const second = await booking();
  const race = await Promise.all([
    left.query(reserveSql, [first, airport, door, van]),
    right.query(reserveSql, [second, airport, door, van]),
  ]);
  const outcomes = race.map((result) => result.rows[0]!.reserve_outcome).sort();
  assert.deepEqual(outcomes, ["reserved", "unavailable"]);
  const occupied = await root.query<{ id: string; vehicle_id: string; duration_minutes: number; lifecycle_state: string }>(
    `select id, vehicle_id, duration_minutes, lifecycle_state
       from bookings
      where capacity_managed and vehicle_id = $1::uuid`,
    [van],
  );
  assert.equal(occupied.rowCount, 1);
  assert.equal(occupied.rows[0]!.duration_minutes, 45);
  assert.equal(occupied.rows[0]!.lifecycle_state, "awaiting_payment");
  const hold = await root.query<{ minutes: number }>(
    `select extract(epoch from (hold_expires_at - clock_timestamp())) / 60 as minutes
       from bookings where id = $1::uuid`,
    [occupied.rows[0]!.id],
  );
  assert.ok(Number(hold.rows[0]!.minutes) > 29 && Number(hold.rows[0]!.minutes) <= 30);

  const third = await booking("2026-06-04", "10:00");
  const fourth = await booking("2026-06-04", "10:00");
  const split = await Promise.all([
    left.query(reserveSql, [third, airport, door, van]),
    right.query(reserveSql, [fourth, airport, door, otherVan]),
  ]);
  assert.deepEqual(split.map((result) => result.rows[0]!.reserve_outcome).sort(), ["reserved", "reserved"]);

  const buffered = await booking("2026-06-03", "11:50");
  await root.query(
    `insert into bookings (
       hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
       guest_name, guest_phone, guest_email, passenger_count, luggage_count,
       pickup_text, destination_text, human_reference, confirmation_token, vehicle_id
     ) values (
       $1::uuid, $2::uuid, '2026-06-03', '11:00', 40,
       'Near', '+302100000001', 'near@example.com', 1, 0,
       'Door', 'Airport', 'S3-NEAR', 'token-near', $3::uuid
     )`,
    [hotel, provider, van],
  );
  await root.query(
    `insert into sbg_booking_itinerary (booking_id, origin_location_id, destination_location_id)
     select id, $1::uuid, $2::uuid from bookings where human_reference = 'S3-NEAR'`,
    [door, airport],
  );
  const beforeBuffer = await root.query<{
    id: string;
    ref: string;
    vehicle_id: string | null;
    capacity_managed: boolean;
    lifecycle_state: string;
    occupies: string;
  }>(
    `select id::text, human_reference as ref, vehicle_id::text, capacity_managed, lifecycle_state, occupies::text as occupies
       from bookings
      where human_reference = 'S3-NEAR' or id = $1::uuid or id = $2::uuid
      order by human_reference`,
    [buffered, occupied.rows[0]!.id],
  );
  const beforeCount = await root.query<{ n: number }>(
    `select count(*)::int as n from bookings
      where vehicle_id = $1::uuid and cancelled_at is null and occupies <> 'empty'`,
    [van],
  );
  const buffer = await root.query(reserveSql, [buffered, airport, door, van]);
  assert.equal(buffer.rows[0]!.reserve_outcome, "unavailable");
  assert.equal(buffer.rows[0]!.reserve_rejection, "previous_reposition");
  const afterBuffer = await root.query<{
    id: string;
    ref: string;
    vehicle_id: string | null;
    capacity_managed: boolean;
    lifecycle_state: string;
    occupies: string;
  }>(
    `select id::text, human_reference as ref, vehicle_id::text, capacity_managed, lifecycle_state, occupies::text as occupies
       from bookings
      where human_reference = 'S3-NEAR' or id = $1::uuid or id = $2::uuid
      order by human_reference`,
    [buffered, occupied.rows[0]!.id],
  );
  const afterCount = await root.query<{ n: number }>(
    `select count(*)::int as n from bookings
      where vehicle_id = $1::uuid and cancelled_at is null and occupies <> 'empty'`,
    [van],
  );
  assert.equal(afterCount.rows[0]!.n, beforeCount.rows[0]!.n);
  assert.deepEqual(afterBuffer.rows, beforeBuffer.rows);
  const rejected = afterBuffer.rows.find((row) => row.id === buffered);
  assert.equal(rejected?.vehicle_id, null);
  assert.equal(rejected?.capacity_managed, false);
  assert.equal(rejected?.lifecycle_state, "legacy_unreconciled");
  console.log(JSON.stringify({
    bufferProof: {
      before: beforeBuffer.rows,
      after: afterBuffer.rows,
      occupiedBefore: beforeCount.rows[0]!.n,
      occupiedAfter: afterCount.rows[0]!.n,
      rejection: buffer.rows[0]!.reserve_rejection,
    },
  }));
  const bufferOccupancy = await root.query<{ n: number }>(
    `select count(*)::int as n from bookings
      where vehicle_id = $1::uuid and transfer_date = '2026-06-03' and cancelled_at is null`,
    [van],
  );
  assert.equal(bufferOccupancy.rows[0]!.n, 2);

  const foreignBooking = await booking("2026-06-05", "10:00");
  const leaked = await root.query(reserveSql, [foreignBooking, airport, door, foreign]);
  assert.notEqual(leaked.rows[0]!.reserve_outcome, "reserved");
  assert.equal(JSON.stringify(leaked.rows).includes("Foreign"), false);

  const rolled = await booking("2026-06-06", "10:00");
  await left.query("begin");
  const rolledReserve = await left.query(reserveSql, [rolled, airport, door, van]);
  assert.equal(rolledReserve.rows[0]!.reserve_outcome, "reserved");
  await left.query("rollback");
  const afterRollback = await root.query<{ capacity_managed: boolean; vehicle_id: string | null }>(
    `select capacity_managed, vehicle_id from bookings where id = $1::uuid`,
    [rolled],
  );
  assert.equal(afterRollback.rows[0]!.capacity_managed, false);
  assert.equal(afterRollback.rows[0]!.vehicle_id, null);
  const retried = await root.query(reserveSql, [rolled, airport, door, van]);
  assert.equal(retried.rows[0]!.reserve_outcome, "reserved");
  await root.query(`select * from public.sbg_release_capacity($1::uuid)`, [rolled]);

  const maintained = await booking("2026-06-07", "10:00");
  await left.query("begin");
  await left.query(`select public.sbg_capacity_lock_vehicle($1::uuid)`, [van]);
  const maintenancePending = right.query(reserveSql, [maintained, airport, door, van]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await left.query(
    `insert into sbg_vehicle_unavailability (vehicle_id, starts_at, ends_at, kind)
     values ($1::uuid, aether_civil_instant('2026-06-07', '10:00', 'Europe/Athens'),
             aether_civil_instant('2026-06-07', '11:00', 'Europe/Athens'), 'maintenance')`,
    [van],
  );
  await left.query("commit");
  const maintenanceResult = await maintenancePending;
  assert.equal(maintenanceResult.rows[0]!.reserve_outcome, "unavailable");
  assert.equal(maintenanceResult.rows[0]!.reserve_rejection, "maintenance");

  await root.query(`update sbg_fleet_routes set duration_minutes = 50 where origin_location_id = $1::uuid`, [airport]);
  const routed = await booking("2026-06-08", "10:00");
  await left.query("begin");
  await left.query(`select public.sbg_capacity_lock_vehicle($1::uuid)`, [otherVan]);
  const routePending = right.query(reserveSql, [routed, airport, door, otherVan]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await left.query(`update sbg_fleet_routes set duration_minutes = 55 where origin_location_id = $1::uuid`, [airport]);
  await left.query("commit");
  const routeResult = await routePending;
  assert.equal(routeResult.rows[0]!.reserve_outcome, "reserved");
  assert.equal(routeResult.rows[0]!.reserve_duration_minutes, 55);

  const legacy = await booking("2026-06-09", "10:00");
  const opened = await root.query<{ opened_lifecycle_state: string }>(
    `select * from public.sbg_open_provisional_hold($1::uuid, 1800)`,
    [legacy],
  );
  assert.equal(opened.rows[0]!.opened_lifecycle_state, "awaiting_payment");
  const legacyVehicle = await root.query<{ vehicle_id: string | null; capacity_managed: boolean }>(
    `select vehicle_id, capacity_managed from bookings where id = $1::uuid`,
    [legacy],
  );
  assert.equal(legacyVehicle.rows[0]!.vehicle_id, null);
  assert.equal(legacyVehicle.rows[0]!.capacity_managed, false);

  const desk = await booking("2026-06-09", "15:00");
  await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [desk, otherVan]);
  const deskRow = await root.query<{ vehicle_id: string; capacity_managed: boolean }>(
    `select vehicle_id, capacity_managed from bookings where id = $1::uuid`,
    [desk],
  );
  assert.equal(deskRow.rows[0]!.vehicle_id, otherVan);
  assert.equal(deskRow.rows[0]!.capacity_managed, false);

  const overlapLeft = await booking("2026-06-10", "10:00");
  const overlapRight = await booking("2026-06-10", "10:00");
  const deskRace = await Promise.allSettled([
    left.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [overlapLeft, van]),
    right.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [overlapRight, van]),
  ]);
  const deskWon = await root.query<{ n: number }>(
    `select count(*)::int as n from bookings
      where id in ($1::uuid, $2::uuid) and vehicle_id = $3::uuid and capacity_managed is not true`,
    [overlapLeft, overlapRight, van],
  );
  assert.equal(deskWon.rows[0]!.n, 1);
  const deskLost = deskRace.filter((result) => result.status === "rejected");
  if (deskLost.length > 0) {
    const code = (deskLost[0]!.reason as { code?: string }).code;
    assert.ok(code === "23P01" || code === "40P01");
  }
  await root.query(
    `update bookings set cancelled_at = clock_timestamp() where id in ($1::uuid, $2::uuid)`,
    [overlapLeft, overlapRight],
  );

  const denied = await root.query(`select id from bookings where capacity_managed and vehicle_id is not null limit 1`);
  const protectedId = denied.rows[0]!.id as string;
  await root.query("begin");
  await root.query("set local session authorization aether_app");
  const cancelDenied = await root.query(
    `update bookings set cancelled_at = clock_timestamp() where id = $1::uuid`,
    [protectedId],
  ).then(() => ({ ok: true })).catch((err: { code?: string }) => ({ ok: false, code: err.code }));
  await root.query("rollback");
  assert.equal(cancelDenied.ok, false);
  if (!cancelDenied.ok) assert.equal(cancelDenied.code, "42501");

  await root.query(
    `create function public.s3_owner_flip(p_id uuid) returns void language plpgsql security definer
     set search_path = pg_catalog, public as $f$
     begin
       update public.bookings set capacity_managed = false where id = p_id;
     end;
     $f$`,
  );
  const ownerDenied = await root.query(`select public.s3_owner_flip($1::uuid)`, [protectedId])
    .then(() => ({ ok: true }))
    .catch((err: { code?: string }) => ({ ok: false, code: err.code }));
  assert.equal(ownerDenied.ok, false);
  if (!ownerDenied.ok) assert.equal(ownerDenied.code, "42501");

  const legacyCancel = await root.query(
    `update bookings set cancelled_at = clock_timestamp() where id = $1::uuid returning occupies::text as occupies`,
    [desk],
  );
  assert.equal(legacyCancel.rows[0]!.occupies, "empty");

  const eventDenied = await root.query<{ sbg_apply_payment_event: boolean }>(
    `select public.sbg_apply_payment_event('evt_capacity_1', 'checkout.session.completed', $1::uuid, $1::uuid, 'pi_x', 'paid', 'acct_hotel_s3')`,
    [protectedId],
  );
  assert.equal(eventDenied.rows[0]!.sbg_apply_payment_event, false);
  const burned = await root.query<{ n: number }>(
    `select count(*)::int as n from sbg_stripe_events where event_id = 'evt_capacity_1'`,
  );
  assert.equal(burned.rows[0]!.n, 0);
  const applySrc = await root.query<{ src: string }>(
    `select prosrc as src from pg_proc where proname = 'sbg_apply_payment_event'`,
  );
  assert.match(applySrc.rows[0]!.src, /insert into sbg_stripe_events/);
  assert.doesNotMatch(applySrc.rows[0]!.src, /lifecycle_state|confirmed_paid_at/);
  const acceptSrc = await root.query<{ src: string }>(
    `select prosrc as src from pg_proc where proname = 'sbg_accept_verified_payment_event'`,
  );
  assert.doesNotMatch(acceptSrc.rows[0]!.src, /sbg_apply_payment_event/);
  const priv = await root.query<{
    app_reserve: boolean;
    app_settle: boolean;
    hook_reserve: boolean;
    app_scope: boolean;
    app_cap: boolean;
    app_vehicle: boolean;
    app_member: boolean;
    owner_member: boolean;
  }>(
    `select
       has_function_privilege('aether_app', 'public.sbg_reserve_capacity(uuid, uuid, uuid, uuid)', 'execute') as app_reserve,
       has_function_privilege('aether_app', 'public.sbg_capacity_settle(uuid, text)', 'execute') as app_settle,
       has_function_privilege('aether_webhook', 'public.sbg_reserve_capacity(uuid, uuid, uuid, uuid)', 'execute') as hook_reserve,
       has_function_privilege('aether_app', 'public.sbg_capacity_lock_scope(uuid, uuid[], uuid[])', 'execute') as app_scope,
       has_column_privilege('aether_app', 'public.bookings', 'capacity_managed', 'update') as app_cap,
       has_column_privilege('aether_app', 'public.bookings', 'vehicle_id', 'update') as app_vehicle,
       pg_has_role('aether_app', 'sbg_capacity_writer', 'member') as app_member,
       exists (
         select 1
           from pg_auth_members m
           join pg_roles granted on granted.oid = m.roleid
           join pg_roles member on member.oid = m.member
          where granted.rolname = 'sbg_capacity_writer'
            and member.rolname = current_user
       ) as owner_member`,
  );
  assert.equal(priv.rows[0]!.app_reserve, true);
  assert.equal(priv.rows[0]!.app_settle, false);
  assert.equal(priv.rows[0]!.hook_reserve, false);
  assert.equal(priv.rows[0]!.app_scope, false);
  assert.equal(priv.rows[0]!.app_cap, false);
  assert.equal(priv.rows[0]!.app_vehicle, false);
  assert.equal(priv.rows[0]!.app_member, false);
  assert.equal(priv.rows[0]!.owner_member, false);

  const due = occupied.rows[0]!.id;
  await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
  await root.query(`update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid`, [due]);
  await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
  const expired = await root.query<{ expired_booking_id: string }>(
    `select * from public.sbg_expire_provisional_holds(20)`,
  );
  assert.equal(expired.rows.some((row) => row.expired_booking_id === due), true);
  const released = await root.query<{ vehicle_id: string | null; lifecycle_state: string }>(
    `select vehicle_id, lifecycle_state from bookings where id = $1::uuid`,
    [due],
  );
  assert.equal(released.rows[0]!.lifecycle_state, "expired");
  assert.equal(released.rows[0]!.vehicle_id, null);

  const paid = await booking("2026-06-11", "10:00");
  const paidReserve = await root.query(reserveSql, [paid, airport, door, van]);
  assert.equal(paidReserve.rows[0]!.reserve_outcome, "reserved");
  const payment = (await root.query<{ id: string }>(
    `insert into sbg_booking_payments (booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url)
     values ($1::uuid, 4500, 'EUR', 'cs_s3_paid', 'https://checkout.stripe.test/s3') returning id`,
    [paid],
  )).rows[0]!.id;
  await root.query(`select * from public.sbg_bind_payment_authority($1::uuid)`, [paid]);
  const confirmed = await root.query<{ transition_outcome: string; transition_lifecycle: string }>(
    `select * from public.sbg_accept_verified_payment_event(
       true, 'evt_s3_paid', 'checkout.session.completed', $1::uuid, $2::uuid, $3::uuid,
       'acct_hotel_s3', 'cs_s3_paid', 4500, 'EUR', 'paid', 'pi_s3_paid'
     )`,
    [paid, payment, provider],
  );
  assert.equal(confirmed.rows[0]!.transition_outcome, "confirmed_paid");
  const kept = await root.query<{ vehicle_id: string; lifecycle_state: string }>(
    `select vehicle_id, lifecycle_state from bookings where id = $1::uuid`,
    [paid],
  );
  assert.equal(kept.rows[0]!.lifecycle_state, "confirmed_paid");
  assert.equal(kept.rows[0]!.vehicle_id, van);
  const notExpired = await root.query<{ expired_booking_id: string }>(
    `select * from public.sbg_expire_provisional_holds(20)`,
  );
  assert.equal(notExpired.rows.some((row) => row.expired_booking_id === paid), false);

  const sessionOnly = await booking("2026-06-12", "10:00");
  await root.query(reserveSql, [sessionOnly, airport, door, otherVan]);
  const sessionPayment = (await root.query<{ id: string }>(
    `insert into sbg_booking_payments (booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url)
     values ($1::uuid, 4500, 'EUR', 'cs_s3_session', 'https://checkout.stripe.test/s3b') returning id`,
    [sessionOnly],
  )).rows[0]!.id;
  await root.query(`select * from public.sbg_bind_payment_authority($1::uuid)`, [sessionOnly]);
  await root.query(
    `select * from public.sbg_accept_verified_payment_event(
       true, 'evt_s3_session', 'checkout.session.expired', $1::uuid, $2::uuid, $3::uuid,
       'acct_hotel_s3', 'cs_s3_session', 4500, 'EUR', 'expired', null
     )`,
    [sessionOnly, sessionPayment, provider],
  );
  const stillHeld = await root.query<{ vehicle_id: string | null; lifecycle_state: string }>(
    `select vehicle_id, lifecycle_state from bookings where id = $1::uuid`,
    [sessionOnly],
  );
  assert.equal(stillHeld.rows[0]!.lifecycle_state, "awaiting_payment");
  assert.equal(stillHeld.rows[0]!.vehicle_id, otherVan);

  const late = await booking("2026-06-13", "10:00");
  await root.query(reserveSql, [late, airport, door, van]);
  const latePayment = (await root.query<{ id: string }>(
    `insert into sbg_booking_payments (booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url)
     values ($1::uuid, 4500, 'EUR', 'cs_s3_late', 'https://checkout.stripe.test/s3c') returning id`,
    [late],
  )).rows[0]!.id;
  await root.query(`select * from public.sbg_bind_payment_authority($1::uuid)`, [late]);
  await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
  await root.query(`update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid`, [late]);
  await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
  const lateCall = once(
    left,
    `select * from public.sbg_accept_verified_payment_event(
       true, 'evt_s3_late', 'checkout.session.completed', $1::uuid, $2::uuid, $3::uuid,
       'acct_hotel_s3', 'cs_s3_late', 4500, 'EUR', 'paid', 'pi_s3_late'
     )`,
    [late, latePayment, provider],
  );
  const expireCall = once(right, `select * from public.sbg_expire_provisional_holds(20)`);
  const [lateResult, expireResult] = await Promise.all([lateCall, expireCall]);
  assert.notEqual(lateResult.rows[0]!.transition_outcome, "confirmed_paid");
  const lateRow = await root.query<{ lifecycle_state: string; vehicle_id: string | null; status: string }>(
    `select b.lifecycle_state, b.vehicle_id, p.status
       from bookings b join sbg_booking_payments p on p.booking_id = b.id
      where b.id = $1::uuid`,
    [late],
  );
  assert.equal(lateRow.rows[0]!.lifecycle_state, "expired");
  assert.equal(lateRow.rows[0]!.vehicle_id, null);
  assert.equal(lateRow.rows[0]!.status, "received_after_expiry");
  assert.ok(expireResult.rowCount !== undefined);

  const reassignBooking = await booking("2026-06-14", "10:00");
  await root.query(reserveSql, [reassignBooking, airport, door, van]);
  const reassignPayment = (await root.query<{ id: string }>(
    `insert into sbg_booking_payments (booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url)
     values ($1::uuid, 4500, 'EUR', 'cs_s3_move', 'https://checkout.stripe.test/s3d') returning id`,
    [reassignBooking],
  )).rows[0]!.id;
  await root.query(`select * from public.sbg_bind_payment_authority($1::uuid)`, [reassignBooking]);
  await root.query(
    `select * from public.sbg_accept_verified_payment_event(
       true, 'evt_s3_move', 'checkout.session.completed', $1::uuid, $2::uuid, $3::uuid,
       'acct_hotel_s3', 'cs_s3_move', 4500, 'EUR', 'paid', 'pi_s3_move'
     )`,
    [reassignBooking, reassignPayment, provider],
  );
  const move = once(left, `select * from public.sbg_reassign_capacity_vehicle($1::uuid, $2::uuid)`, [reassignBooking, otherVan]);
  const cancel = once(right, `select * from public.sbg_release_capacity($1::uuid)`, [reassignBooking]);
  const [moveResult, cancelResult] = await Promise.all([move, cancel]);
  const finals = [moveResult.rows[0]!.reserve_outcome, cancelResult.rows[0]!.reserve_outcome].sort();
  assert.ok(finals.includes("reassigned") || finals.includes("released") || finals.includes("incompatible") || finals.includes("unavailable"));
  const finalRow = await root.query<{ lifecycle_state: string; vehicle_id: string | null; occupies: string }>(
    `select lifecycle_state, vehicle_id, occupies::text as occupies from bookings where id = $1::uuid`,
    [reassignBooking],
  );
  if (finalRow.rows[0]!.lifecycle_state === "cancelled") {
    assert.equal(finalRow.rows[0]!.vehicle_id, null);
    assert.equal(finalRow.rows[0]!.occupies, "empty");
  } else {
    assert.equal(finalRow.rows[0]!.lifecycle_state, "confirmed_paid");
    assert.equal(finalRow.rows[0]!.vehicle_id, otherVan);
    const both = await root.query<{ n: number }>(
      `select count(*)::int as n from bookings where id = $1::uuid and vehicle_id is not null`,
      [reassignBooking],
    );
    assert.equal(both.rows[0]!.n, 1);
  }

  } finally {
    await left?.end().catch(() => undefined);
    await right?.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
});
