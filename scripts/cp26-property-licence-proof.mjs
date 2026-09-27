#!/usr/bin/env node
/**
 * CP26 property-licence allocation proof.
 * Calls existing SECURITY DEFINER functions only.
 * Does not migrate, does not call Stripe, does not publish hotels,
 * does not write organisation billing, and does not print secrets or user ids.
 *
 * CP26_MODE=reconcile  read-only baseline check
 * CP26_MODE=allocate   create four disposable fixtures, prove allocation, release them
 */
import pg from "pg";

const CONFIRM = "ALLOCATE-CP26-PROPERTY-LICENCE";
const ORG_ID = "4208626a-ef20-4f5a-b28e-0d8b9c778205";
const ORG_NAME = "SBG CP26 Stripe Verification";
const CUSTOMER = "cus_VKwWNaJ4nwUTfM";
const SUBSCRIPTION = "sub_1UKGdCFHnHXHuPOwgswtqBhL";
const PRICE = "price_1UKGWjFHnHXHuPOwO50TJS93";
const PRICE_VERSION = "b13f9445-d27a-4e7d-8128-a2238906ce7c";
const EVENT_ID = "evt_1UKKPiFHnHXHuPOwM7L3ZmoM";
const LOCALITY = "CP26 verification fixture";
const TIMEZONE = "Europe/Athens";
const CURRENCY = "EUR";
const FIXTURES = [
  ["cp26-licence-a", "CP26 Licence A Verification"],
  ["cp26-licence-b", "CP26 Licence B Verification"],
  ["cp26-licence-c", "CP26 Licence C Verification"],
  ["cp26-licence-d", "CP26 Licence D Verification"],
];
const PROTECTED = [
  ["demo-kos", "live"],
  ["gate", "unconfigured"],
  ["harbor", "unconfigured"],
  ["sbg-verify-a5", "configured"],
];
const LEDGER = [
  "0001_auth.sql",
  "0002_foundation.sql",
  "0003_occupancy.sql",
  "0004_ops_auth.sql",
  "0005_time_domain.sql",
  "0006_booking_engine.sql",
  "0007_inventory.sql",
  "0008_guest_ux.sql",
  "0009_ops_desk.sql",
  "0010_hotel_white_label.sql",
  "0011_production_hardening.sql",
  "0012_cp12_tenancy.sql",
  "0013_cp12b_runtime_login.sql",
  "0014_cp13a_production_app_role.sql",
  "0015_cp14_hotel_configuration.sql",
  "0016_cp14_hotel_timezone.sql",
  "0017_cp16_runtime_privilege_hardening.sql",
  "0018_cp22_saas_onboarding.sql",
  "0019_cp23_public_hotel_slug.sql",
  "0020_cp24_stripe_billing.sql",
  "0021_cp25_hotel_guest_payments.sql",
  "0022_cp25g3_better_auth_runtime_privileges.sql",
  "0023_cp26a2_entitlement_publication_decoupling.sql",
  "0024_cp26b2_ordered_billing_events.sql",
  "0025_cp26co2_platform_owners.sql",
  "0026_cp26co3_commercial_catalogue.sql",
  "0027_cp26co41_organisation_property_licence.sql",
  "0028_cp26fin_property_licence_catalogue.sql",
];

function say(line) {
  console.log(line);
}

function fail(message) {
  throw new Error(`BLOCKED — ${message}`);
}

function same(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) fail(`${label} drifted: ${left}`);
}

const mode = String(process.env.CP26_MODE ?? "").trim();
if (!["reconcile", "allocate"].includes(mode)) fail("CP26_MODE must be reconcile or allocate");
if (String(process.env.CP26_CONFIRMATION ?? "") !== CONFIRM) fail("confirmation mismatch");

const url = String(process.env.AETHER_DATABASE_OWNER_URL ?? "").trim();
if (!url) fail("AETHER_DATABASE_OWNER_URL is not configured");

const pool = new pg.Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
let began = false;

function rows(result) {
  return result.rows;
}

