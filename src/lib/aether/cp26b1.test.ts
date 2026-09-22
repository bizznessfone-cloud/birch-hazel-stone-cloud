/**
 * CP26B.1 — Domain A application lifecycle: gate-before-write, one subscription,
 * mocked Stripe boundary, PGLite. No Production, no Stripe network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Sql } from "@/lib/db";
import { SaasCommerceError } from "./saas-commerce.server.ts";
import { SaasLifecycleError } from "./saas-lifecycle.ts";
import {
  loadDomainABillingState,
  startDomainACheckout,
  startDomainAPortal,
} from "./saas-billing.server.ts";
import {
  OWNER_USER,
  OTHER_USER,
  SECOND_HOTEL,
  applyBillingEvent,
  createHotelForUser,
  hotelStatus,
  insertAuthUser,
  onboardConfiguredFixture,
  openCp26a4Db,
} from "./cp26a4-fixture.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const TEST_KEY = "sk_test_cp26b1_placeholder";
const PRICE_BASIC = "price_sbg_test_basic";
const PRICE_PRO = "price_sbg_test_pro";
const ORIGIN = "https://scan-book-go.vercel.app";
const FOREIGN_HOTEL_ID = "00000000-0000-0000-0000-000000000099";

function asSql(pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql {
  const sql = (async () => {
    throw new Error("tagged-template SQL is not used in CP26B.1 tests");
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
    const result = await pg.query(text, params);
    return result.rows as T[];
  };
  return sql;
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const COMMERCE_TEST = {
  SBG_SAAS_COMMERCE: "test",
  STRIPE_SECRET_KEY: TEST_KEY,
  STRIPE_BASIC_PRICE_ID: PRICE_BASIC,
  STRIPE_PRO_PRICE_ID: PRICE_PRO,
  STRIPE_PREMIUM_PRICE_ID: "price_sbg_test_premium",
};

const COMMERCE_OFF = {
  ...COMMERCE_TEST,
  SBG_SAAS_COMMERCE: "off",
};

type Captured = { path: string; body: URLSearchParams };

function mockStripe(livemode = false) {
  const calls: Captured[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ path: url, body });
    const isPortal = url.includes("/billing_portal/sessions");
    return new Response(
      JSON.stringify({
        id: isPortal ? "bps_test" : "cs_test",
        url: isPortal ? "https://stripe.example/portal" : "https://stripe.example/checkout",
        livemode,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function billingRow(pg: Awaited<ReturnType<typeof openCp26a4Db>>, hotelId: string) {
  return pg.query<{
    stripe_customer_id: string | null;
    stripe_price_id: string | null;
    status: string;
  }>("select stripe_customer_id, stripe_price_id, status from sbg_billing_accounts where hotel_id = $1::uuid", [
    hotelId,
  ]);
}

test("CP26B.1 commerce OFF does not mutate billing or call Stripe", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await withEnv(COMMERCE_OFF, async () => {
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            hotelId: fixture.hotelId,
            plan: "basic",
            origin: ORIGIN,
          }),
        SaasCommerceError,
      );
    });
    assert.equal(stripe.calls.length, 0);
    assert.equal((await billingRow(pg, fixture.hotelId)).rows.length, 0);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 first subscription builds Checkout request and persists price after gate", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe(false);
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await withEnv(COMMERCE_TEST, async () => {
      const result = await startDomainACheckout({
        db: asSql(pg),
        userId: OWNER_USER.id,
        hotelId: fixture.hotelId,
        plan: "basic",
        origin: ORIGIN,
      });
      assert.equal(result.url, "https://stripe.example/checkout");
    });
    assert.equal(stripe.calls.length, 1);
    const body = stripe.calls[0]!.body;
    assert.equal(body.get("mode"), "subscription");
    assert.equal(body.get("line_items[0][price]"), PRICE_BASIC);
    assert.equal(body.get("metadata[hotel_id]"), fixture.hotelId);
    assert.equal(body.get("metadata[user_id]"), OWNER_USER.id);
    assert.equal(body.get("subscription_data[metadata][hotel_id]"), fixture.hotelId);
    assert.equal(body.get("subscription_data[metadata][user_id]"), OWNER_USER.id);
    assert.equal(
      body.get("success_url"),
      `${ORIGIN}/app/billing?hotelId=${fixture.hotelId}&checkout=success`,
    );
    assert.equal(
      body.get("cancel_url"),
      `${ORIGIN}/app/billing?hotelId=${fixture.hotelId}&checkout=cancel`,
    );
    assert.equal(body.get("customer"), null);
    const row = await billingRow(pg, fixture.hotelId);
    assert.equal(row.rows[0]!.stripe_price_id, PRICE_BASIC);
    assert.equal(row.rows[0]!.status, "inactive");
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 existing subscription cannot start a second Checkout", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await applyBillingEvent(pg, fixture.hotelId, "active");
    await withEnv(COMMERCE_TEST, async () => {
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            hotelId: fixture.hotelId,
            plan: "pro",
            origin: ORIGIN,
          }),
        (err: unknown) => err instanceof SaasLifecycleError && err.code === "subscription_exists",
      );
    });
    assert.equal(stripe.calls.length, 0);
    const row = await billingRow(pg, fixture.hotelId);
    assert.equal(row.rows[0]!.status, "active");
    assert.notEqual(row.rows[0]!.stripe_price_id, PRICE_PRO);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 past_due unpaid paused incomplete reject Checkout; portal requires customer", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    for (const status of ["past_due", "unpaid", "paused", "incomplete", "trialing"] as const) {
      await applyBillingEvent(pg, fixture.hotelId, status);
      await withEnv(COMMERCE_TEST, async () => {
        await assert.rejects(
          () =>
            startDomainACheckout({
              db: asSql(pg),
              userId: OWNER_USER.id,
              hotelId: fixture.hotelId,
              plan: "basic",
              origin: ORIGIN,
            }),
          SaasLifecycleError,
        );
        const portal = await startDomainAPortal({
          db: asSql(pg),
          userId: OWNER_USER.id,
          hotelId: fixture.hotelId,
          origin: ORIGIN,
        });
        assert.equal(portal.url, "https://stripe.example/portal");
      });
    }
    assert.ok(stripe.calls.length >= 1);
    assert.ok(stripe.calls.every((call) => call.path.includes("/billing_portal/sessions")));
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 existing subscription without customer fails portal closed", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await pg.query(
      "insert into sbg_billing_accounts (hotel_id, stripe_price_id, status, updated_at) values ($1::uuid, $2, 'active', now())",
      [fixture.hotelId, PRICE_BASIC],
    );
    await withEnv(COMMERCE_TEST, async () => {
      await assert.rejects(
        () =>
          startDomainAPortal({
            db: asSql(pg),
            userId: OWNER_USER.id,
            hotelId: fixture.hotelId,
            origin: ORIGIN,
          }),
        (err: unknown) => err instanceof SaasLifecycleError && err.code === "portal_customer_missing",
      );
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            hotelId: fixture.hotelId,
            plan: "basic",
            origin: ORIGIN,
          }),
        (err: unknown) => err instanceof SaasLifecycleError && err.code === "subscription_exists",
      );
    });
    assert.equal(stripe.calls.length, 0);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 canceled resubscribe reuses stored customer", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await applyBillingEvent(pg, fixture.hotelId, "canceled");
    await withEnv(COMMERCE_TEST, async () => {
      const result = await startDomainACheckout({
        db: asSql(pg),
        userId: OWNER_USER.id,
        hotelId: fixture.hotelId,
        plan: "basic",
        origin: ORIGIN,
      });
      assert.equal(result.url, "https://stripe.example/checkout");
    });
    assert.equal(stripe.calls.length, 1);
    const expectedCustomer = `cus_sbg_test_${fixture.hotelId.slice(0, 8)}`;
    assert.equal(stripe.calls[0]!.body.get("customer"), expectedCustomer);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 incomplete_expired is checkout-eligible", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await applyBillingEvent(pg, fixture.hotelId, "incomplete_expired");
    await withEnv(COMMERCE_TEST, async () => {
      const result = await startDomainACheckout({
        db: asSql(pg),
        userId: OWNER_USER.id,
        hotelId: fixture.hotelId,
        plan: "pro",
        origin: ORIGIN,
      });
      assert.equal(result.url, "https://stripe.example/checkout");
    });
    assert.equal(stripe.calls[0]!.body.get("line_items[0][price]"), PRICE_PRO);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 tenant isolation, two hotels, configured-not-live", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    const second = await createHotelForUser(pg, OWNER_USER.id, SECOND_HOTEL);
    await applyBillingEvent(pg, fixture.hotelId, "active");
    await withEnv(COMMERCE_TEST, async () => {
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OTHER_USER.id,
            hotelId: fixture.hotelId,
            plan: "basic",
            origin: ORIGIN,
          }),
        /Hotel not found/,
      );
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            hotelId: FOREIGN_HOTEL_ID,
            plan: "basic",
            origin: ORIGIN,
          }),
        /Hotel not found/,
      );
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            hotelId: fixture.hotelId,
            plan: "basic",
            origin: ORIGIN,
          }),
        SaasLifecycleError,
      );
      const result = await startDomainACheckout({
        db: asSql(pg),
        userId: OWNER_USER.id,
        hotelId: second.hotelId,
        plan: "pro",
        origin: ORIGIN,
      });
      assert.equal(result.url, "https://stripe.example/checkout");
      const owned = await loadDomainABillingState(asSql(pg), OWNER_USER.id, fixture.hotelId);
      assert.equal(owned.lifecycle.canStartCheckout, false);
      assert.equal(owned.lifecycle.shouldManageBilling, true);
      assert.equal(owned.lifecycle.isEntitled, true);
    });
    assert.equal((await billingRow(pg, second.hotelId)).rows[0]!.stripe_price_id, PRICE_PRO);
    assert.equal((await billingRow(pg, fixture.hotelId)).rows[0]!.status, "active");
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
    assert.equal(await hotelStatus(pg, second.hotelId), "unconfigured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 Domain B source freeze and gate-before-write", () => {
  const billing = read("src/lib/aether/saas-billing.server.ts");
  const stripe = read("src/lib/aether/stripe.server.ts");
  const fns = read("src/lib/aether/stripe-fns.ts");
  const guest = read("src/lib/aether/guest-payment-fns.ts");
  const webhook = read("src/routes/api/stripe/webhook.ts");
  const checkoutFn = billing.slice(billing.indexOf("export async function startDomainACheckout"));
  const priceWrite = checkoutFn.indexOf("sbg_set_billing_price_for_user");
  const gate = checkoutFn.indexOf("assertDomainACommerceAllowed");
  const allowed = checkoutFn.indexOf("assertCheckoutAllowed");
  assert.ok(allowed >= 0 && gate >= 0 && priceWrite >= 0);
  assert.ok(allowed < gate, "lifecycle check before commerce gate");
  assert.ok(gate < priceWrite, "commerce gate before billing write");
  assert.match(fns, /startDomainACheckout/);
  assert.match(fns, /startDomainAPortal/);
  assert.doesNotMatch(guest, /sbg_billing_accounts/);
  assert.doesNotMatch(guest, /startDomainACheckout/);
  const guestFn = stripe.slice(stripe.indexOf("export async function createGuestTransferCheckout"));
  assert.doesNotMatch(guestFn, /assertDomainACommerceAllowed/);
  assert.doesNotMatch(guestFn, /assertCheckoutAllowed/);
  assert.match(webhook, /sbg_apply_payment_event/);
  assert.match(webhook, /checkout\.session\.completed/);
  assert.doesNotMatch(read("migrations/0023_cp26a2_entitlement_publication_decoupling.sql"), /0024/);
});
