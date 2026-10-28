import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { acceptVerifiedPaymentEvent, type VerifiedPaymentClaim } from "./verified-payment.ts";

const SQL = readFileSync(
  new URL("../../../migrations/0063_gate2_verified_payment_transition.sql", import.meta.url),
  "utf8",
);

const CHAIN = [
  "0001_auth.sql",
  "0002_foundation.sql",
  "0003_occupancy.sql",
  "0005_time_domain.sql",
  "0012_cp12_tenancy.sql",
  "0018_cp22_saas_onboarding.sql",
  "0020_cp24_stripe_billing.sql",
  "0021_cp25_hotel_guest_payments.sql",
  "0024_cp26b2_ordered_billing_events.sql",
  "0025_cp26co2_platform_owners.sql",
  "0026_cp26co3_commercial_catalogue.sql",
  "0027_cp26co41_organisation_property_licence.sql",
  "0031_cp3005e2c_organisation_type.sql",
  "0039_gate2_operator_property_grants.sql",
  "0043_gate2_operator_provider_authorisations.sql",
  "0060_gate2_booking_lifecycle_schema.sql",
  "0061_gate2_provisional_hold_operations.sql",
  "0062_gate2_executing_provider_payment_authority.sql",
  "0063_gate2_verified_payment_transition.sql",
];

type Kind = "in_house" | "external";

type World = {
  hotelOrg: string;
  operatorOrg: string | null;
  hotel: string;
  provider: string;
  account: string;
  legacy: string;
  booking: string;
  payment: string;
};

function dbOf(pg: PGlite) {
  return {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
  };
}

async function openDb(): Promise<PGlite> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  await pg.exec("create role aether_app nologin");
  await pg.exec("create role aether_runtime nologin");
  for (const name of CHAIN) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  await pg.exec(
    `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
     values ('user-1','Ada','ada@example.com',true,now(),now())`,
  );
  return pg;
}

let seq = 0;

