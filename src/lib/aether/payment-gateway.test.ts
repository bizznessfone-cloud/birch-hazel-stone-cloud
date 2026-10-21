/**
 * Gate 2 Stage 4C. Isolated guest-payment authority on disposable PostgreSQL.
 * Not a deployment, not Neon, and not checkout.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";
import { CapacityLatchUnavailable, capacityWebhookLatch } from "./guest-payment-latch.ts";
import { runExpiryWorker } from "./expiry-runner.ts";
import { handleGuestPaymentWebhook, verifyGuestPaymentSignature } from "./payment-gateway.ts";

const ADMIN_URL = process.env.STAGE_G2S4_PG_URL;
const SECRET = "whsec_stage4c_guest";
const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
}

function sign(raw: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

function eventBody(patch: Record<string, unknown>): string {
  return JSON.stringify({
    id: "evt_stage4c",
    type: "checkout.session.completed",
    account: "acct_hotel_s4",
    data: {
      object: {
        id: "cs_stage4c",
        object: "checkout.session",
        amount_total: 4500,
        currency: "eur",
        payment_status: "paid",
        payment_intent: "pi_stage4c",
        metadata: {
          booking_id: "00000000-0000-4000-8000-000000000010",
          payment_id: "00000000-0000-4000-8000-000000000011",
        },
      },
    },
    ...patch,
  });
}

test("stage 4c source stays closed and does not embed a password", () => {
  const sql = readFileSync(new URL("0070_gate2_isolated_payment_authority.sql", MIGRATIONS), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../../routes/api/stripe/webhook.ts", import.meta.url), "utf8");
  const handler = readFileSync(new URL("./payment-gateway.ts", import.meta.url), "utf8");
  const guest = readFileSync(new URL("./guest-payment-fns.ts", import.meta.url), "utf8");
  const db = readFileSync(new URL("../db.ts", import.meta.url), "utf8");
  const expiry = readFileSync(new URL("./expiry-runner.ts", import.meta.url), "utf8");
  assert.equal(preflight.includes("0070_gate2_isolated_payment_authority.sql"), false);
  assert.equal(preflight.includes("0069_gate2_capacity_reservation.sql"), false);
  assert.match(sql, /create role aether_payment_gateway/);
  assert.match(sql, /grant aether_webhook to aether_payment_gateway/);
  assert.match(sql, /grant aether_expiry to aether_expiry_runner/);
  assert.doesNotMatch(sql, /password\s*=|password\s+'/i);
  assert.doesNotMatch(sql, /pg_cron|cron\.schedule/);
  assert.match(webhook, /capacity_payment_unmounted/);
  assert.match(webhook, /status: 503/);
  assert.match(webhook, /charge\.refunded/);
  assert.match(webhook, /checkout_not_applied/);
  assert.match(webhook, /unproven/);
  assert.match(webhook, /sbg_apply_payment_event/);
  assert.match(webhook, /applyDomainABillingEvent/);
  assert.doesNotMatch(webhook, /sbg_accept_verified_payment_event|handleGuestPaymentWebhook|aether_payment_gateway/);
  assert.doesNotMatch(handler, /process\.env|getSql\(|saas-billing|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET/);
  assert.match(handler, /sbg_accept_verified_payment_event|acceptVerifiedPaymentEvent/);
  assert.match(guest, /throw new GuestCheckoutClosed\(\)/);
  assert.doesNotMatch(db, /aether_payment_gateway|aether_expiry_runner/);
  assert.doesNotMatch(expiry, /pg_cron|cron\.schedule|getSql/);
});

test("a bad signature never reaches the database", async () => {
  let calls = 0;
  const db = {
    async query() {
      calls += 1;
      throw new Error("database must not be called");
    },
  };
  const raw = eventBody({});
  const missing = await handleGuestPaymentWebhook({ rawBody: raw, signatureHeader: sign(raw), secret: "", db });
  assert.equal(missing.status, 503);
  assert.equal(missing.body.outcome, "secret_unavailable");
  const bad = await handleGuestPaymentWebhook({
    rawBody: raw,
    signatureHeader: sign(raw, "other-secret"),
    secret: SECRET,
    db,
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.outcome, "invalid_signature");
  assert.equal(verifyGuestPaymentSignature(raw, sign(raw, SECRET, 1), SECRET, 1_000_000), false);
  const stale = await handleGuestPaymentWebhook({
    rawBody: raw,
    signatureHeader: sign(raw, SECRET, 1),
    secret: SECRET,
    db,
    nowMs: 1_000_000,
  });
  assert.equal(stale.status, 400);
  assert.equal(calls, 0);
});

test("malformed, unknown, and session-expiry events are not treated as payment success", async () => {
  let calls = 0;
  const db = {
    async query() {
      calls += 1;
      throw new Error("database must not be called");
    },
  };
  const badJson = "{";
  const malformed = await handleGuestPaymentWebhook({
    rawBody: badJson,
    signatureHeader: sign(badJson),
    secret: SECRET,
    db,
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.outcome, "invalid_json");
  const unknown = JSON.stringify({
    id: "evt_unknown_s4",
    type: "payment_intent.succeeded",
    account: "acct_hotel_s4",
    data: { object: { id: "pi_unknown" } },
  });
  const unknownResult = await handleGuestPaymentWebhook({
    rawBody: unknown,
    signatureHeader: sign(unknown),
    secret: SECRET,
    db,
  });
  assert.equal(unknownResult.status, 409);
  assert.equal(unknownResult.body.outcome, "uncorrelated");
  const saas = JSON.stringify({
    id: "evt_saas_s4",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_s4" } },
  });
  const saasResult = await handleGuestPaymentWebhook({
    rawBody: saas,
    signatureHeader: sign(saas),
    secret: SECRET,
    db,
  });
  assert.equal(saasResult.status, 409);
  assert.equal(saasResult.body.outcome, "uncorrelated");
  assert.equal(calls, 0);
});

test("capacity latch fails closed and an uncorrelated refund stays retryable", async () => {
  assert.equal(
    await capacityWebhookLatch({ async query() { return [{ present: false }]; } }, "00000000-0000-4000-8000-000000000010"),
    "legacy",
  );
  assert.equal(
    await capacityWebhookLatch({
      async query(text: string) {
        return text.includes("information_schema") ? [{ present: true }] : [{ capacity_managed: false }];
      },
    }, "00000000-0000-4000-8000-000000000010"),
    "legacy",
  );
  assert.equal(
    await capacityWebhookLatch({
      async query(text: string) {
        return text.includes("information_schema") ? [{ present: true }] : [{ capacity_managed: true }];
      },
    }, "00000000-0000-4000-8000-000000000010"),
    "fail_closed",
  );
  assert.equal(
    await capacityWebhookLatch({
      async query(text: string) {
        return text.includes("information_schema") ? [{ present: true }] : [];
      },
    }, "00000000-0000-4000-8000-000000000010"),
    "unproven",
  );
  await assert.rejects(
    () => capacityWebhookLatch({ async query() { throw new Error("down"); } }, "00000000-0000-4000-8000-000000000010"),
    CapacityLatchUnavailable,
  );

  const refund = JSON.stringify({
    id: "evt_refund_missing",
    type: "charge.refunded",
    account: "acct_hotel_s4",
    data: { object: { id: "ch_missing", payment_intent: "pi_not_stored" } },
  });
  let calls = 0;
  const result = await handleGuestPaymentWebhook({
    rawBody: refund,
    signatureHeader: sign(refund),
    secret: SECRET,
    db: {
      async query() {
        calls += 1;
        return [];
      },
    },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.outcome, "uncorrelated");
  assert.equal(calls, 1);
});

test("a transaction conflict is retryable and a payment conflict is not retried twice", async () => {
  const row = {
    correlate_booking_id: "00000000-0000-4000-8000-000000000010",
    correlate_payment_id: "00000000-0000-4000-8000-000000000011",
    correlate_executing_provider_id: "00000000-0000-4000-8000-000000000012",
    correlate_session_id: "cs_stage4c",
    correlate_amount_minor: 4500,
    correlate_currency: "EUR",
    correlate_capacity_managed: true,
    correlate_lifecycle: "awaiting_payment",
    correlate_payment_status: "pending",
  };
  const raw = eventBody({});
  let conflictCalls = 0;
  const conflict = await handleGuestPaymentWebhook({
    rawBody: raw,
    signatureHeader: sign(raw),
    secret: SECRET,
    db: {
      async query(text: string) {
        conflictCalls += 1;
        if (text.includes("sbg_correlate_guest_payment")) return [row];
        throw Object.assign(new Error("payment_transition_conflict"), { code: "40001" });
      },
    },
  });
  assert.equal(conflict.status, 503);
  assert.equal(conflictCalls, 2);

  let retryCalls = 0;
  const retried = await handleGuestPaymentWebhook({
    rawBody: raw,
    signatureHeader: sign(raw),
    secret: SECRET,
    db: {
      async query(text: string) {
        retryCalls += 1;
        if (text.includes("sbg_correlate_guest_payment")) return [row];
        if (retryCalls === 2) throw Object.assign(new Error("capacity_lock_retry"), { code: "40001" });
        return [{
          transition_outcome: "confirmed_paid",
          transition_lifecycle: "confirmed_paid",
          transition_payment_status: "paid",
          transition_event_recorded: true,
        }];
      },
    },
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.outcome, "confirmed_paid");
  assert.equal(retryCalls, 3);
});

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
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
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
    await admin.end().catch(() => undefined);
  }
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = "/neondb";
  return dbUrl.toString();
}

test("gateway, operator payee, refund, expiry, and forged admission", { timeout: 180_000 }, async () => {
  if (!ADMIN_URL) assert.fail("BLOCKED — LOCAL POSTGRESQL TEST NOT RUN");
  const adminUrl = new URL(ADMIN_URL);
  if (adminUrl.hostname !== "127.0.0.1" && adminUrl.hostname !== "localhost") {
    assert.fail(`BLOCKED — refusing non-local host ${adminUrl.hostname}`);
  }
  adminUrl.pathname = "/postgres";
  const dbUrl = await resetCluster(adminUrl);
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  const gatewayUrl = new URL(dbUrl);
  gatewayUrl.username = "aether_payment_gateway";
  gatewayUrl.password = "";
  const gateway = new pg.Client({ connectionString: gatewayUrl.toString() });
  try {
    const files = migrationFiles();
    assert.equal(files.at(-1), "0079_gate2_bound_payee_test_mode.sql");
    for (const name of files) {
      await root.query(readFileSync(new URL(name, MIGRATIONS), "utf8"));
    }

    const roles = await root.query<{ rolname: string; rolcanlogin: boolean; rolpassword: string | null }>(
      `select rolname, rolcanlogin, rolpassword
         from pg_authid
        where rolname in ('aether_payment_gateway', 'aether_expiry', 'aether_expiry_runner', 'aether_webhook')
        order by rolname`,
    );
    const byRole = new Map(roles.rows.map((row) => [row.rolname, row]));
    assert.equal(byRole.get("aether_payment_gateway")!.rolcanlogin, true);
    assert.equal(byRole.get("aether_payment_gateway")!.rolpassword, null);
    assert.equal(byRole.get("aether_expiry_runner")!.rolcanlogin, true);
    assert.equal(byRole.get("aether_expiry_runner")!.rolpassword, null);
    assert.equal(byRole.get("aether_expiry")!.rolcanlogin, false);
    assert.equal(byRole.get("aether_webhook")!.rolcanlogin, false);

    const members = await root.query<{ member: string; role: string }>(
      `select member_role.rolname as member, granted.rolname as role
         from pg_auth_members m
         join pg_roles member_role on member_role.oid = m.member
         join pg_roles granted on granted.oid = m.roleid
        where member_role.rolname in (
          'aether_payment_gateway', 'aether_expiry_runner', 'aether_expiry', 'aether_webhook', 'aether_app'
        )
           or granted.rolname in ('aether_payment_gateway', 'aether_expiry_runner', 'aether_webhook', 'aether_expiry')
        order by 1, 2`,
    );
    assert.deepEqual(members.rows, [
      { member: "aether_expiry_runner", role: "aether_expiry" },
      { member: "aether_payment_gateway", role: "aether_webhook" },
    ]);

    const gatewayFns = (await root.query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('aether_payment_gateway', p.oid, 'execute')
          and not has_function_privilege('public', p.oid, 'execute')
        order by p.proname`,
    )).rows.map((row) => row.proname);
    assert.deepEqual(gatewayFns, ["sbg_accept_verified_payment_event", "sbg_correlate_guest_payment"]);
    const denied = await root.query<{
      app_accept: boolean;
      gateway_apply: boolean;
      gateway_reserve: boolean;
      gateway_expire: boolean;
      gateway_settle: boolean;
      gateway_update: boolean;
      gateway_select: boolean;
      runner_accept: boolean;
      runner_expire: boolean;
      runner_update: boolean;
    }>(
      `select
         has_function_privilege('aether_app', 'public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text)', 'execute') as app_accept,
         has_function_privilege('aether_payment_gateway', 'public.sbg_apply_payment_event(text, text, uuid, uuid, text, text, text)', 'execute') as gateway_apply,
         has_function_privilege('aether_payment_gateway', 'public.sbg_reserve_capacity(uuid, uuid, uuid, uuid)', 'execute') as gateway_reserve,
         has_function_privilege('aether_payment_gateway', 'public.sbg_expire_provisional_holds(integer)', 'execute') as gateway_expire,
         has_function_privilege('aether_payment_gateway', 'public.sbg_capacity_settle(uuid, text)', 'execute') as gateway_settle,
         has_table_privilege('aether_payment_gateway', 'public.bookings', 'update') as gateway_update,
         has_table_privilege('aether_payment_gateway', 'public.sbg_booking_payments', 'select') as gateway_select,
         has_function_privilege('aether_expiry_runner', 'public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text)', 'execute') as runner_accept,
         has_function_privilege('aether_expiry_runner', 'public.sbg_expire_provisional_holds(integer)', 'execute') as runner_expire,
         has_table_privilege('aether_expiry_runner', 'public.bookings', 'update') as runner_update`,
    );
    const flags = denied.rows[0]!;
    assert.equal(flags.app_accept, false);
    assert.equal(flags.gateway_apply, false);
    assert.equal(flags.gateway_reserve, false);
    assert.equal(flags.gateway_expire, false);
    assert.equal(flags.gateway_settle, false);
    assert.equal(flags.gateway_update, false);
    assert.equal(flags.gateway_select, false);
    assert.equal(flags.runner_accept, false);
    assert.equal(flags.runner_expire, true);
    assert.equal(flags.runner_update, false);

    await gateway.connect();
    await root.query(
      `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
       values ('user-1','Ada','ada@example.com',true,now(),now()),
              ('user-2','Nia','nia@example.com',true,now(),now())`,
    );
    const hotelOrg = (await root.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Hotel', 'user-1', 'hotel') returning id`,
    )).rows[0]!.id;
    const hotel = (await root.query<{ id: string }>(
      `insert into hotels (code, name, iana_timezone, organisation_id)
       values ('s4', 'Stage Hotel', 'Europe/Athens', $1::uuid) returning id`,
      [hotelOrg],
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity) values ($1::uuid, 'active', 1)`,
      [hotelOrg],
    );
    await root.query(
      `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
       values ($1::uuid, $2::uuid, 'user-1')`,
      [hotelOrg, hotel],
    );
    const provider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s4p', 'Hotel Provider', 'in_house') returning id`,
    )).rows[0]!.id;
    await root.query(
      `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
      [hotel, provider],
    );
    await root.query(
      `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode) values ($1::uuid, 'acct_hotel_conn', false)`,
      [hotel],
    );
    await root.query(
      `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
       values ($1::uuid, 'acct_hotel_s4', false)`,
      [hotelOrg],
    );

    async function fleetFor(owner: string, code: string, property = hotel) {
      const airport = (await root.query<{ id: string }>(
        `insert into sbg_fleet_locations (provider_id, kind, code, name)
         values ($1::uuid, 'airport', $2, 'Airport') returning id`,
        [owner, `${code}-ath`],
      )).rows[0]!.id;
      const door = (await root.query<{ id: string }>(
        `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
         values ($1::uuid, 'hotel', $2::uuid, $3, 'Door') returning id`,
        [owner, property, `${code}-door`],
      )).rows[0]!.id;
      await root.query(
        `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
         values ($1::uuid, $2::uuid, $3::uuid, 45)`,
        [owner, airport, door],
      );
      await root.query(
        `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
         values ($1::uuid, $2::uuid, $3::uuid, 35), ($1::uuid, $3::uuid, $2::uuid, 30)`,
        [owner, airport, door],
      );
      for (let isodow = 1; isodow <= 7; isodow += 1) {
        await root.query(
          `insert into sbg_provider_hours (provider_id, isodow, opens_local, closes_local)
           values ($1::uuid, $2, '08:00', '20:00')`,
          [owner, isodow],
        );
      }
      const van = (await root.query<{ id: string }>(
        `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
         values ($2, 7, 4, true, $1::uuid, $1::uuid) returning id`,
        [owner, `${code}-van`],
      )).rows[0]!.id;
      return { airport, door, van };
    }
    const hotelFleet = await fleetFor(provider, "hotel");

    let n = 0;
    async function booking(owner: string, date: string, time = "10:00", property = hotel): Promise<string> {
      n += 1;
      return (await root.query<{ id: string }>(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, passenger_count, luggage_count,
           pickup_text, destination_text, human_reference, confirmation_token
         ) values (
           $1::uuid, $2::uuid, $3::date, $4::time, 60,
           'Ada', '+302100000000', 'ada@example.com', 2, 1,
           'Door', 'Airport', $5, $6
         ) returning id`,
        [property, owner, date, time, `S4-${n}`, `token-s4-${n}`],
      )).rows[0]!.id;
    }
    async function pay(bookingId: string, session: string): Promise<string> {
      const id = (await root.query<{ id: string }>(
        `insert into sbg_booking_payments (
           booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url
         ) values ($1::uuid, 4500, 'EUR', $2, 'https://checkout.stripe.test/s4') returning id`,
        [bookingId, session],
      )).rows[0]!.id;
      await root.query(`select * from public.sbg_bind_payment_authority($1::uuid)`, [bookingId]);
      return id;
    }
    async function reserve(bookingId: string, fleet: { airport: string; door: string; van: string }) {
      const outcome = (await root.query<{ reserve_outcome: string; reserve_rejection: string | null }>(
        `select reserve_outcome, reserve_rejection from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        [bookingId, fleet.airport, fleet.door, fleet.van],
      )).rows[0]!;
      assert.equal(outcome.reserve_outcome, "reserved", outcome.reserve_rejection ?? "");
    }
    async function state(bookingId: string) {
      return (await root.query<{
        lifecycle_state: string;
        vehicle_id: string | null;
        capacity_managed: boolean;
        status: string | null;
      }>(
        `select b.lifecycle_state, b.vehicle_id::text, b.capacity_managed, p.status
           from bookings b
           left join sbg_booking_payments p on p.booking_id = b.id
          where b.id = $1::uuid`,
        [bookingId],
      )).rows[0]!;
    }
    const gatewayDb = {
      query: <T>(text: string, params?: unknown[]) => gateway.query(text, params).then((result) => result.rows as T[]),
    };

    const paidBooking = await booking(provider, "2026-06-03");
    await reserve(paidBooking, hotelFleet);
    const paidPayment = await pay(paidBooking, "cs_s4_paid");
    const paidRaw = eventBody({
      id: "evt_s4_paid",
      account: "acct_hotel_s4",
      data: {
        object: {
          id: "cs_s4_paid",
          amount_total: 4500,
          currency: "eur",
          payment_status: "paid",
          payment_intent: "pi_s4_paid",
          metadata: { booking_id: paidBooking, payment_id: paidPayment },
        },
      },
    });
    const paid = await handleGuestPaymentWebhook({
      rawBody: paidRaw,
      signatureHeader: sign(paidRaw),
      secret: SECRET,
      db: gatewayDb,
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.outcome, "confirmed_paid");
    assert.equal((await state(paidBooking)).vehicle_id === null, false);
    const duplicate = await handleGuestPaymentWebhook({
      rawBody: paidRaw,
      signatureHeader: sign(paidRaw),
      secret: SECRET,
      db: gatewayDb,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.outcome, "duplicate");

    const lateBooking = await booking(provider, "2026-06-04", "16:00");
    await reserve(lateBooking, hotelFleet);
    const latePayment = await pay(lateBooking, "cs_s4_late");
    await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
    await root.query(`update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid`, [lateBooking]);
    await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    const lateRaw = eventBody({
      id: "evt_s4_late",
      account: "acct_hotel_s4",
      data: {
        object: {
          id: "cs_s4_late",
          amount_total: 4500,
          currency: "eur",
          payment_status: "paid",
          payment_intent: "pi_s4_late",
          metadata: { booking_id: lateBooking, payment_id: latePayment },
        },
      },
    });
    const late = await handleGuestPaymentWebhook({ rawBody: lateRaw, signatureHeader: sign(lateRaw), secret: SECRET, db: gatewayDb });
    assert.equal(late.status, 200);
    assert.equal(late.body.outcome, "late_payment");
    const lateState = await state(lateBooking);
    assert.equal(lateState.lifecycle_state, "expired");
    assert.equal(lateState.vehicle_id, null);
    assert.notEqual(lateState.lifecycle_state, "confirmed_paid");

    const refundBooking = await booking(provider, "2026-06-05");
    await reserve(refundBooking, hotelFleet);
    const refundPayment = await pay(refundBooking, "cs_s4_refund");
    const refundPayRaw = eventBody({
      id: "evt_s4_refund_pay",
      account: "acct_hotel_s4",
      data: {
        object: {
          id: "cs_s4_refund",
          amount_total: 4500,
          currency: "eur",
          payment_status: "paid",
          payment_intent: "pi_s4_refund",
          metadata: { booking_id: refundBooking, payment_id: refundPayment },
        },
      },
    });
    assert.equal((await handleGuestPaymentWebhook({
      rawBody: refundPayRaw,
      signatureHeader: sign(refundPayRaw),
      secret: SECRET,
      db: gatewayDb,
    })).body.outcome, "confirmed_paid");
    const refundRaw = JSON.stringify({
      id: "evt_s4_refund",
      type: "charge.refunded",
      account: "acct_hotel_s4",
      data: { object: { id: "ch_s4_refund", payment_intent: "pi_s4_refund", amount: 4500, currency: "eur" } },
    });
    const refunded = await handleGuestPaymentWebhook({
      rawBody: refundRaw,
      signatureHeader: sign(refundRaw),
      secret: SECRET,
      db: gatewayDb,
    });
    assert.equal(refunded.status, 200);
    assert.equal(refunded.body.outcome, "refunded");
    assert.equal((await state(refundBooking)).vehicle_id, null);

    const failBooking = await booking(provider, "2026-06-08");
    await reserve(failBooking, hotelFleet);
    const failPayment = await pay(failBooking, "cs_s4_fail");
    const failRaw = eventBody({
      id: "evt_s4_fail",
      type: "checkout.session.async_payment_failed",
      account: "acct_hotel_s4",
      data: {
        object: {
          id: "cs_s4_fail",
          amount_total: 4500,
          currency: "eur",
          payment_status: "unpaid",
          metadata: { booking_id: failBooking, payment_id: failPayment },
        },
      },
    });
    const failed = await handleGuestPaymentWebhook({ rawBody: failRaw, signatureHeader: sign(failRaw), secret: SECRET, db: gatewayDb });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.outcome, "payment_failed");
    assert.equal((await state(failBooking)).vehicle_id, null);
    const afterFailRaw = eventBody({
      id: "evt_s4_after_fail",
      account: "acct_hotel_s4",
      data: {
        object: {
          id: "cs_s4_fail",
          amount_total: 4500,
          currency: "eur",
          payment_status: "paid",
          payment_intent: "pi_s4_after_fail",
          metadata: { booking_id: failBooking, payment_id: failPayment },
        },
      },
    });
    const afterFail = await handleGuestPaymentWebhook({
      rawBody: afterFailRaw,
      signatureHeader: sign(afterFailRaw),
      secret: SECRET,
      db: gatewayDb,
    });
    assert.equal(afterFail.status, 200);
    assert.equal(afterFail.body.outcome, "late_payment");
    assert.notEqual((await state(failBooking)).lifecycle_state, "confirmed_paid");

    const sessionBooking = await booking(provider, "2026-06-06");
    await reserve(sessionBooking, hotelFleet);
    const sessionPayment = await pay(sessionBooking, "cs_s4_session");
    const sessionRaw = eventBody({
      id: "evt_s4_session",
      type: "checkout.session.expired",
      account: "acct_hotel_s4",
      data: {
        object: {
          id: "cs_s4_session",
          amount_total: 4500,
          currency: "eur",
          payment_status: "unpaid",
          metadata: { booking_id: sessionBooking, payment_id: sessionPayment },
        },
      },
    });
    const sessionExpired = await handleGuestPaymentWebhook({
      rawBody: sessionRaw,
      signatureHeader: sign(sessionRaw),
      secret: SECRET,
      db: gatewayDb,
    });
    assert.equal(sessionExpired.status, 200);
    assert.equal(sessionExpired.body.outcome, "payment_canceled");
    const sessionState = await state(sessionBooking);
    assert.equal(sessionState.lifecycle_state, "awaiting_payment");
    assert.notEqual(sessionState.vehicle_id, null);
    assert.equal(sessionState.status, "expired");

    const operatorOrg = (await root.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Operator', 'user-2', 'transfer_operator') returning id`,
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity) values ($1::uuid, 'active', 1)`,
      [operatorOrg],
    );
    await root.query(
      `update sbg_organisation_billing set licensed_quantity = 2 where organisation_id = $1::uuid`,
      [hotelOrg],
    );
    const operatorProperty = (await root.query<{ id: string }>(
      `insert into hotels (code, name, iana_timezone, organisation_id)
       values ('s4b', 'Stage Annex', 'Europe/Athens', $1::uuid) returning id`,
      [hotelOrg],
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
       values ($1::uuid, $2::uuid, 'user-1')`,
      [hotelOrg, operatorProperty],
    );
    await root.query(
      `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode)
       values ($1::uuid, 'acct_property_s4', false)`,
      [operatorProperty],
    );
    const operator = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s4o', 'Operator Provider', 'external') returning id`,
    )).rows[0]!.id;
    await root.query(
      `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
      [operatorProperty, operator],
    );
    await root.query(
      `insert into sbg_operator_property_grants (operator_organisation_id, hotel_id, granted_by_user_id)
       values ($1::uuid, $2::uuid, 'user-1')`,
      [operatorOrg, operatorProperty],
    );
    await root.query(
      `insert into sbg_operator_provider_authorisations
         (operator_organisation_id, hotel_id, provider_id, authorised_by_user_id)
       values ($1::uuid, $2::uuid, $3::uuid, 'user-1')`,
      [operatorOrg, operatorProperty, operator],
    );
    await root.query(
      `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
       values ($1::uuid, 'acct_operator_s4', false)`,
      [operatorOrg],
    );
    const operatorFleet = await fleetFor(operator, "op", operatorProperty);
    const operatorBooking = await booking(operator, "2026-06-10", "10:00", operatorProperty);
    await reserve(operatorBooking, operatorFleet);
    const operatorPayment = await pay(operatorBooking, "cs_s4_operator");
    const operatorRaw = eventBody({
      id: "evt_s4_operator",
      account: "acct_operator_s4",
      data: {
        object: {
          id: "cs_s4_operator",
          amount_total: 4500,
          currency: "eur",
          payment_status: "paid",
          payment_intent: "pi_s4_operator",
          metadata: { booking_id: operatorBooking, payment_id: operatorPayment },
        },
      },
    });
    const operatorPaid = await handleGuestPaymentWebhook({
      rawBody: operatorRaw,
      signatureHeader: sign(operatorRaw),
      secret: SECRET,
      db: gatewayDb,
    });
    assert.equal(operatorPaid.status, 200);
    assert.equal(operatorPaid.body.outcome, "confirmed_paid");

    const wrongAccountBooking = await booking(operator, "2026-06-10", "14:00", operatorProperty);
    await reserve(wrongAccountBooking, operatorFleet);
    const wrongPayment = await pay(wrongAccountBooking, "cs_s4_wrong");
    const wrongRaw = eventBody({
      id: "evt_s4_wrong",
      account: "acct_property_s4",
      data: {
        object: {
          id: "cs_s4_wrong",
          amount_total: 4500,
          currency: "eur",
          payment_status: "paid",
          payment_intent: "pi_s4_wrong",
          metadata: { booking_id: wrongAccountBooking, payment_id: wrongPayment },
        },
      },
    });
    const wrong = await handleGuestPaymentWebhook({ rawBody: wrongRaw, signatureHeader: sign(wrongRaw), secret: SECRET, db: gatewayDb });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.outcome, "hotel_account_not_payee");
    assert.equal((await state(wrongAccountBooking)).lifecycle_state, "awaiting_payment");
    const wrongEvents = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_stripe_events where event_id = 'evt_s4_wrong'`,
    );
    assert.equal(wrongEvents.rows[0]!.n, 0);

    const legacy = await booking(operator, "2026-06-11", "10:00", operatorProperty);
    await root.query(`select * from public.sbg_open_provisional_hold($1::uuid, 1800)`, [legacy]);
    const legacyPayment = await pay(legacy, "cs_s4_legacy");
    const legacyRaw = eventBody({
      id: "evt_s4_legacy",
      account: "acct_operator_s4",
      data: {
        object: {
          id: "cs_s4_legacy",
          amount_total: 4500,
          currency: "eur",
          payment_status: "paid",
          payment_intent: "pi_s4_legacy",
          metadata: { booking_id: legacy, payment_id: legacyPayment },
        },
      },
    });
    const legacyResult = await handleGuestPaymentWebhook({
      rawBody: legacyRaw,
      signatureHeader: sign(legacyRaw),
      secret: SECRET,
      db: gatewayDb,
    });
    assert.equal(legacyResult.status, 503);
    assert.equal(legacyResult.body.outcome, "legacy_not_admitted");
    assert.equal((await state(legacy)).lifecycle_state, "awaiting_payment");

    await root.query("set role aether_app");
    await assert.rejects(
      () => root.query(
        `select * from public.sbg_accept_verified_payment_event(
           true, 'evt_forged', 'checkout.session.completed', $1::uuid, $2::uuid, $3::uuid,
           'acct_hotel_s4', 'cs_s4_paid', 4500, 'EUR', 'paid', 'pi_forged'
         )`,
        [paidBooking, paidPayment, provider],
      ),
      (err: { code?: string }) => err.code === "42501",
    );
    await root.query("reset role");

    const due = await booking(provider, "2026-06-12", "12:00");
    await reserve(due, hotelFleet);
    await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
    await root.query(`update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid`, [due]);
    await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    await root.query("set role aether_expiry_runner");
    const expiryDb = {
      query: (text: string, params?: unknown[]) => root.query(text, params).then((result) => result.rows),
    };
    await assert.rejects(() => runExpiryWorker(expiryDb, 0), /unsafe_expiry_limit/);
    const expired = await runExpiryWorker(expiryDb);
    assert.equal(expired.some((row) => row.bookingId === due), true);
    const repeated = await runExpiryWorker(expiryDb);
    assert.deepEqual(repeated, []);
    await root.query("reset role");
    assert.equal((await state(due)).vehicle_id, null);
    await root.query("set role aether_payment_gateway");
    await assert.rejects(
      () => root.query(`select * from public.sbg_expire_provisional_holds(1)`),
      (err: { code?: string }) => err.code === "42501",
    );
    await root.query("reset role");
  } finally {
    await gateway.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
});
