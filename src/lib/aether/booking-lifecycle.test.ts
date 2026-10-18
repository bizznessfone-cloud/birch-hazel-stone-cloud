import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PROVISIONAL_HOLD_TTL_MS,
  PROVISIONAL_HOLD_TTL_STATUS,
  applyLifecycle,
  dispatchEligible,
  emptyDraft,
  holdExpiresAt,
  occupancyClaim,
  operationallyAdmitted,
  payeeBinding,
  provisionalHoldConsumesGist,
  type BookingSnapshot,
  type PayeeFacts,
} from "./booking-lifecycle.ts";

const NOW = Date.parse("2026-03-29T00:30:00.000Z");

function hotelPayee(overrides: Partial<PayeeFacts> = {}): PayeeFacts {
  return {
    kind: "hotel_in_house",
    providerAgreementActive: true,
    propertyGrantActive: true,
    providerAuthorisationActive: true,
    payeeAccountId: "acct_hotel",
    hotelAccountId: "acct_hotel",
    eventAccountId: "acct_hotel",
    licenceAllocated: true,
    subscriptionActive: true,
    ...overrides,
  };
}

function operatorPayee(overrides: Partial<PayeeFacts> = {}): PayeeFacts {
  return {
    kind: "independent_operator",
    providerAgreementActive: true,
    propertyGrantActive: true,
    providerAuthorisationActive: true,
    payeeAccountId: "acct_operator",
    hotelAccountId: "acct_hotel",
    eventAccountId: "acct_operator",
    licenceAllocated: true,
    subscriptionActive: true,
    ...overrides,
  };
}

function admitted(): BookingSnapshot {
  const held = applyLifecycle(emptyDraft(), { type: "open_hold", now: NOW });
  assert.equal(held.allowed, true);
  const opened = applyLifecycle(held.snapshot, {
    type: "open_checkout",
    now: NOW,
    commerceAdmitted: true,
    payee: hotelPayee(),
  });
  assert.equal(opened.reason, "checkout_opened");
  return opened.snapshot;
}

test("return URL cannot confirm a booking", () => {
  const processing = admitted();
  const success = applyLifecycle(processing, { type: "return_url", outcome: "success" });
  assert.equal(success.allowed, false);
  assert.equal(success.reason, "return_url_is_not_confirmation");
  assert.equal(success.snapshot.lifecycle, "payment_processing");
  assert.equal(success.snapshot.payment, "pending");
  assert.equal(success.snapshot.confirmationEmailSent, false);
  assert.equal(dispatchEligible(success.snapshot, true), false);
});

test("confirmation email is forbidden before verified payment", () => {
  const processing = admitted();
  const email = applyLifecycle(processing, { type: "send_confirmation_email" });
  assert.equal(email.allowed, false);
  assert.equal(email.reason, "email_before_verification");
  assert.equal(email.snapshot.confirmationEmailSent, false);
});

test("unpaid expiry releases the hold and does not confirm", () => {
  const processing = admitted();
  const tooSoon = applyLifecycle(processing, { type: "expire", now: processing.holdExpiresAt! });
  assert.equal(tooSoon.allowed, false);
  const expired = applyLifecycle(processing, { type: "expire", now: processing.holdExpiresAt! + 1 });
  assert.equal(expired.reason, "hold_expired");
  assert.equal(expired.snapshot.lifecycle, "expired");
  assert.equal(expired.snapshot.payment, "expired");
  assert.equal(expired.snapshot.vehicleAssigned, false);
  assert.equal(occupancyClaim(expired.snapshot), "none");
  assert.equal(dispatchEligible(expired.snapshot, true), false);
  const email = applyLifecycle(expired.snapshot, { type: "send_confirmation_email" });
  assert.equal(email.allowed, false);
});

test("a provisional hold does not consume the vehicle or driver GiST slot", () => {
  assert.equal(provisionalHoldConsumesGist(), false);
  const processing = admitted();
  assert.equal(occupancyClaim(processing), "none");
  const assigned = applyLifecycle(processing, { type: "assign_resource", resource: "vehicle" });
  assert.equal(assigned.allowed, false);
  assert.equal(assigned.reason, "dispatch_not_admitted");
  const exclusion = readFileSync(new URL("../../../migrations/0003_occupancy.sql", import.meta.url), "utf8");
  assert.match(exclusion, /vehicle_id is not null and cancelled_at is null/);
  assert.match(exclusion, /driver_id is not null and cancelled_at is null/);
});

