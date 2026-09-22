/**
 * CP26B.1 — pure Domain A lifecycle policy. No DB, no Stripe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SaasLifecycleError,
  assertCheckoutAllowed,
  assertPortalAllowed,
  assertStripePriceId,
  billingViewModel,
  canStartCheckout,
  isExistingSubscriptionLifecycle,
  isSaasEntitled,
  parseBillingStatus,
  type BillingStatus,
} from "./saas-lifecycle.ts";

const EXISTING: BillingStatus[] = [
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "paused",
  "unpaid",
];

const CHECKOUT: BillingStatus[] = ["inactive", "canceled", "incomplete_expired"];

function account(status: BillingStatus | null, customer: string | null = null) {
  if (status == null) return null;
  return {
    status,
    stripe_customer_id: customer,
    stripe_price_id: customer ? "price_sbg_test_basic" : null,
    current_period_end: null,
  };
}

test("CP26B.1 checkout / portal / entitlement matrix", () => {
  const none = billingViewModel(null);
  assert.equal(none.canStartCheckout, true);
  assert.equal(none.shouldManageBilling, false);
  assert.equal(none.isEntitled, false);
  assert.equal(none.showPlanSelection, true);
  assert.equal(none.displayStatus, "none");

  const expected: Record<
    BillingStatus,
    { checkout: boolean; portal: boolean; entitled: boolean }
  > = {
    inactive: { checkout: true, portal: false, entitled: false },
    incomplete: { checkout: false, portal: true, entitled: false },
    trialing: { checkout: false, portal: true, entitled: true },
    active: { checkout: false, portal: true, entitled: true },
    past_due: { checkout: false, portal: true, entitled: true },
    paused: { checkout: false, portal: true, entitled: false },
    unpaid: { checkout: false, portal: true, entitled: false },
    canceled: { checkout: true, portal: false, entitled: false },
    incomplete_expired: { checkout: true, portal: false, entitled: false },
  };

  for (const [status, want] of Object.entries(expected) as Array<
    [BillingStatus, (typeof expected)[BillingStatus]]
  >) {
    const withCustomer = billingViewModel(account(status, "cus_sbg_test"));
    const withoutCustomer = billingViewModel(account(status, null));
    assert.equal(withCustomer.canStartCheckout, want.checkout, `${status} checkout`);
    assert.equal(withCustomer.showPlanSelection, want.checkout, `${status} plans`);
    assert.equal(withCustomer.isEntitled, want.entitled, `${status} entitled`);
    assert.equal(withCustomer.shouldManageBilling, want.portal, `${status} portal with customer`);
    assert.equal(withoutCustomer.shouldManageBilling, false, `${status} portal without customer`);
    assert.equal(canStartCheckout(status), want.checkout);
    assert.equal(isSaasEntitled(status), want.entitled);
    assert.equal(isExistingSubscriptionLifecycle(status), EXISTING.includes(status));
  }
});

test("CP26B.1 existing subscription cannot start Checkout", () => {
  for (const status of EXISTING) {
    assert.throws(
      () => assertCheckoutAllowed(account(status, "cus_sbg_test")),
      (err: unknown) => err instanceof SaasLifecycleError && err.code === "subscription_exists",
    );
    assert.throws(() => assertCheckoutAllowed(account(status, null)), SaasLifecycleError);
  }
});

test("CP26B.1 checkout-eligible statuses may start Checkout", () => {
  assert.doesNotThrow(() => assertCheckoutAllowed(null));
  for (const status of CHECKOUT) {
    assert.doesNotThrow(() => assertCheckoutAllowed(account(status, null)));
    assert.doesNotThrow(() => assertCheckoutAllowed(account(status, "cus_sbg_test")));
  }
});

test("CP26B.1 portal requires existing subscription and customer", () => {
  for (const status of EXISTING) {
    assert.doesNotThrow(() => assertPortalAllowed(account(status, "cus_sbg_test")));
    assert.throws(
      () => assertPortalAllowed(account(status, null)),
      (err: unknown) => err instanceof SaasLifecycleError && err.code === "portal_customer_missing",
    );
  }
  assert.throws(
    () => assertPortalAllowed(null),
    (err: unknown) => err instanceof SaasLifecycleError && err.code === "portal_not_applicable",
  );
  assert.throws(
    () => assertPortalAllowed(account("canceled", "cus_sbg_test")),
    (err: unknown) => err instanceof SaasLifecycleError && err.code === "portal_not_applicable",
  );
  assert.throws(
    () => assertPortalAllowed(account("inactive", "cus_sbg_test")),
    SaasLifecycleError,
  );
});

test("CP26B.1 unknown billing status fails closed", () => {
  const view = billingViewModel({
    status: "mystery",
    stripe_customer_id: "cus_x",
    stripe_price_id: "price_x",
    current_period_end: null,
  });
  assert.equal(view.canStartCheckout, false);
  assert.equal(view.shouldManageBilling, false);
  assert.equal(view.isEntitled, false);
  assert.equal(parseBillingStatus("mystery"), null);
  assert.throws(() => assertCheckoutAllowed({
    status: "mystery",
    stripe_customer_id: "cus_x",
    stripe_price_id: "price_x",
    current_period_end: null,
  }), SaasLifecycleError);
});

test("CP26B.1 Stripe Price id validation", () => {
  assert.equal(assertStripePriceId("price_sbg_test_basic"), "price_sbg_test_basic");
  assert.equal(assertStripePriceId("price_test"), "price_test");
  assert.throws(() => assertStripePriceId(""), /not configured/);
  assert.throws(() => assertStripePriceId("   "), /not configured/);
  assert.throws(() => assertStripePriceId(" price_test"), SaasLifecycleError);
  assert.throws(() => assertStripePriceId("price_test "), SaasLifecycleError);
  assert.throws(() => assertStripePriceId("cus_123"), SaasLifecycleError);
  assert.throws(() => assertStripePriceId("price_"), SaasLifecycleError);
  assert.throws(() => assertStripePriceId("sk_test_x"), SaasLifecycleError);
});
