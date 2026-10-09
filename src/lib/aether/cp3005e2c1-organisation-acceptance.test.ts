/**
 * CP30.05E-2C.1 — acceptance evidence is versioned history, not a boolean.
 * PGLite. No Production connection. No Stripe.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { OTHER_USER, OWNER_USER, createHotelForUser, insertAuthUser, openCp272PaymentDb } from "./cp26a4-fixture.ts";
import { isAgreementVersion } from "./organisation-acceptance.ts";

const require = createRequire(import.meta.url);
const { inspect0032State } = require("../../../scripts/cp3005e2c1-0032-production-migrate.mjs") as {
  inspect0032State: (
    client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
    sourceMigrations: string[],
  ) => Promise<{
    acceptanceCount: number;
    classifiedCount: number;
    acceptance: {
      present: boolean;
      versionType: string;
      versionNullable: boolean;
      acceptedAtType: string;
      booleanColumns: number;
      hotelColumn: boolean;
      quantityColumn: boolean;
      uniqueVersion: boolean;
      immutableTrigger: boolean;
      appInsert: boolean;
      appSelect: boolean;
      appExecute: boolean;
      createFunctionArgs: string;
      organisationTypePresent: boolean;
    };
  }>;
};

const root = process.cwd();
const MIGRATION = "0032_cp3005e2c1_organisation_acceptance.sql";
const SQL = readFileSync(join(root, "migrations", MIGRATION), "utf8");
const TYPE_SQL = readFileSync(join(root, "migrations/0031_cp3005e2c_organisation_type.sql"), "utf8");
const V1 = "commercial-terms.v1";
const V2 = "commercial-terms.v2";

test("0032 is evidence only and does not guess, grant, or collapse cardinality", () => {
  const preflight = readFileSync(join(root, "scripts/production-db-preflight.mjs"), "utf8");
  assert.equal(
    createHash("sha256").update(SQL).digest("hex"),
    "c3412d2b6efc05786ea3edf1146da25853b88ac0df69b1ce215240be0c72ab48",
  );
  assert.match(preflight, /"0033_cp3005e2d2b_founding_organisation.sql",\n\];/);
  assert.match(preflight, /"0032_cp3005e2c1_organisation_acceptance.sql",/);
  assert.doesNotMatch(preflight, /0034_/);
  const executable = SQL.replace(/--.*$/gm, "");
  assert.doesNotMatch(executable, /\binsert\s+into\b/i);
  assert.doesNotMatch(executable, /\bgrant\b/i);
  assert.doesNotMatch(executable, /terms_accepted/);
  assert.doesNotMatch(executable, /\bboolean\s+not\s+null\b/i);
  assert.doesNotMatch(executable, /\bhotels\b/);
  assert.doesNotMatch(executable, /licensed_quantity/);
  assert.doesNotMatch(executable, /organisation_type/);
  assert.equal(existsSync(join(root, "migrations/0033_cp3005e2c1.sql")), false);
  assert.equal(isAgreementVersion(V1), true);
  assert.equal(isAgreementVersion("privacy-notice.v1"), true);
  assert.equal(isAgreementVersion("true"), true);
  assert.equal(isAgreementVersion(""), false);
  assert.equal(isAgreementVersion(true), false);
  assert.equal(isAgreementVersion(null), false);
});

test("pre-apply inspect tolerates a missing acceptance table", async () => {
  const pg = await openCp272PaymentDb();
  const facts = await inspect0032State(pg, [MIGRATION]);
  assert.equal(facts.acceptance.present, false);
  assert.equal(facts.acceptanceCount, 0);
  assert.equal(facts.acceptance.createFunctionArgs, "p_user_id text, p_name text");
  assert.equal(facts.acceptance.appInsert, false);
  await pg.exec(SQL);
  const after = await inspect0032State(pg, [MIGRATION]);
  assert.equal(after.acceptance.present, true);
  assert.equal(after.acceptance.versionType, "text");
  assert.equal(after.acceptance.versionNullable, false);
  assert.equal(after.acceptance.acceptedAtType, "timestamptz");
  assert.equal(after.acceptance.booleanColumns, 0);
  assert.equal(after.acceptance.hotelColumn, false);
  assert.equal(after.acceptance.quantityColumn, false);
  assert.equal(after.acceptance.uniqueVersion, true);
  assert.equal(after.acceptance.immutableTrigger, true);
  assert.equal(after.acceptance.appSelect, false);
  assert.equal(after.acceptance.appInsert, false);
  assert.equal(after.acceptance.appExecute, false);
  assert.equal(after.acceptanceCount, 0);
  assert.equal(after.classifiedCount, 0);
});

test("0032 rolls back as one transaction and keeps later versions without rewriting the first", async () => {
  const pg = await openCp272PaymentDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  await pg.exec(TYPE_SQL);
  const org = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, $2)::text as id",
    [OWNER_USER.id, "Existing Operator"],
  );
  const organisationId = org.rows[0]?.id;
  assert.ok(organisationId);
  await pg.query(
    "insert into sbg_organisation_billing (organisation_id, licensed_quantity) values ($1::uuid, 3)",
    [organisationId],
  );

  await pg.exec("begin");
  await pg.exec(SQL);
  await pg.exec("rollback");
  const absent = await pg.query(
    `select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'sbg_organisation_acceptances'`,
  );
  assert.equal(absent.rows.length, 0);

  await pg.exec(SQL);
  const empty = await pg.query<{ n: number }>("select count(*)::int as n from sbg_organisation_acceptances");
  assert.equal(empty.rows[0]?.n, 0);

  await pg.query(
    `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
     values ($1::uuid, $2, $3)`,
    [organisationId, OWNER_USER.id, V1],
  );
  const first = await pg.query<{ accepted_at: string }>(
    `select accepted_at::text as accepted_at
       from sbg_organisation_acceptances
      where organisation_id = $1::uuid and accepted_by_user_id = $2 and agreement_version = $3`,
    [organisationId, OWNER_USER.id, V1],
  );
  await assert.rejects(
    () =>
      pg.query(
        `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
         values ($1::uuid, $2, $3)`,
        [organisationId, OWNER_USER.id, V1],
      ),
    (err: unknown) => {
      assert.match(err instanceof Error ? err.message : String(err), /sbg_organisation_acceptances_version_uidx|unique/i);
      return true;
    },
  );
  const stillFirst = await pg.query<{ n: number; accepted_at: string }>(
    `select count(*)::int as n, min(accepted_at)::text as accepted_at
       from sbg_organisation_acceptances
      where organisation_id = $1::uuid and accepted_by_user_id = $2 and agreement_version = $3`,
    [organisationId, OWNER_USER.id, V1],
  );
  assert.equal(stillFirst.rows[0]?.n, 1);
  assert.equal(stillFirst.rows[0]?.accepted_at, first.rows[0]?.accepted_at);

  await pg.query(
    `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
     values ($1::uuid, $2, $3)`,
    [organisationId, OWNER_USER.id, V2],
  );
  await pg.query(
    `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
     values ($1::uuid, $2, $3)`,
    [organisationId, OTHER_USER.id, V1],
  );
  const history = await pg.query<{ agreement_version: string; accepted_by_user_id: string }>(
    `select agreement_version, accepted_by_user_id
       from sbg_organisation_acceptances
      where organisation_id = $1::uuid
      order by agreement_version, accepted_by_user_id`,
    [organisationId],
  );
  assert.deepEqual(
    history.rows.map((row) => `${row.accepted_by_user_id}:${row.agreement_version}`),
    [`${OTHER_USER.id}:${V1}`, `${OWNER_USER.id}:${V1}`, `${OWNER_USER.id}:${V2}`],
  );

  await assert.rejects(
    () => pg.query("update sbg_organisation_acceptances set agreement_version = 'commercial-terms.v9'"),
    (err: unknown) => {
      assert.match(err instanceof Error ? err.message : String(err), /immutable/i);
      return true;
    },
  );
  await assert.rejects(
    () => pg.query("delete from sbg_organisation_acceptances"),
    (err: unknown) => {
      assert.match(err instanceof Error ? err.message : String(err), /immutable/i);
      return true;
    },
  );
  await assert.rejects(
    () => pg.exec("truncate sbg_organisation_acceptances"),
    (err: unknown) => {
      assert.match(err instanceof Error ? err.message : String(err), /immutable/i);
      return true;
    },
  );

  const typed = await pg.query<{ organisation_type: string | null; role: string; quantity: number; allocations: number }>(
    `select o.organisation_type,
            m.role,
            b.licensed_quantity as quantity,
            (select count(*)::int from sbg_property_licence_allocations) as allocations
       from sbg_organisations o
       join sbg_organisation_members m on m.organisation_id = o.id
       join sbg_organisation_billing b on b.organisation_id = o.id
      where o.id = $1::uuid`,
    [organisationId],
  );
  assert.equal(typed.rows[0]?.organisation_type, null);
  assert.equal(typed.rows[0]?.role, "member");
  assert.equal(typed.rows[0]?.quantity, 3);
  assert.equal(typed.rows[0]?.allocations, 0);

  const booleans = await pg.query<{ n: number }>(
    `select count(*)::int as n
       from information_schema.columns
      where table_name = 'sbg_organisation_acceptances'
        and (data_type = 'boolean' or column_name = 'terms_accepted')`,
  );
  assert.equal(booleans.rows[0]?.n, 0);

  const firstHotel = await createHotelForUser(pg, OWNER_USER.id, {
    code: "sbg-test-accept-one",
    name: "One",
    locality: "Kos",
    ianaTimezone: "Europe/Athens",
    currency: "EUR",
  });
  const secondHotel = await createHotelForUser(pg, OWNER_USER.id, {
    code: "sbg-test-accept-two",
    name: "Two",
    locality: "Kos",
    ianaTimezone: "Europe/Athens",
    currency: "EUR",
  });
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    OWNER_USER.id,
    organisationId,
    firstHotel.hotelId,
  ]);
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    OWNER_USER.id,
    organisationId,
    secondHotel.hotelId,
  ]);
  const hotels = await pg.query<{ n: number }>(
    "select count(*)::int as n from hotels where organisation_id = $1::uuid",
    [organisationId],
  );
  const acceptances = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_organisation_acceptances where organisation_id = $1::uuid",
    [organisationId],
  );
  assert.equal(hotels.rows[0]?.n, 2);
  assert.equal(acceptances.rows[0]?.n, 3);
});
