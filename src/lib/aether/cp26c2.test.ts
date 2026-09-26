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
  domainAWebhookOrganisationAllowed,
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
  PLATFORM_OWNER_USER,
  bootstrapPlatformOwner,
  hotelStatus,
  insertAuthUser,
  onboardConfiguredFixture,
  openCp26a4Db,
  openCp26finDb,
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

test("CP26C.2 organisation allowlist reaches mocked Stripe without a hotel price write", async () => {
  const pg = await openCp26finDb();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "c2 probe");
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    const org = await pg.query<{ id: string }>(
      "select sbg_create_organisation_for_user($1, 'C2')::text as id",
      [OWNER_USER.id],
    );
    const organisationId = org.rows[0]!.id;
    const version = await pg.query<{ id: string }>(
      "select sbg_catalogue_create_price_version($1, 'property_licence', 1111)::text as id",
      [PLATFORM_OWNER_USER.id],
    );
    await pg.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [
      PLATFORM_OWNER_USER.id,
      version.rows[0]!.id,
    ]);
    await pg.query(
      "select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', 'prod_probe_c2', 'price_probe_c2')",
      [PLATFORM_OWNER_USER.id, version.rows[0]!.id],
    );
    await withEnv(
      {
        SBG_SAAS_COMMERCE: "test",
        STRIPE_SECRET_KEY: TEST_KEY,
        SBG_SAAS_TEST_ORGANISATION_IDS: organisationId,
      },
      async () => {
        const result = await startDomainACheckout({
          db: asSql(pg),
          userId: OWNER_USER.id,
          organisationId,
          quantity: 2,
          origin: ORIGIN,
        });
        assert.equal(result.url, "https://stripe.example/checkout");
      },
    );
    assert.equal(stripe.calls.length, 1);
    assert.equal(stripe.calls[0]!.body.get("line_items[0][quantity]"), "2");
    assert.equal(stripe.calls[0]!.body.get("metadata[organisation_id]"), organisationId);
    assert.equal(await billingPrice(pg, fixture.hotelId), null);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26C.2 Checkout non-allowlisted organisation and OFF do not fetch", async () => {
  const pg = await openCp26finDb();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "c2 probe");
    const org = await pg.query<{ id: string }>(
      "select sbg_create_organisation_for_user($1, 'C2')::text as id",
      [OWNER_USER.id],
    );
    const organisationId = org.rows[0]!.id;
    const version = await pg.query<{ id: string }>(
      "select sbg_catalogue_create_price_version($1, 'property_licence', 1111)::text as id",
      [PLATFORM_OWNER_USER.id],
    );
    await pg.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [
      PLATFORM_OWNER_USER.id,
      version.rows[0]!.id,
    ]);
    await pg.query(
      "select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', 'prod_probe_c2b', 'price_probe_c2b')",
      [PLATFORM_OWNER_USER.id, version.rows[0]!.id],
    );
    await withEnv(
      {
        SBG_SAAS_COMMERCE: "test",
        STRIPE_SECRET_KEY: TEST_KEY,
        SBG_SAAS_TEST_ORGANISATION_IDS: HOTEL_B,
      },
      async () => {
        await assert.rejects(
          () =>
            startDomainACheckout({
              db: asSql(pg),
              userId: OWNER_USER.id,
              organisationId,
              quantity: 1,
              origin: ORIGIN,
            }),
          SaasCommerceError,
        );
      },
    );
    await withEnv(
      { SBG_SAAS_COMMERCE: "off", STRIPE_SECRET_KEY: TEST_KEY, SBG_SAAS_TEST_ORGANISATION_IDS: organisationId },
      async () => {
        await assert.rejects(
          () =>
            startDomainACheckout({
              db: asSql(pg),
              userId: OWNER_USER.id,
              organisationId,
              quantity: 1,
              origin: ORIGIN,
            }),
          SaasCommerceError,
        );
      },
    );
    await withEnv(
      {
        SBG_SAAS_COMMERCE: "test",
        STRIPE_SECRET_KEY: TEST_KEY,
        SBG_SAAS_TEST_ORGANISATION_IDS: organisationId,
      },
      async () => {
        await assert.rejects(
          () =>
            startDomainACheckout({
              db: asSql(pg),
              userId: OTHER_USER.id,
              organisationId,
              quantity: 1,
              origin: ORIGIN,
            }),
          /Organisation billing authority required/,
        );
      },
    );
    assert.equal(stripe.calls.length, 0);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26C.2 portal is organisation-scoped and isolated", async () => {
  const pg = await openCp26finDb();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    const org = await pg.query<{ id: string }>(
      "select sbg_create_organisation_for_user($1, 'C2 portal')::text as id",
      [OWNER_USER.id],
    );
    const organisationId = org.rows[0]!.id;
    await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
      OWNER_USER.id,
      organisationId,
      fixture.hotelId,
    ]);
    await pg.query(
      `select sbg_apply_organisation_billing_event(
         'evt_c2p', 'customer.subscription.updated', 20, $1::uuid, 'cus_c2p', 'sub_c2p', 'price_probe_c2p',
         'active', null, false, 1, 'month', null
       )`,
      [organisationId],
    );
    await withEnv(
      {
        SBG_SAAS_COMMERCE: "test",
        STRIPE_SECRET_KEY: TEST_KEY,
        SBG_SAAS_TEST_ORGANISATION_IDS: organisationId,
      },
      async () => {
        const portal = await startDomainAPortal({
          db: asSql(pg),
          userId: OWNER_USER.id,
          organisationId,
          origin: ORIGIN,
        });
        assert.equal(portal.url, "https://stripe.example/portal");
      },
    );
    assert.equal(stripe.calls.length, 1);
    stripe.calls.length = 0;
    await withEnv(
      {
        SBG_SAAS_COMMERCE: "test",
        STRIPE_SECRET_KEY: TEST_KEY,
        SBG_SAAS_TEST_ORGANISATION_IDS: HOTEL_B,
      },
      async () => {
        await assert.rejects(
          () =>
            startDomainAPortal({
              db: asSql(pg),
              userId: OWNER_USER.id,
              organisationId,
              origin: ORIGIN,
            }),
          SaasCommerceError,
        );
      },
    );
    assert.equal(stripe.calls.length, 0);
    const owned = await loadDomainABillingState(asSql(pg), OWNER_USER.id, fixture.hotelId);
    assert.equal(owned.lifecycle.shouldManageBilling, true);
    assert.equal(owned.propertyEntitled, false);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26C.2 Domain A webhook organisation isolation does not sync hotel entitlement", async () => {
  const pg = await openCp26finDb();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "c2 webhook");
    const org = await pg.query<{ id: string }>(
      "select sbg_create_organisation_for_user($1, 'C2 hook')::text as id",
      [OWNER_USER.id],
    );
    const organisationId = org.rows[0]!.id;
    const version = await pg.query<{ id: string }>(
      "select sbg_catalogue_create_price_version($1, 'property_licence', 1111)::text as id",
      [PLATFORM_OWNER_USER.id],
    );
    await pg.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [
      PLATFORM_OWNER_USER.id,
      version.rows[0]!.id,
    ]);
    await pg.query(
      "select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', 'prod_probe_c2w', 'price_probe_c2w')",
      [PLATFORM_OWNER_USER.id, version.rows[0]!.id],
    );
    const extracted = extractDomainASubscriptionEvent({
      id: "evt_c2w",
      type: "customer.subscription.updated",
      created: 30,
      livemode: false,
      data: {
        object: {
          id: "sub_c2w",
          customer: "cus_c2w",
          status: "active",
          current_period_end: 1_800_000_000,
          cancel_at_period_end: false,
          metadata: { organisation_id: organisationId },
          items: { data: [{ quantity: 4, price: { id: "price_probe_c2w", recurring: { interval: "month" } } }] },
        },
      },
    });
    assert.equal(extracted.quantity, 4);
    const isolatedEnv = {
      SBG_SAAS_COMMERCE: "test",
      STRIPE_SECRET_KEY: TEST_KEY,
      SBG_SAAS_TEST_ORGANISATION_IDS: HOTEL_B,
    };
    assert.equal(domainAWebhookOrganisationAllowed(extracted.organisationId, isolatedEnv), false);
    assert.equal(
      domainAWebhookOrganisationAllowed(extracted.organisationId, { ...isolatedEnv, SBG_SAAS_TEST_ORGANISATION_IDS: "" }),
      false,
    );
    const allowedEnv = { ...isolatedEnv, SBG_SAAS_TEST_ORGANISATION_IDS: organisationId };
    assert.equal(domainAWebhookOrganisationAllowed(extracted.organisationId, allowedEnv), true);
    const outcome = await applyDomainABillingEvent(asSql(pg), extracted, allowedEnv);
    assert.equal(outcome, "applied");
    const row = await pg.query<{ licensed_quantity: number }>(
      "select licensed_quantity from sbg_organisation_billing where organisation_id = $1::uuid",
      [organisationId],
    );
    assert.equal(row.rows[0]!.licensed_quantity, 4);
    const again = await applyDomainABillingEvent(asSql(pg), extracted, allowedEnv);
    assert.equal(again, "duplicate");
    assert.equal(
      domainAWebhookEligible({ livemode: true }, { SBG_SAAS_COMMERCE: "off", STRIPE_SECRET_KEY: TEST_KEY }),
      false,
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
  assert.doesNotMatch(domainB, /domainAWebhookOrganisationAllowed|SBG_SAAS_TEST_ORGANISATION_IDS/);
  const deauth = webhook.slice(
    webhook.indexOf('event.type === "account.application.deauthorized"'),
    webhook.indexOf("if (!domainAWebhookEligible"),
  );
  assert.match(deauth, /sbg_disconnect_stripe_by_account/);
  assert.doesNotMatch(deauth, /domainAWebhookOrganisationAllowed|SBG_SAAS_TEST_ORGANISATION_IDS/);
  assert.ok(
    webhook.indexOf('event.type.startsWith("checkout.session.")') <
      webhook.lastIndexOf("domainAWebhookOrganisationAllowed"),
  );
  assert.ok(
    webhook.indexOf('event.type === "account.application.deauthorized"') <
      webhook.lastIndexOf("domainAWebhookOrganisationAllowed"),
  );
  const extractAt = webhook.lastIndexOf("extractDomainASubscriptionEvent");
  const isolateAt = webhook.lastIndexOf("domainAWebhookOrganisationAllowed");
  const applyAt = webhook.lastIndexOf("applyDomainABillingEvent");
  assert.ok(extractAt >= 0 && isolateAt > extractAt && applyAt > isolateAt);
  assert.equal(webhook.includes("sbg_sync_hotel_entitlement"), false);

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
    checkoutFn.indexOf("assertDomainACommerceAllowedForOrganisation") <
      checkoutFn.indexOf("resolvePropertyLicenceCheckoutPrice"),
  );
  assert.equal(checkoutFn.includes("sbg_set_billing_price_for_user"), false);
  assert.ok(
    portalFn.indexOf("assertPortalAllowed") < portalFn.indexOf("assertDomainACommerceAllowedForOrganisation"),
  );
  assert.ok(
    portalFn.indexOf("assertDomainACommerceAllowedForOrganisation") < portalFn.indexOf("createBillingPortal"),
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
