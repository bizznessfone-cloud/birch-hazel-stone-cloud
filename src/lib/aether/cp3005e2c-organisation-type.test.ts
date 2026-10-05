/**
 * CP30.05E-2C — organisation_type is classification only.
 * PGLite. No Production connection. No Stripe.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OWNER_USER, createHotelForUser, insertAuthUser, openCp272PaymentDb } from "./cp26a4-fixture.ts";
import { createRequire } from "node:module";
import { isOrganisationType } from "./organisation-type.ts";

const require = createRequire(import.meta.url);
const { inspect0031State } = require("../../../scripts/cp3005e2c-0031-production-migrate.mjs") as {
  inspect0031State: (
    client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
    sourceMigrations: string[],
  ) => Promise<{
    classifiedCount: number;
    organisationType: {
      present: boolean;
      dataType: string;
      nullable: boolean;
      columnDefault: string | null;
      checkAcceptsHotel: boolean;
      checkAcceptsTransfer: boolean;
      createFunctionArgs: string;
      uniqueHotelOrganisation: boolean;
      appInsert: boolean;
    };
  }>;
};

const root = process.cwd();
const MIGRATION = "0031_cp3005e2c_organisation_type.sql";
const SQL = readFileSync(join(root, "migrations", MIGRATION), "utf8");

async function apply(pg: Awaited<ReturnType<typeof openCp272PaymentDb>>) {
  await pg.exec(SQL);
}

test("0031 is classification only and does not guess, grant, or collapse cardinality", () => {
  const preflight = readFileSync(join(root, "scripts/production-db-preflight.mjs"), "utf8");
  assert.equal(
    createHash("sha256").update(SQL).digest("hex"),
    "be0921b852dda7904863f34bc1160fab844b2aaf0821423f6863c91b71b592b6",
  );
  assert.match(preflight, /"0032_cp3005e2c1_organisation_acceptance.sql",\n\];/);
  assert.match(preflight, /AUTHORISED_PENDING = \[\];/);
  const executable = SQL.replace(/--.*$/gm, "");
  assert.doesNotMatch(executable, /\bupdate\s+sbg_organisations\b/i);
  assert.doesNotMatch(executable, /\binsert\s+into\b/i);
  assert.doesNotMatch(executable, /\bgrant\b/i);
  assert.doesNotMatch(executable, /sbg_organisation_members/);
  assert.doesNotMatch(executable, /\bhotels\b/);
  assert.doesNotMatch(executable, /licensed_quantity/);
  assert.doesNotMatch(executable, /sbg_create_organisation_for_user/);
  assert.equal(existsSync(join(root, "migrations/0032_cp3005e2c.sql")), false);
  assert.match(SQL, /organisation_type in \('hotel', 'transfer_operator'\)/);
  assert.equal(isOrganisationType("hotel"), true);
  assert.equal(isOrganisationType("transfer_operator"), true);
  assert.equal(isOrganisationType("member"), false);
  assert.equal(isOrganisationType(null), false);
});

test("pre-apply inspect tolerates a missing organisation_type column", async () => {
  const pg = await openCp272PaymentDb();
  const facts = await inspect0031State(pg, [MIGRATION]);
  assert.equal(facts.organisationType.present, false);
  assert.equal(facts.classifiedCount, 0);
  assert.equal(facts.organisationType.createFunctionArgs, "p_user_id text, p_name text");
  assert.equal(facts.organisationType.uniqueHotelOrganisation, false);
  assert.equal(facts.organisationType.appInsert, false);
  await pg.exec(SQL);
  const after = await inspect0031State(pg, [MIGRATION]);
  assert.equal(after.organisationType.present, true);
  assert.equal(after.organisationType.dataType, "text");
  assert.equal(after.organisationType.nullable, true);
  assert.equal(after.organisationType.columnDefault, null);
  assert.equal(after.organisationType.checkAcceptsHotel, true);
  assert.equal(after.organisationType.checkAcceptsTransfer, true);
  assert.equal(after.classifiedCount, 0);
});

test("0031 rolls back as one transaction and then accepts only the two types", async () => {
  const pg = await openCp272PaymentDb();
  await insertAuthUser(pg, OWNER_USER);
  const before = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, $2)::text as id",
    [OWNER_USER.id, "Existing Operator"],
  );
  const existingId = before.rows[0]?.id;
  assert.ok(existingId);

  await pg.exec("begin");
  await pg.exec(SQL);
  await pg.exec("rollback");
  const absent = await pg.query(
    `select 1 from information_schema.columns
      where table_name = 'sbg_organisations' and column_name = 'organisation_type'`,
  );
  assert.equal(absent.rows.length, 0);

  await apply(pg);
  const typed = await pg.query<{ organisation_type: string | null }>(
    "select organisation_type from sbg_organisations where id = $1::uuid",
    [existingId],
  );
  assert.equal(typed.rows[0]?.organisation_type, null);

  await pg.query("update sbg_organisations set organisation_type = 'hotel' where id = $1::uuid", [existingId]);
  await pg.query(
    "update sbg_organisations set organisation_type = 'transfer_operator' where id = $1::uuid",
    [existingId],
  );
  await assert.rejects(
    () => pg.query("update sbg_organisations set organisation_type = 'member' where id = $1::uuid", [existingId]),
    (err: unknown) => {
      assert.match(err instanceof Error ? err.message : String(err), /sbg_organisations_organisation_type_check|check constraint/i);
      return true;
    },
  );

  const created = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, $2)::text as id",
    [OWNER_USER.id, "New Operator"],
  );
  const createdId = created.rows[0]?.id;
  assert.ok(createdId);
  const createdType = await pg.query<{ organisation_type: string | null }>(
    "select organisation_type from sbg_organisations where id = $1::uuid",
    [createdId],
  );
  assert.equal(createdType.rows[0]?.organisation_type, null);

  await pg.query(
    `update sbg_organisation_members
        set role = 'transfer_operator'
      where organisation_id = $1::uuid and user_id = $2`,
    [createdId, OWNER_USER.id],
  );
  const still = await pg.query<{ organisation_type: string | null; role: string }>(
    `select o.organisation_type, m.role
       from sbg_organisations o
       join sbg_organisation_members m on m.organisation_id = o.id
      where o.id = $1::uuid`,
    [createdId],
  );
  assert.equal(still.rows[0]?.organisation_type, null);
  assert.equal(still.rows[0]?.role, "transfer_operator");
});

test("one organisation can hold two hotels and type grants nothing", async () => {
  const pg = await openCp272PaymentDb();
  await apply(pg);
  await insertAuthUser(pg, OWNER_USER);
  const org = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, $2)::text as id",
    [OWNER_USER.id, "Multi"],
  );
  const organisationId = org.rows[0]?.id;
  assert.ok(organisationId);
  const first = await createHotelForUser(pg, OWNER_USER.id, {
    code: "sbg-test-one",
    name: "One",
    locality: "Kos",
    ianaTimezone: "Europe/Athens",
    currency: "EUR",
  });
  const second = await createHotelForUser(pg, OWNER_USER.id, {
    code: "sbg-test-two",
    name: "Two",
    locality: "Kos",
    ianaTimezone: "Europe/Athens",
    currency: "EUR",
  });
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
  const attached = await pg.query<{ n: number }>(
    "select count(*)::int as n from hotels where organisation_id = $1::uuid",
    [organisationId],
  );
  assert.equal(attached.rows[0]?.n, 2);
  const unique = await pg.query(
    `select indexdef from pg_indexes
      where tablename = 'hotels' and indexdef ilike '%unique%' and indexdef ilike '%organisation_id%'`,
  );
  assert.equal(unique.rows.length, 0);
  const insert = await pg.query<{ ins: boolean }>(
    "select has_table_privilege('aether_app', 'sbg_organisations', 'insert') as ins",
  );
  assert.equal(insert.rows[0]?.ins, false);
  const billing = await pg.query(
    `select column_name from information_schema.columns
      where table_name = 'sbg_organisations' and column_name = 'licensed_quantity'`,
  );
  assert.equal(billing.rows.length, 0);
});
