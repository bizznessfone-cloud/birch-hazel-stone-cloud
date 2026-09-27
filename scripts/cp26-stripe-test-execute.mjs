#!/usr/bin/env node
/**
 * CP26 STRIPE TEST — owner-plane catalogue, mapping, and organisation fixture.
 * Does not migrate. Does not touch hotels.status. Does not enable live locks.
 * Does not print the owner URL, webhook secrets, or user emails.
 *
 * Modes (CP26_MODE):
 *   apply          create+activate one property_licence version, record the TEST mapping, create the organisation
 *   checkout-plan  run startDomainACheckout and print the Stripe form (no live HTTP)
 *   verify         read-only commercial proof
 */
import pg from "pg";

const CONFIRM = "APPLY-CP26-STRIPE-TEST";
const ORG_NAME = "SBG CP26 Stripe Verification";

function say(line) {
  console.log(line);
}

function fail(message) {
  say(`BLOCKED — ${message}`);
  process.exit(1);
}

function parseEurMajorToMinor(input) {
  const raw = String(input ?? "").trim();
  if (!raw || /[eE+]/.test(raw) || raw.includes(",") || raw.startsWith("-")) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;
  const whole = match[1] ?? "";
  const frac = match[2] ?? "";
  if (whole.length > 1 && whole.startsWith("0")) return null;
  if (frac.length > 2) return null;
  const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > 2_147_483_647) return null;
  return minor;
}

function assertStripeId(value, prefix) {
  const id = String(value ?? "").trim();
  if (!new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id)) fail(`invalid ${prefix} id`);
  return id;
}

const mode = String(process.env.CP26_MODE ?? "").trim();
if (!["apply", "checkout-plan", "verify"].includes(mode)) fail("CP26_MODE must be apply, checkout-plan, or verify");
if (String(process.env.CP26_CONFIRMATION ?? "") !== CONFIRM) fail("confirmation mismatch");

const url = String(process.env.AETHER_DATABASE_OWNER_URL ?? "").trim();
if (!url) fail("AETHER_DATABASE_OWNER_URL is not configured");

const pool = new pg.Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
let began = false;

function rows(result) {
  return result.rows;
}

