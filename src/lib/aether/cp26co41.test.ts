/**
 * CP26C-O4.1 — organisation and property-licence persistence.
 * PGLite only. No Production, no Stripe API, no price version, no commerce change.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { saasCommerceMode } from "./saas-commerce.server.ts";
import {
  FIXTURE_HOTEL,
  OTHER_USER,
  OWNER_USER,
  SECOND_HOTEL,
  ZERO_USER,
  createHotelForUser,
  insertAuthUser,
  openCp26cO41Db,
} from "./cp26a4-fixture.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const MIGRATION = "0027_cp26co41_organisation_property_licence.sql";
const DIGEST_0026 = "4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446";

const THIRD_HOTEL = {
  code: "sbg-test-patmos",
  name: "SBG Test Patmos [TEST]",
  locality: "Patmos, Greece",
  ianaTimezone: "Europe/Athens",
  currency: "EUR",
};

function walkSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkSources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

async function rejects(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(run, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, pattern);
    return true;
  });
}

async function rows<T>(pg: PGlite, text: string, params?: unknown[]): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

async function one<T>(pg: PGlite, text: string, params?: unknown[]): Promise<T> {
  const result = await rows<T>(pg, text, params);
  assert.equal(result.length, 1);
  return result[0]!;
}

test("0027 is source-only, unauthorised, and does not cut over runtime", () => {
  const sql = read(`migrations/${MIGRATION}`);
  const files = readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(files.filter((name) => name.startsWith("0027")).join(","), MIGRATION);
  assert.equal(
    createHash("sha256").update(read("migrations/0026_cp26co3_commercial_catalogue.sql")).digest("hex"),
    DIGEST_0026,
  );
  const preflight = read("scripts/production-db-preflight.mjs");
  assert.match(preflight, /AUTHORISED_PENDING = \[\]/);
  assert.equal(preflight.includes(MIGRATION), false);
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+function\s+sbg_apply_billing_event/i);
  assert.doesNotMatch(sql, /drop\s+function\s+if\s+exists\s+sbg_apply_billing_event/i);
  assert.doesNotMatch(sql, /sbg_booking_payments|sbg_stripe_connections|sbg_prepare_booking/);
  assert.doesNotMatch(sql, /insert\s+into\s+sbg_saas_/i);
  assert.doesNotMatch(sql, /sbg_catalogue_/);
  assert.doesNotMatch(sql, /\b(basic|pro|premium)\b/);
  assert.doesNotMatch(sql, /179|€/);
  assert.doesNotMatch(sql, /update\s+hotels\s+set\s+status/i);
  assert.doesNotMatch(sql, /set\s+status\s*=\s*'live'/i);
  assert.match(sql, /set organisation_id = p_organisation_id/);
  assert.equal(saasCommerceMode({}), "off");

  const needles = [
    "sbg_create_organisation_for_user",
    "sbg_apply_organisation_billing_event",
    "sbg_allocate_property_licence",
    "sbg_attach_hotel_to_organisation",
  ];
  const hits = walkSources(join(root, "src")).filter((path) => {
    const text = readFileSync(path, "utf8");
    return needles.some((needle) => text.includes(needle));
  });
  assert.deepEqual(hits, []);
});

test("organisation persistence keeps hotels, licences, publication and Domain B apart", async () => {
  const pg = await openCp26cO41Db();
  const attachedBefore = await one<{ n: number }>(
    pg,
    "select count(*)::int as n from hotels where organisation_id is not null",
  );
  assert.equal(attachedBefore.n, 0);

  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  await insertAuthUser(pg, ZERO_USER);

  const orgA = await one<{ id: string }>(
    pg,
    "select sbg_create_organisation_for_user($1, $2) as id",
    [OWNER_USER.id, "Alpha"],
  );
  const orgB = await one<{ id: string }>(
    pg,
    "select sbg_create_organisation_for_user($1, $2) as id",
    [OTHER_USER.id, "Beta"],
  );
  assert.equal(
    (await one<{ n: number }>(pg, "select count(*)::int as n from hotels where organisation_id is not null")).n,
    0,
  );

  const hotelA = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const hotelB = await createHotelForUser(pg, OWNER_USER.id, SECOND_HOTEL);
  const hotelC = await createHotelForUser(pg, OWNER_USER.id, THIRD_HOTEL);
  const statusBefore = await rows<{ id: string; status: string; organisation_id: string | null }>(
    pg,
    "select id, status, organisation_id from hotels order by id",
  );

  await rejects(
    () =>
      pg.query("select sbg_attach_hotel_to_organisation($1, $2, $3)", [
        OTHER_USER.id,
        orgB.id,
        hotelA.hotelId,
      ]),
    /hotel is not owned by account/,
  );
  await rejects(
    () =>
      pg.query("select sbg_attach_hotel_to_organisation($1, $2, $3)", [
        OWNER_USER.id,
        orgB.id,
        hotelA.hotelId,
      ]),
    /organisation billing authority required/,
  );

  await pg.query("select sbg_attach_hotel_to_organisation($1, $2, $3)", [
    OWNER_USER.id,
    orgA.id,
    hotelA.hotelId,
  ]);
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2, $3)", [
    OWNER_USER.id,
    orgA.id,
    hotelB.hotelId,
  ]);

  const seeded = await rows<{ code: string; organisation_id: string | null; status: string }>(
    pg,
    "select code, organisation_id, status from hotels where code in ('gate', 'harbor') order by code",
  );
  assert.equal(seeded.length, 2);
  assert.ok(seeded.every((row) => row.organisation_id === null));

  await pg.query(
    `insert into hotel_destinations (hotel_id, kind, name, amount_minor)
     values ($1, 'airport', 'O41 Preserve Airport', 4500)`,
    [hotelA.hotelId],
  );
  const booking = await one<{ id: string }>(
    pg,
    `insert into bookings (
       hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
       guest_name, guest_phone, guest_email, pickup_text, destination_text,
       human_reference, confirmation_token
     ) values (
       $1, $2, '2026-06-15', '09:00', 60,
       'Preserve Guest', '+300000000', 'preserve@sbg.test', 'Hotel', 'Airport',
       'O41-REF', 'o41-token'
     ) returning id`,
    [hotelA.hotelId, hotelA.providerId],
  );
  await pg.query(
    `insert into sbg_booking_payments (booking_id, amount_minor, currency)
     values ($1, 4500, 'EUR')`,
    [booking.id],
  );
  await pg.query(
    "insert into audit_events (actor_type, action, booking_id) values ('test', 'o41.preserve', $1)",
    [booking.id],
  );

  const applied = await one<{ outcome: string }>(
    pg,
    `select sbg_apply_organisation_billing_event(
       $1, 'customer.subscription.updated', $2::bigint, $3, $4, $5, $6,
       'active', '2026-10-01T00:00:00Z'::timestamptz, false, $7::int, 'month', null
     ) as outcome`,
    ["evt_o41_1", 100, orgA.id, "cus_o41_org", "sub_o41_org", "price_o41_synth", 1],
  );
  assert.equal(applied.outcome, "applied");

  const allocationA = await one<{ id: string }>(
    pg,
    "select sbg_allocate_property_licence($1, $2, $3) as id",
    [OWNER_USER.id, orgA.id, hotelA.hotelId],
  );
  await rejects(
    () =>
      pg.query("select sbg_allocate_property_licence($1, $2, $3)", [
        OWNER_USER.id,
        orgA.id,
        hotelB.hotelId,
      ]),
    /no available property licence/,
  );

  await pg.query("select sbg_add_organisation_member($1, $2, $3, $4, $5)", [
    OWNER_USER.id,
    orgA.id,
    OTHER_USER.id,
    "dispatcher",
    false,
  ]);
  await rejects(
    () => pg.query("select sbg_add_organisation_member($1, $2, $3, $4, $5)", [
      OWNER_USER.id,
      orgA.id,
      ZERO_USER.id,
      "Billing",
      false,
    ]),
    /invalid organisation membership/,
  );
  await pg.query("select sbg_add_organisation_member($1, $2, $3, $4, $5)", [
    OWNER_USER.id,
    orgA.id,
    ZERO_USER.id,
    "regional_lead",
    true,
  ]);
  const balanceAfterMembers = await one<{ licensed_quantity: number; active_allocations: number; available_licences: number }>(
    pg,
    "select licensed_quantity, active_allocations, available_licences from sbg_organisation_licence_balance where organisation_id = $1",
    [orgA.id],
  );
  assert.deepEqual(balanceAfterMembers, {
    licensed_quantity: 1,
    active_allocations: 1,
    available_licences: 0,
  });
  await rejects(
    () =>
      pg.query("select sbg_allocate_property_licence($1, $2, $3)", [
        OTHER_USER.id,
        orgA.id,
        hotelB.hotelId,
      ]),
    /organisation billing authority required/,
  );
  await rejects(
    () =>
      pg.query("select sbg_allocate_property_licence($1, $2, $3)", [
        OTHER_USER.id,
        orgB.id,
        hotelA.hotelId,
      ]),
    /organisation billing authority required|property is not attached/,
  );

  await pg.query("select sbg_release_property_licence($1, $2)", [OWNER_USER.id, allocationA.id]);
  const released = await one<{ released_at: string | null; hotel_id: string }>(
    pg,
    "select released_at::text, hotel_id from sbg_property_licence_allocations where id = $1",
    [allocationA.id],
  );
  assert.ok(released.released_at);
  assert.equal(released.hotel_id, hotelA.hotelId);
  assert.equal(
    (await one<{ n: number }>(pg, "select count(*)::int as n from hotels where id = $1", [hotelA.hotelId])).n,
    1,
  );
  assert.equal(
    (await one<{ n: number }>(pg, "select count(*)::int as n from bookings where id = $1", [booking.id])).n,
    1,
  );
  assert.equal(
    (await one<{ amount_minor: number }>(
      pg,
      "select amount_minor from hotel_destinations where hotel_id = $1",
      [hotelA.hotelId],
    )).amount_minor,
    4500,
  );
  assert.equal(
    (await one<{ n: number }>(pg, "select count(*)::int as n from sbg_booking_payments")).n,
    1,
  );
  assert.equal(
    (await one<{ n: number }>(pg, "select count(*)::int as n from audit_events where action = 'o41.preserve'")).n,
    1,
  );

  const allocationB = await one<{ id: string }>(
    pg,
    "select sbg_allocate_property_licence($1, $2, $3) as id",
    [ZERO_USER.id, orgA.id, hotelB.hotelId],
  );
  assert.ok(allocationB.id);

  const reduced = await one<{ outcome: string }>(
    pg,
    `select sbg_apply_organisation_billing_event(
       $1, 'customer.subscription.updated', 110::bigint, $2, 'cus_o41_org', 'sub_o41_org', 'price_o41_synth',
       'active', '2026-10-01T00:00:00Z'::timestamptz, false, 0, 'month', null
     ) as outcome`,
    ["evt_o41_reduce", orgA.id],
  );
  assert.equal(reduced.outcome, "applied");
  const breached = await one<{ licensed_quantity: number; active_allocations: number; available_licences: number }>(
    pg,
    "select licensed_quantity, active_allocations, available_licences from sbg_organisation_licence_balance where organisation_id = $1",
    [orgA.id],
  );
  assert.deepEqual(breached, {
    licensed_quantity: 0,
    active_allocations: 1,
    available_licences: -1,
  });
  assert.equal(
    (await one<{ n: number }>(
      pg,
      "select count(*)::int as n from sbg_property_licence_allocations where id = $1 and released_at is null",
      [allocationB.id],
    )).n,
    1,
  );
  await rejects(
    () =>
      pg.query("select sbg_allocate_property_licence($1, $2, $3)", [
        OWNER_USER.id,
        orgA.id,
        hotelA.hotelId,
      ]),
    /no available property licence/,
  );

  const stale = await one<{ outcome: string }>(
    pg,
    `select sbg_apply_organisation_billing_event(
       'evt_o41_stale', 'customer.subscription.updated', 90::bigint, $1, 'cus_o41_org', 'sub_o41_org', null,
       'active', null, false, 9, 'month', null
     ) as outcome`,
    [orgA.id],
  );
  assert.equal(stale.outcome, "stale");
  const ambiguous = await one<{ outcome: string }>(
    pg,
    `select sbg_apply_organisation_billing_event(
       'evt_o41_ambiguous', 'customer.subscription.updated', 110::bigint, $1, 'cus_o41_org', 'sub_o41_org', null,
       'active', null, false, 9, 'month', null
     ) as outcome`,
    [orgA.id],
  );
  assert.equal(ambiguous.outcome, "ambiguous");
  const duplicate = await one<{ outcome: string }>(
    pg,
    `select sbg_apply_organisation_billing_event(
       'evt_o41_reduce', 'customer.subscription.updated', 110::bigint, $1, 'cus_o41_org', 'sub_o41_org', null,
       'canceled', null, true, 4, 'month', null
     ) as outcome`,
    [orgA.id],
  );
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(
    (await one<{ licensed_quantity: number; status: string }>(
      pg,
      "select licensed_quantity, status from sbg_organisation_billing where organisation_id = $1",
      [orgA.id],
    )).licensed_quantity,
    0,
  );

  const secondSub = await one<{ outcome: string }>(
    pg,
    `select sbg_apply_organisation_billing_event(
       'evt_o41_second', 'customer.subscription.updated', 120::bigint, $1, 'cus_o41_org', 'sub_o41_other', null,
       'active', null, false, 3, 'month', null
     ) as outcome`,
    [orgA.id],
  );
  assert.equal(secondSub.outcome, "rejected");
  assert.equal(
    (await one<{ stripe_subscription_id: string }>(
      pg,
      "select stripe_subscription_id from sbg_organisation_billing where organisation_id = $1",
      [orgA.id],
    )).stripe_subscription_id,
    "sub_o41_org",
  );

  const missingPrice = await one<{ outcome: string }>(
    pg,
    `select sbg_apply_organisation_billing_event(
       'evt_o41_price', 'customer.subscription.updated', 130::bigint, $1, 'cus_o41_org', 'sub_o41_org', null,
       'active', null, false, 1, 'month', '00000000-0000-4000-8000-000000000041'::uuid
     ) as outcome`,
    [orgA.id],
  );
  assert.equal(missingPrice.outcome, "rejected");
  assert.equal(
    (await one<{ n: number }>(pg, "select count(*)::int as n from sbg_saas_price_versions")).n,
    0,
  );
  const plans = await rows<{ code: string; active: boolean }>(
    pg,
    "select code, active from sbg_saas_plans order by code",
  );
  assert.deepEqual(plans, [
    { code: "basic", active: true },
    { code: "premium", active: true },
    { code: "pro", active: true },
  ]);

  const hotelApply = await one<{ outcome: string }>(
    pg,
    `select sbg_apply_billing_event(
       'evt_o41_hotel', 'customer.subscription.updated', 50::bigint, $1::uuid,
       'cus_o41_hotel', 'sub_o41_hotel', 'price_o41_hotel', 'active',
       '2026-10-01T00:00:00Z'::timestamptz, false
     ) as outcome`,
    [hotelC.hotelId],
  );
  assert.equal(hotelApply.outcome, "applied");
  const collided = await one<{ outcome: string }>(
    pg,
    `select sbg_apply_organisation_billing_event(
       'evt_o41_collide', 'customer.subscription.updated', 140::bigint, $1, 'cus_o41_hotel', 'sub_o41_org', null,
       'active', null, false, 1, 'month', null
     ) as outcome`,
    [orgA.id],
  );
  assert.equal(collided.outcome, "rejected");
  await rejects(
    () =>
      pg.query(
        `update sbg_billing_accounts
            set stripe_customer_id = 'cus_o41_org'
          where hotel_id = $1`,
        [hotelC.hotelId],
      ),
    /stripe customer already belongs to an organisation/,
  );
  assert.equal(
    (await one<{ stripe_customer_id: string }>(
      pg,
      "select stripe_customer_id from sbg_billing_accounts where hotel_id = $1",
      [hotelC.hotelId],
    )).stripe_customer_id,
    "cus_o41_hotel",
  );

  await rejects(
    () => pg.query("delete from sbg_property_licence_allocations where id = $1", [allocationB.id]),
    /cannot be deleted/,
  );
  await rejects(
    () => pg.query("delete from sbg_organisation_members where organisation_id = $1", [orgA.id]),
    /cannot be deleted/,
  );
  await pg.query("select sbg_remove_organisation_member($1, $2, $3)", [
    OWNER_USER.id,
    orgA.id,
    OTHER_USER.id,
  ]);
  const removed = await one<{ removed_at: string | null }>(
    pg,
    `select removed_at::text from sbg_organisation_members
      where organisation_id = $1 and user_id = $2`,
    [orgA.id, OTHER_USER.id],
  );
  assert.ok(removed.removed_at);
  assert.equal(
    (await one<{ n: number }>(pg, `select count(*)::int as n from "user" where id = $1`, [OTHER_USER.id])).n,
    1,
  );

  const statusAfter = await rows<{ id: string; status: string }>(
    pg,
    "select id, status from hotels order by id",
  );
  assert.deepEqual(
    statusAfter.map((row) => row.status),
    statusBefore.map((row) => row.status),
  );
  assert.equal(
    (await one<{ organisation_id: string | null }>(
      pg,
      "select organisation_id from hotels where id = $1",
      [hotelC.hotelId],
    )).organisation_id,
    null,
  );
  assert.equal(
    (await one<{ n: number }>(pg, "select count(*)::int as n from sbg_stripe_connections")).n,
    0,
  );

  const privileges = await one<{
    sel: boolean;
    ins: boolean;
    upd: boolean;
    create_org: boolean;
    apply_org: boolean;
    reject_del: boolean;
    hotel_apply: boolean;
  }>(
    pg,
    `select
       has_table_privilege('aether_app', 'sbg_organisations', 'select') as sel,
       has_table_privilege('aether_app', 'sbg_organisations', 'insert') as ins,
       has_table_privilege('aether_app', 'sbg_organisation_billing', 'update') as upd,
       has_function_privilege('aether_app', 'sbg_create_organisation_for_user(text,text)', 'execute') as create_org,
       has_function_privilege(
         'aether_app',
         'sbg_apply_organisation_billing_event(text,text,bigint,uuid,text,text,text,text,timestamptz,boolean,integer,text,uuid)',
         'execute'
       ) as apply_org,
       has_function_privilege('aether_app', 'sbg_organisation_reject_delete()', 'execute') as reject_del,
       to_regprocedure('sbg_apply_billing_event(text,text,bigint,uuid,text,text,text,text,timestamptz,boolean)') is not null as hotel_apply`,
  );
  assert.equal(privileges.sel, true);
  assert.equal(privileges.ins, false);
  assert.equal(privileges.upd, false);
  assert.equal(privileges.create_org, true);
  assert.equal(privileges.apply_org, true);
  assert.equal(privileges.reject_del, false);
  assert.equal(privileges.hotel_apply, true);
});
