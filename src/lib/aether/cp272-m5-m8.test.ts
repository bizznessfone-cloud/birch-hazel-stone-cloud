/**
 * CP27.2 M5–M8 application remediation. PGLite and mocked Stripe only.
 * No Production connection. No live Stripe request. No migration 0031.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Sql } from "@/lib/db";
import { SaasCommerceError } from "./saas-commerce.server.ts";
import { SaasLifecycleError } from "./saas-lifecycle.ts";
import {
  PropertyLicenceQuantityError,
  propertyHasDomainAEntitlement,
  usableLicensedQuantity,
} from "./property-licence.ts";
import {
  DomainACheckoutClaimError,
  allocatePropertyLicence,
  loadDomainABillingState,
  startDomainACheckout,
} from "./saas-billing.server.ts";
import {
  DomainAWebhookExtractError,
  applyDomainABillingEvent,
  extractDomainASubscriptionEvent,
} from "./saas-billing-webhook.ts";
import {
  DomainBLiveCheckoutError,
  assertDomainBLiveCheckoutAllowed,
  domainBLiveCheckoutEnabled,
} from "./domain-b-live.ts";
import { handleDomainBCheckoutEvent } from "./domain-b-payment.ts";
import { startGuestPaymentForBooking } from "./guest-payment-fns.ts";
import { createGuestTransferCheckout, createSubscriptionCheckout } from "./stripe.server.ts";
import {
  OTHER_USER,
  OWNER_USER,
  PLATFORM_OWNER_USER,
  SECOND_HOTEL,
  bootstrapPlatformOwner,
  createHotelForUser,
  hotelStatus,
  insertAuthUser,
  onboardConfiguredFixture,
  openCp26finDb,
  openCp272CheckoutDb,
  openCp272PaymentDb,
} from "./cp26a4-fixture.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const PRICE = "price_probe_m5";
const ORIGIN = "https://scan-book-go.vercel.app";
const TEST_KEY = "sk_test_cp272_m5_placeholder";
const LIVE_KEY = "sk_live_cp272_m5_placeholder";
const ORG = "11111111-1111-4111-8111-111111111111";

function asSql(pg: PGlite): Sql {
  const sql = (async () => {
    throw new Error("tagged-template SQL is not used in CP27.2 M5–M8 tests");
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
    (await pg.query<T>(text, params)).rows as T[];
  return sql;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const keys = new Set([...Object.keys(env), "SBG_DOMAIN_B_LIVE_CHECKOUT"]);
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) previous[key] = process.env[key];
  try {
    for (const key of keys) {
      const value = env[key];
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

function commerce(organisationId: string, extra: Record<string, string | undefined> = {}) {
  return {
    SBG_SAAS_COMMERCE: "test",
    STRIPE_SECRET_KEY: TEST_KEY,
    SBG_SAAS_TEST_ORGANISATION_IDS: organisationId,
    SBG_DOMAIN_B_LIVE_CHECKOUT: undefined,
    ...extra,
  };
}

function subscriptionEvent(organisationId: string, quantity: unknown, eventId: string, created: number, status = "active") {
  return {
    id: eventId,
    type: "customer.subscription.updated",
    created,
    livemode: false,
    data: {
      object: {
        id: "sub_m5",
        customer: "cus_m5",
        status,
        current_period_end: 1_800_000_000,
        cancel_at_period_end: false,
        metadata: { organisation_id: organisationId },
        items: { data: [{ quantity, price: { id: PRICE, recurring: { interval: "month" } } }] },
      },
    },
  };
}

async function licenceOrg(pg: PGlite, quantity: number) {
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  await insertAuthUser(pg, PLATFORM_OWNER_USER);
  await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "m5 probe");
  const first = await onboardConfiguredFixture(pg, OWNER_USER.id);
  const second = await createHotelForUser(pg, OWNER_USER.id, SECOND_HOTEL);
  const org = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'M5 Org')::text as id",
    [OWNER_USER.id],
  );
  const organisationId = org.rows[0]!.id;
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    OWNER_USER.id,
    organisationId,
    first.hotelId,
  ]);
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    OWNER_USER.id,
    organisationId,
    second.hotelId,
  ]);
  const version = await pg.query<{ id: string }>(
    "select sbg_catalogue_create_price_version($1, 'property_licence', 1111)::text as id",
    [PLATFORM_OWNER_USER.id],
  );
  const versionId = version.rows[0]!.id;
  await pg.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [PLATFORM_OWNER_USER.id, versionId]);
  await pg.query("select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', 'prod_probe_m5', $3)", [
    PLATFORM_OWNER_USER.id,
    versionId,
    PRICE,
  ]);
  await pg.query(
    `select sbg_apply_organisation_billing_event(
       'evt_m5_seed', 'customer.subscription.updated', 10, $1::uuid, 'cus_m5', 'sub_m5', $2,
       'active', null, false, $3::integer, 'month', $4::uuid
     )`,
    [organisationId, PRICE, quantity, versionId],
  );
  return { organisationId, first: first.hotelId, second: second.hotelId, versionId };
}

function mockStripe(options?: { fail?: boolean; id?: string; url?: string | null; hold?: boolean }) {
  const calls: Array<{ body: URLSearchParams; headers: Headers }> = [];
  let release: () => void = () => {};
  const gate = options?.hold ? new Promise<void>((resolve) => { release = resolve; }) : null;
  let opened: () => void = () => {};
  const openedGate = new Promise<void>((resolve) => { opened = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ body: new URLSearchParams(String(init?.body ?? "")), headers: new Headers(init?.headers) });
    opened();
    if (gate) await gate;
    if (options?.fail) {
      return new Response(JSON.stringify({ error: { message: "stripe down" } }), { status: 402 });
    }
    const id = options?.id ?? "cs_m6";
    const url = options && "url" in options ? options.url : "https://stripe.example/checkout";
    return new Response(JSON.stringify({ id, url, livemode: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    opened: openedGate,
    release,
    restore() {
      release();
      globalThis.fetch = original;
    },
  };
}

test("M5 usable quantity is only the integers 1–49", () => {
  assert.equal(usableLicensedQuantity(1), 1);
  assert.equal(usableLicensedQuantity(49), 49);
  assert.equal(usableLicensedQuantity("2"), 2);
  assert.equal(usableLicensedQuantity("49"), 49);
  for (const value of [0, 50, -1, 1.5, 49.2, "50", "2.5", " 2", "", null, undefined, true, Number.NaN]) {
    assert.equal(usableLicensedQuantity(value), 0, String(value));
  }
});

test("M5 entitlement matrix is allocation plus active, trialing, or past_due", () => {
  for (const status of ["active", "trialing", "past_due"]) {
    assert.equal(
      propertyHasDomainAEntitlement({ organisationId: ORG, allocationActive: true, subscriptionStatus: status }),
      true,
      status,
    );
  }
  for (const status of ["paused", "unpaid", "incomplete", "canceled", "incomplete_expired", "inactive", null, "unknown"]) {
    assert.equal(
      propertyHasDomainAEntitlement({ organisationId: ORG, allocationActive: true, subscriptionStatus: status }),
      false,
      String(status),
    );
  }
  assert.equal(
    propertyHasDomainAEntitlement({ organisationId: ORG, allocationActive: false, subscriptionStatus: "active" }),
    false,
  );
  assert.equal(
    propertyHasDomainAEntitlement({ organisationId: null, allocationActive: true, subscriptionStatus: "active" }),
    false,
  );
});

test("M5 webhook rejects quantity outside 0–49 and does not clamp or consume the event", async () => {
  const pg = await openCp26finDb();
  try {
    const { organisationId } = await licenceOrg(pg, 2);
    const env = { SBG_SAAS_COMMERCE: "test", STRIPE_SECRET_KEY: TEST_KEY };
    for (const quantity of [50, -1, 1.5, "3"]) {
      assert.throws(
        () => extractDomainASubscriptionEvent(subscriptionEvent(organisationId, quantity, "evt_bad", 30)),
        (err: unknown) => err instanceof DomainAWebhookExtractError && err.code === "missing_quantity",
      );
    }
    const zero = extractDomainASubscriptionEvent(subscriptionEvent(organisationId, 0, "evt_zero", 30));
    assert.equal(zero.quantity, 0);
    const fortyNine = extractDomainASubscriptionEvent(subscriptionEvent(organisationId, 49, "evt_49", 40));
    assert.equal(fortyNine.quantity, 49);
    await assert.rejects(
      () => applyDomainABillingEvent(asSql(pg), { ...zero, quantity: 50 }, env),
      (err: unknown) => err instanceof DomainAWebhookExtractError && err.code === "missing_quantity",
    );
    const consumed = await pg.query<{ n: number }>(
      "select count(*)::int as n from sbg_stripe_events where event_id = 'evt_zero'",
    );
    assert.equal(consumed.rows[0]!.n, 0);
    const stored = await pg.query<{ licensed_quantity: number }>(
      "select licensed_quantity from sbg_organisation_billing where organisation_id = $1::uuid",
      [organisationId],
    );
    assert.equal(stored.rows[0]!.licensed_quantity, 2);
  } finally {
    await pg.close();
  }
});

test("M5 quantity reduction keeps allocations and blocks until quantity is restored", async () => {
  const pg = await openCp26finDb();
  try {
    const { organisationId, first, second } = await licenceOrg(pg, 2);
    const db = asSql(pg);
    const env = { SBG_SAAS_COMMERCE: "test", STRIPE_SECRET_KEY: TEST_KEY };
    await allocatePropertyLicence({ db, userId: OWNER_USER.id, organisationId, hotelId: first });
    await allocatePropertyLicence({ db, userId: OWNER_USER.id, organisationId, hotelId: second });
    const beforeStatus = await hotelStatus(pg, first);
    const reduced = extractDomainASubscriptionEvent(subscriptionEvent(organisationId, 0, "evt_reduce", 30));
    assert.equal(await applyDomainABillingEvent(db, reduced, env), "applied");
    const rows = await pg.query<{ n: number; available: number; status: string }>(
      `select count(*)::int as n,
              (select available_licences from sbg_organisation_licence_balance where organisation_id = $1::uuid) as available,
              (select status from hotels where id = $2::uuid) as status
         from sbg_property_licence_allocations
        where released_at is null`,
      [organisationId, first],
    );
    assert.equal(rows.rows[0]!.n, 2);
    assert.equal(Number(rows.rows[0]!.available), -2);
    assert.equal(rows.rows[0]!.status, beforeStatus);
    const third = await createHotelForUser(pg, OWNER_USER.id, {
      code: "m5-third",
      name: "Third",
      locality: "Kos",
      ianaTimezone: "Europe/Athens",
      currency: "EUR",
    });
    await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
      OWNER_USER.id,
      organisationId,
      third.hotelId,
    ]);
    await assert.rejects(
      () => allocatePropertyLicence({ db, userId: OWNER_USER.id, organisationId, hotelId: third.hotelId }),
      /no available property licence/i,
    );
    assert.equal(await hotelStatus(pg, third.hotelId), "unconfigured");
    const restored = extractDomainASubscriptionEvent(subscriptionEvent(organisationId, 3, "evt_restore", 40));
    assert.equal(await applyDomainABillingEvent(db, restored, env), "applied");
    await allocatePropertyLicence({ db, userId: OWNER_USER.id, organisationId, hotelId: third.hotelId });
    const after = await pg.query<{ n: number }>(
      "select count(*)::int as n from sbg_property_licence_allocations where released_at is null",
    );
    assert.equal(after.rows[0]!.n, 3);
    assert.equal(await hotelStatus(pg, first), beforeStatus);
  } finally {
    await pg.close();
  }
});

test("M5 a stored quantity outside 1–49 grants zero application capacity", async () => {
  const pg = await openCp26finDb();
  try {
    const { organisationId, first } = await licenceOrg(pg, 50);
    await assert.rejects(
      () =>
        allocatePropertyLicence({
          db: asSql(pg),
          userId: OWNER_USER.id,
          organisationId,
          hotelId: first,
        }),
      /no available property licence/i,
    );
    const n = await pg.query<{ n: number }>(
      "select count(*)::int as n from sbg_property_licence_allocations",
    );
    assert.equal(n.rows[0]!.n, 0);
    const state = await loadDomainABillingState(asSql(pg), OWNER_USER.id, first);
    assert.equal(state.propertyEntitled, false);
    await pg.query(
      "update sbg_organisation_billing set status = 'paused' where organisation_id = $1::uuid",
      [organisationId],
    );
    await pg.query("select sbg_allocate_property_licence($1, $2::uuid, $3::uuid)", [
      OWNER_USER.id,
      organisationId,
      first,
    ]);
    const paused = await loadDomainABillingState(asSql(pg), OWNER_USER.id, first);
    assert.equal(paused.allocationActive, true);
    assert.equal(paused.propertyEntitled, false);
    assert.equal(await hotelStatus(pg, first), "configured");
  } finally {
    await pg.close();
  }
});

test("M5 membership does not consume a licence or gain billing authority", async () => {
  const pg = await openCp272CheckoutDb();
  const stripe = mockStripe();
  try {
    const { organisationId, first } = await licenceOrg(pg, 2);
    await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'operator', false)", [
      OWNER_USER.id,
      organisationId,
      OTHER_USER.id,
    ]);
    const balance = await pg.query<{ active_allocations: number }>(
      "select active_allocations from sbg_organisation_licence_balance where organisation_id = $1::uuid",
      [organisationId],
    );
    assert.equal(balance.rows[0]!.active_allocations, 0);
    const state = await loadDomainABillingState(asSql(pg), OWNER_USER.id, first);
    assert.equal(state.propertyEntitled, false);
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
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: PLATFORM_OWNER_USER.id,
            organisationId,
            quantity: 1,
            origin: ORIGIN,
          }),
        /Organisation billing authority required/,
      );
    });
    assert.equal(stripe.calls.length, 0);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

async function checkoutOrg(pg: PGlite, name: string, user: { id: string } = OWNER_USER) {
  const fixture = await onboardConfiguredFixture(pg, user.id, {
    ...{
      code: `sbg-test-${name}`,
      name: `SBG ${name} [TEST]`,
      locality: "Kos",
      ianaTimezone: "Europe/Athens",
      currency: "EUR",
      serviceName: "SBG Test Transfers",
      destinationKind: "airport" as const,
      destinationName: "KOS Test Airport",
      amountMinor: 3500,
    },
  });
  const org = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, $2)::text as id",
    [user.id, name],
  );
  const organisationId = org.rows[0]!.id;
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    user.id,
    organisationId,
    fixture.hotelId,
  ]);
  const mapped = await pg.query<{ id: string }>(
    "select stripe_price_id as id from sbg_saas_stripe_mappings where stripe_price_id = $1",
    [PRICE],
  );
  if (!mapped.rows[0]) {
    const version = await pg.query<{ id: string }>(
      "select sbg_catalogue_create_price_version($1, 'property_licence', 1111)::text as id",
      [PLATFORM_OWNER_USER.id],
    );
    const versionId = version.rows[0]!.id;
    await pg.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [PLATFORM_OWNER_USER.id, versionId]);
    await pg.query("select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', 'prod_probe_m6', $3)", [
      PLATFORM_OWNER_USER.id,
      versionId,
      PRICE,
    ]);
  }
  return { organisationId, hotelId: fixture.hotelId };
}

test("M6 claim integrates checkout and rejects quantity 50 before Stripe", async () => {
  const pg = await openCp272CheckoutDb();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "m6 probe");
    const { organisationId, hotelId } = await checkoutOrg(pg, "m6");
    const before = await hotelStatus(pg, hotelId);
    await withEnv(commerce(organisationId), async () => {
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            organisationId,
            quantity: 50,
            origin: ORIGIN,
          }),
        PropertyLicenceQuantityError,
      );
      const result = await startDomainACheckout({
        db: asSql(pg),
        userId: OWNER_USER.id,
        organisationId,
        quantity: 4,
        origin: ORIGIN,
      });
      assert.equal(result.url, "https://stripe.example/checkout");
      assert.equal(result.quantity, 4);
      const again = await startDomainACheckout({
        db: asSql(pg),
        userId: OWNER_USER.id,
        organisationId,
        quantity: 4,
        origin: ORIGIN,
      });
      assert.equal(again.url, result.url);
    });
    assert.equal(stripe.calls.length, 1);
    assert.match(stripe.calls[0]!.headers.get("Idempotency-Key") ?? "", /^sbg-domain-a:[0-9a-f-]+:[0-9a-f-]+$/i);
    assert.equal(stripe.calls[0]!.body.get("line_items[0][quantity]"), "4");
    assert.equal(stripe.calls[0]!.body.get("line_items[0][price]"), PRICE);
    assert.equal(stripe.calls[0]!.headers.get("Stripe-Account"), null);
    const claim = await pg.query<{ state: string }>(
      "select state from sbg_domain_a_checkout_claims where organisation_id = $1::uuid",
      [organisationId],
    );
    assert.equal(claim.rows[0]!.state, "session_attached");
    const billing = await pg.query<{ n: number }>("select count(*)::int as n from sbg_organisation_billing");
    assert.equal(billing.rows[0]!.n, 0);
    assert.equal(await hotelStatus(pg, hotelId), before);
    const checkoutFn = read("src/lib/aether/saas-billing.server.ts");
    const fn = checkoutFn.slice(checkoutFn.indexOf("export async function startDomainACheckout"));
    const portalAt = fn.indexOf("export async function startDomainAPortal");
    const body = portalAt > 0 ? fn.slice(0, portalAt) : fn;
    assert.equal(body.includes(".transaction("), false);
    assert.ok(body.indexOf("resolvePropertyLicenceCheckoutPrice") < body.indexOf("sbg_claim_domain_a_checkout"));
    assert.ok(body.indexOf("sbg_claim_domain_a_checkout") < body.indexOf("createSubscriptionCheckout"));
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("M6 same-organisation concurrency creates one Stripe session and the other caller is busy", async () => {
  const pg = await openCp272CheckoutDb();
  const stripe = mockStripe({ hold: true });
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "m6 race");
    const { organisationId } = await checkoutOrg(pg, "race");
    await withEnv(commerce(organisationId), async () => {
      const first = startDomainACheckout({
        db: asSql(pg),
        userId: OWNER_USER.id,
        organisationId,
        quantity: 1,
        origin: ORIGIN,
      });
      await stripe.opened;
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            organisationId,
            quantity: 1,
            origin: ORIGIN,
          }),
        (err: unknown) => err instanceof DomainACheckoutClaimError && err.code === "checkout_in_progress",
      );
      stripe.release();
      const result = await first;
      assert.equal(result.url, "https://stripe.example/checkout");
    });
    assert.equal(stripe.calls.length, 1);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("M6 Stripe failure before a session releases the claim and a later checkout can retry", async () => {
  const pg = await openCp272CheckoutDb();
  const failing = mockStripe({ fail: true });
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "m6 fail");
    const { organisationId } = await checkoutOrg(pg, "fail");
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
        /stripe down/,
      );
    });
    assert.equal(failing.calls.length, 1);
    const released = await pg.query<{ state: string; expired: boolean }>(
      `select state, expires_at < clock_timestamp() as expired
         from sbg_domain_a_checkout_claims where organisation_id = $1::uuid`,
      [organisationId],
    );
    assert.equal(released.rows[0]!.state, "claimed");
    assert.equal(released.rows[0]!.expired, true);
  } finally {
    failing.restore();
  }
  const retry = mockStripe();
  try {
    await withEnv(commerce((await pg.query<{ id: string }>("select organisation_id::text as id from sbg_domain_a_checkout_claims")).rows[0]!.id), async () => {
      const org = (await pg.query<{ id: string }>("select organisation_id::text as id from sbg_domain_a_checkout_claims")).rows[0]!.id;
      const result = await startDomainACheckout({
        db: asSql(pg),
        userId: OWNER_USER.id,
        organisationId: org,
        quantity: 1,
        origin: ORIGIN,
      });
      assert.equal(result.url, "https://stripe.example/checkout");
    });
    assert.equal(retry.calls.length, 1);
  } finally {
    retry.restore();
    await pg.close();
  }
});

test("M6 attach failure does not release the claim and does not create a second session", async () => {
  const pg = await openCp272CheckoutDb();
  const stripe = mockStripe({ id: "cs_attached_once" });
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "m6 attach");
    const { organisationId } = await checkoutOrg(pg, "attach");
    const db = asSql(pg);
    const original = db.query.bind(db);
    db.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
      if (text.includes("sbg_attach_domain_a_checkout_session")) throw new Error("attach down");
      return original(text, params) as Promise<T[]>;
    };
    await withEnv(commerce(organisationId), async () => {
      await assert.rejects(
        () =>
          startDomainACheckout({
            db,
            userId: OWNER_USER.id,
            organisationId,
            quantity: 2,
            origin: ORIGIN,
          }),
        (err: unknown) => err instanceof DomainACheckoutClaimError && err.code === "checkout_attach_failed",
      );
      await assert.rejects(
        () =>
          startDomainACheckout({
            db: asSql(pg),
            userId: OWNER_USER.id,
            organisationId,
            quantity: 2,
            origin: ORIGIN,
          }),
        (err: unknown) => err instanceof DomainACheckoutClaimError && err.code === "checkout_in_progress",
      );
    });
    assert.equal(stripe.calls.length, 1);
    const claim = await pg.query<{ state: string; expired: boolean }>(
      `select state, expires_at > clock_timestamp() as expired
         from sbg_domain_a_checkout_claims where organisation_id = $1::uuid`,
      [organisationId],
    );
    assert.equal(claim.rows[0]!.state, "claimed");
    assert.equal(claim.rows[0]!.expired, true);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("M6 different organisations check out independently and a foreign caller cannot claim", async () => {
  const pg = await openCp272CheckoutDb();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "m6 orgs");
    const a = await checkoutOrg(pg, "orga", OWNER_USER);
    const b = await checkoutOrg(pg, "orgb", OTHER_USER);
    await withEnv(
      {
        ...commerce(a.organisationId),
        SBG_SAAS_TEST_ORGANISATION_IDS: `${a.organisationId},${b.organisationId}`,
      },
      async () => {
        await assert.rejects(
          () =>
            startDomainACheckout({
              db: asSql(pg),
              userId: OTHER_USER.id,
              organisationId: a.organisationId,
              quantity: 1,
              origin: ORIGIN,
            }),
          /Organisation billing authority required/,
        );
        const first = await startDomainACheckout({
          db: asSql(pg),
          userId: OWNER_USER.id,
          organisationId: a.organisationId,
          quantity: 1,
          origin: ORIGIN,
        });
        const second = await startDomainACheckout({
          db: asSql(pg),
          userId: OTHER_USER.id,
          organisationId: b.organisationId,
          quantity: 2,
          origin: ORIGIN,
        });
        assert.notEqual(first.url, "");
        assert.equal(second.url, first.url);
      },
    );
    assert.equal(stripe.calls.length, 2);
    assert.equal(stripe.calls[0]!.body.get("metadata[organisation_id]"), a.organisationId);
    assert.equal(stripe.calls[1]!.body.get("metadata[organisation_id]"), b.organisationId);
    const claims = await pg.query<{ n: number }>(
      "select count(*)::int as n from sbg_domain_a_checkout_claims where state = 'session_attached'",
    );
    assert.equal(claims.rows[0]!.n, 2);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

test("M6 commerce off and an existing subscription do not claim or call Stripe", async () => {
  const pg = await openCp272CheckoutDb();
  const stripe = mockStripe();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "m6 gate");
    const { organisationId } = await checkoutOrg(pg, "gate");
    await withEnv({ ...commerce(organisationId), SBG_SAAS_COMMERCE: "off" }, async () => {
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
    });
    await pg.query(
      `select sbg_apply_organisation_billing_event(
         'evt_m6', 'customer.subscription.updated', 10, $1::uuid, 'cus_m6', 'sub_m6', $2,
         'active', null, false, 1, 'month', null
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
            quantity: 1,
            origin: ORIGIN,
          }),
        (err: unknown) => err instanceof SaasLifecycleError && err.code === "subscription_exists",
      );
    });
    assert.equal(stripe.calls.length, 0);
    const claims = await pg.query<{ n: number }>("select count(*)::int as n from sbg_domain_a_checkout_claims");
    assert.equal(claims.rows[0]!.n, 0);
  } finally {
    stripe.restore();
    await pg.close();
  }
});

async function guestBooking(pg: PGlite, token: string, amount = 4200) {
  await insertAuthUser(pg, OWNER_USER);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, {
    code: `pay-${token}`,
    name: "SBG Pay [TEST]",
    locality: "Kos",
    ianaTimezone: "Europe/Athens",
    currency: "EUR",
  });
  const status = await hotelStatus(pg, hotel.hotelId);
  await pg.query(
    `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode)
     values ($1::uuid, 'acct_m7', false)`,
    [hotel.hotelId],
  );
  const booking = await pg.query<{ id: string }>(
    `insert into bookings (
       hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
       guest_name, guest_phone, guest_email, pickup_text, destination_text,
       human_reference, confirmation_token, quoted_amount_minor, quoted_currency
     ) values (
       $1::uuid, $2::uuid, '2026-06-20', '09:00', 60,
       'Guest', '+300000000', 'guest@sbg.test', 'Hotel', 'Airport',
       $3, $4, $5, 'EUR'
     ) returning id::text`,
    [hotel.hotelId, hotel.providerId, token.toUpperCase(), token, amount],
  );
  return { hotelId: hotel.hotelId, bookingId: booking.rows[0]!.id, status };
}

test("M7 guest checkout uses the prepared row, reuses a valid session, and keys Stripe to the payment", async () => {
  const pg = await openCp272PaymentDb();
  const calls: Array<{ body: string; headers: Headers }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ id: "cs_m7pay", url: "https://stripe.example/guest" }), { status: 200 });
  }) as typeof fetch;
  try {
    const fixture = await guestBooking(pg, "m7-token");
    await withEnv({ STRIPE_SECRET_KEY: TEST_KEY, SBG_SAAS_COMMERCE: "off", SBG_DOMAIN_B_LIVE_CHECKOUT: undefined }, async () => {
      const db = asSql(pg);
      const first = await startGuestPaymentForBooking(db, "m7-token", ORIGIN);
      const second = await startGuestPaymentForBooking(db, "m7-token", ORIGIN);
      assert.equal(first.status, "pending");
      assert.equal(second.url, first.url);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.headers.get("Idempotency-Key"), (await pg.query<{ id: string }>("select id::text as id from sbg_booking_payments")).rows[0]!.id);
      assert.equal(calls[0]!.headers.get("Stripe-Account"), "acct_m7");
      const params = new URLSearchParams(calls[0]!.body);
      assert.equal(params.get("line_items[0][price_data][unit_amount]"), "4200");
      assert.equal(params.get("line_items[0][price_data][currency]"), "eur");
      assert.equal(params.get("mode"), "payment");
      assert.equal(params.get("metadata[organisation_id]"), null);
      assert.equal(params.get("metadata[plan_code]"), null);
      const held = await pg.query<{ n: number }>("select count(*)::int as n from sbg_booking_payments");
      assert.equal(held.rows[0]!.n, 1);
      assert.equal(await hotelStatus(pg, fixture.hotelId), fixture.status);
    });
    const guest = read("src/lib/aether/guest-payment-fns.ts");
    assert.match(guest, /z\.object\(\{ token: z\.string\(\)\.min\(1\) \}\)/);
    assert.doesNotMatch(guest, /SBG_SAAS_COMMERCE|assertDomainACommerceAllowed/);
    const guestFn = read("src/lib/aether/stripe.server.ts");
    const slice = guestFn.slice(guestFn.indexOf("export async function createGuestTransferCheckout"));
    assert.doesNotMatch(slice, /assertDomainACommerceAllowed|application_fee|organisation_id|property_licence/);
    assert.match(slice, /mode: "payment"/);
  } finally {
    globalThis.fetch = original;
    await pg.close();
  }
});

test("M7 concurrent guest calls share one payment idempotency key and a failed session can be prepared again", async () => {
  const pg = await openCp272PaymentDb();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let opened: () => void = () => {};
  const openedGate = new Promise<void>((resolve) => { opened = resolve; });
  const keys: string[] = [];
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    n += 1;
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    if (n === 1) {
      opened();
      await gate;
    }
    return new Response(JSON.stringify({ id: "cs_m7concurrent", url: "https://stripe.example/guest" }), { status: 200 });
  }) as typeof fetch;
  try {
    await guestBooking(pg, "m7-race", 1800);
    await withEnv({ STRIPE_SECRET_KEY: TEST_KEY, SBG_SAAS_COMMERCE: undefined, SBG_DOMAIN_B_LIVE_CHECKOUT: undefined }, async () => {
      const db = asSql(pg);
      const first = startGuestPaymentForBooking(db, "m7-race", ORIGIN);
      await openedGate;
      const second = startGuestPaymentForBooking(db, "m7-race", ORIGIN);
      for (let i = 0; i < 50 && keys.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(keys.length, 2);
      release();
      const results = await Promise.all([first, second]);
      assert.equal(results[0]!.url, "https://stripe.example/guest");
      assert.equal(results[1]!.url, "https://stripe.example/guest");
      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1]);
      assert.match(keys[0]!, /^[0-9a-f-]{36}$/i);
      const third = await startGuestPaymentForBooking(db, "m7-race", ORIGIN);
      assert.equal(third.url, results[0]!.url);
      assert.equal(keys.length, 2);
      await pg.query(
        `update sbg_booking_payments
            set status = 'failed', stripe_checkout_session_id = 'cs_old', stripe_checkout_url = 'https://old.example/x'`,
      );
      const reset = await startGuestPaymentForBooking(db, "m7-race", ORIGIN);
      assert.equal(reset.url, "https://stripe.example/guest");
      const stored = await pg.query<{ status: string; session: string | null }>(
        "select status, stripe_checkout_session_id as session from sbg_booking_payments",
      );
      assert.equal(stored.rows[0]!.status, "pending");
      assert.equal(stored.rows[0]!.session, "cs_m7concurrent");
    });
  } finally {
    release();
    globalThis.fetch = original;
    await pg.close();
  }
});

function paymentEvent(input: {
  id: string;
  paymentId: string;
  bookingId: string;
  account?: string;
  sessionId?: string;
  amount?: number;
  currency?: string;
}) {
  return {
    id: input.id,
    type: "checkout.session.completed",
    account: input.account === undefined ? "acct_m7" : input.account,
    data: {
      object: {
        id: input.sessionId ?? "cs_m7pay",
        amount_total: input.amount === undefined ? 4200 : input.amount,
        currency: input.currency ?? "eur",
        payment_status: "paid",
        payment_intent: "pi_m7",
        metadata: { booking_id: input.bookingId, payment_id: input.paymentId },
      },
    },
  };
}

test("M7 webhook binding rejects mismatches and applies one valid event idempotently", async () => {
  const pg = await openCp272PaymentDb();
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: "cs_m7pay", url: "https://stripe.example/guest" }), { status: 200 })) as typeof fetch;
  try {
    const fixture = await guestBooking(pg, "m7-hook");
    const db = asSql(pg);
    await withEnv({ STRIPE_SECRET_KEY: TEST_KEY, SBG_DOMAIN_B_LIVE_CHECKOUT: undefined }, async () => {
      await startGuestPaymentForBooking(db, "m7-hook", ORIGIN);
    });
    const payment = (
      await pg.query<{ id: string }>("select id::text as id from sbg_booking_payments")
    ).rows[0]!.id;
    const base = { paymentId: payment, bookingId: fixture.bookingId };
    const cases: Array<{ name: string; event: ReturnType<typeof paymentEvent> }> = [
      { name: "payment", event: paymentEvent({ ...base, id: "evt_bad_pay", paymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) },
      { name: "booking", event: paymentEvent({ ...base, id: "evt_bad_book", bookingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }) },
      { name: "account", event: paymentEvent({ ...base, id: "evt_bad_acct", account: "acct_other" }) },
      { name: "session", event: paymentEvent({ ...base, id: "evt_bad_cs", sessionId: "cs_other" }) },
      { name: "amount", event: paymentEvent({ ...base, id: "evt_bad_amt", amount: 1 }) },
      { name: "currency", event: paymentEvent({ ...base, id: "evt_bad_ccy", currency: "usd" }) },
    ];
    for (const item of cases) {
      const result = await handleDomainBCheckoutEvent(db, item.event);
      assert.equal(result.status, 409, item.name);
      assert.equal(result.body.outcome, "binding_mismatch");
    }
    const untouched = await pg.query<{ status: string; n: number }>(
      `select p.status, (select count(*)::int from sbg_stripe_events) as n
         from sbg_booking_payments p`,
    );
    assert.equal(untouched.rows[0]!.status, "pending");
    assert.equal(untouched.rows[0]!.n, 0);
    const ok = await handleDomainBCheckoutEvent(db, paymentEvent({ ...base, id: "evt_ok", currency: "EUR" }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.received, true);
    const dup = await handleDomainBCheckoutEvent(db, paymentEvent({ ...base, id: "evt_ok", currency: "EUR" }));
    assert.equal(dup.status, 200);
    const paid = await pg.query<{ status: string; n: number; booking: string }>(
      `select p.status, (select count(*)::int from sbg_stripe_events) as n, p.booking_id::text as booking
         from sbg_booking_payments p`,
    );
    assert.equal(paid.rows[0]!.status, "paid");
    assert.equal(paid.rows[0]!.n, 1);
    assert.equal(paid.rows[0]!.booking, fixture.bookingId);
    const other = await handleDomainBCheckoutEvent(
      db,
      paymentEvent({ ...base, id: "evt_other_payment", paymentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    );
    assert.equal(other.status, 409);
    assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from sbg_stripe_events")).rows[0]!.n, 1);
    assert.equal(await hotelStatus(pg, fixture.hotelId), fixture.status);
  } finally {
    globalThis.fetch = original;
    await pg.close();
  }
});

test("M8 Domain B live checkout is an exact-true lock independent of Domain A", async () => {
  assert.equal(domainBLiveCheckoutEnabled({}), false);
  assert.equal(domainBLiveCheckoutEnabled({ SBG_DOMAIN_B_LIVE_CHECKOUT: "" }), false);
  assert.equal(domainBLiveCheckoutEnabled({ SBG_DOMAIN_B_LIVE_CHECKOUT: "false" }), false);
  assert.equal(domainBLiveCheckoutEnabled({ SBG_DOMAIN_B_LIVE_CHECKOUT: "TRUE" }), false);
  assert.equal(domainBLiveCheckoutEnabled({ SBG_DOMAIN_B_LIVE_CHECKOUT: "1" }), false);
  assert.equal(domainBLiveCheckoutEnabled({ SBG_DOMAIN_B_LIVE_CHECKOUT: " true" }), false);
  assert.equal(domainBLiveCheckoutEnabled({ SBG_DOMAIN_B_LIVE_CHECKOUT: "true" }), true);

  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({ id: "cs_m8", url: "https://stripe.example/guest", livemode: true }), {
      status: 200,
    });
  }) as typeof fetch;
  const guestInput = {
    accountId: "acct_hotel",
    bookingId: "22222222-2222-4222-8222-222222222222",
    paymentId: "33333333-3333-4333-8333-333333333333",
    amountMinor: 3500,
    currency: "EUR",
    successUrl: "https://example.test/ok",
    cancelUrl: "https://example.test/cancel",
  };
  try {
    await withEnv({ STRIPE_SECRET_KEY: TEST_KEY, SBG_SAAS_COMMERCE: "off", SBG_DOMAIN_B_LIVE_CHECKOUT: undefined }, async () => {
      assert.doesNotThrow(() => assertDomainBLiveCheckoutAllowed());
      const result = await createGuestTransferCheckout(guestInput);
      assert.equal(result.url, "https://stripe.example/guest");
    });
    for (const flag of [undefined, "", "false", "TRUE", "1"]) {
      await withEnv({ STRIPE_SECRET_KEY: LIVE_KEY, SBG_SAAS_COMMERCE: "off", SBG_DOMAIN_B_LIVE_CHECKOUT: flag }, async () => {
        assert.throws(() => assertDomainBLiveCheckoutAllowed(), DomainBLiveCheckoutError);
        await assert.rejects(() => createGuestTransferCheckout(guestInput), DomainBLiveCheckoutError);
      });
    }
    const afterBlocked = fetches;
    await withEnv({ STRIPE_SECRET_KEY: LIVE_KEY, SBG_SAAS_COMMERCE: "off", SBG_DOMAIN_B_LIVE_CHECKOUT: "true" }, async () => {
      assert.doesNotThrow(() => assertDomainBLiveCheckoutAllowed());
      const result = await createGuestTransferCheckout(guestInput);
      assert.equal(result.id, "cs_m8");
    });
    assert.equal(fetches, afterBlocked + 1);
    await withEnv(
      { STRIPE_SECRET_KEY: LIVE_KEY, SBG_SAAS_COMMERCE: "test", SBG_DOMAIN_B_LIVE_CHECKOUT: "true" },
      async () => {
        await assert.rejects(
          () =>
            createSubscriptionCheckout({
              priceId: "price_probe",
              organisationId: ORG,
              userId: OWNER_USER.id,
              quantity: 1,
              successUrl: "https://example.test/ok",
              cancelUrl: "https://example.test/cancel",
            }),
          SaasCommerceError,
        );
      },
    );
    await withEnv(
      { STRIPE_SECRET_KEY: LIVE_KEY, SBG_SAAS_COMMERCE: "live", SBG_DOMAIN_B_LIVE_CHECKOUT: "false" },
      async () => {
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({ id: "cs_domain_a", url: "https://stripe.example/a", livemode: true }), {
            status: 200,
          })) as typeof fetch;
        const result = await createSubscriptionCheckout({
          priceId: "price_probe",
          organisationId: ORG,
          userId: OWNER_USER.id,
          quantity: 1,
          successUrl: "https://example.test/ok",
          cancelUrl: "https://example.test/cancel",
        });
        assert.equal(result.url, "https://stripe.example/a");
      },
    );
  } finally {
    globalThis.fetch = original;
  }
  const live = read("src/lib/aether/domain-b-live.ts");
  assert.doesNotMatch(live, /process\.env\.SBG_SAAS_COMMERCE|assertDomainACommerceAllowed|VITE_|AETHER_DATABASE_OWNER_URL/);
  assert.equal(
    createHash("sha256").update(read("migrations/0029_cp272_domain_a_checkout_claims.sql")).digest("hex"),
    "e5897eda1a4f3c8c4025e16235b9d11a677b3cc7994934058142934d4dea7adc",
  );
  assert.equal(
    createHash("sha256").update(read("migrations/0030_cp272_fix_prepare_booking_payment.sql")).digest("hex"),
    "9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f",
  );
  assert.equal(read("scripts/production-db-preflight.mjs").includes("0031_"), false);
});