try {
  const identity = rows(await client.query("select current_database() as database, current_user"))[0];
  if (identity?.database !== "neondb" || identity?.current_user !== "neondb_owner") {
    fail("unexpected database identity");
  }

  if (mode === "verify") {
    await client.query("BEGIN READ ONLY");
    began = true;
    const payload = await readProof(client);
    say("CP26 STRIPE TEST VERIFY");
    say(JSON.stringify(payload, null, 2));
  } else if (mode === "apply") {
    const minor = parseEurMajorToMinor(process.env.CP26_PRICE_MAJOR);
    if (minor == null) fail("CP26_PRICE_MAJOR is not a valid EUR major amount");
    const productId = assertStripeId(process.env.CP26_STRIPE_PRODUCT_ID, "prod");
    const priceId = assertStripeId(process.env.CP26_STRIPE_PRICE_ID, "price");
    await client.query("BEGIN");
    began = true;
    const before = await readGuards(client);
    if (before.price_versions !== 0) fail("price versions already exist");
    if (before.mappings !== 0) fail("stripe mappings already exist");
    if (before.organisations !== 0) fail("organisations already exist");
    if (before.locks?.live_mapping_enabled !== false || before.locks?.live_checkout_enabled !== false) {
      fail("live locks are not false");
    }
    if (before.platform_owners !== 1) fail("expected exactly one platform owner");
    if (before.attached_hotels !== 0) fail("hotels are already attached");
    const hotelsBefore = JSON.stringify(before.hotels);

    const owner = rows(
      await client.query(
        "select user_id from sbg_platform_owners where revoked_at is null",
      ),
    );
    if (owner.length !== 1 || !owner[0]?.user_id) fail("platform owner row missing");
    const actor = owner[0].user_id;

    const created = rows(
      await client.query(
        `select sbg_catalogue_create_price_version($1, 'property_licence', $2::integer, 'EUR', 'month', 1::smallint)::text as id`,
        [actor, minor],
      ),
    );
    const versionId = created[0]?.id;
    if (!versionId) fail("price version was not created");
    await client.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [actor, versionId]);
    const mapping = rows(
      await client.query(
        `select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', $3, $4)::text as id`,
        [actor, versionId, productId, priceId],
      ),
    );
    const organisation = rows(
      await client.query(
        "select sbg_create_organisation_for_user($1, $2)::text as id",
        [actor, ORG_NAME],
      ),
    );
    const organisationId = organisation[0]?.id;
    if (!organisationId || !mapping[0]?.id) fail("organisation or mapping was not created");

    const resolved = rows(
      await client.query(
        "select sbg_resolve_domain_a_checkout_price('property_licence', 'test') as price_id",
      ),
    );
    if (resolved[0]?.price_id !== priceId) fail("resolved TEST price does not match the mapped price");

    const after = await readGuards(client);
    if (JSON.stringify(after.hotels) !== hotelsBefore) fail("hotel rows changed");
    if (after.locks?.live_mapping_enabled !== false || after.locks?.live_checkout_enabled !== false) {
      fail("live locks changed");
    }
    const versions = rows(
      await client.query(
        `select plan_code, currency, amount_minor, billing_interval, interval_count, purchasable,
                retired_at is null as open
           from sbg_saas_price_versions`,
      ),
    );
    if (versions.length !== 1 || versions[0].plan_code !== "property_licence" || versions[0].purchasable !== true) {
      fail("expected exactly one purchasable property_licence version");
    }
    if (Number(versions[0].amount_minor) !== minor) fail("stored amount does not match the parsed major amount");

    await client.query("COMMIT");
    began = false;
    say("CP26 STRIPE TEST APPLY");
    say(JSON.stringify({
      price_version_id: versionId,
      amount_minor: Number(versions[0].amount_minor),
      currency: versions[0].currency,
      billing_interval: versions[0].billing_interval,
      interval_count: versions[0].interval_count,
      purchasable: versions[0].purchasable,
      mapping_id: mapping[0].id,
      mapping_environment: "test",
      stripe_product_id: productId,
      stripe_price_id: priceId,
      resolved_price_id: resolved[0].price_id,
      organisation_id: organisationId,
      organisation_name: ORG_NAME,
      live_mapping_enabled: false,
      live_checkout_enabled: false,
      hotels_unchanged: true,
    }, null, 2));
  } else if (mode === "checkout-plan") {
    await client.query("BEGIN READ ONLY");
    began = true;
    const priceId = assertStripeId(process.env.CP26_STRIPE_PRICE_ID, "price");
    const quantity = Number(process.env.CP26_QUANTITY);
    const org = rows(
      await client.query("select id::text as id, name from sbg_organisations"),
    );
    if (org.length !== 1 || org[0].name !== ORG_NAME) fail("expected the single CP26 test organisation");
    const member = rows(
      await client.query(
        `select user_id from sbg_organisation_members
          where organisation_id = $1::uuid and billing_authority and removed_at is null`,
        [org[0].id],
      ),
    );
    if (member.length !== 1) fail("expected one billing authority");
    const resolved = rows(
      await client.query(
        "select sbg_resolve_domain_a_checkout_price('property_licence', 'test') as price_id",
      ),
    );
    if (resolved[0]?.price_id !== priceId) fail("TEST checkout price is not the mapped price");

    process.env.SBG_SAAS_COMMERCE = "test";
    process.env.SBG_SAAS_TEST_ORGANISATION_IDS = org[0].id;
    process.env.STRIPE_SECRET_KEY = `sk_test_${"cp26plan".padEnd(20, "0")}`;
    const captured = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const href = String(input);
      if (href.startsWith("https://api.stripe.com/")) {
        const rawBody =
          typeof init?.body === "string"
            ? init.body
            : init?.body instanceof URLSearchParams
              ? init.body.toString()
              : "";
        const params = new URLSearchParams(rawBody);
        captured.push({
          path: href.slice("https://api.stripe.com".length),
          params: Object.fromEntries(params.entries()),
        });
        return new Response(
          JSON.stringify({
            id: "cs_test_plan_only",
            url: "https://checkout.stripe.com/c/pay/cs_test_plan_only",
            livemode: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    };

    const { startDomainACheckout } = await import("../src/lib/aether/saas-billing.server.ts");
    const db = {
      query: async (text, params = []) => rows(await client.query(text, params)),
    };
    const result = await startDomainACheckout({
      db,
      userId: member[0].user_id,
      organisationId: org[0].id,
      quantity,
      origin: "https://scan-book-go.vercel.app",
    });
    globalThis.fetch = originalFetch;
    if (captured.length !== 1 || captured[0].path !== "/v1/checkout/sessions") {
      fail("application did not build exactly one Checkout request");
    }
    say("CP26 STRIPE TEST CHECKOUT PLAN");
    say(JSON.stringify({
      organisation_id: org[0].id,
      quantity: result.quantity,
      checkout_url_is_plan_placeholder: result.url.includes("cs_test_plan_only"),
      request: captured[0],
    }, null, 2));
  }
} catch (error) {
  if (began) {
    try {
      await client.query("ROLLBACK");
      began = false;
    } catch {
      /* already failed */
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("BLOCKED —")) {
    say(message);
  } else {
    say(`BLOCKED — ${message}`);
  }
  process.exitCode = 1;
} finally {
  if (began) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* closed */
    }
  }
  client.release();
  await pool.end();
}

async function readGuards(client) {
  const counts = rows(
    await client.query(`select
      (select count(*)::int from sbg_saas_price_versions) as price_versions,
      (select count(*)::int from sbg_saas_stripe_mappings) as mappings,
      (select count(*)::int from sbg_organisations) as organisations,
      (select count(*)::int from sbg_platform_owners where revoked_at is null) as platform_owners,
      (select count(*)::int from hotels where organisation_id is not null) as attached_hotels`),
  )[0];
  const locks = rows(
    await client.query(
      "select live_mapping_enabled, live_checkout_enabled from sbg_saas_commerce_locks where id = 1",
    ),
  )[0] ?? null;
  const hotels = rows(await client.query("select code, status from hotels order by code"));
  return { ...counts, locks, hotels };
}

async function readProof(client) {
  const guards = await readGuards(client);
  const plans = rows(await client.query("select code, active from sbg_saas_plans order by sort_order, code"));
  const versions = rows(
    await client.query(
      `select id::text, plan_code, currency, amount_minor, billing_interval, interval_count, purchasable,
              retired_at is not null as retired
         from sbg_saas_price_versions
        order by created_at`,
    ),
  );
  const mappings = rows(
    await client.query(
      `select id::text, environment, status, stripe_product_id, stripe_price_id, price_version_id::text
         from sbg_saas_stripe_mappings
        order by created_at`,
    ),
  );
  const orgs = rows(await client.query("select id::text, name from sbg_organisations order by created_at"));
  const billing = rows(
    await client.query(
      `select organisation_id::text, stripe_customer_id, stripe_subscription_id, stripe_price_id, status,
              billing_interval, licensed_quantity, price_version_id::text, cancel_at_period_end,
              last_stripe_event_id
         from sbg_organisation_billing`,
    ),
  );
  const counts = rows(
    await client.query(`select
      (select count(*)::int from sbg_organisation_members) as organisation_members,
      (select count(*)::int from sbg_property_licence_allocations) as property_allocations,
      (select count(*)::int from sbg_billing_accounts) as hotel_billing_accounts,
      (select count(*)::int from sbg_stripe_events) as stripe_events,
      (select count(*)::int from sbg_booking_payments) as booking_payments,
      (select count(*)::int from _migrations) as ledger_rows`),
  )[0];
  const ledger = rows(await client.query("select name from _migrations order by name")).map((row) => row.name);
  return { ...guards, plans, versions, mappings, orgs, billing, counts, ledger };
}
