import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { BookingError } from "./booking.ts";
import { getPublicGuestBooking } from "./public-booking-read.ts";
import {
  GUEST_PAYMENT_ACTION_LABEL,
  GUEST_STATUS_POLL_LIMIT,
  guestCanStartPayment,
  guestCheckoutUrl,
  guestPaymentFailureMessage,
  projectPublicGuestStatus,
  shouldPollGuestStatus,
  type PublicLifecycleFacts,
} from "./public-booking-status.ts";

const CHAIN = [
  "0001_auth.sql",
  "0002_foundation.sql",
  "0003_occupancy.sql",
  "0005_time_domain.sql",
  "0012_cp12_tenancy.sql",
  "0015_cp14_hotel_configuration.sql",
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
];

function facts(overrides: Partial<PublicLifecycleFacts> = {}): PublicLifecycleFacts {
  return {
    lifecycle: "legacy_unreconciled",
    confirmedPaidAt: null,
    cancelledAt: null,
    paymentStatus: null,
    paidAt: null,
    bindingComplete: false,
    providerMatch: false,
    ...overrides,
  };
}

const PAID: Partial<PublicLifecycleFacts> = {
  lifecycle: "confirmed_paid",
  confirmedPaidAt: "2026-01-15T12:00:00.000Z",
  paymentStatus: "paid",
  paidAt: "2026-01-15T12:00:00.000Z",
  bindingComplete: true,
  providerMatch: true,
};

