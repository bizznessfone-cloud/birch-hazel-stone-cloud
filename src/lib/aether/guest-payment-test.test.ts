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
  const payment = readFileSync(new URL("./guest-payment-fns.ts", import.meta.url), "utf8");
  const entry = readFileSync(new URL("./guest-payment-gateway-entry.ts", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../../routes/api/stripe/webhook.ts", import.meta.url), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  assert.equal(files.at(-1), "0077_gate2_capacity_guest_payment.sql");
  assert.equal(preflight.includes("0077_gate2_capacity_guest_payment.sql"), false);
  assert.doesNotMatch(sql, /from public\.sbg_stripe_connections|join public\.sbg_stripe_connections/);
  assert.match(sql, /sbg_prepare_capacity_guest_payment/);
  assert.match(payment, /throw new GuestCheckoutClosed\(\)/);
  assert.match(payment, /bound\.stripeAccountId/);
  assert.doesNotMatch(payment, /sbg_prepare_booking_payment|SBG_SAAS_COMMERCE|SBG_DOMAIN_B_LIVE_CHECKOUT/);
  assert.match(entry, /handleGuestPaymentWebhook/);
  assert.doesNotMatch(webhook, /acceptIsolatedGuestPaymentTest|handleGuestPaymentWebhook/);
  assert.match(webhook, /capacity_payment_unmounted/);
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

test("bound payee, concurrency, and mocked payment lifecycle", { timeout: 180_000 }, async () => {
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
  let failStore = false;
  const deps = {
    async createCheckout(input: GuestCheckoutRequest) {
      created.push(input);
      if (failStore) {
        await root.query(`update sbg_booking_payments set status = 'failed' where id = $1::uuid`, [input.paymentId]);
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
       values ($1::uuid, 'acct_inhouse', false), ($2::uuid, 'acct_operator', false)`,
      [hotelOrg, operatorOrg],
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
    const completed = checkoutEvent("evt_paid_1", "checkout.session.completed", "paid", "pi_paid_1");
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
    const bad = await asGateway(() => acceptIsolatedGuestPaymentTest({
      rawBody: completed,
      signatureHeader: "t=1,v1=dead",
      webhookSecret: WEBHOOK_SECRET,
      db: gateway,
      env: TEST_ENV,
      nowMs: now,
    }));
    assert.equal(bad.status, 400);
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

    void payload;
  } finally {
    await left.end().catch(() => undefined);
    await right.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
});