async function snapshot(client) {
  const hotels = rows(await client.query("select code, status from hotels order by code"));
  const orgs = rows(await client.query("select id::text, name from sbg_organisations order by created_at"));
  const billing = rows(
    await client.query(
      `select organisation_id::text, stripe_customer_id, stripe_subscription_id, stripe_price_id, status,
              billing_interval, licensed_quantity, price_version_id::text, cancel_at_period_end,
              last_stripe_event_id
         from sbg_organisation_billing`,
    ),
  );
  const locks = rows(
    await client.query(
      "select live_mapping_enabled, live_checkout_enabled from sbg_saas_commerce_locks where id = 1",
    ),
  )[0] ?? null;
  const mappings = rows(
    await client.query(
      `select environment, status, stripe_product_id, stripe_price_id, price_version_id::text
         from sbg_saas_stripe_mappings
        order by created_at`,
    ),
  );
  const counts = rows(
    await client.query(`select
      (select count(*)::int from sbg_organisation_members where removed_at is null) as active_members,
      (select count(*)::int from sbg_property_licence_allocations) as property_allocations,
      (select count(*)::int from sbg_property_licence_allocations where released_at is null) as active_allocations,
      (select count(*)::int from sbg_billing_accounts) as hotel_billing_accounts,
      (select count(*)::int from sbg_stripe_events) as stripe_events,
      (select count(*)::int from sbg_booking_payments) as booking_payments,
      (select count(*)::int from _migrations) as ledger_rows,
      (select count(*)::int from sbg_platform_owners where revoked_at is null) as platform_owners`),
  )[0];
  const ledger = rows(await client.query("select name from _migrations order by name")).map((row) => row.name);
  const events = rows(
    await client.query(
      `select event_id, event_type, outcome, organisation_id::text, hotel_id::text
         from sbg_stripe_events
        order by stripe_created, event_id`,
    ),
  );
  const balance = rows(
    await client.query(
      `select licensed_quantity, active_allocations, available_licences
         from sbg_organisation_licence_balance
        where organisation_id = $1::uuid`,
      [ORG_ID],
    ),
  );
  return { hotels, orgs, billing, locks, mappings, counts, ledger, events, balance };
}

function assertBaseline(proof) {
  same(proof.ledger, LEDGER, "ledger");
  same(proof.counts.ledger_rows, 28, "ledger_rows");
  same(proof.locks, { live_mapping_enabled: false, live_checkout_enabled: false }, "locks");
  same(proof.orgs, [{ id: ORG_ID, name: ORG_NAME }], "organisations");
  same(
    proof.billing,
    [
      {
        organisation_id: ORG_ID,
        stripe_customer_id: CUSTOMER,
        stripe_subscription_id: SUBSCRIPTION,
        stripe_price_id: PRICE,
        status: "active",
        billing_interval: "month",
        licensed_quantity: 3,
        price_version_id: PRICE_VERSION,
        cancel_at_period_end: false,
        last_stripe_event_id: EVENT_ID,
      },
    ],
    "billing",
  );
  same(
    proof.mappings,
    [
      {
        environment: "test",
        status: "verified",
        stripe_product_id: "prod_VKwPfVeu1Q3S21",
        stripe_price_id: PRICE,
        price_version_id: PRICE_VERSION,
      },
    ],
    "mappings",
  );
  same(proof.hotels, PROTECTED.map(([code, status]) => ({ code, status })), "hotels");
  same(proof.counts.property_allocations, 0, "property_allocations");
  same(proof.counts.active_allocations, 0, "active_allocations");
  same(proof.counts.hotel_billing_accounts, 0, "hotel_billing_accounts");
  same(proof.counts.stripe_events, 1, "stripe_events");
  same(proof.counts.active_members, 1, "active_members");
  same(proof.counts.platform_owners, 1, "platform_owners");
  same(
    proof.events,
    [
      {
        event_id: EVENT_ID,
        event_type: "customer.subscription.updated",
        outcome: "applied",
        organisation_id: ORG_ID,
        hotel_id: null,
      },
    ],
    "stripe event",
  );
  same(proof.balance, [{ licensed_quantity: 3, active_allocations: 0, available_licences: 3 }], "balance");
}

