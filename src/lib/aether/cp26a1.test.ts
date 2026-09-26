import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  SaasCommerceError,
  assertDomainACommerceAllowed,
  assertDomainALivemode,
  classifyStripeSecretKey,
  domainAWebhookEligible,
  parseSaasCommerceMode,
} from "./saas-commerce.server.ts";
import {
  createBillingPortal,
  createGuestTransferCheckout,
  createSubscriptionCheckout,
} from "./stripe.server.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const TEST_KEY = "sk_test_cp26a1_placeholder";
const LIVE_KEY = "sk_live_cp26a1_placeholder";
const GARBAGE_KEY = "not-a-stripe-key";

const checkoutInput = {
  priceId: "price_test",
  organisationId: "11111111-1111-4111-8111-111111111111",
  userId: "user_test",
  quantity: 1,
  successUrl: "https://scan-book-go.vercel.app/app/billing?checkout=success",
  cancelUrl: "https://scan-book-go.vercel.app/app/billing?checkout=cancel",
};

function env(commerce: string | undefined, key: string | undefined): NodeJS.Dict<string> {
  const next: NodeJS.Dict<string> = {};
  if (commerce !== undefined) next.SBG_SAAS_COMMERCE = commerce;
  if (key !== undefined) next.STRIPE_SECRET_KEY = key;
  return next;
}

function expectReject(commerce: string | undefined, key: string | undefined) {
  assert.throws(() => assertDomainACommerceAllowed(env(commerce, key)), SaasCommerceError);
}

function expectAllow(commerce: string, key: string, livemode: boolean) {
  const result = assertDomainACommerceAllowed(env(commerce, key));
  assert.equal(result.mode, commerce);
  assert.equal(result.expectedLivemode, livemode);
}

test("CP26A.1 parseSaasCommerceMode fails closed", () => {
  assert.equal(parseSaasCommerceMode(undefined), "off");
  assert.equal(parseSaasCommerceMode(""), "off");
  assert.equal(parseSaasCommerceMode("  "), "off");
  assert.equal(parseSaasCommerceMode("off"), "off");
  assert.equal(parseSaasCommerceMode("OFF"), "off");
  assert.equal(parseSaasCommerceMode("false"), "off");
  assert.equal(parseSaasCommerceMode("0"), "off");
  assert.equal(parseSaasCommerceMode("nope"), "off");
  assert.equal(parseSaasCommerceMode("enabled"), "off");
  assert.equal(parseSaasCommerceMode("test"), "test");
  assert.equal(parseSaasCommerceMode("TEST"), "test");
  assert.equal(parseSaasCommerceMode("live"), "live");
});

test("CP26A.1 Domain A commerce/key matrix", () => {
  expectReject(undefined, undefined);
  expectReject(undefined, TEST_KEY);
  expectReject("off", undefined);
  expectReject("off", TEST_KEY);
  expectReject("off", LIVE_KEY);
  expectReject("malformed", TEST_KEY);
  expectReject("test", undefined);
  expectAllow("test", TEST_KEY, false);
  expectReject("test", LIVE_KEY);
  expectReject("test", GARBAGE_KEY);
  expectReject("live", TEST_KEY);
  expectAllow("live", LIVE_KEY, true);
  expectReject("live", GARBAGE_KEY);
  assert.equal(classifyStripeSecretKey(undefined), "absent");
  assert.equal(classifyStripeSecretKey(TEST_KEY), "test");
  assert.equal(classifyStripeSecretKey(LIVE_KEY), "live");
  assert.equal(classifyStripeSecretKey(GARBAGE_KEY), "unrecognised");
});

test("CP26A.1 Domain A webhook eligibility", () => {
  assert.equal(domainAWebhookEligible({ livemode: false }, env("off", TEST_KEY)), false);
  assert.equal(domainAWebhookEligible({ livemode: true }, env("off", LIVE_KEY)), false);
  assert.equal(domainAWebhookEligible({ livemode: false }, env(undefined, TEST_KEY)), false);
  assert.equal(domainAWebhookEligible({ livemode: false }, env("test", TEST_KEY)), true);
  assert.equal(domainAWebhookEligible({ livemode: true }, env("test", TEST_KEY)), false);
  assert.equal(domainAWebhookEligible({ livemode: false }, env("live", LIVE_KEY)), false);
  assert.equal(domainAWebhookEligible({ livemode: true }, env("live", LIVE_KEY)), true);
  assert.equal(domainAWebhookEligible({}, env("test", TEST_KEY)), false);
});

test("CP26A.1 livemode mismatch fails closed", () => {
  assert.throws(() => assertDomainALivemode(true, false), SaasCommerceError);
  assert.throws(() => assertDomainALivemode(false, true), SaasCommerceError);
  assert.throws(() => assertDomainALivemode(undefined, false), SaasCommerceError);
  assert.doesNotThrow(() => assertDomainALivemode(false, false));
  assert.doesNotThrow(() => assertDomainALivemode(true, true));
});