test("two open holds do not exclude each other through this contract", () => {
  const first = admitted();
  const second = admitted();
  assert.equal(first.lifecycle, "payment_processing");
  assert.equal(second.lifecycle, "payment_processing");
  assert.equal(occupancyClaim(first), "none");
  assert.equal(occupancyClaim(second), "none");
});

test("webhook replay does not change a confirmed booking", () => {
  const processing = admitted();
  const paid = applyLifecycle(processing, {
    type: "verified_payment",
    now: NOW + 1000,
    eventId: "evt_1",
    paid: true,
    failed: false,
    payee: hotelPayee(),
    providerAuthorised: true,
    licenceAllocated: true,
  });
  assert.equal(paid.reason, "confirmed_paid");
  const replay = applyLifecycle(paid.snapshot, {
    type: "verified_payment",
    now: NOW + 1000,
    eventId: "evt_1",
    paid: true,
    failed: false,
    payee: hotelPayee(),
    providerAuthorised: false,
    licenceAllocated: false,
  });
  assert.equal(replay.reason, "webhook_replay");
  assert.deepEqual(replay.snapshot, paid.snapshot);
});

test("asynchronous success confirms only inside the hold; failure does not", () => {
  const processing = admitted();
  const failed = applyLifecycle(processing, {
    type: "verified_payment",
    now: NOW + 1000,
    eventId: "evt_fail",
    paid: false,
    failed: true,
    payee: hotelPayee(),
    providerAuthorised: true,
    licenceAllocated: true,
  });
  assert.equal(failed.snapshot.lifecycle, "failed");
  assert.equal(failed.snapshot.payment, "failed");
  assert.equal(dispatchEligible(failed.snapshot, true), false);
  const later = applyLifecycle(admitted(), {
    type: "verified_payment",
    now: NOW + 1000,
    eventId: "evt_async",
    paid: true,
    failed: false,
    payee: hotelPayee(),
    providerAuthorised: true,
    licenceAllocated: true,
  });
  assert.equal(later.snapshot.lifecycle, "confirmed_paid");
  const email = applyLifecycle(later.snapshot, { type: "send_confirmation_email" });
  assert.equal(email.reason, "confirmation_email_sent");
});

test("the hotel Stripe account is not the payee for an independent operator", () => {
  const wrong = payeeBinding(operatorPayee({ eventAccountId: "acct_hotel", payeeAccountId: "acct_hotel" }));
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, "hotel_account_not_payee");
  const checkout = applyLifecycle(applyLifecycle(emptyDraft(), { type: "open_hold", now: NOW }).snapshot, {
    type: "open_checkout",
    now: NOW,
    commerceAdmitted: true,
    payee: operatorPayee({ eventAccountId: "acct_hotel" }),
  });
  assert.equal(checkout.allowed, false);
  assert.equal(checkout.reason, "wrong_account");
  const bound = payeeBinding(operatorPayee());
  assert.equal(bound.ok && bound.accountId, "acct_operator");
});

test("revoked provider, inactive agreement, or stale licence blocks confirmation", () => {
  const processing = admitted();
  const revoked = applyLifecycle(processing, {
    type: "verified_payment",
    now: NOW + 1000,
    eventId: "evt_revoked",
    paid: true,
    failed: false,
    payee: operatorPayee({ providerAuthorisationActive: false }),
    providerAuthorised: true,
    licenceAllocated: true,
  });
  assert.equal(revoked.reason, "authorisation_revoked");
  assert.equal(revoked.snapshot.lifecycle, "payment_processing");
  const stale = applyLifecycle(processing, {
    type: "verified_payment",
    now: NOW + 1000,
    eventId: "evt_licence",
    paid: true,
    failed: false,
    payee: hotelPayee(),
    providerAuthorised: true,
    licenceAllocated: false,
  });
  assert.equal(stale.reason, "licence_missing");
  const inactive = applyLifecycle(processing, {
    type: "verified_payment",
    now: NOW + 1000,
    eventId: "evt_agreement",
    paid: true,
    failed: false,
    payee: hotelPayee({ providerAgreementActive: false }),
    providerAuthorised: true,
    licenceAllocated: true,
  });
  assert.equal(inactive.reason, "inactive_agreement");
});

