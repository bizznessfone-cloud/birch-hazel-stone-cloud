/**
 * CP26B.2 — ordered Domain A billing persistence. PGLite + mocked apply.
 * No Production, no Stripe network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Sql } from "@/lib/db";
import {
  applyLegacyHotelBillingEvent as applyDomainABillingEvent,
  extractLegacyHotelSubscriptionEvent as extractDomainASubscriptionEvent,
  hasOrderedBillingApply,
  OrderedBillingSchemaError,
} from "./saas-billing-webhook.ts";
import { SaasLifecycleError } from "./saas-lifecycle.ts";
import {
  applyBillingEvent,
  hotelStatus,
  insertAuthUser,
  onboardConfiguredFixture,
  openCp26a4Db,
  openCp26a4DbThrough0023,
  OWNER_USER,
  OTHER_USER,
  createHotelForUser,
  SECOND_HOTEL,
} from "./cp26a4-fixture.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const PRICE_BASIC = "price_sbg_test_basic";
const PRICE_PRO = "price_sbg_test_pro";
const PRICE_ENV = {
  STRIPE_BASIC_PRICE_ID: PRICE_BASIC,
  STRIPE_PRO_PRICE_ID: PRICE_PRO,
  STRIPE_PREMIUM_PRICE_ID: "price_sbg_test_premium",
};

function asSql(pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql {
  const sql = (async () => {
    throw new Error("tagged-template SQL is not used in CP26B.2 tests");
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
    const result = await pg.query(text, params);
    return result.rows as T[];
  };
  return sql;
}

async function billing(pg: Awaited<ReturnType<typeof openCp26a4Db>>, hotelId: string) {
  const rows = await pg.query<{
    status: string;
    stripe_subscription_id: string | null;
    stripe_price_id: string | null;
    cancel_at_period_end: boolean | null;
    last_stripe_event_created: string | number | null;
    last_stripe_event_id: string | null;
  }>(
    `select status, stripe_subscription_id, stripe_price_id, cancel_at_period_end,
            last_stripe_event_created, last_stripe_event_id
       from sbg_billing_accounts where hotel_id = $1::uuid`,
    [hotelId],
  );
  return rows.rows[0] ?? null;
}

async function eventRow(pg: Awaited<ReturnType<typeof openCp26a4Db>>, eventId: string) {
  const rows = await pg.query<{ outcome: string | null; stripe_created: string | number | null }>(
    "select outcome, stripe_created from sbg_stripe_events where event_id = $1",
    [eventId],
  );
  return rows.rows[0] ?? null;
}

function createdOf(row: { last_stripe_event_created: string | number | null } | null) {
  return row?.last_stripe_event_created == null ? null : Number(row.last_stripe_event_created);
}

test("CP26B.2 normal progression trialing then active", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "trialing", { created: 100, eventId: "evt_a" }), "applied");
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "active", { created: 200, eventId: "evt_b" }), "applied");
    const row = await billing(pg, fixture.hotelId);
    assert.equal(row?.status, "active");
    assert.equal(createdOf(row), 200);
    assert.equal(row?.last_stripe_event_id, "evt_b");
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 duplicate event id is idempotent", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "active", { created: 100, eventId: "evt_dup" }), "applied");
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "canceled", { created: 100, eventId: "evt_dup" }), "duplicate");
    const row = await billing(pg, fixture.hotelId);
    assert.equal(row?.status, "active");
    assert.equal(createdOf(row), 100);
    assert.equal((await eventRow(pg, "evt_dup"))?.outcome, "applied");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 stale older event does not regress active", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "active", { created: 200, eventId: "evt_new" }), "applied");
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "trialing", { created: 100, eventId: "evt_old" }), "stale");
    const row = await billing(pg, fixture.hotelId);
    assert.equal(row?.status, "active");
    assert.equal(createdOf(row), 200);
    assert.equal((await eventRow(pg, "evt_old"))?.outcome, "stale");
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 canceled is protected from a later-arriving older active", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "canceled", { created: 200, eventId: "evt_cxl" }), "applied");
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "active", { created: 100, eventId: "evt_act" }), "stale");
    assert.equal((await billing(pg, fixture.hotelId))?.status, "canceled");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 equal-timestamp different event ids are ambiguous", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "active", { created: 200, eventId: "evt_eq_a" }), "applied");
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "canceled", { created: 200, eventId: "evt_eq_b" }), "ambiguous");
    const row = await billing(pg, fixture.hotelId);
    assert.equal(row?.status, "active");
    assert.equal(row?.last_stripe_event_id, "evt_eq_a");
    assert.equal((await eventRow(pg, "evt_eq_b"))?.outcome, "ambiguous");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 equal-timestamp reverse initial order still cannot overwrite", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "canceled", { created: 200, eventId: "evt_eq_c" }), "applied");
    assert.equal(await applyBillingEvent(pg, fixture.hotelId, "active", { created: 200, eventId: "evt_eq_d" }), "ambiguous");
    assert.equal((await billing(pg, fixture.hotelId))?.status, "canceled");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 cancel_at_period_end persists without canceling", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(
      await applyBillingEvent(pg, fixture.hotelId, "active", {
        created: 200,
        eventId: "evt_cap",
        cancelAtPeriodEnd: true,
      }),
      "applied",
    );
    const row = await billing(pg, fixture.hotelId);
    assert.equal(row?.status, "active");
    assert.equal(row?.cancel_at_period_end, true);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 resubscribe accepts a newer subscription; delayed old is stale", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(
      await applyBillingEvent(pg, fixture.hotelId, "canceled", {
        created: 200,
        eventId: "evt_old_sub",
        subscriptionId: "sub_old",
      }),
      "applied",
    );
    assert.equal(
      await applyBillingEvent(pg, fixture.hotelId, "active", {
        created: 300,
        eventId: "evt_new_sub",
        subscriptionId: "sub_new",
      }),
      "applied",
    );
    assert.equal(
      await applyBillingEvent(pg, fixture.hotelId, "active", {
        created: 250,
        eventId: "evt_delayed_old",
        subscriptionId: "sub_old",
      }),
      "stale",
    );
    const row = await billing(pg, fixture.hotelId);
    assert.equal(row?.status, "active");
    assert.equal(row?.stripe_subscription_id, "sub_new");
    assert.equal(createdOf(row), 300);
  } finally {
    await pg.close();
  }
});

test("CP26B.2 unexpected subscription switch while active is rejected", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(
      await applyBillingEvent(pg, fixture.hotelId, "active", {
        created: 200,
        eventId: "evt_keep",
        subscriptionId: "sub_keep",
      }),
      "applied",
    );
    assert.equal(
      await applyBillingEvent(pg, fixture.hotelId, "active", {
        created: 300,
        eventId: "evt_switch",
        subscriptionId: "sub_other",
      }),
      "rejected",
    );
    const row = await billing(pg, fixture.hotelId);
    assert.equal(row?.status, "active");
    assert.equal(row?.stripe_subscription_id, "sub_keep");
    assert.equal((await eventRow(pg, "evt_switch"))?.outcome, "rejected");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 illegal status does not corrupt billing state", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await applyBillingEvent(pg, fixture.hotelId, "active", { created: 200, eventId: "evt_ok" });
    assert.equal(
      await applyBillingEvent(pg, fixture.hotelId, "mystery", { created: 300, eventId: "evt_bad" }),
      "rejected",
    );
    const row = await billing(pg, fixture.hotelId);
    assert.equal(row?.status, "active");
    assert.equal(createdOf(row), 200);
    assert.equal((await eventRow(pg, "evt_bad"))?.outcome, "rejected");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 hotel isolation and publication independence", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    const a = await onboardConfiguredFixture(pg, OWNER_USER.id);
    const b = await createHotelForUser(pg, OWNER_USER.id, SECOND_HOTEL);
    await applyBillingEvent(pg, a.hotelId, "active", { created: 200, eventId: "evt_a_only" });
    await applyBillingEvent(pg, b.hotelId, "trialing", { created: 150, eventId: "evt_b_only" });
    assert.equal((await billing(pg, a.hotelId))?.status, "active");
    assert.equal((await billing(pg, b.hotelId))?.status, "trialing");
    assert.equal(await hotelStatus(pg, a.hotelId), "configured");
    assert.equal(await hotelStatus(pg, b.hotelId), "unconfigured");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 webhook apply uses ordered function, unknown price fail-closed, 0023 schema gated", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    const extracted = extractDomainASubscriptionEvent({
      id: "evt_wh",
      type: "customer.subscription.updated",
      created: 400,
      data: {
        object: {
          id: "sub_wh",
          customer: "cus_wh",
          status: "active",
          current_period_end: 1_800_000_000,
          cancel_at_period_end: false,
          metadata: { hotel_id: fixture.hotelId },
          items: { data: [{ price: { id: PRICE_BASIC } }] },
        },
      },
    });
    assert.equal(await hasOrderedBillingApply(asSql(pg)), true);
    assert.equal(await applyDomainABillingEvent(asSql(pg), extracted, PRICE_ENV), "applied");
    await assert.rejects(
      () =>
        applyDomainABillingEvent(
          asSql(pg),
          { ...extracted, eventId: "evt_wh_price", priceId: "price_unknown_other" },
          PRICE_ENV,
        ),
      SaasLifecycleError,
    );
    assert.equal((await billing(pg, fixture.hotelId))?.stripe_price_id, PRICE_BASIC);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");
  } finally {
    await pg.close();
  }

  const legacy = await openCp26a4DbThrough0023();
  try {
    assert.equal(await hasOrderedBillingApply(asSql(legacy)), false);
    await insertAuthUser(legacy, OWNER_USER);
    const fixture = await onboardConfiguredFixture(legacy, OWNER_USER.id);
    await assert.rejects(
      () =>
        applyDomainABillingEvent(
          asSql(legacy),
          {
            eventId: "evt_legacy",
            eventType: "customer.subscription.updated",
            eventCreated: 100,
            hotelId: fixture.hotelId,
            customerId: "cus_x",
            subscriptionId: "sub_x",
            priceId: PRICE_BASIC,
            status: "active",
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
          },
          PRICE_ENV,
        ),
      OrderedBillingSchemaError,
    );
    const oldFn = await legacy.query<{ n: number }>(
      `select count(*)::int as n from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'sbg_apply_billing_event'`,
    );
    assert.equal(oldFn.rows[0]!.n, 1);
    const accounts = await legacy.query("select 1 from sbg_billing_accounts");
    assert.equal(accounts.rows.length, 0);
  } finally {
    await legacy.close();
  }
});

test("CP26B.2 concurrency: hotel FOR UPDATE serialises; final state is the newer event", async () => {
  const sql = read("migrations/0024_cp26b2_ordered_billing_events.sql");
  const fn = sql.slice(sql.indexOf("create or replace function sbg_apply_billing_event"));
  assert.match(fn, /from hotels where id = p_hotel_id for update/i);
  assert.match(fn, /from sbg_billing_accounts/i);
  assert.match(fn, /for update/i);
  assert.match(fn, /'stale'/);
  assert.match(fn, /'ambiguous'/);
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    const results = await Promise.all([
      applyBillingEvent(pg, fixture.hotelId, "trialing", { created: 100, eventId: "evt_race_100" }),
      applyBillingEvent(pg, fixture.hotelId, "active", { created: 200, eventId: "evt_race_200" }),
    ]);
    assert.ok(results.includes("applied"));
    const row = await billing(pg, fixture.hotelId);
    assert.equal(row?.status, "active");
    assert.equal(createdOf(row), 200);
    assert.equal(row?.last_stripe_event_id, "evt_race_200");
  } finally {
    await pg.close();
  }
});

test("CP26B.2 Domain B freeze, compatibility SELECT, 0001-0023 untouched", () => {
  const webhook = read("src/routes/api/stripe/webhook.ts");
  const apply = read("src/lib/aether/saas-billing-webhook.ts");
  const billingGet = read("src/lib/aether/saas-billing.server.ts");
  const guest = read("src/lib/aether/guest-payment-fns.ts");
  const payment = read("migrations/0021_cp25_hotel_guest_payments.sql");
  const m23 = read("migrations/0023_cp26a2_entitlement_publication_decoupling.sql");
  const m20 = read("migrations/0020_cp24_stripe_billing.sql");
  const checkout = webhook.slice(webhook.indexOf('if (event.type.startsWith("checkout.session."))'));
  assert.match(checkout, /sbg_apply_payment_event/);
  assert.match(checkout, /booking_id/);
  assert.match(checkout, /payment_id/);
  assert.doesNotMatch(checkout, /sbg_apply_billing_event/);
  assert.doesNotMatch(checkout, /last_stripe_event_created/);
  assert.match(apply, /to_regprocedure/);
  assert.match(apply, /OrderedBillingSchemaError/);
  assert.doesNotMatch(apply, /\$8::timestamptz\)/);
  assert.doesNotMatch(billingGet, /last_stripe_event_created/);
  assert.doesNotMatch(billingGet, /cancel_at_period_end/);
  assert.doesNotMatch(guest, /sbg_apply_billing_event/);
  assert.match(payment, /sbg_apply_payment_event/);
  assert.doesNotMatch(m23, /0024/);
  assert.match(m20, /sbg_apply_billing_event/);
  assert.match(read("migrations/0024_cp26b2_ordered_billing_events.sql"), /bigint/);
  assert.doesNotMatch(read("migrations/0024_cp26b2_ordered_billing_events.sql"), /update\s+hotels/i);
});