test("public status uses the server lifecycle and ignores a return url", () => {
  assert.equal(projectPublicGuestStatus.length, 1);
  const page = readFileSync(new URL("../../routes/confirmed.$token.tsx", import.meta.url), "utf8");
  const payment = readFileSync(new URL("./guest-payment-fns.ts", import.meta.url), "utf8");
  const schema = readFileSync(
    new URL("../../../migrations/0060_gate2_booking_lifecycle_schema.sql", import.meta.url),
    "utf8",
  );
  assert.equal(projectPublicGuestStatus(facts({ lifecycle: "awaiting_payment" })).heading, "Complete your payment");
  assert.equal(
    projectPublicGuestStatus(facts({ lifecycle: "payment_processing" })).heading,
    "Checking your payment",
  );
  assert.equal(projectPublicGuestStatus(facts(PAID)).heading, "Your transfer is confirmed");
  assert.equal(projectPublicGuestStatus(facts({ lifecycle: "expired" })).heading, "Your booking has expired");
  assert.equal(projectPublicGuestStatus(facts({ lifecycle: "failed" })).heading, "Payment was unsuccessful");
  assert.equal(projectPublicGuestStatus(facts({ lifecycle: "cancelled" })).heading, "Your transfer is cancelled");
  assert.equal(projectPublicGuestStatus(facts({ lifecycle: "refunded" })).heading, "Your transfer has been refunded");
  assert.equal(
    projectPublicGuestStatus(facts({ ...PAID, lifecycle: "legacy_unreconciled" })).heading,
    "Booking status unavailable",
  );
  assert.equal(
    projectPublicGuestStatus(facts({ ...PAID, paymentStatus: "paid", lifecycle: "legacy_unreconciled" })).code,
    "unavailable",
  );
  assert.equal(projectPublicGuestStatus(facts({ ...PAID, paymentStatus: "pending" })).code, "unavailable");
  assert.equal(projectPublicGuestStatus(facts({ ...PAID, paidAt: null })).code, "unavailable");
  assert.equal(projectPublicGuestStatus(facts({ ...PAID, confirmedPaidAt: null })).code, "unavailable");
  assert.equal(projectPublicGuestStatus(facts({ ...PAID, bindingComplete: false })).code, "unavailable");
  assert.equal(projectPublicGuestStatus(facts({ ...PAID, providerMatch: false })).code, "unavailable");
  assert.equal(projectPublicGuestStatus(facts({ ...PAID, paymentStatus: "received_after_expiry" })).code, "unavailable");
  assert.equal(projectPublicGuestStatus(facts({ ...PAID, cancelledAt: "2026-01-16T00:00:00.000Z" })).code, "cancelled");
  assert.equal(
    projectPublicGuestStatus(facts({ ...PAID, lifecycle: "refunded", cancelledAt: "2026-01-16T00:00:00.000Z" })).code,
    "refunded",
  );
  assert.equal(projectPublicGuestStatus(facts()).code, "unavailable");
  assert.match(projectPublicGuestStatus(facts({ lifecycle: "awaiting_payment" })).paymentNote ?? "", /Nothing has been charged/);
  assert.equal(projectPublicGuestStatus(facts(PAID)).paymentNote, null);
  const awaiting = projectPublicGuestStatus(facts({ lifecycle: "awaiting_payment" }));
  const checking = projectPublicGuestStatus(facts({ lifecycle: "payment_processing" }));
  assert.equal(shouldPollGuestStatus(checking, 0), true);
  assert.equal(shouldPollGuestStatus(checking, GUEST_STATUS_POLL_LIMIT - 1), true);
  assert.equal(shouldPollGuestStatus(checking, GUEST_STATUS_POLL_LIMIT), false);
  assert.equal(shouldPollGuestStatus(awaiting, 0), true);
  for (const status of [
    projectPublicGuestStatus(facts(PAID)),
    projectPublicGuestStatus(facts({ lifecycle: "expired" })),
    projectPublicGuestStatus(facts({ lifecycle: "failed" })),
    projectPublicGuestStatus(facts({ lifecycle: "cancelled" })),
    projectPublicGuestStatus(facts({ lifecycle: "refunded" })),
    projectPublicGuestStatus(facts()),
  ]) {
    assert.equal(shouldPollGuestStatus(status, 0), false);
  }
  assert.match(page, /startGuestPayment/);
  assert.match(page, /guestCanStartPayment/);
  assert.match(page, /GUEST_PAYMENT_ACTION_LABEL/);
  assert.equal(GUEST_PAYMENT_ACTION_LABEL, "Continue to secure payment");
  assert.doesNotMatch(page, /Pay for transfer|sbg_prepare_booking_payment/);
  assert.doesNotMatch(page, /paymentId|accountId/);
  assert.doesNotMatch(page, /payment=success|useSearch|searchParams/);
  assert.doesNotMatch(page, /confirmed_paid|hold_expires_at|webhook|Stripe Connect|entitlement/);
  assert.doesNotMatch(page, /durationMinutes|label="Duration"|confirmation email/i);
  assert.doesNotMatch(page, /pay later|cash payment|on arrival/i);
  assert.match(page, /Refresh status/);
  assert.match(page, /shouldPollGuestStatus/);
  assert.match(page, /guestStatus/);
  assert.doesNotMatch(payment, /sbg_prepare_booking_payment/);
  assert.match(payment, /GuestCheckoutClosed/);
  assert.match(payment, /SBG_GUEST_PAYMENT_TEST/);
  assert.doesNotMatch(schema, /revoke select \(lifecycle_state/);
  const projected = JSON.stringify(projectPublicGuestStatus(facts(PAID)));
  assert.doesNotMatch(projected, /confirmed_paid|acct_|payee_|webhook/);
});

test("payment action is offered only for an unpaid booking", () => {
  assert.equal(guestCanStartPayment(projectPublicGuestStatus(facts({ lifecycle: "awaiting_payment" }))), true);
  for (const status of [
    projectPublicGuestStatus(facts({ lifecycle: "payment_processing" })),
    projectPublicGuestStatus(facts(PAID)),
    projectPublicGuestStatus(facts({ lifecycle: "expired" })),
    projectPublicGuestStatus(facts({ lifecycle: "failed" })),
    projectPublicGuestStatus(facts({ lifecycle: "cancelled" })),
    projectPublicGuestStatus(facts({ lifecycle: "refunded" })),
    projectPublicGuestStatus(facts()),
  ]) {
    assert.equal(guestCanStartPayment(status), false);
  }
  assert.equal(projectPublicGuestStatus(facts(PAID)).code, "confirmed");
  assert.match(
    projectPublicGuestStatus(facts({ lifecycle: "awaiting_payment" })).paymentNote ?? "",
    /does not confirm this transfer/,
  );
});

test("payment start failures stay on the allowlisted guest messages", () => {
  assert.match(guestPaymentFailureMessage({ code: "guest_checkout_closed" }), /not open/);
  assert.match(guestPaymentFailureMessage({ message: "Online payment is not open for this booking." }), /not open/);
  assert.match(guestPaymentFailureMessage({ code: "hold_expired" }), /no longer held/);
  assert.match(guestPaymentFailureMessage({ message: "hold_expired" }), /no longer held/);
  assert.match(guestPaymentFailureMessage({ code: "checkout_in_progress" }), /already being started/);
  const leaked = guestPaymentFailureMessage({
    message: "duplicate key acct_1UKEFuFHnHoOWAJE payment_id secret sk_test_value",
  });
  assert.equal(leaked, "Payment cannot be started from this page. Nothing has been charged.");
  assert.doesNotMatch(leaked, /acct_|sk_test_|payment_id/);
  assert.equal(guestCheckoutUrl({ url: "https://checkout.stripe.com/c/pay/cs_test_example", paymentId: "pay", accountId: "acct" }), "https://checkout.stripe.com/c/pay/cs_test_example");
  assert.equal(guestCheckoutUrl({ url: "http://checkout.stripe.com/c/pay/cs_test_example" }), null);
  assert.equal(guestCheckoutUrl({ url: "/confirmed/token?payment=success" }), null);
  const page = readFileSync(new URL("../../routes/confirmed.$token.tsx", import.meta.url), "utf8");
  assert.match(page, /paymentPending\.current/);
  assert.match(page, /disabled=\{paying\}/);
  assert.doesNotMatch(page, /payment=success|result\.paymentId|result\.accountId/);
});

test("token lookup follows payment evidence and does not confirm a legacy row", async () => {
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
  const db = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
  };
  const hotelOrg = (
    await pg.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Hotel', 'user-1', 'hotel') returning id`,
    )
  ).rows[0]!.id;
  const hotel = (
    await pg.query<{ id: string }>(
      `insert into hotels (code, name, organisation_id) values ('stf', 'Status Hotel', $1::uuid) returning id`,
      [hotelOrg],
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity) values ($1::uuid, 'active', 1)`,
    [hotelOrg],
  );
  await pg.query(
    `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
     values ($1::uuid, $2::uuid, 'user-1')`,
    [hotelOrg, hotel],
  );
  const provider = (
    await pg.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('stf', 'Status Provider', 'in_house') returning id`,
    )
  ).rows[0]!.id;
  const otherProvider = (
    await pg.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('stf-other', 'Other Provider', 'in_house') returning id`,
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
    [hotel, provider],
  );
  await pg.query(
    `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode) values ($1::uuid, 'acct_legacy_stf', false)`,
    [hotel],
  );
  await pg.query(
    `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
     values ($1::uuid, 'acct_hotel_stf', false)`,
    [hotelOrg],
  );

  async function booking(token: string, reference: string): Promise<string> {
    const id = (
      await pg.query<{ id: string }>(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, pickup_text, destination_text,
           human_reference, confirmation_token
         ) values (
           $1::uuid, $2::uuid, '2026-01-15', '09:00', 60,
           'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport', $3, $4
         ) returning id`,
        [hotel, provider, reference, token],
      )
    ).rows[0]!.id;
    return id;
  }

  const openId = await booking("token-open", "ST-OPEN");
  await pg.query(`select * from sbg_open_provisional_hold($1::uuid, 1800)`, [openId]);
  await pg.query(
    `insert into sbg_booking_payments (booking_id, amount_minor, currency, stripe_checkout_session_id)
     values ($1::uuid, 4500, 'EUR', 'cs_open')`,
    [openId],
  );
  await pg.query(`select * from sbg_bind_payment_authority($1::uuid)`, [openId]);

  const open = await getPublicGuestBooking(db, "token-open");
  assert.equal(open.guestStatus.heading, "Complete your payment");
  assert.equal(open.humanReference, "ST-OPEN");
  assert.equal(open.hotelName, "Status Hotel");
  assert.doesNotMatch(JSON.stringify(open), /acct_|payee_|confirmed_paid|lifecycle_state/);

  await pg.query(
    `update bookings set lifecycle_state = 'payment_processing' where id = $1::uuid`,
    [openId],
  );
  assert.equal((await getPublicGuestBooking(db, "token-open")).guestStatus.heading, "Checking your payment");

  await pg.query(`update bookings set lifecycle_state = 'expired' where id = $1::uuid`, [openId]);
  assert.equal((await getPublicGuestBooking(db, "token-open")).guestStatus.code, "expired");

  await pg.query(`update bookings set lifecycle_state = 'failed' where id = $1::uuid`, [openId]);
  assert.equal((await getPublicGuestBooking(db, "token-open")).guestStatus.code, "unsuccessful");

  await pg.query(
    `update bookings set lifecycle_state = 'cancelled', cancelled_at = clock_timestamp() where id = $1::uuid`,
    [openId],
  );
  assert.equal((await getPublicGuestBooking(db, "token-open")).guestStatus.code, "cancelled");

  const paidId = await booking("token-paid", "ST-PAID");
  await pg.query(`select * from sbg_open_provisional_hold($1::uuid, 1800)`, [paidId]);
  const paymentId = (
    await pg.query<{ id: string }>(
      `insert into sbg_booking_payments (booking_id, amount_minor, currency, stripe_checkout_session_id)
       values ($1::uuid, 4500, 'EUR', 'cs_paid') returning id`,
      [paidId],
    )
  ).rows[0]!.id;
  await pg.query(`select * from sbg_bind_payment_authority($1::uuid)`, [paidId]);
  await pg.query(
    `update sbg_booking_payments set status = 'paid', paid_at = clock_timestamp() where id = $1::uuid`,
    [paymentId],
  );
  await pg.query(
    `update bookings set lifecycle_state = 'confirmed_paid', confirmed_paid_at = clock_timestamp() where id = $1::uuid`,
    [paidId],
  );
  const paid = await getPublicGuestBooking(db, "token-paid");
  assert.equal(paid.guestStatus.heading, "Your transfer is confirmed");
  assert.equal(paid.guestStatus.refresh, "none");

  await pg.query(`update sbg_booking_payments set status = 'pending', paid_at = null where id = $1::uuid`, [paymentId]);
  assert.equal((await getPublicGuestBooking(db, "token-paid")).guestStatus.code, "unavailable");
  await pg.query(
    `update sbg_booking_payments set status = 'paid', paid_at = clock_timestamp() where id = $1::uuid`,
    [paymentId],
  );
  assert.equal((await getPublicGuestBooking(db, "token-paid")).guestStatus.code, "confirmed");

  await pg.query(
    `update sbg_booking_payments set executing_provider_id = $2::uuid where id = $1::uuid`,
    [paymentId, otherProvider],
  );
  assert.equal((await getPublicGuestBooking(db, "token-paid")).guestStatus.code, "unavailable");
  await pg.query(
    `update sbg_booking_payments set executing_provider_id = $2::uuid where id = $1::uuid`,
    [paymentId, provider],
  );

  await pg.query(
    `update sbg_booking_payments
        set payee_organisation_id = null,
            executing_provider_id = null,
            payee_stripe_account_id = null,
            payee_kind = null,
            authority_bound_at = null
      where id = $1::uuid`,
    [paymentId],
  );
  assert.equal((await getPublicGuestBooking(db, "token-paid")).guestStatus.code, "unavailable");

  const legacyId = await booking("token-legacy", "ST-LEGACY");
  await pg.query(
    `insert into sbg_booking_payments (booking_id, amount_minor, currency, status, paid_at, stripe_checkout_session_id)
     values ($1::uuid, 4500, 'EUR', 'paid', clock_timestamp(), 'cs_legacy')`,
    [legacyId],
  );
  const legacy = await getPublicGuestBooking(db, "token-legacy");
  assert.equal(legacy.guestStatus.heading, "Booking status unavailable");
  assert.notEqual(legacy.guestStatus.code, "confirmed");

  await pg.query(
    `update bookings set lifecycle_state = 'refunded', cancelled_at = clock_timestamp() where id = $1::uuid`,
    [legacyId],
  );
  assert.equal((await getPublicGuestBooking(db, "token-legacy")).guestStatus.code, "refunded");

  await assert.rejects(() => getPublicGuestBooking(db, "ST-PAID"), (err: unknown) => {
    assert.ok(err instanceof BookingError);
    assert.equal(err.code, "not_found");
    return true;
  });
  await assert.rejects(() => getPublicGuestBooking(db, "   "), (err: unknown) => {
    assert.ok(err instanceof BookingError);
    assert.equal(err.code, "not_found");
    return true;
  });
  await assert.rejects(() => getPublicGuestBooking(db, "missing-token"), (err: unknown) => {
    assert.ok(err instanceof BookingError);
    assert.equal(err.code, "not_found");
    return true;
  });
});
