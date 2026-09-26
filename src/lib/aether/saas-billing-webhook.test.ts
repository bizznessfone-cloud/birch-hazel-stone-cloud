/**
 * CP26B.2 — pure Domain A webhook extraction / price gate. No DB, no Stripe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DomainAWebhookExtractError,
  assertDomainAWebhookPriceId,
  extractCancelAtPeriodEnd,
  extractDomainASubscriptionEvent,
  extractStripeCreated,
} from "./saas-billing-webhook.ts";
import { SaasLifecycleError } from "./saas-lifecycle.ts";

const PRICE_ENV = {
  STRIPE_BASIC_PRICE_ID: "price_sbg_test_basic",
  STRIPE_PRO_PRICE_ID: "price_sbg_test_pro",
  STRIPE_PREMIUM_PRICE_ID: "price_sbg_test_premium",
};

const ORG = "11111111-1111-4111-8111-111111111111";

function subscriptionEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "customer.subscription.updated",
    created: 200,
    livemode: false,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        current_period_end: 1_800_000_000,
        cancel_at_period_end: false,
        metadata: { organisation_id: ORG },
        items: { data: [{ quantity: 3, price: { id: "price_sbg_test_basic", recurring: { interval: "month" } } }] },
      },
    },
    ...overrides,
  };
}

test("CP26B.2 extracts event.created and cancel_at_period_end", () => {
  const extracted = extractDomainASubscriptionEvent(subscriptionEvent());
  assert.equal(extracted.eventCreated, 200);
  assert.equal(extracted.cancelAtPeriodEnd, false);
  assert.equal(extracted.status, "active");
  assert.equal(extracted.priceId, "price_sbg_test_basic");
  assert.equal(extracted.organisationId, ORG);
  assert.equal(extracted.quantity, 3);
  const scheduled = extractDomainASubscriptionEvent(
    subscriptionEvent({
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          current_period_end: 1_800_000_000,
          cancel_at_period_end: true,
          metadata: { organisation_id: ORG },
          items: { data: [{ quantity: 3, price: { id: "price_sbg_test_pro", recurring: { interval: "month" } } }] },
        },
      },
    }),
  );
  assert.equal(scheduled.cancelAtPeriodEnd, true);
  assert.equal(extractCancelAtPeriodEnd({ cancel_at_period_end: true }), true);
});

test("CP26B.2 missing or malformed created fails closed", () => {
  assert.throws(
    () => extractStripeCreated(subscriptionEvent({ created: undefined })),
    (err: unknown) => err instanceof DomainAWebhookExtractError && err.code === "missing_created",
  );
  assert.throws(() => extractDomainASubscriptionEvent(subscriptionEvent({ created: "200" })), DomainAWebhookExtractError);
  assert.throws(() => extractDomainASubscriptionEvent(subscriptionEvent({ created: 200.5 })), DomainAWebhookExtractError);
  assert.throws(() => extractDomainASubscriptionEvent(subscriptionEvent({ created: -1 })), DomainAWebhookExtractError);
  assert.throws(() => extractStripeCreated({ created: 200.25 }), DomainAWebhookExtractError);
});

test("CP26B.2 missing cancel_at_period_end fails closed", () => {
  assert.throws(
    () =>
      extractDomainASubscriptionEvent(
        subscriptionEvent({
          data: {
            object: {
              id: "sub_1",
              status: "active",
              metadata: { organisation_id: ORG },
              items: { data: [{ quantity: 1, price: { id: "price_sbg_test_basic" } }] },
            },
          },
        }),
      ),
    (err: unknown) =>
      err instanceof DomainAWebhookExtractError && err.code === "missing_cancel_at_period_end",
  );
});

test("CP26B.2 missing organisation, quantity, or ambiguous items fail closed", () => {
  assert.throws(
    () =>
      extractDomainASubscriptionEvent(
        subscriptionEvent({
          data: {
            object: {
              id: "sub_1",
              status: "active",
              cancel_at_period_end: false,
              metadata: { hotel_id: ORG },
              items: { data: [{ quantity: 1, price: { id: "price_sbg_test_basic" } }] },
            },
          },
        }),
      ),
    (err: unknown) => err instanceof DomainAWebhookExtractError && err.code === "missing_identity",
  );
  assert.throws(
    () =>
      extractDomainASubscriptionEvent(
        subscriptionEvent({
          data: {
            object: {
              id: "sub_1",
              status: "active",
              cancel_at_period_end: false,
              metadata: { organisation_id: ORG },
              items: { data: [{ price: { id: "price_sbg_test_basic" } }] },
            },
          },
        }),
      ),
    (err: unknown) => err instanceof DomainAWebhookExtractError && err.code === "missing_quantity",
  );
  assert.throws(
    () =>
      extractDomainASubscriptionEvent(
        subscriptionEvent({
          data: {
            object: {
              id: "sub_1",
              status: "active",
              cancel_at_period_end: false,
              metadata: { organisation_id: ORG },
              items: { data: [{ quantity: 1 }, { quantity: 1 }] },
            },
          },
        }),
      ),
    (err: unknown) => err instanceof DomainAWebhookExtractError && err.code === "ambiguous_items",
  );
});

test("CP26B.2 legacy env price allowlist is not the active property-licence gate", () => {
  assert.equal(assertDomainAWebhookPriceId("price_sbg_test_basic", PRICE_ENV), "price_sbg_test_basic");
  assert.throws(
    () => assertDomainAWebhookPriceId("price_someone_else", PRICE_ENV),
    (err: unknown) => err instanceof SaasLifecycleError && err.code === "invalid_price_id",
  );
  assert.throws(() => assertDomainAWebhookPriceId(null, PRICE_ENV), SaasLifecycleError);
  assert.throws(() => assertDomainAWebhookPriceId("price_sbg_test_basic", {}), SaasLifecycleError);
  assert.throws(() => assertDomainAWebhookPriceId("cus_1", PRICE_ENV), SaasLifecycleError);
});
