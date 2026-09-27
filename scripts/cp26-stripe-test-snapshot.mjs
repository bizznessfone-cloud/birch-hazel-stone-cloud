#!/usr/bin/env node
/**
 * CP26 STRIPE TEST — read-only Production commercial snapshot.
 * Never migrates. Never writes. Never prints the owner URL or user emails.
 */
import pg from "pg";

function say(line) {
  console.log(line);
}

const url = String(process.env.AETHER_DATABASE_OWNER_URL ?? "").trim();
if (!url) {
  say("BLOCKED — AETHER_DATABASE_OWNER_URL is not configured");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
let began = false;
try {
  await client.query("BEGIN READ ONLY");
  began = true;
  const q = async (text) => (await client.query(text)).rows;

  const identity = (await q("select current_database() as database, current_user, session_user"))[0];
  const ledger = (await q("select name from _migrations order by name")).map((row) => row.name);
  const plans = await q(
    "select code, active from sbg_saas_plans order by sort_order, code",
  );
  const prices = await q(
    `select plan_code, currency, amount_minor, billing_interval, interval_count,
            purchasable, retired_at is not null as retired
       from sbg_saas_price_versions
      order by plan_code, created_at`,
  );
  const mappings = await q(
    `select environment, status, count(*)::int as n
       from sbg_saas_stripe_mappings
      group by environment, status
      order by environment, status`,
  );
  const locks = await q(
    "select live_mapping_enabled, live_checkout_enabled from sbg_saas_commerce_locks where id = 1",
  );
  const counts = (
    await q(`select
      (select count(*)::int from sbg_organisations) as organisations,
      (select count(*)::int from sbg_organisation_members) as organisation_members,
      (select count(*)::int from sbg_organisation_billing) as organisation_billing,
      (select count(*)::int from sbg_property_licence_allocations) as property_allocations,
      (select count(*)::int from hotels where organisation_id is not null) as attached_hotels,
      (select count(*)::int from hotels) as hotels,
      (select count(*)::int from sbg_platform_owners where revoked_at is null) as platform_owners,
      (select count(*)::int from sbg_stripe_events) as stripe_events,
      (select count(*)::int from sbg_booking_payments) as booking_payments`)
  )[0];
  const hotels = await q("select code, status from hotels order by code");

  const payload = {
    database: identity?.database ?? null,
    current_user: identity?.current_user ?? null,
    session_user: identity?.session_user ?? null,
    ledger,
    plans,
    price_versions: prices,
    mappings,
    locks: locks[0] ?? null,
    counts,
    hotels,
  };
  say("CP26 STRIPE TEST SNAPSHOT");
  say(JSON.stringify(payload, null, 2));
} finally {
  if (began) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* read-only rollback */
    }
  }
  client.release();
  await pool.end();
}