async function withStripeEnv<T>(
  commerce: string | undefined,
  key: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const prevCommerce = process.env.SBG_SAAS_COMMERCE;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  try {
    if (commerce === undefined) delete process.env.SBG_SAAS_COMMERCE;
    else process.env.SBG_SAAS_COMMERCE = commerce;
    if (key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = key;
    return await fn();
  } finally {
    if (prevCommerce === undefined) delete process.env.SBG_SAAS_COMMERCE;
    else process.env.SBG_SAAS_COMMERCE = prevCommerce;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevKey;
  }
}

test("CP26A.1 Checkout and portal gate before Stripe network", async () => {
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({ id: "cs_x", url: "https://stripe.example/c", livemode: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await withStripeEnv("off", LIVE_KEY, async () => {
      await assert.rejects(() => createSubscriptionCheckout(checkoutInput), SaasCommerceError);
      await assert.rejects(() => createBillingPortal("cus_x", "https://example.test/return"), SaasCommerceError);
    });
    await withStripeEnv(undefined, TEST_KEY, async () => {
      await assert.rejects(() => createSubscriptionCheckout(checkoutInput), SaasCommerceError);
    });
    await withStripeEnv("test", LIVE_KEY, async () => {
      await assert.rejects(() => createSubscriptionCheckout(checkoutInput), SaasCommerceError);
    });
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CP26A.1 test-mode Checkout requires matching livemode and does not return a mismatched URL", async () => {
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({ id: "cs_live_mismatch", url: "https://stripe.example/live", livemode: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await withStripeEnv("test", TEST_KEY, async () => {
      await assert.rejects(() => createSubscriptionCheckout(checkoutInput), /execution mode/);
    });
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CP26A.1 test-mode Checkout and portal succeed only when livemode is false", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: "cs_test", url: "https://stripe.example/test", livemode: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    await withStripeEnv("test", TEST_KEY, async () => {
      const checkout = await createSubscriptionCheckout(checkoutInput);
      assert.equal(checkout.url, "https://stripe.example/test");
      const portal = await createBillingPortal("cus_test", "https://example.test/return");
      assert.equal(portal.url, "https://stripe.example/test");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CP26A.1 live commerce is code-compatible with sk_live and matching livemode", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: "cs_live", url: "https://stripe.example/live", livemode: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    await withStripeEnv("live", LIVE_KEY, async () => {
      const checkout = await createSubscriptionCheckout(checkoutInput);
      assert.equal(checkout.url, "https://stripe.example/live");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CP26A.1 Domain B guest Checkout is not blocked by SBG_SAAS_COMMERCE=off", async () => {
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    fetches += 1;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Stripe-Account"), "acct_hotel");
    return new Response(JSON.stringify({ id: "cs_guest", url: "https://stripe.example/guest" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await withStripeEnv("off", LIVE_KEY, async () => {
      const result = await createGuestTransferCheckout({
        accountId: "acct_hotel",
        bookingId: "22222222-2222-2222-2222-222222222222",
        paymentId: "33333333-3333-3333-3333-333333333333",
        amountMinor: 3500,
        currency: "EUR",
        successUrl: "https://example.test/ok",
        cancelUrl: "https://example.test/cancel",
      });
      assert.equal(result.url, "https://stripe.example/guest");
    });
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CP26A.1 source isolation: Domain A gated, Domain B and entitlement untouched", () => {
  const helper = read("src/lib/aether/saas-commerce.server.ts");
  const stripe = read("src/lib/aether/stripe.server.ts");
  const fns = read("src/lib/aether/stripe-fns.ts");
  const billingOrch = read("src/lib/aether/saas-billing.server.ts");
  const webhook = read("src/routes/api/stripe/webhook.ts");
  const example = read(".env.example");
  const entitlement = read("migrations/0020_cp24_stripe_billing.sql");

  assert.match(helper, /SBG_SAAS_COMMERCE/);
  assert.match(helper, /reserved for CP31/);
  assert.match(example, /SBG_SAAS_COMMERCE=off/);
  assert.match(stripe, /assertDomainACommerceAllowed/);
  assert.match(webhook, /domainAWebhookEligible/);
  assert.match(fns, /authMiddleware/);
  assert.match(billingOrch, /createSubscriptionCheckout/);
  assert.match(billingOrch, /assertDomainACommerceAllowed/);

  const guestFn = stripe.slice(stripe.indexOf("export async function createGuestTransferCheckout"));
  assert.doesNotMatch(guestFn, /assertDomainACommerceAllowed/);
  assert.doesNotMatch(guestFn, /saasCommerceMode/);

  const secretGetter = stripe.match(/function secretKey\(\) \{[\s\S]*?\n\}/);
  assert.ok(secretGetter);
  assert.doesNotMatch(secretGetter[0], /SBG_SAAS_COMMERCE|assertDomainACommerceAllowed/);

  assert.match(entitlement, /update hotels set status = 'live'/);
  assert.doesNotMatch(read("src/lib/aether/saas-commerce.server.ts"), /sbg_sync_hotel_entitlement/);
  assert.doesNotMatch(webhook, /VITE_|PUBLIC_STRIPE|NEXT_PUBLIC_/);
});