test("commerce admission stays closed until explicitly supplied", () => {
  const held = applyLifecycle(emptyDraft(), { type: "open_hold", now: NOW }).snapshot;
  const closed = applyLifecycle(held, {
    type: "open_checkout",
    now: NOW,
    commerceAdmitted: false,
    payee: hotelPayee(),
  });
  assert.equal(closed.reason, "commerce_not_admitted");
  assert.equal(closed.snapshot.lifecycle, "awaiting_payment");
});

test("a payment after expiry is recorded and does not reinstate capacity", () => {
  const processing = admitted();
  const expired = applyLifecycle(processing, { type: "expire", now: processing.holdExpiresAt! + 1 }).snapshot;
  const late = applyLifecycle(expired, {
    type: "verified_payment",
    now: expired.holdExpiresAt! + 5,
    eventId: "evt_late",
    paid: true,
    failed: false,
    payee: hotelPayee(),
    providerAuthorised: true,
    licenceAllocated: true,
  });
  assert.equal(late.reason, "late_payment");
  assert.equal(late.snapshot.lifecycle, "expired");
  assert.equal(late.snapshot.payment, "received_after_expiry");
  assert.equal(late.snapshot.confirmationEmailSent, false);
  assert.equal(occupancyClaim(late.snapshot), "none");
  assert.equal(operationallyAdmitted(late.snapshot, true), false);
  const assign = applyLifecycle(late.snapshot, { type: "assign_resource", resource: "vehicle" });
  assert.equal(assign.allowed, false);
  const email = applyLifecycle(late.snapshot, { type: "send_confirmation_email" });
  assert.equal(email.allowed, false);
});

test("hold TTL is absolute and is not a civil-time or DST conversion", () => {
  assert.equal(PROVISIONAL_HOLD_TTL_STATUS, "provisional_pending_approval");
  assert.equal(PROVISIONAL_HOLD_TTL_MS, 1_800_000);
  const beforeGap = Date.parse("2026-03-29T00:30:00.000Z");
  assert.equal(holdExpiresAt(beforeGap) - beforeGap, PROVISIONAL_HOLD_TTL_MS);
  const afterGap = Date.parse("2026-03-29T01:30:00.000Z");
  assert.equal(holdExpiresAt(afterGap) - afterGap, PROVISIONAL_HOLD_TTL_MS);
});

test("verified payment admits dispatch; revocation withdraws it without unconfirming", () => {
  const paid = applyLifecycle(admitted(), {
    type: "verified_payment",
    now: NOW + 1000,
    eventId: "evt_ok",
    paid: true,
    failed: false,
    payee: hotelPayee(),
    providerAuthorised: true,
    licenceAllocated: true,
  }).snapshot;
  assert.equal(dispatchEligible(paid, true), true);
  assert.equal(dispatchEligible(paid, false), false);
  assert.equal(paid.lifecycle, "confirmed_paid");
  const assigned = applyLifecycle(paid, { type: "assign_resource", resource: "vehicle" });
  assert.equal(assigned.reason, "resource_assigned");
  assert.equal(occupancyClaim(assigned.snapshot), "vehicle");
});

test("current engine still lacks the lifecycle; the gap register must stay explicit", () => {
  const guestCreate = readFileSync(new URL("./guest-create.ts", import.meta.url), "utf8");
  const confirmed = readFileSync(new URL("../../routes/confirmed.$token.tsx", import.meta.url), "utf8");
  const domainB = readFileSync(new URL("./domain-b-payment.ts", import.meta.url), "utf8");
  const paymentSql = readFileSync(new URL("../../../migrations/0021_cp25_hotel_guest_payments.sql", import.meta.url), "utf8");
  const duration = readFileSync(new URL("./public-booking-duration.ts", import.meta.url), "utf8");
  assert.doesNotMatch(guestCreate, /sendConfirmationEmail/);
  assert.match(confirmed, /Your transfer is booked/);
  assert.match(confirmed, /Confirmed/);
  assert.match(domainB, /c\.hotel_id = b\.hotel_id/);
  assert.doesNotMatch(paymentSql, /received_after_expiry/);
  assert.match(paymentSql, /status = p_status/);
  assert.match(duration, /PROVISIONAL_PUBLIC_DURATION_MINUTES = 60/);
  const gaps = [
    "insert_confirms_before_payment",
    "confirmation_page_before_payment",
    "payee_is_hotel_connection",
    "no_hold_expiry",
    "no_late_payment_disposition",
  ];
  assert.equal(gaps.length, 5);
});
