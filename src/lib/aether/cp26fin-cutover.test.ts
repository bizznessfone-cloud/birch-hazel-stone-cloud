/**
 * CP26 FINALISATION — dormant Domain A cutover proofs.
 * Synthetic 1111 minor units are probes, not a commercial price. No Stripe network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Sql } from "@/lib/db";
import { createGuestTransferCheckout } from "./stripe.server.ts";
import { applyDomainABillingEvent, extractDomainASubscriptionEvent } from "./saas-billing-webhook.ts";
import { CatalogueCommandError, createOwnerPriceVersion } from "./owner-catalogue.ts";
import { loadOwnerRevenue } from "./owner-queries.ts";
import { allocatePropertyLicence } from "./saas-billing.server.ts";
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
} from "./cp26a4-fixture.ts";

function asSql(pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql {
  const sql = (async () => {
    throw new Error("unused");
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
    (await pg.query(text, params)).rows as T[];
  return sql;
}

const PRICE = "price_probe_fin";

async function orgWithQuantity(pg: Awaited<ReturnType<typeof openCp26finDb>>, quantity: number) {
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  await insertAuthUser(pg, PLATFORM_OWNER_USER);
  await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "fin cutover");
  const first = await onboardConfiguredFixture(pg, OWNER_USER.id);
  const second = await createHotelForUser(pg, OWNER_USER.id, SECOND_HOTEL);
  const org = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'Licence Org')::text as id",
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
  await pg.query("select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', 'prod_probe_fin', $3)", [
    PLATFORM_OWNER_USER.id,
    versionId,
    PRICE,
  ]);
  await pg.query(
    `select sbg_apply_organisation_billing_event(
       'evt_seed', 'customer.subscription.updated', 10, $1::uuid, 'cus_fin', 'sub_fin', $2,
       'active', null, false, $3::integer, 'month', $4::uuid
     )`,
    [organisationId, PRICE, quantity, versionId],
  );
  return { organisationId, first: first.hotelId, second: second.hotelId, versionId };
}

function event(organisationId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_fin",
    type: "customer.subscription.updated",
    created: 40,
    livemode: false,
    data: {
      object: {
        id: "sub_fin",
        customer: "cus_fin",
        status: "active",
        current_period_end: 1_800_000_000,
        cancel_at_period_end: false,
        metadata: { organisation_id: organisationId },
        items: { data: [{ quantity: 2, price: { id: PRICE, recurring: { interval: "month" } } }] },
      },
    },
    ...overrides,
  };
}

test("allocation consumes one licence per property and spare capacity needs no second subscription", async () => {
  const pg = await openCp26finDb();
  try {
    const { organisationId, first, second } = await orgWithQuantity(pg, 2);
    const db = asSql(pg);
    await allocatePropertyLicence({ db, userId: OWNER_USER.id, organisationId, hotelId: first });
    const balance = await pg.query<{ licensed_quantity: number; active_allocations: number; available_licences: number }>(
      "select licensed_quantity, active_allocations, available_licences from sbg_organisation_licence_balance where organisation_id = $1::uuid",
      [organisationId],
    );
    assert.equal(balance.rows[0]!.licensed_quantity, 2);
    assert.equal(balance.rows[0]!.active_allocations, 1);
    assert.equal(balance.rows[0]!.available_licences, 1);
    await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'operator', false)", [
      OWNER_USER.id,
      organisationId,
      OTHER_USER.id,
    ]);
    const afterUsers = await pg.query<{ active_allocations: number }>(
      "select active_allocations from sbg_organisation_licence_balance where organisation_id = $1::uuid",
      [organisationId],
    );
    assert.equal(afterUsers.rows[0]!.active_allocations, 1);
    await allocatePropertyLicence({ db, userId: OWNER_USER.id, organisationId, hotelId: second });
    const full = await pg.query<{ available_licences: number; n: number }>(
      `select available_licences,
              (select count(*)::int from sbg_organisation_billing) as n
         from sbg_organisation_licence_balance
        where organisation_id = $1::uuid`,
      [organisationId],
    );
    assert.equal(full.rows[0]!.available_licences, 0);
    assert.equal(full.rows[0]!.n, 1);
    const third = await createHotelForUser(pg, OWNER_USER.id, {
      code: "third-prop",
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
    assert.equal(await hotelStatus(pg, first), "configured");
    assert.equal(await hotelStatus(pg, third.hotelId), "unconfigured");
    const subs = await pg.query<{ n: number }>("select count(*)::int as n from sbg_organisation_billing");
    assert.equal(subs.rows[0]!.n, 1);
  } finally {
    await pg.close();
  }
});

test("webhook keeps quantity and rejects duplicate, stale, ambiguous, and conflicting subscriptions", async () => {
  const pg = await openCp26finDb();
  try {
    const { organisationId } = await orgWithQuantity(pg, 2);
    const db = asSql(pg);
    const env = { SBG_SAAS_COMMERCE: "test", STRIPE_SECRET_KEY: "sk_test_fin_placeholder" };
    const first = extractDomainASubscriptionEvent(event(organisationId, { id: "evt_q", created: 50 }));
    assert.equal(await applyDomainABillingEvent(db, first, env), "applied");
    const qty = await pg.query<{ licensed_quantity: number }>(
      "select licensed_quantity from sbg_organisation_billing where organisation_id = $1::uuid",
      [organisationId],
    );
    assert.equal(qty.rows[0]!.licensed_quantity, 2);
    assert.equal(await applyDomainABillingEvent(db, first, env), "duplicate");
    const stale = extractDomainASubscriptionEvent(
      event(organisationId, {
        id: "evt_stale",
        created: 20,
        data: {
          object: {
            id: "sub_fin",
            customer: "cus_fin",
            status: "active",
            cancel_at_period_end: false,
            metadata: { organisation_id: organisationId },
            items: { data: [{ quantity: 9, price: { id: PRICE, recurring: { interval: "month" } } }] },
          },
        },
      }),
    );
    assert.equal(await applyDomainABillingEvent(db, stale, env), "stale");
    const ambiguous = extractDomainASubscriptionEvent(event(organisationId, { id: "evt_amb", created: 50 }));
    assert.equal(await applyDomainABillingEvent(db, ambiguous, env), "ambiguous");
    const conflict = extractDomainASubscriptionEvent(
      event(organisationId, {
        id: "evt_conflict",
        created: 80,
        data: {
          object: {
            id: "sub_other",
            customer: "cus_fin",
            status: "active",
            cancel_at_period_end: false,
            metadata: { organisation_id: organisationId },
            items: { data: [{ quantity: 2, price: { id: PRICE, recurring: { interval: "month" } } }] },
          },
        },
      }),
    );
    assert.equal(await applyDomainABillingEvent(db, conflict, env), "rejected");
    assert.throws(
      () =>
        extractDomainASubscriptionEvent(
          event(organisationId, {
            data: {
              object: {
                id: "sub_fin",
                status: "active",
                cancel_at_period_end: false,
                metadata: { organisation_id: organisationId },
                items: { data: [{ price: { id: PRICE } }] },
              },
            },
          }),
        ),
      /quantity/i,
    );
    const still = await pg.query<{ licensed_quantity: number; stripe_subscription_id: string }>(
      "select licensed_quantity, stripe_subscription_id from sbg_organisation_billing where organisation_id = $1::uuid",
      [organisationId],
    );
    assert.equal(still.rows[0]!.licensed_quantity, 2);
    assert.equal(still.rows[0]!.stripe_subscription_id, "sub_fin");
    const revenue = await loadOwnerRevenue(db);
    assert.equal(revenue.mrr, 2222);
    assert.equal(revenue.arr, 26664);
  } finally {
    await pg.close();
  }
});

test("historical plans cannot be priced and empty organisation revenue is zero", async () => {
  const pg = await openCp26finDb();
  try {
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "fin price");
    await assert.rejects(
      () => createOwnerPriceVersion(asSql(pg), PLATFORM_OWNER_USER.id, { code: "basic", amount: "11.11" }),
      (err: unknown) => err instanceof CatalogueCommandError,
    );
    const revenue = await loadOwnerRevenue(asSql(pg));
    assert.equal(revenue.mrr, 0);
    assert.equal(revenue.arr, 0);
    assert.equal(revenue.active, 0);
    const prices = await pg.query<{ n: number }>("select count(*)::int as n from sbg_saas_price_versions");
    assert.equal(prices.rows[0]!.n, 0);
  } finally {
    await pg.close();
  }
});

test("Domain B guest checkout stays a connected payment without an application fee", async () => {
  const stripe = readFileSync(join(process.cwd(), "src/lib/aether/stripe.server.ts"), "utf8");
  const guest = stripe.slice(stripe.indexOf("export async function createGuestTransferCheckout"));
  assert.match(guest, /mode: "payment"/);
  assert.doesNotMatch(guest, /application_fee|mode: "subscription"|organisation_id|property_licence/);
  const payment = readFileSync(join(process.cwd(), "migrations/0021_cp25_hotel_guest_payments.sql"), "utf8");
  assert.match(payment, /sbg_apply_payment_event/);
  let accountHeader: string | null = null;
  let body = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    accountHeader = new Headers(init?.headers).get("Stripe-Account");
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ id: "cs_guest", url: "https://stripe.example/guest" }), { status: 200 });
  }) as typeof fetch;
  const prev = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_fin_guest";
  delete process.env.SBG_SAAS_COMMERCE;
  try {
    const result = await createGuestTransferCheckout({
      accountId: "acct_hotel",
      bookingId: "22222222-2222-4222-8222-222222222222",
      paymentId: "33333333-3333-4333-8333-333333333333",
      amountMinor: 3500,
      currency: "EUR",
      successUrl: "https://example.test/ok",
      cancelUrl: "https://example.test/cancel",
    });
    assert.equal(result.url, "https://stripe.example/guest");
    assert.equal(accountHeader, "acct_hotel");
    assert.match(body, /mode=payment/);
    assert.doesNotMatch(body, /application_fee|property_licence|organisation_id/);
  } finally {
    globalThis.fetch = original;
    if (prev === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prev;
  }
});
