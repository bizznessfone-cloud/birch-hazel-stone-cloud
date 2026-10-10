/**
 * CP30.05E-2D-2D A3-M36 — one founding organisation and one effective terms version.
 * PGLite only. One backend. This file does not prove a two-connection lock wait.
 * No Production connection. No Neon branch. No legal Terms. No ledger entry.
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
const { ACCEPTED_LEDGER, AUTHORISED_PENDING, REVIEWED_DIGESTS, isAuthorisedPending } = require(
  "../../../scripts/production-db-preflight.mjs",
) as {
  ACCEPTED_LEDGER: string[];
  AUTHORISED_PENDING: string[];
  REVIEWED_DIGESTS: Record<string, string>;
  isAuthorisedPending: (name: string) => boolean;
};

const root = process.cwd();
const MIGRATION = "0036_cp3005e2d2d_founding_integrity.sql";
const MIGRATION_35 = "0035_cp3005e2d2d_founding_property.sql";
const DIGEST = "fb300bb17c8e9758700cf2fd09aa355b0293b5cd84c692e2913835876ece18fc";
const DIGEST_35 = "80d1d3ec68eebfba0bcfbe07ac3c3dd1ade11d7d0466be9264cf0f28d27def67";
const EFFECTIVE = "fixture-effective";
const SUPERSEDED = "fixture-superseded";
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

async function openThrough(last: string): Promise<PGlite> {
  const pg = await openCp272PaymentDb();
  for (const name of [
    "0031_cp3005e2c_organisation_type.sql",
    "0032_cp3005e2c1_organisation_acceptance.sql",
    "0033_cp3005e2d2b_founding_organisation.sql",
    "0034_cp3005e2d2c_founding_classification_acceptance.sql",
    MIGRATION_35,
    MIGRATION,
  ]) {
    await pg.exec(read(`migrations/${name}`));
    if (name === last) break;
  }
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

async function createdOrgs(pg: PGlite, userId: string) {
  const rows = await pg.query<{ id: string; name: string; organisation_type: string | null }>(
    `select id::text as id, name, organisation_type
       from sbg_organisations
      where created_by_user_id = $1
      order by created_at, id`,
    [userId],
  );
  return rows.rows;
}

async function hotelState(pg: PGlite, hotelId: string) {
  const rows = await pg.query<{ organisation_id: string | null; name: string; code: string }>(
    `select organisation_id::text as organisation_id, name, code
       from hotels where id = $1::uuid`,
    [hotelId],
  );
  return rows.rows[0]!;
}

function createProperty(pg: PGlite, userId: string, code: string, name = "Blue Lagoon Hotel") {
  return pg.query<{ hotel_id: string; provider_id: string }>(
    `select hotel_id::text as hotel_id, provider_id::text as provider_id
       from sbg_create_founding_property_for_user($1, $2, $3, $4, $5, $6)`,
    [userId, code, name, "Kos, Greece", "Europe/Athens", "EUR"],
  );
}

async function indexCount(pg: PGlite, name: string) {
  const rows = await pg.query<{ n: number }>(
    "select count(*)::int as n from pg_class where relkind = 'i' and relname = $1",
    [name],
  );
  return rows.rows[0]!.n;
}

async function functionDef(pg: PGlite, signature: string) {
  const rows = await pg.query<{ def: string }>(
    "select pg_get_functiondef($1::regprocedure) as def",
    [signature],
  );
  return rows.rows[0]!.def;
}

test("0036 is source only and does not rewrite 0035 or authorise itself", () => {
  const sql = read(`migrations/${MIGRATION}`);
  assert.equal(createHash("sha256").update(sql).digest("hex"), DIGEST);
  assert.equal(createHash("sha256").update(read(`migrations/${MIGRATION_35}`)).digest("hex"), DIGEST_35);
  assert.equal(ACCEPTED_LEDGER.includes(MIGRATION), false);
  assert.equal(ACCEPTED_LEDGER.includes(MIGRATION_35), false);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0034_cp3005e2d2c_founding_classification_acceptance.sql");
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(MIGRATION), false);
  assert.equal(Object.hasOwn(REVIEWED_DIGESTS, MIGRATION), false);
  assert.equal(Object.hasOwn(REVIEWED_DIGESTS, MIGRATION_35), false);
  const preflight = sql.indexOf("founding organisation duplicates exist");
  const creatorIndex = sql.indexOf("create unique index if not exists sbg_organisations_one_founding_creator_uidx");
  assert.equal(preflight > 0 && preflight < creatorIndex, true);
  assert.match(sql, /and v\.effective/);
  assert.match(sql, /agreement_version <> 'terms-v1'/);
  assert.match(sql, /where effective/);
  assert.doesNotMatch(sql, /insert\s+into\s+(public\.)?sbg_approved_property_agreement_versions/i);
  assert.doesNotMatch(sql, /delete\s+from\s+(public\.)?sbg_organisations/i);
  assert.doesNotMatch(sql, /update\s+(public\.)?sbg_organisations/i);
  assert.doesNotMatch(sql, /p_organisation_id|p_agreement_version|SKIP_TERMS|process\.env|AETHER_/);
  assert.doesNotMatch(read("src/lib/aether/onboarding-fns.ts"), /sbg_create_founding_property_for_user/);
  assert.doesNotMatch(read("src/lib/aether/hotel-recovery.ts"), /sbg_create_founding_property_for_user/);
  assert.doesNotMatch(read("src/routes/app.founding.tsx"), /sbg_create_founding_property_for_user/);
  assert.doesNotMatch(read("src/routes/app.hotels.$hotelId.tsx"), /sbg_create_founding_property_for_user/);
  assert.match(read("src/routes/index.tsx"), /href="#start"/);
  const creator = sql.slice(
    sql.indexOf("create or replace function sbg_create_organisation_for_user"),
    sql.indexOf("create or replace function sbg_ensure_founding_organisation"),
  );
  assert.match(creator, /set search_path = pg_catalog, public/);
  assert.doesNotMatch(creator, /sbg_approved_property_agreement_versions/);
});

test("duplicate creators fail closed inside one transaction and are not repaired", async () => {
  const pg = await openThrough(MIGRATION_35);
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  await pg.query("select sbg_create_organisation_for_user($1, 'First Business')", [OWNER_USER.id]);
  await pg.query("select sbg_create_organisation_for_user($1, 'Second Business')", [OWNER_USER.id]);
  await pg.query("select sbg_create_organisation_for_user($1, 'Other Business')", [OTHER_USER.id]);
  const ownerBefore = await createdOrgs(pg, OWNER_USER.id);
  const otherBefore = await createdOrgs(pg, OTHER_USER.id);
  assert.equal(ownerBefore.length, 2);
  const sql = read(`migrations/${MIGRATION}`);
  const preflight = sql.slice(sql.indexOf("do $m36dup$"), sql.indexOf("$m36dup$;") + "$m36dup$;".length);
  await assert.rejects(() => pg.exec(preflight), (error: { message?: string; code?: string }) => {
    assert.match(error.message ?? "", /founding organisation duplicates exist:/);
    assert.match(error.message ?? "", new RegExp(OWNER_USER.id));
    assert.match(error.message ?? "", /count=2/);
    assert.match(error.message ?? "", new RegExp(ownerBefore[0]!.id));
    assert.match(error.message ?? "", new RegExp(ownerBefore[1]!.id));
    assert.doesNotMatch(error.message ?? "", new RegExp(OTHER_USER.id));
    assert.equal(error.code, "23505");
    return true;
  });
  assert.equal(await indexCount(pg, "sbg_organisations_one_founding_creator_uidx"), 0);

  await assert.rejects(
    () => pg.transaction(async (tx) => {
      await tx.exec(sql);
    }),
    /founding organisation duplicates exist:|current transaction is aborted|could not create unique index/i,
  );
  assert.equal(await indexCount(pg, "sbg_organisations_one_founding_creator_uidx"), 0);
  const column = await pg.query<{ n: number }>(
    `select count(*)::int as n
       from information_schema.columns
      where table_name = 'sbg_approved_property_agreement_versions'
        and column_name = 'effective'`,
  );
  assert.equal(column.rows[0]!.n, 0);
  const creator = await functionDef(pg, "sbg_create_organisation_for_user(text,text)");
  assert.doesNotMatch(creator, /founding organisation already exists/);
  assert.deepEqual(await createdOrgs(pg, OWNER_USER.id), ownerBefore);
  assert.deepEqual(await createdOrgs(pg, OTHER_USER.id), otherBefore);
});

test("one connection rejects a second founding organisation without renaming the first", async () => {
  // PGLite is one backend. A second PGlite would be a different database.
  // The user-row lock below is held in this session; it is not a waiter on another connection.
  const pg = await openThrough(MIGRATION);
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  assert.equal(await indexCount(pg, "sbg_organisations_one_founding_creator_uidx"), 1);
  const approvals = await pg.query<{ n: number; effective: number }>(
    `select count(*)::int as n,
            count(*) filter (where effective)::int as effective
       from sbg_approved_property_agreement_versions`,
  );
  assert.deepEqual(approvals.rows[0], { n: 0, effective: 0 });

  const first = await pg.query<{ organisation_id: string; name: string }>(
    `select organisation_id::text as organisation_id, name
       from sbg_ensure_founding_organisation($1, 'Aegean Hotels')`,
    [OWNER_USER.id],
  );
  const again = await pg.query<{ organisation_id: string; name: string }>(
    `select organisation_id::text as organisation_id, name
       from sbg_ensure_founding_organisation($1, 'A Different Name')`,
    [OWNER_USER.id],
  );
  assert.equal(again.rows[0]!.organisation_id, first.rows[0]!.organisation_id);
  assert.equal(again.rows[0]!.name, "Aegean Hotels");
  await assert.rejects(
    () => pg.query("select sbg_create_organisation_for_user($1, 'Second Business')", [OWNER_USER.id]),
    /founding organisation already exists/i,
  );
  assert.deepEqual(
    (await createdOrgs(pg, OWNER_USER.id)).map((row) => row.name),
    ["Aegean Hotels"],
  );

  await pg.exec("begin");
  const created = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'Harbour Co')::text as id",
    [OTHER_USER.id],
  );
  assert.equal(created.rows.length, 1);
  const locks = await pg.query<{ relname: string; mode: string }>(
    `select c.relname, l.mode
       from pg_locks l
       join pg_class c on c.oid = l.relation
      where l.pid = pg_backend_pid()
        and l.granted
        and c.relname = 'user'`,
  );
  assert.equal(locks.rows.some((row) => row.mode === "RowShareLock"), true);
  await assert.rejects(
    () => pg.query("select sbg_create_organisation_for_user($1, 'Harbour Two')", [OTHER_USER.id]),
    /founding organisation already exists/i,
  );
  await pg.exec("rollback");
  assert.equal((await createdOrgs(pg, OTHER_USER.id)).length, 0);

  const kept = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'Harbour Co')::text as id",
    [OTHER_USER.id],
  );
  await assert.rejects(
    () => pg.query("select sbg_create_organisation_for_user($1, 'Harbour Two')", [OTHER_USER.id]),
    /founding organisation already exists/i,
  );
  await assert.rejects(
    () => pg.query(
      "insert into sbg_organisations (name, created_by_user_id) values ('Direct Second', $1)",
      [OTHER_USER.id],
    ),
    /sbg_organisations_one_founding_creator_uidx/,
  );
  assert.equal((await createdOrgs(pg, OTHER_USER.id))[0]!.id, kept.rows[0]!.id);
  assert.equal((await createdOrgs(pg, OTHER_USER.id))[0]!.name, "Harbour Co");
  await pg.query(
    `insert into sbg_organisation_members (organisation_id, user_id, role, billing_authority)
     values ($1::uuid, $2, 'member', false)`,
    [kept.rows[0]!.id, OWNER_USER.id],
  );
  assert.equal((await createdOrgs(pg, OWNER_USER.id)).length, 1);
  assert.equal((await createdOrgs(pg, OTHER_USER.id)).length, 1);

  await pg.exec(read(`migrations/${MIGRATION}`));
  assert.equal(await indexCount(pg, "sbg_organisations_one_founding_creator_uidx"), 1);
  assert.equal((await effects(pg)).approvals, 0);
});

test("property creation requires the one effective version and preserves existing rows", async () => {
  const pg = await openThrough(MIGRATION);
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const legacy = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const legacyBefore = await hotelState(pg, legacy.hotelId);
  assert.equal(legacyBefore.organisation_id, null);
  const org = await pg.query<{ organisation_id: string }>(
    "select organisation_id::text as organisation_id from sbg_ensure_founding_organisation($1, 'Blue Lagoon Hotel')",
    [OWNER_USER.id],
  );
  const organisationId = org.rows[0]!.organisation_id;
  await pg.query("select sbg_classify_founding_organisation($1, 'hotel')", [OWNER_USER.id]);
  await pg.query("select sbg_record_founding_terms_acceptance($1)", [OWNER_USER.id]);
  const before = await effects(pg);

  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m36a"),
    /terms are not approved for property creation/i,
  );
  await assert.rejects(
    () => pg.query(
      "insert into sbg_approved_property_agreement_versions (agreement_version, effective) values ('terms-v1', false)",
    ),
    /check constraint|violates/i,
  );
  await pg.query(
    `insert into sbg_approved_property_agreement_versions (agreement_version, effective)
     values ($1, false), ($2, true)`,
    [SUPERSEDED, EFFECTIVE],
  );
  await pg.query(
    `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
     values ($1::uuid, $2, $3)`,
    [organisationId, OWNER_USER.id, SUPERSEDED],
  );
  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m36a"),
    /terms are not approved for property creation/i,
  );
  await assert.rejects(
    () => pg.query(
      "update sbg_approved_property_agreement_versions set effective = true where agreement_version = $1",
      [SUPERSEDED],
    ),
    /sbg_approved_property_agreement_versions_one_effective_uidx/,
  );
  const flags = await pg.query<{ agreement_version: string; effective: boolean }>(
    "select agreement_version, effective from sbg_approved_property_agreement_versions order by agreement_version",
  );
  assert.deepEqual(flags.rows, [
    { agreement_version: EFFECTIVE, effective: true },
    { agreement_version: SUPERSEDED, effective: false },
  ]);
  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m36a"),
    /terms are not approved for property creation/i,
  );

  await pg.query(
    `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
     values ($1::uuid, $2, $3)`,
    [organisationId, OWNER_USER.id, EFFECTIVE],
  );
  const first = await createProperty(pg, OWNER_USER.id, "sbg-test-m36a", "Blue Lagoon Hotel");
  const second = await createProperty(pg, OWNER_USER.id, "sbg-test-m36b", "Harbour House");
  assert.notEqual(first.rows[0]!.hotel_id, second.rows[0]!.hotel_id);
  assert.equal((await hotelState(pg, first.rows[0]!.hotel_id)).organisation_id, organisationId);
  assert.equal((await hotelState(pg, second.rows[0]!.hotel_id)).organisation_id, organisationId);
  assert.deepEqual(await hotelState(pg, legacy.hotelId), legacyBefore);
  const mid = await effects(pg);
  assert.equal(mid.hotels, before.hotels + 2);
  assert.equal(mid.providers, before.providers + 2);
  assert.equal(mid.agreements, before.agreements + 2);
  assert.equal(mid.accounts, before.accounts + 2);
  assert.equal(mid.orgs, before.orgs);
  assert.equal(mid.acceptances, before.acceptances + 2);
  assert.equal(mid.approvals, 2);
  assert.equal((await createdOrgs(pg, OWNER_USER.id)).length, 1);

  await pg.query(
    "update sbg_approved_property_agreement_versions set effective = false where agreement_version = $1",
    [EFFECTIVE],
  );
  await pg.query(
    "update sbg_approved_property_agreement_versions set effective = true where agreement_version = $1",
    [SUPERSEDED],
  );
  const other = await pg.query<{ organisation_id: string }>(
    "select organisation_id::text as organisation_id from sbg_ensure_founding_organisation($1, 'Other Hotels')",
    [OTHER_USER.id],
  );
  await pg.query("select sbg_classify_founding_organisation($1, 'hotel')", [OTHER_USER.id]);
  await pg.query(
    `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
     values ($1::uuid, $2, $3)`,
    [other.rows[0]!.organisation_id, OTHER_USER.id, EFFECTIVE],
  );
  const otherBefore = await effects(pg);
  await assert.rejects(
    () => createProperty(pg, OTHER_USER.id, "sbg-test-m36c"),
    /terms are not approved for property creation/i,
  );
  assert.deepEqual(await effects(pg), otherBefore);
  const third = await createProperty(pg, OWNER_USER.id, "sbg-test-m36d", "Current House");
  assert.equal((await hotelState(pg, third.rows[0]!.hotel_id)).organisation_id, organisationId);

  await assert.rejects(
    () => pg.query("update sbg_organisation_acceptances set agreement_version = 'fixture-changed'"),
    /organisation acceptance evidence is immutable/i,
  );
  await assert.rejects(
    () => pg.query("delete from sbg_organisation_acceptances"),
    /organisation acceptance evidence is immutable/i,
  );
  assert.equal((await effects(pg)).acceptances, otherBefore.acceptances);

  await pg.query(
    "update sbg_organisations set organisation_type = 'transfer_operator' where id = $1::uuid",
    [other.rows[0]!.organisation_id],
  );
  await pg.query(
    `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
     values ($1::uuid, $2, $3)`,
    [other.rows[0]!.organisation_id, OTHER_USER.id, SUPERSEDED],
  );
  const operatorBefore = await effects(pg);
  await assert.rejects(
    () => createProperty(pg, OTHER_USER.id, "sbg-test-m36c"),
    /organisation type is not hotel/i,
  );
  assert.equal((await createdOrgs(pg, OTHER_USER.id))[0]!.organisation_type, "transfer_operator");
  await pg.query(
    "update sbg_organisations set organisation_type = 'hotel' where id = $1::uuid",
    [other.rows[0]!.organisation_id],
  );
  await pg.query(
    "update sbg_organisation_members set billing_authority = false where organisation_id = $1::uuid and user_id = $2",
    [other.rows[0]!.organisation_id, OTHER_USER.id],
  );
  await assert.rejects(
    () => createProperty(pg, OTHER_USER.id, "sbg-test-m36c"),
    /organisation billing authority required/i,
  );
  assert.equal((await effects(pg)).hotels, operatorBefore.hotels);
  assert.equal((await effects(pg)).orgs, operatorBefore.orgs);
  assert.deepEqual(await hotelState(pg, legacy.hotelId), legacyBefore);

  await pg.query(
    "update sbg_organisation_members set billing_authority = true where organisation_id = $1::uuid and user_id = $2",
    [organisationId, OWNER_USER.id],
  );
  const stable = await effects(pg);
  await pg.exec(`
    create or replace function sbg_m36_test_drop_billing()
    returns trigger language plpgsql as $t$
    begin
      update sbg_organisation_members
         set billing_authority = false
       where user_id = new.user_id and removed_at is null;
      return new;
    end;
    $t$;
    create trigger sbg_m36_test_drop_billing
    after insert on app_hotel_accounts
    for each row execute function sbg_m36_test_drop_billing();
  `);
  await assert.rejects(
    () => createProperty(pg, OWNER_USER.id, "sbg-test-m36e"),
    /organisation billing authority required/i,
  );
  await pg.exec("drop trigger sbg_m36_test_drop_billing on app_hotel_accounts");
  assert.deepEqual(await effects(pg), stable);
  const billing = await pg.query<{ billing_authority: boolean }>(
    "select billing_authority from sbg_organisation_members where organisation_id = $1::uuid and user_id = $2",
    [organisationId, OWNER_USER.id],
  );
  assert.equal(billing.rows[0]!.billing_authority, true);
  await pg.exec("begin");
  await createProperty(pg, OWNER_USER.id, "sbg-test-m36e");
  await pg.exec("rollback");
  assert.deepEqual(await effects(pg), stable);
  assert.deepEqual(await hotelState(pg, legacy.hotelId), legacyBefore);
  assert.deepEqual(await hotelState(pg, first.rows[0]!.hotel_id), {
    organisation_id: organisationId,
    name: "Blue Lagoon Hotel",
    code: "sbg-test-m36a",
  });
});

test("aether_app cannot approve terms or designate the effective version", async () => {
  const pg = await openThrough(MIGRATION);
  await insertAuthUser(pg, OWNER_USER);
  const org = await pg.query<{ organisation_id: string }>(
    "select organisation_id::text as organisation_id from sbg_ensure_founding_organisation($1, 'Role Hotels')",
    [OWNER_USER.id],
  );
  await pg.query("select sbg_classify_founding_organisation($1, 'hotel')", [OWNER_USER.id]);
  const priv = await pg.query<{
    execute_property: boolean;
    execute_create: boolean;
    runtime_create: boolean;
    insert_approval: boolean;
    update_approval: boolean;
    select_approval: boolean;
    args: string;
    config: string;
    secdef: boolean;
  }>(
    `select
       has_function_privilege('aether_app', 'sbg_create_founding_property_for_user(text,text,text,text,text,text)', 'execute') as execute_property,
       has_function_privilege('aether_app', 'sbg_create_organisation_for_user(text,text)', 'execute') as execute_create,
       has_function_privilege('aether_runtime', 'sbg_create_organisation_for_user(text,text)', 'execute') as runtime_create,
       has_table_privilege('aether_app', 'sbg_approved_property_agreement_versions', 'insert') as insert_approval,
       has_table_privilege('aether_app', 'sbg_approved_property_agreement_versions', 'update') as update_approval,
       has_table_privilege('aether_app', 'sbg_approved_property_agreement_versions', 'select') as select_approval,
       pg_get_function_identity_arguments('sbg_create_founding_property_for_user(text,text,text,text,text,text)'::regprocedure) as args,
       coalesce((
         select proconfig::text
           from pg_proc
          where oid = 'sbg_create_founding_property_for_user(text,text,text,text,text,text)'::regprocedure
       ), '') as config,
       (
         select prosecdef
           from pg_proc
          where oid = 'sbg_create_organisation_for_user(text,text)'::regprocedure
       ) as secdef`,
  );
  assert.equal(priv.rows[0]!.execute_property, true);
  assert.equal(priv.rows[0]!.execute_create, true);
  assert.equal(priv.rows[0]!.runtime_create, false);
  assert.equal(priv.rows[0]!.insert_approval, false);
  assert.equal(priv.rows[0]!.update_approval, false);
  assert.equal(priv.rows[0]!.select_approval, false);
  assert.equal(priv.rows[0]!.args.includes("uuid"), false);
  assert.match(priv.rows[0]!.config, /search_path=pg_catalog, public/);
  assert.doesNotMatch(priv.rows[0]!.config, /pg_temp/);
  assert.equal(priv.rows[0]!.secdef, true);
  const acls = await pg.query<{ proname: string; acl: string }>(
    `select proname, coalesce(proacl::text, '') as acl
       from pg_proc
      where proname in (
        'sbg_create_organisation_for_user',
        'sbg_ensure_founding_organisation',
        'sbg_create_founding_property_for_user'
      )`,
  );
  assert.equal(acls.rows.length, 3);
  for (const row of acls.rows) {
    assert.match(row.acl, /aether_app=X/);
    assert.doesNotMatch(row.acl, /(^\{|,)=X\//);
  }

  await pg.query(
    `insert into sbg_approved_property_agreement_versions (agreement_version, effective)
     values ($1, true)`,
    [EFFECTIVE],
  );
  const before = await pg.query<{ effective: boolean }>(
    "select effective from sbg_approved_property_agreement_versions where agreement_version = $1",
    [EFFECTIVE],
  );
  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  await assert.rejects(
    () => pg.query(
      "update sbg_approved_property_agreement_versions set effective = false where agreement_version = $1",
      [EFFECTIVE],
    ),
    /permission denied/i,
  );
  await pg.exec("rollback");
  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  await assert.rejects(
    () => pg.query(
      "insert into sbg_approved_property_agreement_versions (agreement_version, effective) values ('fixture-app', true)",
    ),
    /permission denied/i,
  );
  await pg.exec("rollback");
  assert.equal(
    (await pg.query<{ effective: boolean }>(
      "select effective from sbg_approved_property_agreement_versions where agreement_version = $1",
      [EFFECTIVE],
    )).rows[0]!.effective,
    before.rows[0]!.effective,
  );

  await pg.query(
    `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
     values ($1::uuid, $2, $3)`,
    [org.rows[0]!.organisation_id, OWNER_USER.id, EFFECTIVE],
  );
  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  const created = await createProperty(pg, OWNER_USER.id, "sbg-test-m36a");
  await pg.exec("commit");
  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  await assert.rejects(
    () => pg.query("select sbg_create_organisation_for_user($1, 'Escalated')", [OWNER_USER.id]),
    /founding organisation already exists/i,
  );
  await pg.exec("rollback");
  assert.equal((await hotelState(pg, created.rows[0]!.hotel_id)).organisation_id, org.rows[0]!.organisation_id);
  assert.equal((await createdOrgs(pg, OWNER_USER.id)).length, 1);
  assert.equal((await effects(pg)).approvals, 1);
});
