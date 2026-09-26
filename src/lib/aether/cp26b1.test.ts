/**
 * CP26B.1 / CP26 FINALISATION — organisation property-licence checkout.
 * Mocked Stripe. No Production network. No € amount in source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Sql } from "@/lib/db";
import { SaasCommerceError } from "./saas-commerce.server.ts";
import { SaasLifecycleError } from "./saas-lifecycle.ts";
import { PropertyLicenceQuantityError } from "./property-licence.ts";
import {
  loadDomainABillingState,
  startDomainACheckout,
  startDomainAPortal,
} from "./saas-billing.server.ts";
import {
  OWNER_USER,
  OTHER_USER,
  PLATFORM_OWNER_USER,
  bootstrapPlatformOwner,
  hotelStatus,
  insertAuthUser,
  onboardConfiguredFixture,
  openCp26finDb,
} from "./cp26a4-fixture.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const TEST_KEY = "sk_test_cp26b1_placeholder";
const PRICE = "price_probe_property";
const ORIGIN = "https://scan-book-go.vercel.app";

function asSql(pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql {
  const sql = (async () => {
    throw new Error("tagged-template SQL is not used in CP26B.1 tests");
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
    (await pg.query(text, params)).rows as T[];
  return sql;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
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

function mockStripe() {
  const calls: Array<{ path: string; body: URLSearchParams; headers: Headers }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      path: url,
      body: new URLSearchParams(String(init?.body ?? "")),
      headers: new Headers(init?.headers),
    });
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

async function readyOrg(pg: Awaited<ReturnType<typeof openCp26finDb>>, withPrice: boolean) {
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  await insertAuthUser(pg, PLATFORM_OWNER_USER);
  await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "b1 probe");
  const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
  const org = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, $2)::text as id",
    [OWNER_USER.id, "Probe Org"],
  );
  const organisationId = org.rows[0]!.id;
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    OWNER_USER.id,
    organisationId,
    fixture.hotelId,
  ]);
  if (withPrice) {
    const version = await pg.query<{ id: string }>(
      "select sbg_catalogue_create_price_version($1, 'property_licence', 1111)::text as id",
      [PLATFORM_OWNER_USER.id],
    );
    await pg.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [
      PLATFORM_OWNER_USER.id,
      version.rows[0]!.id,
    ]);
    await pg.query(
      "select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', 'prod_probe_b1', $3)",
      [PLATFORM_OWNER_USER.id, version.rows[0]!.id, PRICE],
    );
  }
  return { organisationId, hotelId: fixture.hotelId };
}

function commerce(organisationId: string) {
  return {
    SBG_SAAS_COMMERCE: "test",
    STRIPE_SECRET_KEY: TEST_KEY,
    SBG_SAAS_TEST_ORGANISATION_IDS: organisationId,
  };
}

test("CP26B.1 commerce OFF does not call Stripe or write a licence quantity", async () => {
  const pg = await openCp26finDb();
  const stripe = mockStripe();
  try {
    const { organisationId, hotelId } = await readyOrg(pg, true);
    await withEnv({ ...commerce(organisationId), SBG_SAAS_COMMERCE: "off" }, async () => {
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            organisationId,
            quantity: 2,
            origin: ORIGIN,
          }),
        SaasCommerceError,
      );
    });
    assert.equal(stripe.calls.length, 0);
    const billing = await pg.query("select 1 from sbg_organisation_billing");
    assert.equal(billing.rows.length, 0);
    assert.equal(await hotelStatus(pg, hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 quantity above 49 is rejected and never reaches Stripe", async () => {
  const pg = await openCp26finDb();
  const stripe = mockStripe();
  try {
    const { organisationId } = await readyOrg(pg, true);
    await withEnv(commerce(organisationId), async () => {
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            organisationId,
            quantity: 500,
            origin: ORIGIN,
          }),
        PropertyLicenceQuantityError,
      );
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            organisationId,
            quantity: "2",
            origin: ORIGIN,
          }),
        PropertyLicenceQuantityError,
      );
    });
    assert.equal(stripe.calls.length, 0);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 missing mapping does not start Checkout", async () => {
  const pg = await openCp26finDb();
  const stripe = mockStripe();
  try {
    const { organisationId } = await readyOrg(pg, false);
    await withEnv(commerce(organisationId), async () => {
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            organisationId,
            quantity: 1,
            origin: ORIGIN,
          }),
        (err: unknown) => err instanceof SaasLifecycleError && err.code === "invalid_price_id",
      );
    });
    assert.equal(stripe.calls.length, 0);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 checkout is organisation-scoped property_licence quantity", async () => {
  const pg = await openCp26finDb();
  const stripe = mockStripe();
  try {
    const { organisationId, hotelId } = await readyOrg(pg, true);
    await withEnv(commerce(organisationId), async () => {
      const result = await startDomainACheckout({
        db: asSql(pg),
        userId: OWNER_USER.id,
        organisationId,
        quantity: 7,
        origin: ORIGIN,
      });
      assert.equal(result.url, "https://stripe.example/checkout");
      assert.equal(result.quantity, 7);
    });
    assert.equal(stripe.calls.length, 1);
    const body = stripe.calls[0]!.body;
    assert.equal(body.get("mode"), "subscription");
    assert.equal(body.get("line_items[0][price]"), PRICE);
    assert.equal(body.get("line_items[0][quantity]"), "7");
    assert.equal(body.get("metadata[organisation_id]"), organisationId);
    assert.equal(body.get("subscription_data[metadata][organisation_id]"), organisationId);
    assert.equal(body.get("metadata[plan_code]"), "property_licence");
    assert.equal(body.get("metadata[hotel_id]"), null);
    assert.equal(body.get("subscription_data[metadata][hotel_id]"), null);
    assert.equal(stripe.calls[0]!.headers.get("Stripe-Account"), null);
    const billing = await pg.query("select 1 from sbg_organisation_billing");
    assert.equal(billing.rows.length, 0);
    assert.equal(await hotelStatus(pg, hotelId), "configured");
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 an existing organisation subscription cannot start a second Checkout", async () => {
  const pg = await openCp26finDb();
  const stripe = mockStripe();
  try {
    const { organisationId } = await readyOrg(pg, true);
    await pg.query(
      `select sbg_apply_organisation_billing_event(
         'evt_b1', 'customer.subscription.updated', 10, $1::uuid, 'cus_b1', 'sub_b1', $2,
         'active', null, false, 7, 'month', null
       )`,
      [organisationId, PRICE],
    );
    await withEnv(commerce(organisationId), async () => {
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            organisationId,
            quantity: 2,
            origin: ORIGIN,
          }),
        (err: unknown) => err instanceof SaasLifecycleError && err.code === "subscription_exists",
      );
      const portal = await startDomainAPortal({
        db: asSql(pg),
        userId: OWNER_USER.id,
        organisationId,
        origin: ORIGIN,
      });
      assert.equal(portal.url, "https://stripe.example/portal");
    });
    assert.equal(stripe.calls.length, 1);
    assert.match(stripe.calls[0]!.path, /billing_portal/);
    await withEnv(commerce(organisationId), async () => {
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
    });
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 non-allowlisted organisation and live keys do not open Checkout", async () => {
  const pg = await openCp26finDb();
  const stripe = mockStripe();
  try {
    const { organisationId } = await readyOrg(pg, true);
    await withEnv(
      { ...commerce(organisationId), SBG_SAAS_TEST_ORGANISATION_IDS: "00000000-0000-4000-8000-000000000099" },
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
        STRIPE_SECRET_KEY: "sk_live_cp26b1_placeholder",
        SBG_SAAS_TEST_ORGANISATION_IDS: organisationId,
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
    assert.equal(stripe.calls.length, 0);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("CP26B.1 Domain B source freeze and gate before Stripe", () => {
  const billing = read("src/lib/aether/saas-billing.server.ts");
  const stripe = read("src/lib/aether/stripe.server.ts");
  const fns = read("src/lib/aether/stripe-fns.ts");
  const guest = read("src/lib/aether/guest-payment-fns.ts");
  const webhook = read("src/routes/api/stripe/webhook.ts");
  const checkoutFn = billing.slice(billing.indexOf("export async function startDomainACheckout"));
  const portalFn = billing.slice(billing.indexOf("export async function startDomainAPortal"));
  const gate = checkoutFn.indexOf("assertDomainACommerceAllowedForOrganisation");
  const allowed = checkoutFn.indexOf("assertCheckoutAllowed");
  const resolve = checkoutFn.indexOf("resolvePropertyLicenceCheckoutPrice");
  assert.ok(allowed >= 0 && gate > allowed && resolve > gate);
  assert.equal(checkoutFn.includes("sbg_set_billing_price_for_user"), false);
  assert.ok(portalFn.indexOf("assertPortalAllowed") < portalFn.indexOf("assertDomainACommerceAllowedForOrganisation"));
  assert.match(fns, /startDomainACheckout/);
  assert.match(fns, /quantity/);
  assert.doesNotMatch(fns, /z\.enum\(\["basic", "pro", "premium"\]\)/);
  assert.doesNotMatch(guest, /startDomainACheckout/);
  const guestFn = stripe.slice(stripe.indexOf("export async function createGuestTransferCheckout"));
  assert.match(guestFn, /mode: "payment"/);
  assert.doesNotMatch(guestFn, /application_fee/);
  assert.doesNotMatch(guestFn, /assertDomainACommerceAllowed/);
  assert.match(webhook, /sbg_apply_payment_event/);
  assert.match(webhook, /sbg_apply_organisation_billing_event|applyDomainABillingEvent/);
  assert.doesNotMatch(webhook, /sbg_sync_hotel_entitlement/);
});

test("CP26B.1 property entitlement requires an allocation, not a user or a bare organisation", async () => {
  const pg = await openCp26finDb();
  try {
    const { organisationId, hotelId } = await readyOrg(pg, true);
    await pg.query(
      `select sbg_apply_organisation_billing_event(
         'evt_ent', 'customer.subscription.updated', 10, $1::uuid, 'cus_ent', 'sub_ent', $2,
         'active', null, false, 2, 'month', null
       )`,
      [organisationId, PRICE],
    );
    const before = await loadDomainABillingState(asSql(pg), OWNER_USER.id, hotelId);
    assert.equal(before.propertyEntitled, false);
    assert.equal(before.lifecycle.isEntitled, true);
    assert.equal(await hotelStatus(pg, hotelId), "configured");
    await pg.query("select sbg_allocate_property_licence($1, $2::uuid, $3::uuid)", [
      OWNER_USER.id,
      organisationId,
      hotelId,
    ]);
    const after = await loadDomainABillingState(asSql(pg), OWNER_USER.id, hotelId);
    assert.equal(after.propertyEntitled, true);
    assert.equal(after.allocationActive, true);
    assert.equal(await hotelStatus(pg, hotelId), "configured");
    const members = await pg.query<{ n: number }>(
      "select count(*)::int as n from sbg_organisation_members where organisation_id = $1::uuid",
      [organisationId],
    );
    assert.equal(members.rows[0]!.n, 1);
    const allocations = await pg.query<{ n: number }>(
      "select count(*)::int as n from sbg_property_licence_allocations where released_at is null",
    );
    assert.equal(allocations.rows[0]!.n, 1);
  } finally {
    await pg.close();
  }
});
