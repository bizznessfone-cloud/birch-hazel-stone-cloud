/**
 * Gate 2 Stage 6D. TEST guest payment uses the bound payee.
 * Stripe is mocked. Fails closed when STAGE_G2S5_PG_URL is unset.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";
import { createBooking, type BookingDb } from "./booking.ts";
import { acceptIsolatedGuestPaymentTest } from "./guest-payment-gateway-entry.ts";
import {
  GuestCheckoutClosed,
  GuestPaymentTestError,
  startGuestPaymentForBooking,
  type GuestCheckoutRequest,
} from "./guest-payment-fns.ts";
import { runLocalExpiryOnce } from "./expiry-runner-local.ts";
import { startLocalGuestPaymentTestListener } from "./guest-payment-test-listener.ts";
import {
  assertDisposableDatabaseIdentity,
  assertGuestPaymentTestProcess,
  GuestPaymentIsolationError,
  readAuthorisedClusterSystemIdentifier,
} from "./guest-payment-test-isolation.ts";

const ADMIN_URL = process.env.STAGE_G2S5_PG_URL;
const MIGRATIONS = new URL("../../../migrations/", import.meta.url);
const TEST_ENV = { SBG_GUEST_PAYMENT_TEST: "true", STRIPE_SECRET_KEY: "sk_test_stage6d", STRIPE_WEBHOOK_SECRET: "whsec_saas" };
const WEBHOOK_SECRET = "whsec_guest_test";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
}

function bookingDb(client: pg.Client): BookingDb {
  return {
    query: async <T>(text: string, params?: unknown[]) => (await client.query(text, params)).rows as T[],
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      await client.query("begin");
      const inner: BookingDb = {
        query: async <R>(text: string, params?: unknown[]) => (await client.query(text, params)).rows as R[],
        transaction() {
          throw new Error("nested");
        },
      };
      try {
        const result = await fn(inner);
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    },
  };
}

function sign(payload: string, secret = WEBHOOK_SECRET, now = 1_700_000_000): string {
  const digest = createHmac("sha256", secret).update(`${now}.${payload}`).digest("hex");
  return `t=${now},v1=${digest}`;
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
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [row.datname],
      );
      await admin.query(`drop database if exists ${row.datname}`);
    }
    for (const role of [
      "sbg_fleet_writer", "aether_payment_gateway", "aether_expiry_runner", "aether_expiry",
      "aether_app", "aether_runtime", "aether_webhook", "aether_mailer", "sbg_capacity_writer",
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

test("stage 6D source stays test-only and off the SaaS webhook", () => {
  const files = migrationFiles();
  const sql = readFileSync(new URL("0077_gate2_capacity_guest_payment.sql", MIGRATIONS), "utf8");
  const generation = readFileSync(new URL("0078_gate2_capacity_checkout_claim_generation.sql", MIGRATIONS), "utf8");
  const payment = readFileSync(new URL("./guest-payment-fns.ts", import.meta.url), "utf8");
  const entry = readFileSync(new URL("./guest-payment-gateway-entry.ts", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../../routes/api/stripe/webhook.ts", import.meta.url), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  const proof = readFileSync(new URL("0079_gate2_bound_payee_test_mode.sql", MIGRATIONS), "utf8");
  assert.equal(files.at(-1), "0079_gate2_bound_payee_test_mode.sql");
  assert.equal(files.includes("0077_gate2_capacity_guest_payment.sql"), true);
  assert.equal(preflight.includes("0077_gate2_capacity_guest_payment.sql"), false);
  assert.equal(preflight.includes("0078_gate2_capacity_checkout_claim_generation.sql"), false);
  assert.equal(preflight.includes("0079_gate2_bound_payee_test_mode.sql"), false);
  assert.match(proof, /sbg_bound_payee_is_test_mode/);
  assert.match(proof, /returns boolean/);
  assert.doesNotMatch(proof, /grant\s+select\s+on\s+table\s+public\.sbg_organisation_stripe_connections/i);
  assert.doesNotMatch(sql, /from public\.sbg_stripe_connections|join public\.sbg_stripe_connections/);
  assert.doesNotMatch(generation, /from public\.sbg_stripe_connections|join public\.sbg_stripe_connections/);
  assert.match(generation, /checkout_claim_generation/);
  assert.match(generation, /sbg_settle_capacity_checkout_attempt/);
  assert.match(sql, /sbg_prepare_capacity_guest_payment/);
  assert.match(payment, /throw new GuestCheckoutClosed\(\)/);
  assert.match(payment, /bound\.stripeAccountId/);
  assert.doesNotMatch(payment, /sbg_prepare_booking_payment|SBG_SAAS_COMMERCE|SBG_DOMAIN_B_LIVE_CHECKOUT/);
  assert.match(entry, /handleGuestPaymentWebhook/);
  assert.match(entry, /verifyGuestPaymentSignature/);
  assert.match(entry, /live_event_rejected/);
  const suite = readFileSync(new URL("./guest-payment-test.test.ts", import.meta.url), "utf8");
  assert.match(suite, /signed LIVE webhook leaves the PostgreSQL booking unchanged/);
  assert.match(suite, /exactly one paid record survives replay/);
  assert.match(suite, /wrong connected account cannot confirm/);
  assert.match(suite, /wrong Checkout Session cannot confirm/);
  assert.match(suite, /wrong amount cannot confirm/);
  assert.match(suite, /wrong currency cannot confirm/);
  assert.doesNotMatch(readFileSync(new URL("./payment-gateway.ts", import.meta.url), "utf8"), /live_event_rejected/);
  assert.doesNotMatch(webhook, /acceptIsolatedGuestPaymentTest|handleGuestPaymentWebhook/);
  assert.match(webhook, /capacity_payment_unmounted/);
  assert.doesNotMatch(webhook, /startLocalGuestPaymentTestListener|runLocalExpiryOnce/);
  const listener = readFileSync(new URL("./guest-payment-test-listener.ts", import.meta.url), "utf8");
  const expiry = readFileSync(new URL("./expiry-runner.ts", import.meta.url), "utf8");
  assert.match(listener, /host: LOCAL_TEST_LISTENER_HOST/);
  assert.doesNotMatch(listener, /0\.0\.0\.0/);
  assert.doesNotMatch(expiry, /pg_cron|cron\.schedule|runLocalExpiryOnce/);
});

test("TEST guards reject live credentials, live flags, and an unauthorised database", () => {
  assert.throws(
    () => assertGuestPaymentTestProcess({ STRIPE_SECRET_KEY: "sk_live_no", SBG_GUEST_PAYMENT_TEST: "true" }),
    (err: unknown) => err instanceof GuestPaymentIsolationError && err.code === "live_credentials_rejected",
  );
  assert.throws(
    () => assertGuestPaymentTestProcess({ STRIPE_SECRET_KEY: "rk_live_no" }),
    (err: unknown) => err instanceof GuestPaymentIsolationError && err.code === "live_credentials_rejected",
  );
  assert.throws(
    () => assertGuestPaymentTestProcess({ STRIPE_SECRET_KEY: "sk_test_ok", SBG_DOMAIN_B_LIVE_CHECKOUT: "true" }),
    (err: unknown) => err instanceof GuestPaymentIsolationError && err.code === "live_payment_flag",
  );
  assert.throws(
    () => assertGuestPaymentTestProcess({ STRIPE_SECRET_KEY: "sk_test_ok", SBG_SAAS_COMMERCE: "live" }),
    (err: unknown) => err instanceof GuestPaymentIsolationError && err.code === "live_payment_flag",
  );
  const authorised = {
    dataDirectory: "/tmp/s1pg/data",
    listenAddresses: "127.0.0.1",
    port: "54329",
    serverAddr: "127.0.0.1/32",
    databaseName: "neondb",
    inRecovery: false,
    systemIdentifier: readAuthorisedClusterSystemIdentifier().toString(),
  };
  assert.doesNotThrow(() => assertDisposableDatabaseIdentity(authorised));
  for (const facts of [
    { ...authorised, serverAddr: "10.0.0.8/32" },
    { ...authorised, serverAddr: null },
    { ...authorised, dataDirectory: "/var/lib/postgresql/18/main" },
    { ...authorised, listenAddresses: "*" },
    { ...authorised, databaseName: "postgres" },
    { ...authorised, inRecovery: true },
    { ...authorised, port: null },
    { ...authorised, systemIdentifier: "1" },
  ]) {
    assert.throws(
      () => assertDisposableDatabaseIdentity(facts),
      (err: unknown) => err instanceof GuestPaymentIsolationError && err.code === "database_not_authorised",
    );
  }
  let queries = 0;
  const db = {
    async query() {
      queries += 1;
      return [];
    },
  };
  return Promise.all([
    assert.rejects(
      () => startGuestPaymentForBooking(db, "token", "https://guest.test", { ...TEST_ENV, STRIPE_SECRET_KEY: "sk_live_stage6d" }),
      (err: unknown) => err instanceof GuestPaymentTestError && err.code === "live_credentials_rejected",
    ),
    assert.rejects(
      () => startGuestPaymentForBooking(db, "token", "https://guest.test", { ...TEST_ENV, SBG_DOMAIN_B_LIVE_CHECKOUT: "true" }),
      (err: unknown) => err instanceof GuestPaymentTestError && err.code === "live_payment_flag",
    ),
  ]).then(() => {
    assert.equal(queries, 0);
  });
});

test("isolated entry refuses the SaaS secret before the database", async () => {
  const db = {
    async query() {
      throw new Error("database must not be reached");
    },
  };
  const raw = "{}";
  const shared = await acceptIsolatedGuestPaymentTest({
    rawBody: raw,
    signatureHeader: sign(raw),
    webhookSecret: "whsec_saas",
    db,
    env: TEST_ENV,
  });
  assert.equal(shared.status, 503);
  assert.equal(shared.body.outcome, "secret_unavailable");
  const empty = await acceptIsolatedGuestPaymentTest({
    rawBody: raw,
    signatureHeader: sign(raw),
    webhookSecret: "",
    db,
    env: TEST_ENV,
  });
  assert.equal(empty.status, 503);
  assert.equal(empty.body.outcome, "secret_unavailable");
});

test("a signed LIVE event cannot mutate a TEST booking", async () => {
  let queries = 0;
  const db = {
    async query() {
      queries += 1;
      return [];
    },
  };
  const now = 1_700_000_000;
  const live = JSON.stringify({
    id: "evt_live_mode",
    type: "checkout.session.completed",
    account: "acct_1UKEFuFHnHoOWAJE",
    livemode: true,
    data: {
      object: {
        id: "cs_live",
        object: "checkout.session",
        mode: "payment",
        livemode: true,
        amount_total: 4500,
        currency: "eur",
        payment_status: "paid",
        metadata: {
          booking_id: "00000000-0000-4000-8000-000000000010",
          payment_id: "00000000-0000-4000-8000-000000000011",
        },
      },
    },
  });
  const rejected = await acceptIsolatedGuestPaymentTest({
    rawBody: live,
    signatureHeader: sign(live, WEBHOOK_SECRET, now),
    webhookSecret: WEBHOOK_SECRET,
    db,
    env: TEST_ENV,
    nowMs: now * 1000,
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.outcome, "live_event_rejected");
  const mismatchedObject = JSON.stringify({
    ...JSON.parse(live),
    livemode: false,
    data: { object: { ...JSON.parse(live).data.object, livemode: true } },
  });
  const objectRejected = await acceptIsolatedGuestPaymentTest({
    rawBody: mismatchedObject,
    signatureHeader: sign(mismatchedObject, WEBHOOK_SECRET, now),
    webhookSecret: WEBHOOK_SECRET,
    db,
    env: TEST_ENV,
    nowMs: now * 1000,
  });
  assert.equal(objectRejected.body.outcome, "live_event_rejected");
  const forged = JSON.stringify({
    ...JSON.parse(live),
    livemode: false,
    data: { object: { ...JSON.parse(live).data.object, livemode: false } },
  });
  const invalid = await acceptIsolatedGuestPaymentTest({
    rawBody: forged,
    signatureHeader: "t=1,v1=dead",
    webhookSecret: WEBHOOK_SECRET,
    db,
    env: TEST_ENV,
    nowMs: now * 1000,
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.outcome, "invalid_signature");
  assert.equal(queries, 0);
  const accepted = await acceptIsolatedGuestPaymentTest({
    rawBody: forged,
    signatureHeader: sign(forged, WEBHOOK_SECRET, now),
    webhookSecret: WEBHOOK_SECRET,
    db,
    env: TEST_ENV,
    nowMs: now * 1000,
  });
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.outcome, "uncorrelated");
  assert.equal(queries, 1);
});

test("bound payee, concurrency, and mocked payment lifecycle", { timeout: 180_000 }, async (t) => {
  if (!ADMIN_URL) assert.fail("BLOCKED — LOCAL POSTGRESQL TEST NOT RUN");
  const adminUrl = new URL(ADMIN_URL);
  if (adminUrl.hostname !== "127.0.0.1" && adminUrl.hostname !== "localhost") {
    assert.fail(`BLOCKED — refusing non-local host ${adminUrl.hostname}`);
  }
  adminUrl.pathname = "/postgres";
  const dbUrl = await resetCluster(adminUrl);
  const root = new pg.Client({ connectionString: dbUrl });
  const left = new pg.Client({ connectionString: dbUrl });
  const right = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await left.connect();
  await right.connect();
  const created: GuestCheckoutRequest[] = [];
  const expired: { accountId: string; sessionId: string }[] = [];
  const queued: Array<(session: { id: string; url: string }) => void> = [];
  let failStore = false;
  let queueCheckout = false;
  const deps = {
    async createCheckout(input: GuestCheckoutRequest) {
      created.push(input);
      if (failStore) {
        await root.query(`update sbg_booking_payments set status = 'failed' where id = $1::uuid`, [input.paymentId]);
      }
      if (queueCheckout) {
        return await new Promise<{ id: string; url: string }>((resolve) => {
          queued.push(resolve);
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { id: `cs_test_${created.length}`, url: `https://checkout.stripe.test/${created.length}` };
    },
    async expireCheckout(input: { accountId: string; sessionId: string }) {
      expired.push(input);
    },
  };
  try {
    for (const name of migrationFiles()) {
      await root.query(readFileSync(new URL(name, MIGRATIONS), "utf8"));
    }
    await root.query(
      `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt") values
       ('user-1','Ada','ada@example.com',true,now(),now()),
       ('user-2','Bea','bea@example.com',true,now(),now())`,
    );
    const hotelOrg = (await root.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Hotel Org', 'user-1', 'hotel') returning id`,
    )).rows[0]!.id;
    const operatorOrg = (await root.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Operator Org', 'user-2', 'transfer_operator') returning id`,
    )).rows[0]!.id;
    async function hotel(code: string) {
      return (await root.query<{ id: string }>(
        `insert into hotels (code, name, iana_timezone, organisation_id, status, currency)
         values ($1, $2, 'Europe/Athens', $3::uuid, 'live', 'EUR') returning id`,
        [code, code, hotelOrg],
      )).rows[0]!.id;
    }
    const inHouseHotel = await hotel("s6din");
    const operatorHotel = await hotel("s6dout");
    const inProvider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s6dinp', 'In House', 'in_house') returning id`,
    )).rows[0]!.id;
    const outProvider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s6doutp', 'Outside', 'external') returning id`,
    )).rows[0]!.id;
    await root.query(`update providers set reservation_mode = 'capacity' where id in ($1::uuid, $2::uuid)`, [inProvider, outProvider]);
    await root.query(
      `insert into hotel_provider_agreements (hotel_id, provider_id, active) values
       ($1::uuid, $2::uuid, true), ($3::uuid, $4::uuid, true)`,
      [inHouseHotel, inProvider, operatorHotel, outProvider],
    );
    async function destination(hotelId: string) {
      return (await root.query<{ id: string }>(
        `insert into hotel_destinations (hotel_id, kind, name, active, amount_minor)
         values ($1::uuid, 'airport', 'Airport', true, 4500) returning id`,
        [hotelId],
      )).rows[0]!.id;
    }
    const inDestination = await destination(inHouseHotel);
    const outDestination = await destination(operatorHotel);
    async function fleet(provider: string, hotelId: string, code: string) {
      const door = (await root.query<{ id: string }>(
        `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
         values ($1::uuid, 'hotel', $2::uuid, $3, $3) returning id`,
        [provider, hotelId, `${code}-door`],
      )).rows[0]!.id;
      const airport = (await root.query<{ id: string }>(
        `insert into sbg_fleet_locations (provider_id, kind, code, name)
         values ($1::uuid, 'airport', $2, $2) returning id`,
        [provider, `${code}-ath`],
      )).rows[0]!.id;
      await root.query(
        `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
         values ($1::uuid, $2::uuid, $3::uuid, 45), ($1::uuid, $3::uuid, $2::uuid, 70)`,
        [provider, door, airport],
      );
      await root.query(
        `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
         values ($1::uuid, $2::uuid, $3::uuid, 20), ($1::uuid, $3::uuid, $2::uuid, 20)`,
        [provider, door, airport],
      );
      for (let isodow = 1; isodow <= 7; isodow += 1) {
        await root.query(
          `insert into sbg_provider_hours (provider_id, isodow, opens_local, closes_local)
           values ($1::uuid, $2, '08:00', '20:00')`,
          [provider, isodow],
        );
      }
      await root.query(
        `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
         values ($2, 6, 4, true, $1::uuid, $1::uuid)`,
        [provider, code],
      );
      return { door, airport };
    }
    const inFleet = await fleet(inProvider, inHouseHotel, "in");
    const outFleet = await fleet(outProvider, operatorHotel, "out");
    await root.query(
      `insert into sbg_guest_destination_bindings (hotel_destination_id, hotel_id, provider_id, fleet_location_id)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid), ($5::uuid, $6::uuid, $7::uuid, $8::uuid)`,
      [inDestination, inHouseHotel, inProvider, inFleet.airport, outDestination, operatorHotel, outProvider, outFleet.airport],
    );
    await root.query(
      `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity, billing_interval)
       values ($1::uuid, 'active', 2, 'month'), ($2::uuid, 'active', 1, 'month')`,
      [hotelOrg, operatorOrg],
    );
    await root.query(
      `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
       values ($1::uuid, $2::uuid, 'user-1'), ($1::uuid, $3::uuid, 'user-1')`,
      [hotelOrg, inHouseHotel, operatorHotel],
    );
    await root.query(
      `insert into sbg_operator_property_grants (operator_organisation_id, hotel_id, granted_by_user_id)
       values ($1::uuid, $2::uuid, 'user-2')`,
      [operatorOrg, operatorHotel],
    );
    await root.query(
      `insert into sbg_operator_provider_authorisations
         (operator_organisation_id, hotel_id, provider_id, authorised_by_user_id)
       values ($1::uuid, $2::uuid, $3::uuid, 'user-2')`,
      [operatorOrg, operatorHotel, outProvider],
    );

    const db = bookingDb(root);
    function input(hotelCode: string, destinationId: string, date: string) {
      return {
        hotelCode,
        destinationId,
        transferDate: date,
        pickupTime: "10:00",
        durationMinutes: 60,
        guestName: "Ada Guest",
        guestPhone: "+302100000000",
        guestEmail: "ada@example.com",
        passengerCount: 1,
        luggageCount: 0,
        pickupText: "Door",
        direction: "from_hotel" as const,
      };
    }
    const first = await createBooking(db, input("s6din", inDestination, "2026-07-08"));
    await assert.rejects(
      () => startGuestPaymentForBooking(db, first.confirmationToken, "https://guest.test", TEST_ENV, deps),
      (err: unknown) => err instanceof GuestPaymentTestError && err.code === "stripe_disconnected",
    );
    assert.equal(created.length, 0);

    await root.query(
      `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
       values ($1::uuid, 'acct_inhouse', true), ($2::uuid, 'acct_operator', false)`,
      [hotelOrg, operatorOrg],
    );
    await assert.rejects(
      () => startGuestPaymentForBooking(db, first.confirmationToken, "https://guest.test", TEST_ENV, deps),
      (err: unknown) => err instanceof GuestPaymentTestError && err.code === "live_payee_rejected",
    );
    assert.equal(created.length, 0);
    await root.query(
      `update sbg_organisation_stripe_connections set livemode = false where stripe_account_id = 'acct_inhouse'`,
    );
    await root.query(
      `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode)
       values ($1::uuid, 'acct_decoy', false)`,
      [inHouseHotel],
    );

    const paid = await startGuestPaymentForBooking(db, first.confirmationToken, "https://guest.test", TEST_ENV, deps);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.accountId, "acct_inhouse");
    assert.notEqual(created[0]!.accountId, "acct_decoy");
    assert.equal(created[0]!.amountMinor, 4500);
    assert.equal(created[0]!.currency, "EUR");
    assert.equal(created[0]!.idempotencyKey, `${created[0]!.paymentId}:1`);
    assert.equal(paid.accountId, "acct_inhouse");
    const again = await startGuestPaymentForBooking(db, first.confirmationToken, "https://guest.test", TEST_ENV, deps);
    assert.equal(again.url, paid.url);
    assert.equal(created.length, 1);
    const held = await root.query<{ lifecycle_state: string; vehicle_id: string | null; amount_minor: number }>(
      `select b.lifecycle_state, b.vehicle_id::text, p.amount_minor
         from bookings b join sbg_booking_payments p on p.booking_id = b.id
        where p.id = $1::uuid`,
      [paid.paymentId],
    );
    assert.equal(held.rows[0]!.lifecycle_state, "awaiting_payment");
    assert.ok(held.rows[0]!.vehicle_id);
    assert.equal(held.rows[0]!.amount_minor, 4500);

    const raceA = await createBooking(db, input("s6din", inDestination, "2026-07-09"));
    const raceB = await createBooking(db, input("s6din", inDestination, "2026-07-10"));
    const raced = await Promise.allSettled([
      startGuestPaymentForBooking(bookingDb(left), raceA.confirmationToken, "https://guest.test", TEST_ENV, deps),
      startGuestPaymentForBooking(bookingDb(right), raceA.confirmationToken, "https://guest.test", TEST_ENV, deps),
    ]);
    const won = raced.filter((row) => row.status === "fulfilled");
    const lost = raced.filter((row) => row.status === "rejected");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.equal((lost[0] as PromiseRejectedResult).reason instanceof GuestPaymentTestError, true);
    assert.equal((lost[0] as PromiseRejectedResult).reason.code, "checkout_in_progress");
    const raceSessions = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_booking_payments p
         join bookings b on b.id = p.booking_id
        where b.confirmation_token = $1 and p.stripe_checkout_session_id is not null`,
      [raceA.confirmationToken],
    );
    assert.equal(raceSessions.rows[0]!.n, 1);

    failStore = true;
    const beforeExpire = expired.length;
    await assert.rejects(
      () => startGuestPaymentForBooking(db, raceB.confirmationToken, "https://guest.test", TEST_ENV, deps),
      (err: unknown) => err instanceof GuestPaymentTestError && err.code === "checkout_not_stored",
    );
    failStore = false;
    assert.equal(expired.length, beforeExpire + 1);
    assert.equal(expired.at(-1)!.accountId, "acct_inhouse");
    const unstored = await root.query<{ session: string | null; status: string }>(
      `select stripe_checkout_session_id as session, status from sbg_booking_payments where id = $1::uuid`,
      [created.at(-1)!.paymentId],
    );
    assert.equal(unstored.rows[0]!.session, null);
    assert.equal(unstored.rows[0]!.status, "failed");

    const operatorBooking = await createBooking(db, input("s6dout", outDestination, "2026-07-08"));
    const operatorPaid = await startGuestPaymentForBooking(db, operatorBooking.confirmationToken, "https://guest.test", TEST_ENV, deps);
    assert.equal(operatorPaid.accountId, "acct_operator");
    assert.equal(created.at(-1)!.accountId, "acct_operator");

    const stale = await createBooking(db, input("s6din", inDestination, "2026-07-11"));
    await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
    await root.query(
      `update bookings set hold_expires_at = clock_timestamp() - interval '1 minute' where confirmation_token = $1`,
      [stale.confirmationToken],
    );
    await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    await assert.rejects(
      () => startGuestPaymentForBooking(db, stale.confirmationToken, "https://guest.test", TEST_ENV, deps),
      (err: unknown) => err instanceof GuestPaymentTestError && err.code === "hold_expired",
    );
    await assert.rejects(
      () => startGuestPaymentForBooking(db, "missing-token", "https://guest.test", TEST_ENV, deps),
      (err: unknown) => err instanceof GuestPaymentTestError && err.code === "booking_not_found",
    );
    await assert.rejects(
      () => startGuestPaymentForBooking(db, first.confirmationToken, "https://guest.test", { ...TEST_ENV, SBG_GUEST_PAYMENT_TEST: undefined }),
      (err: unknown) => err instanceof GuestCheckoutClosed,
    );
    await assert.rejects(
      () => startGuestPaymentForBooking(db, first.confirmationToken, "https://guest.test", { ...TEST_ENV, STRIPE_SECRET_KEY: "sk_live_stage6d" }, deps),
      (err: unknown) => err instanceof GuestPaymentTestError && err.code === "live_credentials_rejected",
    );

    const gateway = bookingDb(root);
    async function asGateway<T>(fn: () => Promise<T>): Promise<T> {
      await root.query("set role aether_payment_gateway");
      try {
        return await fn();
      } finally {
        await root.query("reset role");
      }
    }
    const session = created[0]!;
    function payload(eventId: string, type: string, paymentStatus: string, intent: string | null) {
      return JSON.stringify({
        id: eventId,
        type,
        account: "acct_inhouse",
        data: {
          object: {
            id: session.id && created[0]!.id ? (type.startsWith("charge") || type.startsWith("refund") ? undefined : undefined) : undefined,
            id_unused: true,
            amount_total: 4500,
            currency: "eur",
            payment_status: paymentStatus,
            payment_intent: intent,
            metadata: { booking_id: session.bookingId, payment_id: session.paymentId },
          },
        },
      });
    }
    const storedSession = (await root.query<{ id: string }>(
      `select stripe_checkout_session_id as id from sbg_booking_payments where id = $1::uuid`,
      [session.paymentId],
    )).rows[0]!.id;
    function checkoutEvent(eventId: string, type: string, paymentStatus: string, intent: string | null, account = "acct_inhouse") {
      return JSON.stringify({
        id: eventId,
        type,
        livemode: false,
        account,
        data: {
          object: {
            id: storedSession,
            amount_total: 4500,
            currency: "eur",
            payment_status: paymentStatus,
            payment_intent: intent,
            metadata: { booking_id: session.bookingId, payment_id: session.paymentId },
          },
        },
      });
    }
    const now = 1_700_000_000_000;
    type PaymentSnapshot = {
      booking_id: string;
      lifecycle_state: string;
      vehicle_id: string | null;
      confirmed_paid_at: string | null;
      status: string;
      session_id: string;
      amount_minor: number;
      currency: string;
      account_id: string;
      paid_count: number;
    };
    async function paymentSnapshot(paymentId: string): Promise<PaymentSnapshot> {
      const row = (await root.query<PaymentSnapshot>(
        `select b.id::text as booking_id,
                b.lifecycle_state,
                b.vehicle_id::text as vehicle_id,
                b.confirmed_paid_at::text as confirmed_paid_at,
                p.status,
                p.stripe_checkout_session_id as session_id,
                p.amount_minor,
                p.currency,
                p.payee_stripe_account_id as account_id,
                (select count(*)::int
                   from public.sbg_booking_payments paid
                  where paid.booking_id = b.id
                    and paid.stripe_checkout_session_id = p.stripe_checkout_session_id
                    and paid.status = 'paid') as paid_count
           from public.sbg_booking_payments p
           join public.bookings b on b.id = p.booking_id
          where p.id = $1::uuid`,
        [paymentId],
      )).rows[0];
      assert.ok(row);
      return row;
    }
    function signedCheckout(args: {
      eventId: string;
      bookingId: string;
      paymentId: string;
      sessionId: string;
      account: string;
      amount: number;
      currency: string;
      livemode?: boolean;
    }): string {
      const livemode = args.livemode ?? false;
      return JSON.stringify({
        id: args.eventId,
        type: "checkout.session.completed",
        livemode,
        account: args.account,
        data: {
          object: {
            id: args.sessionId,
            livemode,
            amount_total: args.amount,
            currency: args.currency,
            payment_status: "paid",
            payment_intent: `pi_${args.eventId}`,
            metadata: { booking_id: args.bookingId, payment_id: args.paymentId },
          },
        },
      });
    }
    await t.test("signed LIVE webhook leaves the PostgreSQL booking unchanged", async () => {
      const booking = await createBooking(db, input("s6din", inDestination, "2026-07-28"));
      const payment = await startGuestPaymentForBooking(db, booking.confirmationToken, "https://guest.test", TEST_ENV, deps);
      const before = await paymentSnapshot(payment.paymentId);
      assert.equal(before.lifecycle_state, "awaiting_payment");
      assert.equal(before.status, "pending");
      assert.equal(before.paid_count, 0);
      assert.equal(before.confirmed_paid_at, null);
      assert.ok(before.vehicle_id);
      const raw = signedCheckout({
        eventId: "evt_live_pg_1",
        bookingId: before.booking_id,
        paymentId: payment.paymentId,
        sessionId: before.session_id,
        account: before.account_id,
        amount: before.amount_minor,
        currency: "eur",
        livemode: true,
      });
      const rejected = await asGateway(() => acceptIsolatedGuestPaymentTest({
        rawBody: raw,
        signatureHeader: sign(raw, WEBHOOK_SECRET, now / 1000),
        webhookSecret: WEBHOOK_SECRET,
        db: gateway,
        env: TEST_ENV,
        nowMs: now,
      }));
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.outcome, "live_event_rejected");
      assert.deepEqual(await paymentSnapshot(payment.paymentId), before);
      const recorded = await root.query<{ n: number }>(
        `select count(*)::int as n from public.sbg_stripe_events where event_id = 'evt_live_pg_1'`,
      );
      assert.equal(recorded.rows[0]!.n, 0);
    });
    const completed = checkoutEvent("evt_paid_1", "checkout.session.completed", "paid", "pi_paid_1");
    await t.test("exactly one paid record survives replay", async () => {
      const confirmed = await asGateway(() => acceptIsolatedGuestPaymentTest({
        rawBody: completed,
        signatureHeader: sign(completed, WEBHOOK_SECRET, now / 1000),
        webhookSecret: WEBHOOK_SECRET,
        db: gateway,
        env: TEST_ENV,
        nowMs: now,
      }));
      assert.equal(confirmed.status, 200);
      assert.equal(confirmed.body.outcome, "confirmed_paid");
      const paidOnce = await paymentSnapshot(session.paymentId);
      assert.equal(paidOnce.lifecycle_state, "confirmed_paid");
      assert.equal(paidOnce.status, "paid");
      assert.equal(paidOnce.paid_count, 1);
      assert.equal(paidOnce.amount_minor, 4500);
      assert.equal(paidOnce.currency.toLowerCase(), "eur");
      assert.equal(paidOnce.session_id, storedSession);
      assert.equal(paidOnce.account_id, "acct_inhouse");
      assert.ok(paidOnce.vehicle_id);
      assert.ok(paidOnce.confirmed_paid_at);
      const duplicate = await asGateway(() => acceptIsolatedGuestPaymentTest({
        rawBody: completed,
        signatureHeader: sign(completed, WEBHOOK_SECRET, now / 1000),
        webhookSecret: WEBHOOK_SECRET,
        db: gateway,
        env: TEST_ENV,
        nowMs: now,
      }));
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.outcome, "duplicate");
      const paidAgain = await paymentSnapshot(session.paymentId);
      assert.equal(paidAgain.paid_count, 1);
      assert.equal(paidAgain.lifecycle_state, "confirmed_paid");
      assert.equal(paidAgain.status, "paid");
      assert.equal(paidAgain.vehicle_id, paidOnce.vehicle_id);
      assert.equal(paidAgain.confirmed_paid_at, paidOnce.confirmed_paid_at);
      const recorded = await root.query<{ n: number }>(
        `select count(*)::int as n from public.sbg_stripe_events where event_id = 'evt_paid_1'`,
      );
      assert.equal(recorded.rows[0]!.n, 1);
    });
    const bad = await asGateway(() => acceptIsolatedGuestPaymentTest({
      rawBody: completed,
      signatureHeader: "t=1,v1=dead",
      webhookSecret: WEBHOOK_SECRET,
      db: gateway,
      env: TEST_ENV,
      nowMs: now,
    }));
    assert.equal(bad.status, 400);
    async function rejectAuthorityMismatch(
      name: string,
      date: string,
      eventId: string,
      outcome: string,
      patch: (before: PaymentSnapshot) => { account: string; sessionId: string; amount: number; currency: string },
    ) {
      await t.test(name, async () => {
        const booking = await createBooking(db, input("s6din", inDestination, date));
        const payment = await startGuestPaymentForBooking(db, booking.confirmationToken, "https://guest.test", TEST_ENV, deps);
        const before = await paymentSnapshot(payment.paymentId);
        assert.equal(before.lifecycle_state, "awaiting_payment");
        assert.equal(before.status, "pending");
        assert.equal(before.paid_count, 0);
        assert.equal(before.confirmed_paid_at, null);
        assert.ok(before.vehicle_id);
        const changed = patch(before);
        const raw = signedCheckout({
          eventId,
          bookingId: before.booking_id,
          paymentId: payment.paymentId,
          sessionId: changed.sessionId,
          account: changed.account,
          amount: changed.amount,
          currency: changed.currency,
        });
        const rejected = await asGateway(() => acceptIsolatedGuestPaymentTest({
          rawBody: raw,
          signatureHeader: sign(raw, WEBHOOK_SECRET, now / 1000),
          webhookSecret: WEBHOOK_SECRET,
          db: gateway,
          env: TEST_ENV,
          nowMs: now,
        }));
        assert.equal(rejected.status, 409);
        assert.notEqual(rejected.body.outcome, "confirmed_paid");
        assert.equal(rejected.body.outcome, outcome);
        assert.deepEqual(await paymentSnapshot(payment.paymentId), before);
      });
    }
    await rejectAuthorityMismatch(
      "wrong connected account cannot confirm",
      "2026-07-29",
      "evt_wrong_account_1",
      "wrong_account",
      (before) => ({ account: "acct_not_bound", sessionId: before.session_id, amount: before.amount_minor, currency: "eur" }),
    );
    await rejectAuthorityMismatch(
      "wrong Checkout Session cannot confirm",
      "2026-07-30",
      "evt_wrong_session_1",
      "session",
      (before) => ({ account: before.account_id, sessionId: "cs_not_the_stored_session", amount: before.amount_minor, currency: "eur" }),
    );
    await rejectAuthorityMismatch(
      "wrong amount cannot confirm",
      "2026-07-31",
      "evt_wrong_amount_1",
      "amount",
      (before) => ({ account: before.account_id, sessionId: before.session_id, amount: before.amount_minor + 1, currency: "eur" }),
    );
    await rejectAuthorityMismatch(
      "wrong currency cannot confirm",
      "2026-08-01",
      "evt_wrong_currency_1",
      "currency",
      (before) => ({ account: before.account_id, sessionId: before.session_id, amount: before.amount_minor, currency: "usd" }),
    );
    const liveEntry = await acceptIsolatedGuestPaymentTest({
      rawBody: completed,
      signatureHeader: sign(completed, WEBHOOK_SECRET, now / 1000),
      webhookSecret: WEBHOOK_SECRET,
      db: gateway,
      env: { ...TEST_ENV, STRIPE_SECRET_KEY: "sk_live_stage6d" },
      nowMs: now,
    });
    assert.equal(liveEntry.status, 503);
    assert.equal(liveEntry.body.outcome, "live_credentials_rejected");
    const closedEntry = await acceptIsolatedGuestPaymentTest({
      rawBody: completed,
      signatureHeader: sign(completed, WEBHOOK_SECRET, now / 1000),
      webhookSecret: WEBHOOK_SECRET,
      db: gateway,
      env: { STRIPE_SECRET_KEY: "sk_test_stage6d" },
      nowMs: now,
    });
    assert.equal(closedEntry.status, 503);

    const lateBooking = await createBooking(db, input("s6din", inDestination, "2026-07-12"));
    const latePay = await startGuestPaymentForBooking(db, lateBooking.confirmationToken, "https://guest.test", TEST_ENV, deps);
    await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
    await root.query(
      `update bookings set hold_expires_at = clock_timestamp() - interval '1 minute' where confirmation_token = $1`,
      [lateBooking.confirmationToken],
    );
    await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    const lateSession = (await root.query<{ id: string; booking_id: string }>(
      `select stripe_checkout_session_id as id, booking_id::text from sbg_booking_payments where id = $1::uuid`,
      [latePay.paymentId],
    )).rows[0]!;
    const lateRaw = JSON.stringify({
      id: "evt_late_1",
      type: "checkout.session.completed",
      livemode: false,
      account: "acct_inhouse",
      data: {
        object: {
          id: lateSession.id,
          amount_total: 4500,
          currency: "eur",
          payment_status: "paid",
          payment_intent: "pi_late_1",
          metadata: { booking_id: lateSession.booking_id, payment_id: latePay.paymentId },
        },
      },
    });
    const late = await asGateway(() => acceptIsolatedGuestPaymentTest({
      rawBody: lateRaw,
      signatureHeader: sign(lateRaw, WEBHOOK_SECRET, now / 1000),
      webhookSecret: WEBHOOK_SECRET,
      db: gateway,
      env: TEST_ENV,
      nowMs: now,
    }));
    assert.equal(late.body.outcome, "late_payment");
    const lateRow = await root.query<{ lifecycle_state: string; vehicle_id: string | null; status: string }>(
      `select b.lifecycle_state, b.vehicle_id::text, p.status
         from bookings b join sbg_booking_payments p on p.booking_id = b.id
        where p.id = $1::uuid`,
      [latePay.paymentId],
    );
    assert.equal(lateRow.rows[0]!.lifecycle_state, "expired");
    assert.equal(lateRow.rows[0]!.vehicle_id, null);
    assert.equal(lateRow.rows[0]!.status, "received_after_expiry");

    const failBooking = await createBooking(db, input("s6din", inDestination, "2026-07-13"));
    const failPay = await startGuestPaymentForBooking(db, failBooking.confirmationToken, "https://guest.test", TEST_ENV, deps);
    const failSession = (await root.query<{ id: string; booking_id: string }>(
      `select stripe_checkout_session_id as id, booking_id::text from sbg_booking_payments where id = $1::uuid`,
      [failPay.paymentId],
    )).rows[0]!;
    const failRaw = JSON.stringify({
      id: "evt_fail_1",
      type: "checkout.session.async_payment_failed",
      livemode: false,
      account: "acct_inhouse",
      data: {
        object: {
          id: failSession.id,
          amount_total: 4500,
          currency: "eur",
          payment_status: "unpaid",
          payment_intent: "pi_fail_1",
          metadata: { booking_id: failSession.booking_id, payment_id: failPay.paymentId },
        },
      },
    });
    const failed = await asGateway(() => acceptIsolatedGuestPaymentTest({
      rawBody: failRaw,
      signatureHeader: sign(failRaw, WEBHOOK_SECRET, now / 1000),
      webhookSecret: WEBHOOK_SECRET,
      db: gateway,
      env: TEST_ENV,
      nowMs: now,
    }));
    assert.equal(failed.body.outcome, "payment_failed");
    const failRow = await root.query<{ lifecycle_state: string; vehicle_id: string | null }>(
      `select lifecycle_state, vehicle_id::text from bookings where id = $1::uuid`,
      [failSession.booking_id],
    );
    assert.equal(failRow.rows[0]!.lifecycle_state, "failed");
    assert.equal(failRow.rows[0]!.vehicle_id, null);

    const abandonBooking = await createBooking(db, input("s6din", inDestination, "2026-07-14"));
    const abandonPay = await startGuestPaymentForBooking(db, abandonBooking.confirmationToken, "https://guest.test", TEST_ENV, deps);
    const abandonSession = (await root.query<{ id: string; booking_id: string }>(
      `select stripe_checkout_session_id as id, booking_id::text from sbg_booking_payments where id = $1::uuid`,
      [abandonPay.paymentId],
    )).rows[0]!;
    const abandonRaw = JSON.stringify({
      id: "evt_abandon_1",
      type: "checkout.session.expired",
      livemode: false,
      account: "acct_inhouse",
      data: {
        object: {
          id: abandonSession.id,
          amount_total: 4500,
          currency: "eur",
          payment_status: "unpaid",
          payment_intent: null,
          metadata: { booking_id: abandonSession.booking_id, payment_id: abandonPay.paymentId },
        },
      },
    });
    const abandoned = await asGateway(() => acceptIsolatedGuestPaymentTest({
      rawBody: abandonRaw,
      signatureHeader: sign(abandonRaw, WEBHOOK_SECRET, now / 1000),
      webhookSecret: WEBHOOK_SECRET,
      db: gateway,
      env: TEST_ENV,
      nowMs: now,
    }));
    assert.equal(abandoned.body.outcome, "payment_canceled");
    const stillHeld = await root.query<{ vehicle_id: string | null; lifecycle_state: string }>(
      `select vehicle_id::text, lifecycle_state from bookings where id = $1::uuid`,
      [abandonSession.booking_id],
    );
    assert.equal(stillHeld.rows[0]!.lifecycle_state, "awaiting_payment");
    assert.ok(stillHeld.rows[0]!.vehicle_id);
    await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
    await root.query(
      `update bookings set hold_expires_at = clock_timestamp() - interval '1 minute' where id = $1::uuid`,
      [abandonSession.booking_id],
    );
    await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    await root.query("set role aether_expiry_runner");
    const expiredHolds = await root.query<{ expired_booking_id: string }>(
      `select expired_booking_id from public.sbg_expire_provisional_holds(20)`,
    );
    await root.query("reset role");
    assert.equal(expiredHolds.rows.some((row) => row.expired_booking_id === abandonSession.booking_id), true);
    const released = await root.query<{ vehicle_id: string | null; lifecycle_state: string }>(
      `select vehicle_id::text, lifecycle_state from bookings where id = $1::uuid`,
      [abandonSession.booking_id],
    );
    assert.equal(released.rows[0]!.lifecycle_state, "expired");
    assert.equal(released.rows[0]!.vehicle_id, null);
    const confirmedStill = await root.query<{ lifecycle_state: string; vehicle_id: string | null }>(
      `select lifecycle_state, vehicle_id::text from bookings where id = $1::uuid`,
      [session.bookingId],
    );
    assert.equal(confirmedStill.rows[0]!.lifecycle_state, "confirmed_paid");
    assert.ok(confirmedStill.rows[0]!.vehicle_id);

    const refundRaw = JSON.stringify({
      id: "evt_refund_early",
      type: "charge.refunded",
      livemode: false,
      account: "acct_inhouse",
      data: { object: { payment_intent: null } },
    });
    const earlyRefund = await asGateway(() => acceptIsolatedGuestPaymentTest({
      rawBody: refundRaw,
      signatureHeader: sign(refundRaw, WEBHOOK_SECRET, now / 1000),
      webhookSecret: WEBHOOK_SECRET,
      db: gateway,
      env: TEST_ENV,
      nowMs: now,
    }));
    assert.equal(earlyRefund.status, 409);
    assert.equal(earlyRefund.body.outcome, "uncorrelated");

    async function waitForCreates(target: number) {
      for (let i = 0; i < 100; i += 1) {
        if (created.length >= target) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("timed out waiting for checkout");
    }
    async function stalePair(date: string) {
      const booking = await createBooking(db, input("s6din", inDestination, date));
      queueCheckout = true;
      queued.length = 0;
      const mark = created.length;
      const pendingA = startGuestPaymentForBooking(db, booking.confirmationToken, "https://guest.test", TEST_ENV, deps);
      await waitForCreates(mark + 1);
      const paymentId = created[mark]!.paymentId;
      const attempt = Number(created[mark]!.idempotencyKey.split(":")[1]);
      const generationA = Number((await root.query<{ g: number }>(
        `select checkout_claim_generation as g from sbg_booking_payments where id = $1::uuid`,
        [paymentId],
      )).rows[0]!.g);
      await root.query(
        `update sbg_booking_payments set checkout_claim_at = clock_timestamp() - interval '3 minutes' where id = $1::uuid`,
        [paymentId],
      );
      const pendingB = startGuestPaymentForBooking(db, booking.confirmationToken, "https://guest.test", TEST_ENV, deps);
      await waitForCreates(mark + 2);
      const generationB = Number((await root.query<{ g: number }>(
        `select checkout_claim_generation as g from sbg_booking_payments where id = $1::uuid`,
        [paymentId],
      )).rows[0]!.g);
      assert.equal(created[mark]!.idempotencyKey, created[mark + 1]!.idempotencyKey);
      assert.equal(created[mark]!.accountId, "acct_inhouse");
      assert.equal(created[mark + 1]!.accountId, "acct_inhouse");
      assert.notEqual(generationA, generationB);
      const stale = await root.query<{ sbg_release_capacity_checkout_claim: string }>(
        `select public.sbg_release_capacity_checkout_claim($1::uuid, $2::integer, $3::integer)`,
        [paymentId, attempt, generationA],
      );
      assert.equal(stale.rows[0]!.sbg_release_capacity_checkout_claim, "held");
      const owned = await root.query<{ g: number; claimed: boolean }>(
        `select checkout_claim_generation as g, checkout_claim_at is not null as claimed
           from sbg_booking_payments where id = $1::uuid`,
        [paymentId],
      );
      assert.equal(Number(owned.rows[0]!.g), generationB);
      assert.equal(owned.rows[0]!.claimed, true);
      return { booking, pendingA, pendingB, paymentId, mark };
    }

    const sameWinner = await stalePair("2026-07-20");
    const expiredBeforeSame = expired.length;
    queued[1]!({ id: "cs_same_b_first", url: "https://checkout.stripe.test/same-b" });
    const sameB = await sameWinner.pendingB;
    queued[0]!({ id: "cs_same_b_first", url: "https://checkout.stripe.test/same-b" });
    const sameA = await sameWinner.pendingA;
    queueCheckout = false;
    assert.equal(sameA.url, sameB.url);
    assert.equal(sameA.accountId, "acct_inhouse");
    assert.equal(expired.length, expiredBeforeSame);
    const sameStored = await root.query<{ session: string }>(
      `select stripe_checkout_session_id as session from sbg_booking_payments where id = $1::uuid`,
      [sameWinner.paymentId],
    );
    assert.equal(sameStored.rows[0]!.session, "cs_same_b_first");
    const sameCalls = created.length;
    const sameAgain = await startGuestPaymentForBooking(db, sameWinner.booking.confirmationToken, "https://guest.test", TEST_ENV, deps);
    assert.equal(sameAgain.url, sameB.url);
    assert.equal(created.length, sameCalls);

    const sameOpposite = await stalePair("2026-07-21");
    const expiredBeforeOpposite = expired.length;
    queued[0]!({ id: "cs_same_a_first", url: "https://checkout.stripe.test/same-a" });
    await assert.rejects(sameOpposite.pendingA, (err: unknown) => err instanceof GuestPaymentTestError && err.code === "checkout_in_progress");
    queued[1]!({ id: "cs_same_a_first", url: "https://checkout.stripe.test/same-a" });
    const oppositeB = await sameOpposite.pendingB;
    queueCheckout = false;
    assert.equal(oppositeB.url, "https://checkout.stripe.test/same-a");
    assert.equal(expired.length, expiredBeforeOpposite);
    const oppositeStored = await root.query<{ session: string }>(
      `select stripe_checkout_session_id as session from sbg_booking_payments where id = $1::uuid`,
      [sameOpposite.paymentId],
    );
    assert.equal(oppositeStored.rows[0]!.session, "cs_same_a_first");
    const oppositeCalls = created.length;
    const oppositeAgain = await startGuestPaymentForBooking(db, sameOpposite.booking.confirmationToken, "https://guest.test", TEST_ENV, deps);
    assert.equal(oppositeAgain.url, oppositeB.url);
    assert.equal(created.length, oppositeCalls);

    const different = await stalePair("2026-07-22");
    queued[1]!({ id: "cs_winner_only", url: "https://checkout.stripe.test/winner" });
    const differentB = await different.pendingB;
    queued[0]!({ id: "cs_loser_only", url: "https://checkout.stripe.test/loser" });
    await assert.rejects(different.pendingA, (err: unknown) => err instanceof GuestPaymentTestError && err.code === "checkout_not_stored");
    queueCheckout = false;
    assert.equal(differentB.url, "https://checkout.stripe.test/winner");
    assert.equal(expired.filter((row) => row.sessionId === "cs_loser_only" && row.accountId === "acct_inhouse").length, 1);
    assert.equal(expired.filter((row) => row.sessionId === "cs_winner_only").length, 0);
    const differentStored = await root.query<{ session: string }>(
      `select stripe_checkout_session_id as session from sbg_booking_payments where id = $1::uuid`,
      [different.paymentId],
    );
    assert.equal(differentStored.rows[0]!.session, "cs_winner_only");
    const differentCalls = created.length;
    const differentAgain = await startGuestPaymentForBooking(db, different.booking.confirmationToken, "https://guest.test", TEST_ENV, deps);
    assert.equal(differentAgain.url, differentB.url);
    assert.equal(created.length, differentCalls);

    const staleHeld = await createBooking(db, input("s6din", inDestination, "2026-07-23"));
    const stalePay = await startGuestPaymentForBooking(db, staleHeld.confirmationToken, "https://guest.test", TEST_ENV, deps);
    const expiredBeforeHold = expired.length;
    await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
    await root.query(
      `update bookings set hold_expires_at = clock_timestamp() - interval '1 minute' where confirmation_token = $1`,
      [staleHeld.confirmationToken],
    );
    await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    await assert.rejects(
      () => startGuestPaymentForBooking(db, staleHeld.confirmationToken, "https://guest.test", TEST_ENV, deps),
      (err: unknown) => err instanceof GuestPaymentTestError && err.code === "hold_expired",
    );
    assert.equal(expired.length, expiredBeforeHold);
    const heldSession = await root.query<{ session: string }>(
      `select stripe_checkout_session_id as session from sbg_booking_payments where id = $1::uuid`,
      [stalePay.paymentId],
    );
    assert.ok(heldSession.rows[0]!.session);

    const cancelled = await createBooking(db, input("s6din", inDestination, "2026-07-24"));
    await startGuestPaymentForBooking(db, cancelled.confirmationToken, "https://guest.test", TEST_ENV, deps);
    const expiredBeforeCancel = expired.length;
    await root.query("alter table public.bookings disable trigger user");
    await root.query(
      `update bookings set cancelled_at = clock_timestamp(), lifecycle_state = 'cancelled' where confirmation_token = $1`,
      [cancelled.confirmationToken],
    );
    await root.query("alter table public.bookings enable trigger user");
    await assert.rejects(
      () => startGuestPaymentForBooking(db, cancelled.confirmationToken, "https://guest.test", TEST_ENV, deps),
      (err: unknown) => err instanceof GuestPaymentTestError && err.code === "booking_not_payable",
    );
    assert.equal(expired.length, expiredBeforeCancel);

    const appBooking = await createBooking(db, input("s6din", inDestination, "2026-07-25"));
    const appUrl = new URL(dbUrl);
    appUrl.username = "aether_app";
    appUrl.password = "";
    const appClient = new pg.Client({ connectionString: appUrl.toString() });
    await appClient.connect();
    const appDb = bookingDb(appClient);
    try {
      await assert.rejects(
        () => appClient.query("select stripe_account_id, livemode from public.sbg_organisation_stripe_connections"),
        (err: { code?: string }) => err.code === "42501",
      );
      await assert.rejects(
        () => appClient.query("select count(*)::int as n from public.sbg_organisation_stripe_connections"),
        (err: { code?: string }) => err.code === "42501",
      );
      await assert.rejects(
        () => appClient.query(
          "select stripe_account_id from public.sbg_organisation_stripe_connections where organisation_id = $1::uuid",
          [operatorOrg],
        ),
        (err: { code?: string }) => err.code === "42501",
      );
      const beforeApp = created.length;
      const started = await startGuestPaymentForBooking(appDb, appBooking.confirmationToken, "https://guest.test", TEST_ENV, deps);
      assert.equal(started.accountId, "acct_inhouse");
      assert.equal(created.length, beforeApp + 1);
      const mode = await appClient.query<{ test_mode: boolean }>(
        "select public.sbg_bound_payee_is_test_mode($1::uuid) as test_mode",
        [started.paymentId],
      );
      assert.equal(mode.rows[0]!.test_mode, true);
      const resultType = await root.query<{ result: string }>(
        "select pg_get_function_result('public.sbg_bound_payee_is_test_mode(uuid)'::regprocedure) as result",
      );
      assert.equal(resultType.rows[0]!.result, "boolean");
      const denied = await root.query<{ gateway: boolean; runner: boolean; app: boolean }>(
        `select
           has_function_privilege('aether_payment_gateway', 'public.sbg_bound_payee_is_test_mode(uuid)', 'execute') as gateway,
           has_function_privilege('aether_expiry_runner', 'public.sbg_bound_payee_is_test_mode(uuid)', 'execute') as runner,
           has_function_privilege('aether_app', 'public.sbg_bound_payee_is_test_mode(uuid)', 'execute') as app`,
      );
      assert.equal(denied.rows[0]!.gateway, false);
      assert.equal(denied.rows[0]!.runner, false);
      assert.equal(denied.rows[0]!.app, true);

      await root.query(
        `update public.sbg_organisation_stripe_connections
            set disconnected_at = clock_timestamp()
          where stripe_account_id = 'acct_inhouse'`,
      );
      const beforeRevoke = created.length;
      await assert.rejects(
        () => startGuestPaymentForBooking(appDb, appBooking.confirmationToken, "https://guest.test", TEST_ENV, deps),
        (err: unknown) => err instanceof GuestPaymentTestError && err.code === "live_payee_rejected",
      );
      assert.equal(created.length, beforeRevoke);

      await root.query(
        `update public.sbg_organisation_stripe_connections
            set disconnected_at = null, livemode = true
          where stripe_account_id = 'acct_inhouse'`,
      );
      const liveBooking = await createBooking(db, input("s6din", inDestination, "2026-07-26"));
      const beforeLive = created.length;
      await assert.rejects(
        () => startGuestPaymentForBooking(appDb, liveBooking.confirmationToken, "https://guest.test", TEST_ENV, deps),
        (err: unknown) => err instanceof GuestPaymentTestError && err.code === "live_payee_rejected",
      );
      assert.equal(created.length, beforeLive);

      await root.query(
        `delete from public.sbg_organisation_stripe_connections where stripe_account_id = 'acct_inhouse'`,
      );
      const missingBooking = await createBooking(db, input("s6din", inDestination, "2026-07-27"));
      const beforeMissing = created.length;
      await assert.rejects(
        () => startGuestPaymentForBooking(appDb, missingBooking.confirmationToken, "https://guest.test", TEST_ENV, deps),
        (err: unknown) => err instanceof GuestPaymentTestError && err.code === "stripe_disconnected",
      );
      assert.equal(created.length, beforeMissing);
      await root.query(
        `insert into public.sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
         values ($1::uuid, 'acct_inhouse', false)`,
        [hotelOrg],
      );
    } finally {
      await appClient.end().catch(() => undefined);
    }

    const listenerUrl = new URL(dbUrl);
    listenerUrl.username = "aether_payment_gateway";
    listenerUrl.password = "";
    const expiryUrl = new URL(dbUrl);
    expiryUrl.username = "aether_expiry_runner";
    expiryUrl.password = "";
    await assert.rejects(
      () => startLocalGuestPaymentTestListener({
        connectionString: "postgresql://postgres@127.0.0.1:54329/neondb",
        webhookSecret: WEBHOOK_SECRET,
        env: TEST_ENV,
      }),
      (err: unknown) => err instanceof GuestPaymentIsolationError && err.code === "role_not_authorised",
    );
    await assert.rejects(
      () => startLocalGuestPaymentTestListener({
        connectionString: `postgresql://aether_payment_gateway:secret@127.0.0.1:${listenerUrl.port}/neondb`,
        webhookSecret: WEBHOOK_SECRET,
        env: TEST_ENV,
      }),
      (err: unknown) => err instanceof GuestPaymentIsolationError && err.code === "password_not_permitted",
    );
    await assert.rejects(
      () => startLocalGuestPaymentTestListener({
        connectionString: `postgresql://aether_payment_gateway@127.0.0.1:${listenerUrl.port}/postgres`,
        webhookSecret: WEBHOOK_SECRET,
        env: TEST_ENV,
      }),
      (err: unknown) => err instanceof GuestPaymentIsolationError && err.code === "database_not_authorised",
    );
    const listener = await startLocalGuestPaymentTestListener({
      connectionString: listenerUrl.toString(),
      webhookSecret: WEBHOOK_SECRET,
      env: TEST_ENV,
    });
    try {
      assert.equal(listener.host, "127.0.0.1");
      const bad = await fetch(`http://127.0.0.1:${listener.port}/`, {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=dead" },
        body: "{}",
      });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).outcome, "invalid_signature");
    } finally {
      await listener.close();
    }
    const gatewayPriv = await root.query<{ can_expire: boolean; can_settle: boolean }>(
      `select
         has_function_privilege('aether_payment_gateway', 'public.sbg_expire_provisional_holds(integer)', 'execute') as can_expire,
         has_function_privilege('aether_payment_gateway', 'public.sbg_settle_capacity_checkout_attempt(uuid,integer,integer,text,text)', 'execute') as can_settle`,
    );
    const runnerPriv = await root.query<{ can_accept: boolean; can_settle: boolean }>(
      `select
         has_function_privilege('aether_expiry_runner', 'public.sbg_accept_verified_payment_event(boolean,text,text,uuid,uuid,uuid,text,text,integer,text,text,text)', 'execute') as can_accept,
         has_function_privilege('aether_expiry_runner', 'public.sbg_settle_capacity_checkout_attempt(uuid,integer,integer,text,text)', 'execute') as can_settle`,
    );
    assert.equal(gatewayPriv.rows[0]!.can_expire, false);
    assert.equal(gatewayPriv.rows[0]!.can_settle, false);
    assert.equal(runnerPriv.rows[0]!.can_accept, false);
    assert.equal(runnerPriv.rows[0]!.can_settle, false);
    const localExpiry = await runLocalExpiryOnce(expiryUrl.toString(), TEST_ENV);
    assert.ok(Array.isArray(localExpiry));

    void payload;
  } finally {
    await left.end().catch(() => undefined);
    await right.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
});
