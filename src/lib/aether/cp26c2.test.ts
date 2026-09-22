/**
 * CP26C.2 — Domain A Stripe TEST hotel isolation.
 * PGLite + mocked Stripe. No Production, no Stripe network, no real hotel UUIDs from Production.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Sql } from "@/lib/db";
import {
  SaasCommerceError,
  assertDomainACommerceAllowed,
  assertDomainACommerceAllowedForHotel,
  classifyStripeSecretKey,
  domainAWebhookEligible,
  domainAWebhookHotelAllowed,
  parseSaasTestHotelIds,
} from "./saas-commerce.server.ts";
import {
  loadDomainABillingState,
  startDomainACheckout,
  startDomainAPortal,
} from "./saas-billing.server.ts";
import {
  applyDomainABillingEvent,
  extractDomainASubscriptionEvent,
} from "./saas-billing-webhook.ts";
import { createGuestTransferCheckout } from "./stripe.server.ts";
import {
  OWNER_USER,
  OTHER_USER,
  applyBillingEvent,
  hotelStatus,
  insertAuthUser,
  onboardConfiguredFixture,
  openCp26a4Db,
} from "./cp26a4-fixture.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const TEST_KEY = "sk_test_cp26c2_placeholder";
const LIVE_KEY = "sk_live_cp26c2_placeholder";
const HOTEL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOTEL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOTEL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRICE_BASIC = "price_sbg_test_basic";
const PRICE_PRO = "price_sbg_test_pro";
const PRICE_PREMIUM = "price_sbg_test_premium";
const ORIGIN = "https://scan-book-go.vercel.app";
const PRICE_ENV = {
  STRIPE_BASIC_PRICE_ID: PRICE_BASIC,
  STRIPE_PRO_PRICE_ID: PRICE_PRO,
  STRIPE_PREMIUM_PRICE_ID: PRICE_PREMIUM,
};

function asSql(pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql {
  const sql = (async () => {
    throw new Error("tagged-template SQL is not used in CP26C.2 tests");
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
    const result = await pg.query(text, params);
    return result.rows as T[];
  };
  return sql;
}

function env(overrides: NodeJS.Dict<string> = {}): NodeJS.Dict<string> {
  return { ...overrides };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
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

function mockStripe() {
  const calls: Array<{ path: string; body: URLSearchParams }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ path: url, body: new URLSearchParams(String(init?.body ?? "")) });
    const isPortal = url.includes("/billing_portal/sessions");
    return new Response(
      JSON.stringify({
        id: isPortal ? "bps_test" : "cs_test",
        url: isPortal ? "https://stripe.example/portal" : "https://stripe.example/checkout",
        livemode: false,
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

function commerceTest(hotelIds: string) {
  return {
    SBG_SAAS_COMMERCE: "test",
    STRIPE_SECRET_KEY: TEST_KEY,
    SBG_SAAS_TEST_HOTEL_IDS: hotelIds,
    ...PRICE_ENV,
  };
}

async function billingPrice(pg: Awaited<ReturnType<typeof openCp26a4Db>>, hotelId: string) {
  const rows = await pg.query<{ stripe_price_id: string | null; status: string }>(
    "select stripe_price_id, status from sbg_billing_accounts where hotel_id = $1::uuid",
    [hotelId],
  );
  return rows.rows[0] ?? null;
}

function subscriptionEvent(hotelId: string, livemode = false) {
  return {
    id: `evt_cp26c2_${hotelId.slice(0, 8)}`,
    type: "customer.subscription.updated",
    created: 1_700_000_000,
    livemode,
    data: {
      object: {
        id: `sub_cp26c2_${hotelId.slice(0, 8)}`,
        customer: `cus_cp26c2_${hotelId.slice(0, 8)}`,
        status: "active",
        current_period_end: 1_800_000_000,
        cancel_at_period_end: false,
        metadata: { hotel_id: hotelId },
        items: { data: [{ price: { id: PRICE_BASIC } }] },
      },
    },
  };
}

test("CP26C.2 parseSaasTestHotelIds contract", () => {
  assert.deepEqual(parseSaasTestHotelIds(undefined), { ok: true, ids: [] });
  assert.deepEqual(parseSaasTestHotelIds(""), { ok: true, ids: [] });
  assert.deepEqual(parseSaasTestHotelIds("   ,  ,"), { ok: true, ids: [] });
  assert.deepEqual(parseSaasTestHotelIds(HOTEL_A), { ok: true, ids: [HOTEL_A] });
  assert.deepEqual(parseSaasTestHotelIds(` ${HOTEL_A} , ${HOTEL_B} `), {
    ok: true,
    ids: [HOTEL_A, HOTEL_B],
  });
  assert.deepEqual(parseSaasTestHotelIds(`${HOTEL_A},${HOTEL_A}`), { ok: true, ids: [HOTEL_A] });
  assert.deepEqual(parseSaasTestHotelIds(HOTEL_A.toUpperCase()), { ok: true, ids: [HOTEL_A] });
  assert.equal(parseSaasTestHotelIds("not-a-uuid").ok, false);
  assert.equal(parseSaasTestHotelIds(`${HOTEL_A},not-a-uuid`).ok, false);
  assert.equal(parseSaasTestHotelIds("11111111-1111-1111-1111-11111111111").ok, false);
  const helper = read("src/lib/aether/saas-commerce.server.ts");
  assert.doesNotMatch(helper, /console\.(?:log|error|info|debug)\([^)]*SBG_SAAS_TEST_HOTEL_IDS/);
  assert.doesNotMatch(helper, /sbg-verify-a5/);
  assert.doesNotMatch(helper, /demo-kos/);
});

test("CP26C.2 hotel-aware gate OFF / absent", () => {
  assert.throws(
    () => assertDomainACommerceAllowedForHotel(HOTEL_A, env({ SBG_SAAS_TEST_HOTEL_IDS: HOTEL_A })),
    SaasCommerceError,
  );
  assert.throws(
    () =>
      assertDomainACommerceAllowedForHotel(
        HOTEL_A,
        env({ SBG_SAAS_COMMERCE: "off", STRIPE_SECRET_KEY: TEST_KEY, SBG_SAAS_TEST_HOTEL_IDS: HOTEL_A }),
      ),
    SaasCommerceError,
  );
});

test("CP26C.2 hotel-aware gate TEST matrix", () => {
  const base = { SBG_SAAS_COMMERCE: "test", STRIPE_SECRET_KEY: TEST_KEY };
  assert.throws(() => assertDomainACommerceAllowedForHotel(HOTEL_A, env(base)), SaasCommerceError);
  assert.throws(
    () => assertDomainACommerceAllowedForHotel(HOTEL_A, env({ ...base, SBG_SAAS_TEST_HOTEL_IDS: "" })),
    SaasCommerceError,
  );
  assert.throws(
    () => assertDomainACommerceAllowedForHotel(HOTEL_A, env({ ...base, SBG_SAAS_TEST_HOTEL_IDS: "nope" })),
    SaasCommerceError,
  );
  assert.throws(
    () =>
      assertDomainACommerceAllowedForHotel(
        HOTEL_A,
        env({ ...base, SBG_SAAS_TEST_HOTEL_IDS: HOTEL_B }),
      ),
    SaasCommerceError,
  );
  const allowed = assertDomainACommerceAllowedForHotel(
    HOTEL_A,
    env({ ...base, SBG_SAAS_TEST_HOTEL_IDS: ` ${HOTEL_A}, ${HOTEL_C}` }),
  );
  assert.equal(allowed.mode, "test");
  assert.equal(allowed.expectedLivemode, false);
  assert.equal(
    assertDomainACommerceAllowedForHotel(
      HOTEL_A.toUpperCase(),
      env({ ...base, SBG_SAAS_TEST_HOTEL_IDS: HOTEL_A }),
    ).mode,
    "test",
  );
  assert.throws(
    () =>
      assertDomainACommerceAllowedForHotel(
        HOTEL_A,
        env({ SBG_SAAS_COMMERCE: "test", STRIPE_SECRET_KEY: LIVE_KEY, SBG_SAAS_TEST_HOTEL_IDS: HOTEL_A }),
      ),
    SaasCommerceError,
  );
  assert.throws(
    () =>
      assertDomainACommerceAllowedForHotel(
        HOTEL_A,
        env({ SBG_SAAS_COMMERCE: "test", SBG_SAAS_TEST_HOTEL_IDS: HOTEL_A }),
      ),
    SaasCommerceError,
  );
});

test("CP26C.2 hotel-aware gate LIVE ignores test allowlist", () => {
  const live = assertDomainACommerceAllowedForHotel(
    HOTEL_A,
    env({ SBG_SAAS_COMMERCE: "live", STRIPE_SECRET_KEY: LIVE_KEY }),
  );
  assert.equal(live.mode, "live");
  assert.equal(live.expectedLivemode, true);
  const malformed = assertDomainACommerceAllowedForHotel(
    HOTEL_A,
    env({
      SBG_SAAS_COMMERCE: "live",
      STRIPE_SECRET_KEY: LIVE_KEY,
      SBG_SAAS_TEST_HOTEL_IDS: "not-a-uuid",
    }),
  );
  assert.equal(malformed.mode, "live");
  assert.throws(
    () =>
      assertDomainACommerceAllowedForHotel(
        HOTEL_A,
        env({ SBG_SAAS_COMMERCE: "live", STRIPE_SECRET_KEY: TEST_KEY, SBG_SAAS_TEST_HOTEL_IDS: HOTEL_A }),
      ),
    SaasCommerceError,
  );
  assert.equal(classifyStripeSecretKey(TEST_KEY), "test");
  assert.doesNotThrow(() => assertDomainACommerceAllowed(env({ SBG_SAAS_COMMERCE: "live", STRIPE_SECRET_KEY: LIVE_KEY })));
});

test("CP26C.2 Checkout allowlisted hotel mutates price and reaches mocked Stripe", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await withEnv(commerceTest(fixture.hotelId), async () => {
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
    assert.match(stripe.calls[0]!.path, /checkout\/sessions/);
    const row = await billingPrice(pg, fixture.hotelId);
    assert.equal(row?.stripe_price_id, PRICE_BASIC);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26C.2 Checkout non-allowlisted / OFF / foreign hotel do not mutate or fetch", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await withEnv(commerceTest(HOTEL_B), async () => {
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
    await withEnv(
      { SBG_SAAS_COMMERCE: "off", STRIPE_SECRET_KEY: TEST_KEY, SBG_SAAS_TEST_HOTEL_IDS: fixture.hotelId, ...PRICE_ENV },
      async () => {
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
      },
    );
    await withEnv(commerceTest(fixture.hotelId), async () => {
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
    });
    assert.equal(stripe.calls.length, 0);
    assert.equal(await billingPrice(pg, fixture.hotelId), null);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26C.2 Portal isolation", async () => {
  const pg = await openCp26a4Db();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await applyBillingEvent(pg, fixture.hotelId, "active");
    await withEnv(commerceTest(fixture.hotelId), async () => {
      const portal = await startDomainAPortal({
        db: asSql(pg),
        userId: OWNER_USER.id,
        hotelId: fixture.hotelId,
        origin: ORIGIN,
      });
      assert.equal(portal.url, "https://stripe.example/portal");
    });
    assert.equal(stripe.calls.length, 1);
    assert.match(stripe.calls[0]!.path, /billing_portal/);
    stripe.calls.length = 0;
    await withEnv(commerceTest(HOTEL_B), async () => {
      await assert.rejects(
        () =>
          startDomainAPortal({
            db: asSql(pg),
            userId: OWNER_USER.id,
            hotelId: fixture.hotelId,
            origin: ORIGIN,
          }),
        SaasCommerceError,
      );
    });
    await withEnv(
      { SBG_SAAS_COMMERCE: "off", STRIPE_SECRET_KEY: TEST_KEY, SBG_SAAS_TEST_HOTEL_IDS: fixture.hotelId, ...PRICE_ENV },
      async () => {
        await assert.rejects(
          () =>
            startDomainAPortal({
              db: asSql(pg),
              userId: OWNER_USER.id,
              hotelId: fixture.hotelId,
              origin: ORIGIN,
            }),
          SaasCommerceError,
        );
      },
    );
    assert.equal(stripe.calls.length, 0);
    const owned = await loadDomainABillingState(asSql(pg), OWNER_USER.id, fixture.hotelId);
    assert.equal(owned.lifecycle.shouldManageBilling, true);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26C.2 Domain A webhook hotel isolation with ordered persistence", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    const extracted = extractDomainASubscriptionEvent(subscriptionEvent(fixture.hotelId, false));
    const isolatedEnv = {
      SBG_SAAS_COMMERCE: "test",
      STRIPE_SECRET_KEY: TEST_KEY,
      SBG_SAAS_TEST_HOTEL_IDS: HOTEL_B,
      ...PRICE_ENV,
    };
    assert.equal(domainAWebhookEligible({ livemode: false }, isolatedEnv), true);
    assert.equal(domainAWebhookHotelAllowed(extracted.hotelId, isolatedEnv), false);
    assert.equal(domainAWebhookHotelAllowed(extracted.hotelId, { ...isolatedEnv, SBG_SAAS_TEST_HOTEL_IDS: "" }), false);
    assert.equal(
      domainAWebhookHotelAllowed(extracted.hotelId, { ...isolatedEnv, SBG_SAAS_TEST_HOTEL_IDS: "not-a-uuid" }),
      false,
    );

    let applyCalls = 0;
    let syncCalls = 0;
    const db = asSql(pg);
    const originalQuery = db.query.bind(db);
    db.query = (async (text: string, params?: unknown[]) => {
      if (/sbg_apply_billing_event/.test(text)) applyCalls += 1;
      if (/sbg_sync_hotel_entitlement/.test(text)) syncCalls += 1;
      return originalQuery(text, params);
    }) as typeof db.query;

    if (!domainAWebhookHotelAllowed(extracted.hotelId, isolatedEnv)) {
      /* acknowledge; do not persist */
    } else {
      await applyDomainABillingEvent(db, extracted, isolatedEnv);
      await db.query("select sbg_sync_hotel_entitlement($1::uuid)", [extracted.hotelId]);
    }
    assert.equal(applyCalls, 0);
    assert.equal(syncCalls, 0);
    assert.equal(await billingPrice(pg, fixture.hotelId), null);

    const allowedEnv = { ...isolatedEnv, SBG_SAAS_TEST_HOTEL_IDS: fixture.hotelId };
    assert.equal(domainAWebhookHotelAllowed(extracted.hotelId, allowedEnv), true);
    const outcome = await applyDomainABillingEvent(db, extracted, allowedEnv);
    await db.query("select sbg_sync_hotel_entitlement($1::uuid)", [extracted.hotelId]);
    assert.equal(outcome, "applied");
    assert.equal(applyCalls, 1);
    assert.equal(syncCalls, 1);
    assert.equal((await billingPrice(pg, fixture.hotelId))?.status, "active");
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");

    assert.equal(
      domainAWebhookEligible({ livemode: true }, { SBG_SAAS_COMMERCE: "test", STRIPE_SECRET_KEY: TEST_KEY }),
      false,
    );
    assert.equal(
      domainAWebhookHotelAllowed(HOTEL_A, {
        SBG_SAAS_COMMERCE: "live",
        STRIPE_SECRET_KEY: LIVE_KEY,
        SBG_SAAS_TEST_HOTEL_IDS: "not-a-uuid",
      }),
      true,
    );
  } finally {
    await pg.close();
  }
});

