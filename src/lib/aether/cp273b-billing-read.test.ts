/**
 * CP27.3b — organisation membership before Domain A billing reads.
 * Billing mutations still require billing_authority. No schema change.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Sql } from "@/lib/db";
import { SaasCommerceError } from "./saas-commerce.server.ts";
import { SaasLifecycleError } from "./saas-lifecycle.ts";
import {
  allocatePropertyLicence,
  loadDomainABillingState,
  startDomainACheckout,
  startDomainAPortal,
} from "./saas-billing.server.ts";
import { decideOwnerGate, isPlatformOwner } from "./owner-auth.ts";
import {
  FIXTURE_HOTEL,
  OTHER_USER,
  OWNER_USER,
  PLATFORM_OWNER_USER,
  SECOND_HOTEL,
  ZERO_USER,
  bootstrapPlatformOwner,
  createHotelForUser,
  insertAuthUser,
  onboardConfiguredFixture,
  openCp272PaymentDb,
} from "./cp26a4-fixture.ts";

const SECRET = "cus_cp273b_do_not_leak";
const MISSING_HOTEL = "00000000-0000-4000-8000-000000000000";
const BILLED = /sbg_organisation_billing|sbg_organisation_licence_balance|sbg_stripe_connections|sbg_property_licence_allocations/;

function tracing(pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) {
  const queries: string[] = [];
  const sql = (async () => {
    throw new Error("tagged-template SQL is not used in CP27.3b tests");
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
    queries.push(text);
    return (await pg.query(text, params)).rows as T[];
  };
  return { sql, queries };
}

async function message(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

test("billing reads require current membership and do not bypass hotel ownership", async () => {
  const pg = await openCp272PaymentDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  await insertAuthUser(pg, ZERO_USER);
  await insertAuthUser(pg, PLATFORM_OWNER_USER);
  await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "cp273b");
  const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const bare = await createHotelForUser(pg, OWNER_USER.id, SECOND_HOTEL);
  const org = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, $2)::text as id",
    [OWNER_USER.id, "CP273B Org"],
  );
  const organisationId = org.rows[0]!.id;
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    OWNER_USER.id,
    organisationId,
    fixture.hotelId,
  ]);
  await pg.query(
    `insert into sbg_organisation_billing (
       organisation_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status, licensed_quantity
     ) values ($1::uuid, $2, 'sub_cp273b', 'price_cp273b', 'active', 3)`,
    [organisationId, SECRET],
  );
  await pg.query("insert into app_hotel_accounts (user_id, hotel_id) values ($1, $2::uuid), ($3, $2::uuid)", [
    OTHER_USER.id,
    fixture.hotelId,
    ZERO_USER.id,
  ]);
  await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'member', false)", [
    OWNER_USER.id,
    organisationId,
    OTHER_USER.id,
  ]);
  await pg.query("select sbg_create_organisation_for_user($1, $2)::text as id", [ZERO_USER.id, "Other Org"]);

  const { sql, queries } = tracing(pg);

  queries.length = 0;
  const billingMember = await loadDomainABillingState(sql, OWNER_USER.id, fixture.hotelId);
  assert.equal(billingMember.billing?.stripe_customer_id, SECRET);
  assert.equal(billingMember.organisationId, organisationId);
  assert.ok(queries.some((query) => query.includes("sbg_organisation_members")));
  assert.ok(queries.some((query) => query.includes("sbg_organisation_billing")));

  queries.length = 0;
  const reader = await loadDomainABillingState(sql, OTHER_USER.id, fixture.hotelId);
  assert.equal(reader.billing?.stripe_customer_id, SECRET);
  assert.equal(reader.licensedQuantity, 3);
  assert.ok(queries.some((query) => query.includes("sbg_organisation_members")));

  const bareState = await loadDomainABillingState(sql, OWNER_USER.id, bare.hotelId);
  assert.equal(bareState.organisationId, null);
  assert.equal(bareState.billing, null);

  queries.length = 0;
  const foreign = await message(() => loadDomainABillingState(sql, PLATFORM_OWNER_USER.id, fixture.hotelId));
  assert.equal(foreign, "Hotel not found.");
  assert.equal(queries.some((query) => BILLED.test(query)), false);
  assert.equal(queries.some((query) => query.includes("sbg_organisation_members")), false);
  assert.equal(foreign.includes(SECRET), false);

  queries.length = 0;
  const missing = await message(() => loadDomainABillingState(sql, OWNER_USER.id, MISSING_HOTEL));
  assert.equal(missing, "Hotel not found.");
  assert.equal(missing, foreign);
  assert.equal(queries.some((query) => query.includes("from hotels")), false);
  assert.equal(queries.some((query) => BILLED.test(query)), false);

  queries.length = 0;
  const neverMember = await message(() => loadDomainABillingState(sql, ZERO_USER.id, fixture.hotelId));
  assert.equal(neverMember, "Hotel not found.");
  assert.equal(neverMember, foreign);
  assert.equal(queries.some((query) => BILLED.test(query)), false);
  assert.equal(neverMember.includes(SECRET), false);
  assert.ok(queries.some((query) => query.includes("app_hotel_accounts")));
  assert.ok(queries.some((query) => query.includes("sbg_organisation_members")));

  await pg.query("select sbg_remove_organisation_member($1, $2::uuid, $3)", [
    OWNER_USER.id,
    organisationId,
    OTHER_USER.id,
  ]);
  const removedRow = await pg.query<{ removed_at: string | null }>(
    `select removed_at::text as removed_at
       from sbg_organisation_members
      where organisation_id = $1::uuid and user_id = $2`,
    [organisationId, OTHER_USER.id],
  );
  assert.ok(removedRow.rows[0]?.removed_at);
  const stillOwns = await pg.query<{ ok: number }>(
    "select 1 as ok from app_hotel_accounts where user_id = $1 and hotel_id = $2::uuid",
    [OTHER_USER.id, fixture.hotelId],
  );
  assert.ok(stillOwns.rows[0]);

  queries.length = 0;
  const removed = await message(() => loadDomainABillingState(sql, OTHER_USER.id, fixture.hotelId));
  assert.equal(removed, "Hotel not found.");
  assert.equal(removed, foreign);
  assert.equal(queries.some((query) => BILLED.test(query)), false);
  assert.equal(removed.includes(SECRET), false);

  const ownerStill = await loadDomainABillingState(sql, OWNER_USER.id, fixture.hotelId);
  assert.equal(ownerStill.billing?.stripe_customer_id, SECRET);

  const checkoutDenied = await message(() =>
    startDomainACheckout({
      db: sql,
      userId: ZERO_USER.id,
      organisationId,
      quantity: 1,
      origin: "https://scan-book-go.vercel.app",
    }),
  );
  assert.equal(checkoutDenied, "Organisation billing authority required.");
  await assert.rejects(
    () =>
      startDomainACheckout({
        db: sql,
        userId: OWNER_USER.id,
        organisationId,
        quantity: 1,
        origin: "https://scan-book-go.vercel.app",
      }),
    (error: unknown) => error instanceof SaasLifecycleError && error.code === "subscription_exists",
  );
  const portalDenied = await message(() =>
    startDomainAPortal({
      db: sql,
      userId: OTHER_USER.id,
      organisationId,
      origin: "https://scan-book-go.vercel.app",
    }),
  );
  assert.equal(portalDenied, "Organisation billing authority required.");
  await assert.rejects(
    () =>
      startDomainAPortal({
        db: sql,
        userId: OWNER_USER.id,
        organisationId,
        origin: "https://scan-book-go.vercel.app",
      }),
    (error: unknown) => error instanceof SaasCommerceError,
  );

  const allocateDenied = await message(() =>
    allocatePropertyLicence({
      db: sql,
      userId: OTHER_USER.id,
      organisationId,
      hotelId: fixture.hotelId,
    }),
  );
  assert.match(allocateDenied, /billing authority/i);
  const allocated = await allocatePropertyLicence({
    db: sql,
    userId: OWNER_USER.id,
    organisationId,
    hotelId: fixture.hotelId,
  });
  assert.match(allocated.id, /^[0-9a-f-]{36}$/i);

  assert.equal(await isPlatformOwner(sql, PLATFORM_OWNER_USER.id), true);
  assert.equal(await isPlatformOwner(sql, OWNER_USER.id), false);
  assert.deepEqual(decideOwnerGate({ hasSession: true, hasGrant: true }), { ok: true });
  assert.equal(foreign, "Hotel not found.");

  const root = process.cwd();
  const billing = readFileSync(join(root, "src/lib/aether/saas-billing.server.ts"), "utf8");
  const owner = readFileSync(join(root, "src/lib/aether/owner-auth.ts"), "utf8");
  const ops = readFileSync(join(root, "src/lib/aether/ops-auth.ts"), "utf8");
  const booking = readFileSync(join(root, "src/lib/aether/booking.server.ts"), "utf8");
  const domainB = readFileSync(join(root, "src/lib/aether/domain-b-live.ts"), "utf8");
  const commerce = readFileSync(join(root, "src/lib/aether/saas-commerce.server.ts"), "utf8");
  assert.match(billing, /await ownedHotel\(db, userId, hotelId\)/);
  assert.match(billing, /assertCurrentOrganisationMember/);
  assert.match(billing, /Organisation billing authority required\./);
  assert.doesNotMatch(billing, /sbg_platform_owners/);
  assert.match(owner, /from sbg_platform_owners/);
  assert.match(ops, /"invalid_credentials"/);
  assert.match(booking, /guestLimiterIdentity/);
  assert.doesNotMatch(booking, /split\(","\)\[0\]/);
  assert.match(domainB, /=== "true"/);
  assert.match(commerce, /mode === "live"/);
  assert.doesNotMatch(commerce, /SBG_DOMAIN_B_LIVE_CHECKOUT/);
});