async function provision(pg: PGlite, kind: Kind): Promise<World> {
  const n = ++seq;
  const hotelOrg = (
    await pg.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ($1, 'user-1', 'hotel') returning id`,
      [`Hotel ${n}`],
    )
  ).rows[0]!.id;
  const operatorOrg =
    kind === "external"
      ? (
          await pg.query<{ id: string }>(
            `insert into sbg_organisations (name, created_by_user_id, organisation_type)
             values ($1, 'user-1', 'transfer_operator') returning id`,
            [`Operator ${n}`],
          )
        ).rows[0]!.id
      : null;
  const hotel = (
    await pg.query<{ id: string }>(
      `insert into hotels (code, name, organisation_id) values ($1, $2, $3::uuid) returning id`,
      [`h${n}`, `Hotel ${n}`, hotelOrg],
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity)
     values ($1::uuid, 'active', 1)`,
    [hotelOrg],
  );
  if (operatorOrg) {
    await pg.query(
      `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity)
       values ($1::uuid, 'active', 1)`,
      [operatorOrg],
    );
  }
  await pg.query(
    `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
     values ($1::uuid, $2::uuid, 'user-1')`,
    [hotelOrg, hotel],
  );
  const provider = (
    await pg.query<{ id: string }>(
      `insert into providers (code, name, kind) values ($1, $2, $3) returning id`,
      [`p${n}`, `Provider ${n}`, kind],
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
    [hotel, provider],
  );
  const legacy = `acct_legacy_${n}`;
  await pg.query(
    `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode) values ($1::uuid, $2, false)`,
    [hotel, legacy],
  );
  const account = kind === "in_house" ? `acct_hotel_${n}` : `acct_operator_${n}`;
  await pg.query(
    `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
     values ($1::uuid, $2, false)`,
    [kind === "in_house" ? hotelOrg : operatorOrg, account],
  );
  if (operatorOrg) {
    await pg.query(
      `insert into sbg_operator_property_grants (operator_organisation_id, hotel_id, granted_by_user_id)
       values ($1::uuid, $2::uuid, 'user-1')`,
      [operatorOrg, hotel],
    );
    await pg.query(
      `insert into sbg_operator_provider_authorisations
         (operator_organisation_id, hotel_id, provider_id, authorised_by_user_id)
       values ($1::uuid, $2::uuid, $3::uuid, 'user-1')`,
      [operatorOrg, hotel, provider],
    );
  }
  const booking = (
    await pg.query<{ id: string }>(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, pickup_text, destination_text,
         human_reference, confirmation_token
       ) values (
         $1::uuid, $2::uuid, '2026-01-15', '09:00', 60,
         'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport', $3, $4
       ) returning id`,
      [hotel, provider, `PT-${n}`, `token-PT-${n}`],
    )
  ).rows[0]!.id;
  await pg.query(`select * from sbg_open_provisional_hold($1::uuid, 1800)`, [booking]);
  const payment = (
    await pg.query<{ id: string }>(
      `insert into sbg_booking_payments (
         booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url
       ) values ($1::uuid, 4500, 'EUR', $2, 'https://checkout.stripe.test/session')
       returning id`,
      [booking, `cs_test_${n}`],
    )
  ).rows[0]!.id;
  await pg.query(`select * from sbg_bind_payment_authority($1::uuid)`, [booking]);
  return { hotelOrg, operatorOrg, hotel, provider, account, legacy, booking, payment };
}

function claim(world: World, eventId: string, patch: Partial<VerifiedPaymentClaim> = {}): VerifiedPaymentClaim {
  return {
    signatureVerified: true,
    eventId,
    eventType: "checkout.session.completed",
    bookingId: world.booking,
    paymentId: world.payment,
    executingProviderId: world.provider,
    accountId: world.account,
    sessionId: "",
    amountMinor: 4500,
    currency: "EUR",
    paymentStatus: "paid",
    paymentIntentId: `pi_${eventId}`,
    ...patch,
  };
}

async function withSession(pg: PGlite, world: World, eventId: string, patch: Partial<VerifiedPaymentClaim> = {}) {
  const session = (
    await pg.query<{ stripe_checkout_session_id: string }>(
      `select stripe_checkout_session_id from sbg_booking_payments where id = $1::uuid`,
      [world.payment],
    )
  ).rows[0]!.stripe_checkout_session_id;
  return acceptVerifiedPaymentEvent(dbOf(pg), claim(world, eventId, { sessionId: session, ...patch }));
}

async function stateOf(pg: PGlite, world: World) {
  const booking = (
    await pg.query<{
      lifecycle_state: string;
      confirmed_paid_at: string | null;
      vehicle_id: string | null;
      driver_id: string | null;
    }>(
      `select lifecycle_state, confirmed_paid_at, vehicle_id, driver_id
         from bookings where id = $1::uuid`,
      [world.booking],
    )
  ).rows[0]!;
  const payment = (
    await pg.query<{
      status: string;
      amount_minor: number;
      currency: string;
      stripe_checkout_session_id: string;
      payee_organisation_id: string;
      payee_stripe_account_id: string;
      paid_at: string | null;
    }>(
      `select status, amount_minor, currency, stripe_checkout_session_id,
              payee_organisation_id, payee_stripe_account_id, paid_at
         from sbg_booking_payments where id = $1::uuid`,
      [world.payment],
    )
  ).rows[0]!;
  return { booking, payment };
}

async function eventCount(pg: PGlite, eventId: string): Promise<number> {
  const rows = await pg.query<{ n: number }>(
    `select count(*)::int as n from sbg_stripe_events where event_id = $1`,
    [eventId],
  );
  return rows.rows[0]!.n;
}

test("0063 is source-only and is not mounted", () => {
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  assert.equal(preflight.includes("0063_gate2_verified_payment_transition.sql"), false);
  assert.doesNotMatch(SQL, /pg_cron|cron\.schedule/);
  assert.doesNotMatch(SQL, /create or replace function public\.sbg_prepare_booking_payment/);
  assert.doesNotMatch(SQL, /create or replace function public\.sbg_apply_payment_event/);
  assert.match(SQL, /grant execute on function public\.sbg_accept_verified_payment_event/);
  assert.match(SQL, /for update/);
  const webhook = readFileSync(new URL("../../routes/api/stripe/webhook.ts", import.meta.url), "utf8");
  const guestPay = readFileSync(new URL("./guest-payment-fns.ts", import.meta.url), "utf8");
  const domainB = readFileSync(new URL("./domain-b-payment.ts", import.meta.url), "utf8");
  assert.doesNotMatch(webhook, /sbg_accept_verified_payment_event|acceptVerifiedPaymentEvent/);
  assert.match(webhook, /sbg_apply_payment_event/);
  assert.doesNotMatch(guestPay, /sbg_accept_verified_payment_event|acceptVerifiedPaymentEvent/);
  assert.match(domainB, /sbg_apply_payment_event/);
  assert.match(domainB, /c\.hotel_id = b\.hotel_id/);
});

test("timely hotel and operator payments confirm without moving commercial columns", async () => {
  const pg = await openDb();
  const hotel = await provision(pg, "in_house");
  const hotelPaid = await withSession(pg, hotel, "evt_hotel_paid_1");
  assert.equal(hotelPaid.outcome, "confirmed_paid");
  assert.equal(hotelPaid.lifecycle, "confirmed_paid");
  assert.equal(hotelPaid.paymentStatus, "paid");
  assert.equal(hotelPaid.eventRecorded, true);
  const hotelState = await stateOf(pg, hotel);
  assert.ok(hotelState.booking.confirmed_paid_at);
  assert.equal(hotelState.booking.vehicle_id, null);
  assert.equal(hotelState.booking.driver_id, null);
  assert.equal(hotelState.payment.amount_minor, 4500);
  assert.equal(hotelState.payment.currency, "EUR");
  assert.equal(hotelState.payment.payee_stripe_account_id, hotel.account);
  assert.equal(hotelState.payment.payee_organisation_id, hotel.hotelOrg);
  assert.ok(hotelState.payment.paid_at);

  const operator = await provision(pg, "external");
  await pg.query(`update bookings set lifecycle_state = 'payment_processing' where id = $1::uuid`, [operator.booking]);
  const operatorPaid = await withSession(pg, operator, "evt_operator_paid_1");
  assert.equal(operatorPaid.outcome, "confirmed_paid");
  assert.equal(operatorPaid.lifecycle, "confirmed_paid");
  const operatorState = await stateOf(pg, operator);
  assert.equal(operatorState.payment.payee_organisation_id, operator.operatorOrg);
  assert.equal(operatorState.payment.payee_stripe_account_id, operator.account);
  assert.notEqual(operatorState.payment.payee_stripe_account_id, operator.legacy);
  const args = await pg.query<{ args: string }>(
    `select pg_get_function_identity_arguments(oid) as args
       from pg_proc where proname = 'sbg_accept_verified_payment_event'`,
  );
  assert.doesNotMatch(args.rows[0]!.args, /timestamptz/);
  const body = await pg.query<{ src: string }>(
    `select prosrc as src from pg_proc where proname = 'sbg_accept_verified_payment_event'`,
  );
  assert.doesNotMatch(body.rows[0]!.src, /sbg_apply_payment_event/);
  const legacyApply = await pg.query<{ src: string }>(
    `select prosrc as src from pg_proc where proname = 'sbg_apply_payment_event'`,
  );
  assert.doesNotMatch(legacyApply.rows[0]!.src, /lifecycle_state|confirmed_paid_at/);
  await pg.close();
});

test("late holds, expired sessions, and canceled sessions do not resurrect a closed hold", async () => {
  const pg = await openDb();
  const late = await provision(pg, "in_house");
  await pg.query(
    `update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid`,
    [late.booking],
  );
  const lateResult = await withSession(pg, late, "evt_late_1");
  assert.equal(lateResult.outcome, "late_payment");
  assert.equal(lateResult.lifecycle, "expired");
  assert.equal(lateResult.paymentStatus, "received_after_expiry");
  assert.equal(lateResult.eventRecorded, true);
  assert.equal((await stateOf(pg, late)).booking.confirmed_paid_at, null);

  const sessionThenPaid = await provision(pg, "external");
  const expiredSession = await withSession(pg, sessionThenPaid, "evt_session_expired_1", {
    eventType: "checkout.session.expired",
    paymentStatus: "expired",
    paymentIntentId: null,
  });
  assert.equal(expiredSession.outcome, "payment_canceled");
  assert.equal(expiredSession.lifecycle, "awaiting_payment");
  assert.equal(expiredSession.paymentStatus, "expired");
  const paidAfterExpiry = await withSession(pg, sessionThenPaid, "evt_paid_after_session_1");
  assert.equal(paidAfterExpiry.outcome, "confirmed_paid");
  assert.equal(paidAfterExpiry.lifecycle, "confirmed_paid");
  assert.equal(paidAfterExpiry.paymentStatus, "paid");

  const driftedSession = await provision(pg, "in_house");
  await withSession(pg, driftedSession, "evt_session_expired_2", {
    eventType: "checkout.session.expired",
    paymentStatus: "expired",
    paymentIntentId: null,
  });
  await pg.query(
    `update sbg_organisation_stripe_connections set stripe_account_id = $2 where organisation_id = $1::uuid`,
    [driftedSession.hotelOrg, "acct_drift_after_session"],
  );
  const drifted = await withSession(pg, driftedSession, "evt_paid_after_drift_session");
  assert.equal(drifted.outcome, "authority_drift");
  assert.equal(drifted.eventRecorded, false);
  assert.equal(await eventCount(pg, "evt_paid_after_drift_session"), 0);
  assert.equal((await stateOf(pg, driftedSession)).booking.lifecycle_state, "awaiting_payment");
  assert.equal((await stateOf(pg, driftedSession)).payment.status, "expired");

  const canceled = await provision(pg, "in_house");
  await pg.query(`update sbg_booking_payments set status = 'canceled' where id = $1::uuid`, [canceled.payment]);
  const canceledPaid = await withSession(pg, canceled, "evt_paid_after_canceled_session");
  assert.equal(canceledPaid.outcome, "confirmed_paid");

  const closed = await provision(pg, "external");
  await pg.query(
    `update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid`,
    [closed.booking],
  );
  await pg.query(`update sbg_booking_payments set status = 'expired' where id = $1::uuid`, [closed.payment]);
  const closedPaid = await withSession(pg, closed, "evt_paid_after_hold_and_session");
  assert.equal(closedPaid.outcome, "late_payment");
  assert.equal(closedPaid.lifecycle, "expired");
  assert.equal(closedPaid.paymentStatus, "received_after_expiry");
  assert.equal((await stateOf(pg, closed)).booking.confirmed_paid_at, null);
  await pg.close();
});

test("mismatches, duplicates, async events, failures, and refunds keep one disposition", async () => {
  const pg = await openDb();
  const world = await provision(pg, "external");
  const wrongAccount = await withSession(pg, world, "evt_wrong_account", { accountId: "acct_other" });
  assert.equal(wrongAccount.outcome, "wrong_account");
  assert.equal(wrongAccount.eventRecorded, false);
  assert.equal(await eventCount(pg, "evt_wrong_account"), 0);
  const hotelAccount = await withSession(pg, world, "evt_hotel_account", { accountId: world.legacy });
  assert.equal(hotelAccount.outcome, "hotel_account_not_payee");
  assert.equal(await eventCount(pg, "evt_hotel_account"), 0);
  const wrongAmount = await withSession(pg, world, "evt_wrong_amount", { amountMinor: 1 });
  assert.equal(wrongAmount.outcome, "amount");
  const wrongCurrency = await withSession(pg, world, "evt_wrong_currency", { currency: "usd" });
  assert.equal(wrongCurrency.outcome, "currency");
  const wrongSession = await withSession(pg, world, "evt_wrong_session", { sessionId: "cs_other" });
  assert.equal(wrongSession.outcome, "session");
  const wrongProvider = await withSession(pg, world, "evt_wrong_provider", {
    executingProviderId: "00000000-0000-4000-8000-000000000099",
  });
  assert.equal(wrongProvider.outcome, "provider");
  assert.equal((await stateOf(pg, world)).booking.lifecycle_state, "awaiting_payment");
  assert.equal((await stateOf(pg, world)).payment.status, "pending");

  const unsigned = await withSession(pg, world, "evt_unsigned", { signatureVerified: false });
  assert.equal(unsigned.outcome, "signature_not_verified");
  assert.equal(await eventCount(pg, "evt_unsigned"), 0);
  const badId = await withSession(pg, world, "not-an-event");
  assert.equal(badId.outcome, "event_id_required");
  assert.equal(await eventCount(pg, "not-an-event"), 0);
  const unsupported = await withSession(pg, world, "evt_return_url", {
    eventType: "payment_return_url",
    paymentStatus: "paid",
  });
  assert.equal(unsupported.outcome, "unsupported_event");
  assert.equal(await eventCount(pg, "evt_return_url"), 0);

  const processing = await withSession(pg, world, "evt_processing", {
    paymentStatus: "unpaid",
    paymentIntentId: null,
  });
  assert.equal(processing.outcome, "processing");
  assert.equal(processing.lifecycle, "awaiting_payment");
  assert.equal(processing.paymentStatus, "pending");
  assert.equal(processing.eventRecorded, true);

  const failed = await withSession(pg, world, "evt_async_failed", {
    eventType: "checkout.session.async_payment_failed",
    paymentStatus: "failed",
    paymentIntentId: null,
  });
  assert.equal(failed.outcome, "payment_failed");
  assert.equal(failed.lifecycle, "failed");
  assert.equal(failed.paymentStatus, "failed");
  const afterFailure = await withSession(pg, world, "evt_success_after_failure");
  assert.equal(afterFailure.outcome, "late_payment");
  assert.equal(afterFailure.lifecycle, "failed");
  assert.equal(afterFailure.paymentStatus, "received_after_expiry");
  assert.equal((await stateOf(pg, world)).booking.confirmed_paid_at, null);

  const fresh = await provision(pg, "in_house");
  const asyncPaid = await withSession(pg, fresh, "evt_async_paid", {
    eventType: "checkout.session.async_payment_succeeded",
    paymentStatus: "paid",
  });
  assert.equal(asyncPaid.outcome, "confirmed_paid");
  const replay = await withSession(pg, fresh, "evt_async_paid");
  assert.equal(replay.outcome, "duplicate");
  assert.equal(replay.eventRecorded, false);
  assert.equal(await eventCount(pg, "evt_async_paid"), 1);
  const second = await withSession(pg, fresh, "evt_async_paid_again");
  assert.equal(second.outcome, "ignored_after_settlement");
  assert.equal(second.lifecycle, "confirmed_paid");
  assert.equal(second.paymentStatus, "paid");
  const failureAfter = await withSession(pg, fresh, "evt_failure_after_paid", {
    eventType: "checkout.session.async_payment_failed",
    paymentStatus: "failed",
  });
  assert.equal(failureAfter.outcome, "ignored_after_settlement");
  assert.equal((await stateOf(pg, fresh)).booking.lifecycle_state, "confirmed_paid");
  assert.equal((await stateOf(pg, fresh)).payment.status, "paid");
  const early = await provision(pg, "in_house");
  const refundEarly = await withSession(pg, early, "evt_refund_early", {
    eventType: "charge.refunded",
    paymentStatus: "refunded",
  });
  assert.equal(refundEarly.outcome, "refund_not_applicable");
  assert.equal(refundEarly.eventRecorded, false);
  const refund = await withSession(pg, fresh, "evt_refund_after_paid", {
    eventType: "charge.refunded",
    paymentStatus: "refunded",
  });
  assert.equal(refund.outcome, "refunded");
  assert.equal(refund.lifecycle, "refunded");
  assert.equal(refund.paymentStatus, "paid");
  assert.ok((await stateOf(pg, fresh)).booking.confirmed_paid_at);

  const legacy = await provision(pg, "in_house");
  await pg.query(
    `update bookings set lifecycle_state = 'legacy_unreconciled', hold_expires_at = null where id = $1::uuid`,
    [legacy.booking],
  );
  const legacyResult = await withSession(pg, legacy, "evt_legacy");
  assert.equal(legacyResult.outcome, "ineligible_lifecycle");
  assert.equal(legacyResult.eventRecorded, false);
  assert.equal(await eventCount(pg, "evt_legacy"), 0);

  const bypass = await provision(pg, "in_house");
  await pg.query(
    `select sbg_apply_payment_event($1, $2, $3::uuid, $4::uuid, $5, $6, $7)`,
    ["evt_apply_bypass", "checkout.session.completed", bypass.booking, bypass.payment, "pi_bypass", "paid", bypass.legacy],
  );
  const bypassed = await stateOf(pg, bypass);
  assert.equal(bypassed.payment.status, "paid");
  assert.equal(bypassed.booking.lifecycle_state, "awaiting_payment");
  assert.equal(bypassed.booking.confirmed_paid_at, null);
  const afterBypass = await withSession(pg, bypass, "evt_after_apply_bypass");
  assert.equal(afterBypass.outcome, "ignored_after_settlement");
  assert.equal((await stateOf(pg, bypass)).booking.lifecycle_state, "awaiting_payment");
  await pg.close();
});

test("drift, revocation, rollback, and role grants stay closed", async () => {
  const pg = await openDb();
  const drifted = await provision(pg, "in_house");
  await pg.query(
    `update sbg_organisation_stripe_connections set stripe_account_id = $2 where organisation_id = $1::uuid`,
    [drifted.hotelOrg, "acct_changed_after_bind"],
  );
  const drift = await withSession(pg, drifted, "evt_account_drift");
  assert.equal(drift.outcome, "authority_drift");
  assert.equal(drift.eventRecorded, false);
  assert.equal(await eventCount(pg, "evt_account_drift"), 0);
  assert.equal((await stateOf(pg, drifted)).payment.payee_stripe_account_id, drifted.account);
  assert.equal((await stateOf(pg, drifted)).booking.lifecycle_state, "awaiting_payment");

  const revoked = await provision(pg, "external");
  await pg.query(
    `update sbg_operator_provider_authorisations set revoked_at = clock_timestamp()
      where hotel_id = $1::uuid and provider_id = $2::uuid`,
    [revoked.hotel, revoked.provider],
  );
  const revokedResult = await withSession(pg, revoked, "evt_revoked");
  assert.equal(revokedResult.outcome, "authority_drift");
  assert.equal(await eventCount(pg, "evt_revoked"), 0);
  assert.equal((await stateOf(pg, revoked)).booking.lifecycle_state, "awaiting_payment");

  const rolled = await provision(pg, "in_house");
  await pg.exec("begin");
  const inside = await withSession(pg, rolled, "evt_rollback");
  assert.equal(inside.outcome, "confirmed_paid");
  await pg.exec("rollback");
  assert.equal(await eventCount(pg, "evt_rollback"), 0);
  const rolledState = await stateOf(pg, rolled);
  assert.equal(rolledState.booking.lifecycle_state, "awaiting_payment");
  assert.equal(rolledState.booking.confirmed_paid_at, null);
  assert.equal(rolledState.payment.status, "pending");

  const privileges = await pg.query<{
    webhook: boolean;
    app: boolean;
    runtime: boolean;
    public_exec: boolean;
    webhook_update: boolean;
    webhook_insert: boolean;
    prosecdef: boolean;
    owner: string;
  }>(
    `select
       has_function_privilege('aether_webhook', 'public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text)', 'execute') as webhook,
       has_function_privilege('aether_app', 'public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text)', 'execute') as app,
       has_function_privilege('aether_runtime', 'public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text)', 'execute') as runtime,
       has_function_privilege('public', 'public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text)', 'execute') as public_exec,
       has_table_privilege('aether_webhook', 'public.bookings', 'update') as webhook_update,
       has_table_privilege('aether_webhook', 'public.sbg_stripe_events', 'insert') as webhook_insert,
       p.prosecdef,
       r.rolname as owner
     from pg_proc p
     join pg_roles r on r.oid = p.proowner
    where p.proname = 'sbg_accept_verified_payment_event'`,
  );
  assert.equal(privileges.rows[0]!.webhook, true);
  assert.equal(privileges.rows[0]!.app, false);
  assert.equal(privileges.rows[0]!.runtime, false);
  assert.equal(privileges.rows[0]!.public_exec, false);
  assert.equal(privileges.rows[0]!.webhook_update, false);
  assert.equal(privileges.rows[0]!.webhook_insert, false);
  assert.equal(privileges.rows[0]!.prosecdef, true);
  assert.notEqual(privileges.rows[0]!.owner, "aether_webhook");

  const allowed = await provision(pg, "in_house");
  const allowedSession = (
    await pg.query<{ stripe_checkout_session_id: string }>(
      `select stripe_checkout_session_id from sbg_booking_payments where id = $1::uuid`,
      [allowed.payment],
    )
  ).rows[0]!.stripe_checkout_session_id;
  await pg.exec("set role aether_webhook");
  const asWebhook = await acceptVerifiedPaymentEvent(
    dbOf(pg),
    claim(allowed, "evt_as_webhook", { sessionId: allowedSession }),
  );
  await pg.exec("reset role");
  assert.equal(asWebhook.outcome, "confirmed_paid");

  const denied = await provision(pg, "in_house");
  const deniedSession = (
    await pg.query<{ stripe_checkout_session_id: string }>(
      `select stripe_checkout_session_id from sbg_booking_payments where id = $1::uuid`,
      [denied.payment],
    )
  ).rows[0]!.stripe_checkout_session_id;
  await pg.exec("set role aether_app");
  await assert.rejects(
    () => acceptVerifiedPaymentEvent(dbOf(pg), claim(denied, "evt_as_app", { sessionId: deniedSession })),
    /permission denied/,
  );
  await pg.exec("reset role");
  await pg.exec("set role aether_runtime");
  await assert.rejects(
    () => acceptVerifiedPaymentEvent(dbOf(pg), claim(denied, "evt_as_runtime", { sessionId: deniedSession })),
    /permission denied/,
  );
  await pg.exec("reset role");
  await pg.exec("set role aether_app");
  await assert.rejects(
    () => pg.query(`update bookings set lifecycle_state = 'confirmed_paid', confirmed_paid_at = clock_timestamp() where id = $1::uuid`, [denied.booking]),
    /permission denied|not directly writable/,
  );
  await pg.exec("reset role");
  assert.equal((await stateOf(pg, denied)).booking.lifecycle_state, "awaiting_payment");
  await pg.close();
});
