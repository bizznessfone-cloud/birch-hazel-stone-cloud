/**
 * CP30.05E-2D-2D A3-M35 — atomic founding property creation.
 * PGLite only. No Production connection. No Stripe. No ledger entry.
 * terms-v1 is not approval. The fixture version is not legal Terms.
 * One connection cannot prove a two-backend lock wait.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  FIXTURE_HOTEL,
  OTHER_USER,
  OWNER_USER,
  createHotelForUser,
  insertAuthUser,
  openCp272PaymentDb,
} from "./cp26a4-fixture.ts";

const require = createRequire(import.meta.url);
const { ACCEPTED_LEDGER, AUTHORISED_PENDING, isAuthorisedPending } = require(
  "../../../scripts/production-db-preflight.mjs",
) as {
  ACCEPTED_LEDGER: string[];
  AUTHORISED_PENDING: string[];
  isAuthorisedPending: (name: string) => boolean;
};

const root = process.cwd();
const MIGRATION = "0035_cp3005e2d2d_founding_property.sql";
const DIGEST = "80d1d3ec68eebfba0bcfbe07ac3c3dd1ade11d7d0466be9264cf0f28d27def67";
const FIXTURE_TERMS = "fixture-not-legal";
const read = (path: string) => readFileSync(join(root, path), "utf8");

type Effects = {
  hotels: number;
  providers: number;
  agreements: number;
  accounts: number;
  orgs: number;
  acceptances: number;
  billing: number;
  allocations: number;
  bookings: number;
  claims: number;
  approvals: number;
};

async function openDb(): Promise<PGlite> {
  const pg = await openCp272PaymentDb();
  await pg.exec(read("migrations/0031_cp3005e2c_organisation_type.sql"));
  await pg.exec(read("migrations/0032_cp3005e2c1_organisation_acceptance.sql"));
  await pg.exec(read("migrations/0033_cp3005e2d2b_founding_organisation.sql"));
  await pg.exec(read("migrations/0034_cp3005e2d2c_founding_classification_acceptance.sql"));
  await pg.exec(read(`migrations/${MIGRATION}`));
  return pg;
}

async function effects(pg: PGlite): Promise<Effects> {
  const rows = await pg.query<Effects>(
    `select
       (select count(*)::int from hotels) as hotels,
       (select count(*)::int from providers) as providers,
       (select count(*)::int from hotel_provider_agreements) as agreements,
       (select count(*)::int from app_hotel_accounts) as accounts,
       (select count(*)::int from sbg_organisations) as orgs,
       (select count(*)::int from sbg_organisation_acceptances) as acceptances,
       (select count(*)::int from sbg_organisation_billing) as billing,
       (select count(*)::int from sbg_property_licence_allocations) as allocations,
       (select count(*)::int from bookings) as bookings,
       (select count(*)::int from sbg_domain_a_checkout_claims) as claims,
       (select count(*)::int from sbg_approved_property_agreement_versions) as approvals`,
  );
  return rows.rows[0]!;
}

async function hotelOrg(pg: PGlite, userId: string) {
  const rows = await pg.query<{
    id: string;
    name: string;
    organisation_type: string | null;
  }>(
    `select id::text as id, name, organisation_type
       from sbg_organisations
      where created_by_user_id = $1
      order by created_at, id`,
    [userId],
  );
  return rows.rows;
}

async function hotelState(pg: PGlite, hotelId: string) {
  const rows = await pg.query<{
    organisation_id: string | null;
    name: string;
    status: string;
    public_slug: string;
    code: string;
  }>(
    `select organisation_id::text as organisation_id, name, status, public_slug, code
       from hotels where id = $1::uuid`,
    [hotelId],
  );
  return rows.rows[0]!;
}

async function foundHotelOrg(pg: PGlite, userId: string, name: string) {
  const rows = await pg.query<{ organisation_id: string }>(
    `select organisation_id::text as organisation_id
       from sbg_ensure_founding_organisation($1, $2)`,
    [userId, name],
  );
  return rows.rows[0]!.organisation_id;
}

async function allowFixture(pg: PGlite, organisationId: string, userId: string) {
  await pg.query(
    "insert into sbg_approved_property_agreement_versions (agreement_version) values ($1)",
    [FIXTURE_TERMS],
  );
  await pg.query(
    `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
     values ($1::uuid, $2, $3)`,
    [organisationId, userId, FIXTURE_TERMS],
  );
}

function createProperty(
  pg: PGlite,
  userId: string,
  code: string,
  name = "Blue Lagoon Hotel",
) {
  return pg.query<{ hotel_id: string; provider_id: string }>(
    `select hotel_id::text as hotel_id, provider_id::text as provider_id
       from sbg_create_founding_property_for_user($1, $2, $3, $4, $5, $6)`,
    [userId, code, name, "Kos, Greece", "Europe/Athens", "EUR"],
  );
}

test("0035 is source only, terms-v1 cannot be approved, and the app does not call it", () => {
  const sql = read(`migrations/${MIGRATION}`);
  const digest = createHash("sha256").update(sql).digest("hex");
  assert.equal(digest, DIGEST);
  assert.equal(
    createHash("sha256").update(read("migrations/0034_cp3005e2d2c_founding_classification_acceptance.sql")).digest("hex"),
    "3a80e2ec5ff9ab474c8dabf562fe8e3e37b8fcaa77ef7e8467bd0127afdc433c",
  );
  assert.equal(ACCEPTED_LEDGER.includes(MIGRATION), false);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0034_cp3005e2d2c_founding_classification_acceptance.sql");
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(MIGRATION), false);
  assert.match(sql, /sbg_create_hotel_for_user/);
  assert.match(sql, /sbg_attach_hotel_to_organisation/);
  assert.match(sql, /for update/);
  assert.match(sql, /agreement_version <> 'terms-v1'/);
  assert.doesNotMatch(sql, /insert into sbg_approved_property_agreement_versions/i);
  assert.doesNotMatch(sql, /p_organisation_id|p_agreement_version|SKIP_TERMS|process\.env|AETHER_/);
  assert.doesNotMatch(sql, /sbg_record_founding_terms_acceptance|sbg_classify_founding_organisation/);
  const property = sql.slice(
    sql.indexOf("create or replace function sbg_create_founding_property_for_user"),
    sql.indexOf("comment on function sbg_create_organisation_for_user"),
  );
  assert.doesNotMatch(property, /sbg_create_organisation_for_user|insert into public\.sbg_organisations/);
  assert.doesNotMatch(read("src/lib/aether/onboarding-fns.ts"), /sbg_create_founding_property_for_user/);
  assert.doesNotMatch(read("src/lib/aether/hotel-recovery.ts"), /sbg_create_founding_property_for_user/);
  assert.doesNotMatch(read("src/routes/app.founding.tsx"), /sbg_create_founding_property_for_user/);
  assert.doesNotMatch(read("src/routes/app.hotels.$hotelId.tsx"), /sbg_create_founding_property_for_user/);
  assert.match(read("src/routes/index.tsx"), /href="#start"/);
  assert.match(read("src/lib/aether/onboarding-fns.ts"), /Finish business setup before adding a property/);
});

test("an empty approval list and terms-v1 create nothing", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const organisationId = await foundHotelOrg(pg, OWNER_USER.id, "Aegean Hotels");
  await pg.query("select sbg_classify_founding_organisation($1, 'hotel')", [OWNER_USER.id]);
  await pg.query("select sbg_record_founding_terms_acceptance($1)", [OWNER_USER.id]);
  const before = await effects(pg);
  assert.equal(before.approvals, 0);
  assert.equal(before.acceptances, 1);

  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m35a"),
    /terms are not approved for property creation/i,
  );
  await assert.rejects(
    () => pg.query("insert into sbg_approved_property_agreement_versions (agreement_version) values ('terms-v1')"),
    /check constraint|violates/i,
  );
  await pg.query(
    "insert into sbg_approved_property_agreement_versions (agreement_version) values ($1)",
    [FIXTURE_TERMS],
  );
  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m35a"),
    /terms are not approved for property creation/i,
  );

  const after = await effects(pg);
  assert.equal(after.hotels, before.hotels);
  assert.equal(after.providers, before.providers);
  assert.equal(after.agreements, before.agreements);
  assert.equal(after.accounts, before.accounts);
  assert.equal(after.orgs, before.orgs);
  assert.equal(after.acceptances, before.acceptances);
  assert.equal(after.billing, before.billing);
  assert.equal(after.allocations, before.allocations);
  assert.equal(after.bookings, before.bookings);
  assert.equal(after.claims, before.claims);
  assert.equal((await hotelOrg(pg, OWNER_USER.id))[0]!.id, organisationId);
  assert.equal((await hotelOrg(pg, OWNER_USER.id))[0]!.organisation_type, "hotel");
});

test("a non-legal fixture can create two properties and a repeat code rolls back", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const legacy = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const legacyBefore = await hotelState(pg, legacy.hotelId);
  assert.equal(legacyBefore.organisation_id, null);
  const organisationId = await foundHotelOrg(pg, OWNER_USER.id, "Blue Lagoon Hotel");
  await pg.query("select sbg_classify_founding_organisation($1, 'hotel')", [OWNER_USER.id]);
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    OWNER_USER.id,
    organisationId,
    legacy.hotelId,
  ]);
  const attached = await hotelState(pg, legacy.hotelId);
  await allowFixture(pg, organisationId, OWNER_USER.id);
  const before = await effects(pg);

  const first = await createProperty(pg, OWNER_USER.id, "sbg-test-m35a", "Blue Lagoon Hotel");
  const second = await createProperty(pg, OWNER_USER.id, "sbg-test-m35b", "Harbour House");
  assert.notEqual(first.rows[0]!.hotel_id, second.rows[0]!.hotel_id);
  assert.notEqual(first.rows[0]!.hotel_id, legacy.hotelId);

  const created = await hotelState(pg, first.rows[0]!.hotel_id);
  const other = await hotelState(pg, second.rows[0]!.hotel_id);
  assert.equal(created.organisation_id, organisationId);
  assert.equal(other.organisation_id, organisationId);
  assert.equal(created.name, "Blue Lagoon Hotel");
  assert.equal(created.status, "unconfigured");
  assert.equal(created.public_slug.length > 0, true);
  assert.notEqual(created.public_slug, other.public_slug);
  assert.deepEqual(await hotelState(pg, legacy.hotelId), attached);

  const provider = await pg.query<{ kind: string; active: boolean }>(
    `select p.kind, a.active
       from providers p
       join hotel_provider_agreements a on a.provider_id = p.id
      where p.id = $1::uuid and a.hotel_id = $2::uuid`,
    [first.rows[0]!.provider_id, first.rows[0]!.hotel_id],
  );
  assert.deepEqual(provider.rows, [{ kind: "in_house", active: true }]);
  const account = await pg.query<{ n: number }>(
    "select count(*)::int as n from app_hotel_accounts where user_id = $1 and hotel_id = $2::uuid",
    [OWNER_USER.id, first.rows[0]!.hotel_id],
  );
  assert.equal(account.rows[0]!.n, 1);

  const mid = await effects(pg);
  assert.equal(mid.hotels, before.hotels + 2);
  assert.equal(mid.providers, before.providers + 2);
  assert.equal(mid.agreements, before.agreements + 2);
  assert.equal(mid.accounts, before.accounts + 2);
  assert.equal(mid.orgs, before.orgs);
  assert.equal(mid.acceptances, before.acceptances);
  assert.equal(mid.billing, before.billing);
  assert.equal(mid.allocations, before.allocations);
  assert.equal(mid.bookings, before.bookings);
  assert.equal(mid.claims, before.claims);
  assert.equal((await hotelOrg(pg, OWNER_USER.id)).length, 1);

  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m35a"),
    /hotel code already exists/i,
  );
  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "NOT VALID"),
    /invalid hotel code/i,
  );
  const after = await effects(pg);
  assert.equal(after.hotels, mid.hotels);
  assert.equal(after.providers, mid.providers);
  assert.equal(after.agreements, mid.agreements);
  assert.equal(after.accounts, mid.accounts);
  assert.equal(after.orgs, mid.orgs);
  assert.deepEqual(await hotelState(pg, legacy.hotelId), attached);
});

test("operator, ambiguous, unclassified, and lost billing create nothing", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const organisationId = await foundHotelOrg(pg, OWNER_USER.id, "Island Hotels");
  await allowFixture(pg, organisationId, OWNER_USER.id);
  const before = await effects(pg);

  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m35a"),
    /organisation is unclassified/i,
  );
  await pg.query("select sbg_classify_founding_organisation($1, 'transfer_operator')", [OWNER_USER.id]);
  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m35a"),
    /organisation type is not hotel/i,
  );
  assert.equal((await hotelOrg(pg, OWNER_USER.id))[0]!.organisation_type, "transfer_operator");

  await pg.query(
    "update sbg_organisations set organisation_type = 'hotel' where id = $1::uuid",
    [organisationId],
  );
  await pg.query(
    "update sbg_organisation_members set billing_authority = false where user_id = $1",
    [OWNER_USER.id],
  );
  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m35a"),
    /organisation billing authority required/i,
  );
  await pg.query(
    "update sbg_organisation_members set billing_authority = true where user_id = $1",
    [OWNER_USER.id],
  );
  await pg.query("select sbg_create_organisation_for_user($1, 'Second Business')", [OWNER_USER.id]);
  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m35a"),
    /founding organisation is ambiguous/i,
  );
  await assert.rejects(
    () => createProperty(pg, OTHER_USER.id, "sbg-test-m35c"),
    /founding organisation is missing/i,
  );
  await assert.rejects(
    () => createProperty(pg, "missing-user", "sbg-test-m35d"),
    /account not found/i,
  );

  const after = await effects(pg);
  assert.equal(after.hotels, before.hotels);
  assert.equal(after.providers, before.providers);
  assert.equal(after.agreements, before.agreements);
  assert.equal(after.accounts, before.accounts);
  assert.equal(after.orgs, before.orgs + 1);
  assert.equal(after.acceptances, before.acceptances);
  assert.equal(after.bookings, before.bookings);
  assert.equal(after.claims, before.claims);
  assert.equal(
    (await pg.query<{ n: number }>("select count(*)::int as n from hotels where organisation_id = $1::uuid", [organisationId])).rows[0]!.n,
    0,
  );
});

test("a failure after insert rolls back, and the user lock is held until rollback", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const organisationId = await foundHotelOrg(pg, OWNER_USER.id, "Rollback Hotels");
  await pg.query("select sbg_classify_founding_organisation($1, 'hotel')", [OWNER_USER.id]);
  await allowFixture(pg, organisationId, OWNER_USER.id);
  const before = await effects(pg);

  await pg.exec(`
    create or replace function sbg_m35_test_drop_billing()
    returns trigger
    language plpgsql
    as $t$
    begin
      update sbg_organisation_members
         set billing_authority = false
       where user_id = new.user_id
         and removed_at is null;
      return new;
    end;
    $t$;
    create trigger sbg_m35_test_drop_billing
    after insert on app_hotel_accounts
    for each row execute function sbg_m35_test_drop_billing();
  `);
  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m35a"),
    /organisation billing authority required/i,
  );
  await pg.exec("drop trigger sbg_m35_test_drop_billing on app_hotel_accounts");
  assert.deepEqual(await effects(pg), before);
  const billing = await pg.query<{ billing_authority: boolean }>(
    "select billing_authority from sbg_organisation_members where user_id = $1",
    [OWNER_USER.id],
  );
  assert.equal(billing.rows[0]!.billing_authority, true);

  await pg.exec("begin");
  const created = await createProperty(pg, OWNER_USER.id, "sbg-test-m35a");
  assert.equal(created.rows.length, 1);
  const locks = await pg.query<{ relname: string; mode: string }>(
    `select c.relname, l.mode
       from pg_locks l
       join pg_class c on c.oid = l.relation
      where l.pid = pg_backend_pid()
        and l.granted
        and c.relname in ('user', 'sbg_organisations', 'sbg_organisation_members')`,
  );
  const held = new Set(locks.rows.map((row) => `${row.relname}:${row.mode}`));
  assert.equal(held.has("user:RowShareLock"), true);
  assert.equal(held.has("sbg_organisations:RowShareLock"), true);
  assert.equal(held.has("sbg_organisation_members:RowShareLock"), true);
  const visible = await effects(pg);
  assert.equal(visible.hotels, before.hotels + 1);
  await pg.exec("rollback");
  assert.deepEqual(await effects(pg), before);
});

test("aether_app may execute the function and cannot approve terms or write the tables", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const organisationId = await foundHotelOrg(pg, OWNER_USER.id, "Role Hotels");
  await pg.query("select sbg_classify_founding_organisation($1, 'hotel')", [OWNER_USER.id]);
  const priv = await pg.query<{
    execute: boolean;
    insert_approval: boolean;
    select_approval: boolean;
    insert_acceptance: boolean;
    args: string;
    acl: string;
  }>(
    `select
       has_function_privilege('aether_app', 'sbg_create_founding_property_for_user(text,text,text,text,text,text)', 'execute') as execute,
       has_table_privilege('aether_app', 'sbg_approved_property_agreement_versions', 'insert') as insert_approval,
       has_table_privilege('aether_app', 'sbg_approved_property_agreement_versions', 'select') as select_approval,
       has_table_privilege('aether_app', 'sbg_organisation_acceptances', 'insert') as insert_acceptance,
       pg_get_function_identity_arguments('sbg_create_founding_property_for_user(text,text,text,text,text,text)'::regprocedure) as args,
       coalesce((select proacl::text from pg_proc where proname = 'sbg_create_founding_property_for_user'), '') as acl`,
  );
  assert.equal(priv.rows[0]!.execute, true);
  assert.equal(priv.rows[0]!.insert_approval, false);
  assert.equal(priv.rows[0]!.select_approval, false);
  assert.equal(priv.rows[0]!.insert_acceptance, false);
  assert.equal(priv.rows[0]!.args.includes("uuid"), false);
  assert.match(priv.rows[0]!.acl, /aether_app=X/);
  assert.doesNotMatch(priv.rows[0]!.acl, /(^\{|,)=X\//);
  const beforeRole = await effects(pg);

  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  await assert.rejects(
    () => pg.query("insert into sbg_approved_property_agreement_versions (agreement_version) values ('fixture-not-legal')"),
    /permission denied/i,
  );
  await pg.exec("rollback");

  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m35a"),
    /terms are not approved for property creation/i,
  );
  await pg.exec("rollback");
  assert.deepEqual(await effects(pg), beforeRole);
  const unchanged = beforeRole;

  await allowFixture(pg, organisationId, OWNER_USER.id);
  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  const created = await createProperty(pg, OWNER_USER.id, "sbg-test-m35a");
  await pg.exec("commit");
  const row = await hotelState(pg, created.rows[0]!.hotel_id);
  assert.equal(row.organisation_id, organisationId);
  assert.equal((await effects(pg)).hotels, unchanged.hotels + 1);
  assert.equal((await effects(pg)).orgs, unchanged.orgs);
  assert.equal((await effects(pg)).acceptances, unchanged.acceptances + 1);

  await pg.exec(read(`migrations/${MIGRATION}`));
  assert.equal((await effects(pg)).approvals, 1);
});