test("CP26C.2 Domain B and Connect source freeze; no publication coupling", () => {
  const webhook = read("src/routes/api/stripe/webhook.ts");
  const guest = read("src/lib/aether/guest-payment-fns.ts");
  const stripe = read("src/lib/aether/stripe.server.ts");
  const billing = read("src/lib/aether/saas-billing.server.ts");
  const commerce = read("src/lib/aether/saas-commerce.server.ts");
  const entitlement = read("migrations/0023_cp26a2_entitlement_publication_decoupling.sql");
  const payment = read("migrations/0021_cp25_hotel_guest_payments.sql");
  const example = read(".env.example");

  const domainB = webhook.slice(
    webhook.indexOf('event.type.startsWith("checkout.session.")'),
    webhook.indexOf('event.type === "account.application.deauthorized"'),
  );
  assert.match(domainB, /sbg_apply_payment_event/);
  assert.doesNotMatch(domainB, /domainAWebhookHotelAllowed|SBG_SAAS_TEST_HOTEL_IDS/);
  const deauth = webhook.slice(
    webhook.indexOf('event.type === "account.application.deauthorized"'),
    webhook.indexOf("if (!domainAWebhookEligible"),
  );
  assert.match(deauth, /sbg_disconnect_stripe_by_account/);
  assert.doesNotMatch(deauth, /domainAWebhookHotelAllowed|SBG_SAAS_TEST_HOTEL_IDS/);
  assert.ok(
    webhook.indexOf('event.type.startsWith("checkout.session.")') <
      webhook.lastIndexOf("domainAWebhookHotelAllowed"),
  );
  assert.ok(
    webhook.indexOf('event.type === "account.application.deauthorized"') <
      webhook.lastIndexOf("domainAWebhookHotelAllowed"),
  );
  const extractAt = webhook.lastIndexOf("extractDomainASubscriptionEvent");
  const isolateAt = webhook.lastIndexOf("domainAWebhookHotelAllowed");
  const applyAt = webhook.lastIndexOf("applyDomainABillingEvent");
  const syncAt = webhook.lastIndexOf("sbg_sync_hotel_entitlement");
  assert.ok(extractAt >= 0 && isolateAt > extractAt && applyAt > isolateAt && syncAt > applyAt);

  assert.doesNotMatch(guest, /SBG_SAAS_TEST_HOTEL_IDS|assertDomainACommerceAllowedForHotel/);
  const guestFn = stripe.slice(stripe.indexOf("export async function createGuestTransferCheckout"));
  assert.doesNotMatch(guestFn, /SBG_SAAS_TEST_HOTEL_IDS|assertDomainACommerceAllowedForHotel/);
  assert.match(stripe, /startStripeConnectFn|createConnectState|STRIPE_CONNECT_CLIENT_ID/);
  assert.doesNotMatch(read("src/lib/aether/stripe-fns.ts").slice(
    read("src/lib/aether/stripe-fns.ts").indexOf("startStripeConnectFn"),
  ), /SBG_SAAS_TEST_HOTEL_IDS/);

  const checkoutFn = billing.slice(billing.indexOf("export async function startDomainACheckout"));
  const portalFn = billing.slice(billing.indexOf("export async function startDomainAPortal"));
  assert.ok(
    checkoutFn.indexOf("assertDomainACommerceAllowedForHotel") <
      checkoutFn.indexOf("sbg_set_billing_price_for_user"),
  );
  assert.ok(
    portalFn.indexOf("assertPortalAllowed") < portalFn.indexOf("assertDomainACommerceAllowedForHotel"),
  );
  assert.ok(
    portalFn.indexOf("assertDomainACommerceAllowedForHotel") < portalFn.indexOf("createBillingPortal"),
  );

  assert.doesNotMatch(commerce, /update\s+hotels\s+set\s+status/i);
  const body = entitlement.slice(entitlement.indexOf("as $$"), entitlement.lastIndexOf("$$"));
  assert.doesNotMatch(body, /update\s+hotels/i);
  assert.doesNotMatch(payment, /SBG_SAAS_TEST_HOTEL_IDS/);
  assert.match(example, /SBG_SAAS_TEST_HOTEL_IDS=/);
  assert.match(example, /empty = nobody authorised|empty = nobody authorized|empty = nobody/i);
  assert.doesNotMatch(example, /sbg-verify-a5|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test("CP26C.2 Domain B guest Checkout ignores test hotel allowlist", async () => {
  const stripe = mockStripe();
  try {
    await withEnv(
      {
        SBG_SAAS_COMMERCE: "test",
        STRIPE_SECRET_KEY: TEST_KEY,
        SBG_SAAS_TEST_HOTEL_IDS: "",
        ...PRICE_ENV,
      },
      async () => {
        const result = await createGuestTransferCheckout({
          accountId: "acct_hotel",
          bookingId: "22222222-2222-2222-2222-222222222222",
          paymentId: "33333333-3333-3333-3333-333333333333",
          amountMinor: 3500,
          currency: "EUR",
          successUrl: "https://example.test/ok",
          cancelUrl: "https://example.test/cancel",
        });
        assert.equal(result.url, "https://stripe.example/checkout");
      },
    );
    assert.equal(stripe.calls.length, 1);
    assert.match(stripe.calls[0]!.path, /checkout\/sessions/);
  } finally {
    stripe.restore();
  }
});