async function hotelRow(client, hotelId) {
  const row = rows(
    await client.query(
      `select id::text, code, name, status, organisation_id::text, locality, currency
         from hotels where id = $1::uuid`,
      [hotelId],
    ),
  )[0];
  if (!row) fail("created hotel missing");
  return row;
}

async function balance(client) {
  const row = rows(
    await client.query(
      `select licensed_quantity, active_allocations, available_licences
         from sbg_organisation_licence_balance
        where organisation_id = $1::uuid`,
      [ORG_ID],
    ),
  )[0];
  if (!row) fail("licence balance missing");
  return row;
}

async function allocate(client, actor, hotelId) {
  const row = rows(
    await client.query(
      "select sbg_allocate_property_licence($1, $2::uuid, $3::uuid)::text as id",
      [actor, ORG_ID, hotelId],
    ),
  )[0];
  if (!row?.id) fail("allocation returned no id");
  return row.id;
}

try {
  const identity = rows(await client.query("select current_database() as database, current_user"))[0];
  if (identity?.database !== "neondb" || identity?.current_user !== "neondb_owner") {
    fail("unexpected database identity");
  }

  if (mode === "reconcile") {
    await client.query("BEGIN READ ONLY");
    began = true;
    const proof = await snapshot(client);
    assertBaseline(proof);
    say("CP26 PROPERTY LICENCE RECONCILE");
    say(JSON.stringify({ ok: true, ...proof }, null, 2));
    await client.query("ROLLBACK");
    began = false;
  } else {
    await client.query("BEGIN");
    began = true;
    const before = await snapshot(client);
    assertBaseline(before);
    const domainBBefore = before.counts.booking_payments;

    const members = rows(
      await client.query(
        `select user_id
           from sbg_organisation_members
          where organisation_id = $1::uuid
            and billing_authority
            and removed_at is null`,
        [ORG_ID],
      ),
    );
    if (members.length !== 1 || !members[0]?.user_id) fail("expected exactly one billing member");
    const actor = members[0].user_id;

    const created = [];
    for (const [code, name] of FIXTURES) {
      const inserted = rows(
        await client.query(
          `select hotel_id::text, provider_id::text
             from sbg_create_hotel_for_user($1, $2, $3, $4, $5, $6)`,
          [actor, code, name, LOCALITY, TIMEZONE, CURRENCY],
        ),
      )[0];
      if (!inserted?.hotel_id) fail(`hotel ${code} was not created`);
      const fresh = await hotelRow(client, inserted.hotel_id);
      if (fresh.status !== "unconfigured" || fresh.organisation_id !== null || fresh.code !== code) {
        fail(`hotel ${code} was not created unattached and unconfigured`);
      }
      await client.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
        actor,
        ORG_ID,
        inserted.hotel_id,
      ]);
      const attached = await hotelRow(client, inserted.hotel_id);
      if (attached.status !== "unconfigured" || attached.organisation_id !== ORG_ID) {
        fail(`hotel ${code} attachment changed publication or organisation`);
      }
      created.push({
        code,
        hotel_id: inserted.hotel_id,
        provider_id: inserted.provider_id,
        status: attached.status,
        organisation_id: attached.organisation_id,
      });
    }

    const allocationIds = {};
    for (const key of ["cp26-licence-a", "cp26-licence-b", "cp26-licence-c"]) {
      const hotel = created.find((row) => row.code === key);
      allocationIds[key] = await allocate(client, actor, hotel.hotel_id);
    }
    const full = await balance(client);
    same(full, { licensed_quantity: 3, active_allocations: 3, available_licences: 0 }, "balance after three");

    const spare = created.find((row) => row.code === "cp26-licence-d");
    await client.query("SAVEPOINT over_allocation");
    let rejection = null;
    try {
      await allocate(client, actor, spare.hotel_id);
    } catch (error) {
      rejection = {
        code: error?.code ?? null,
        message: String(error?.message ?? "allocation error").split("\n")[0],
      };
    }
    if (!rejection) fail("fourth allocation was accepted");
    if (rejection.code !== "23514" || !rejection.message.includes("no available property licence")) {
      fail(`fourth allocation failed for an unexpected reason: ${rejection.code} ${rejection.message}`);
    }
    await client.query("ROLLBACK TO SAVEPOINT over_allocation");
    const stillFull = await balance(client);
    same(stillFull, full, "balance after rejected fourth allocation");

    await client.query("select sbg_release_property_licence($1, $2::uuid)", [actor, allocationIds["cp26-licence-a"]]);
    const afterRelease = await balance(client);
    same(afterRelease, { licensed_quantity: 3, active_allocations: 2, available_licences: 1 }, "balance after release");

    allocationIds["cp26-licence-d"] = await allocate(client, actor, spare.hotel_id);
    const reused = await balance(client);
    same(reused, { licensed_quantity: 3, active_allocations: 3, available_licences: 0 }, "balance after spare reuse");

    const mid = await snapshot(client);
    same(mid.billing, before.billing, "billing during proof");
    same(mid.events, before.events, "stripe events during proof");
    same(mid.counts.booking_payments, domainBBefore, "booking payments during proof");
    same(mid.counts.hotel_billing_accounts, 0, "hotel billing during proof");
    same(mid.counts.stripe_events, 1, "stripe event count during proof");
    same(mid.ledger, LEDGER, "ledger during proof");
    same(mid.locks, before.locks, "locks during proof");
    same(mid.orgs, before.orgs, "organisations during proof");
    for (const [code, status] of PROTECTED) {
      const row = mid.hotels.find((hotel) => hotel.code === code);
      if (!row || row.status !== status) fail(`protected hotel ${code} changed`);
    }
    for (const fixture of created) {
      const row = mid.hotels.find((hotel) => hotel.code === fixture.code);
      if (!row || row.status !== "unconfigured") fail(`fixture ${fixture.code} was published`);
    }

    const proofAllocations = rows(
      await client.query(
        `select a.id::text, h.code, a.released_at is not null as released
           from sbg_property_licence_allocations a
           join hotels h on h.id = a.hotel_id
          where a.organisation_id = $1::uuid
          order by h.code`,
        [ORG_ID],
      ),
    );

    const active = rows(
      await client.query(
        `select id::text
           from sbg_property_licence_allocations
          where organisation_id = $1::uuid
            and released_at is null
          order by allocated_at, id`,
        [ORG_ID],
      ),
    );
    for (const row of active) {
      await client.query("select sbg_release_property_licence($1, $2::uuid)", [actor, row.id]);
    }
    const aftercareBalance = await balance(client);
    same(
      aftercareBalance,
      { licensed_quantity: 3, active_allocations: 0, available_licences: 3 },
      "aftercare balance",
    );
    const after = await snapshot(client);
    same(after.billing, before.billing, "billing aftercare");
    same(after.events, before.events, "events aftercare");
    same(after.counts.booking_payments, domainBBefore, "booking payments aftercare");
    same(after.counts.hotel_billing_accounts, 0, "hotel billing aftercare");
    same(after.ledger, LEDGER, "ledger aftercare");
    same(after.locks, before.locks, "locks aftercare");
    for (const [code, status] of PROTECTED) {
      const row = after.hotels.find((hotel) => hotel.code === code);
      if (!row || row.status !== status) fail(`protected hotel ${code} changed during aftercare`);
    }

    await client.query("COMMIT");
    began = false;
    say("CP26 PROPERTY LICENCE ALLOCATE");
    say(
      JSON.stringify(
        {
          ok: true,
          fixtures: created,
          allocations: allocationIds,
          rejection,
          balance_after_three: full,
          balance_after_release: afterRelease,
          balance_after_reuse: reused,
          proof_allocations: proofAllocations,
          aftercare_balance: aftercareBalance,
          aftercare_active_allocations: after.counts.active_allocations,
          hotels: after.hotels,
          billing: after.billing,
          events: after.events,
          counts: after.counts,
          locks: after.locks,
          ledger_rows: after.counts.ledger_rows,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  say(message.startsWith("BLOCKED —") ? message.split("\n")[0] : `BLOCKED — ${message.split("\n")[0]}`);
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
