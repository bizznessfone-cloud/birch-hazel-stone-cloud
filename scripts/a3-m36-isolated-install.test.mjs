/**
 * A3-M36 isolated installer. No database is opened.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING } from "./production-db-preflight.mjs";
import {
  DIGEST_36,
  MIGRATION_33,
  MIGRATION_35,
  MIGRATION_36,
  assess0035Equivalence,
  expectedFromSources,
  installDecision,
  ledgerDisposition,
  sha256,
} from "./a3-m36-0035-equivalence.mjs";
import {
  ALREADY_APPLIED,
  APPLIED,
  INSTALL_CONFIRMATION,
  endpointPinFailures,
  runInstall,
} from "./a3-m36-isolated-install.mjs";
import { CONFIRMATION as PREFLIGHT_CONFIRMATION, EXPECTED_BRANCH, EXPECTED_DATABASE, EXPECTED_PROJECT, EXPECTED_ROLE } from "./a3-m36-isolated-preflight.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql35 = readFileSync(join(root, "migrations", MIGRATION_35), "utf8");
const sql33 = readFileSync(join(root, "migrations", MIGRATION_33), "utf8");
const sql36 = readFileSync(join(root, "migrations", MIGRATION_36), "utf8");
const expected = expectedFromSources(sql35, sql33);
const ENDPOINT = "ep-damp-dust-b1rdfp34";
const HOST = `${ENDPOINT}.eu-central-1.aws.neon.tech`;
const OWNER_URL = `postgres://${EXPECTED_ROLE}:secret@${HOST}/${EXPECTED_DATABASE}?sslmode=require`;
const workflow = readFileSync(join(root, ".github/workflows/a3-m36-isolated-install.yml"), "utf8");
const preflightWorkflow = readFileSync(join(root, ".github/workflows/a3-m36-isolated-verification.yml"), "utf8");

function sources(overrides = {}) {
  return async () => ({ sql35, sql33, sql36, ...overrides });
}

function functionRows() {
  return [
    {
      proname: "sbg_create_organisation_for_user",
      args: "p_user_id text, p_name text",
      result: "uuid",
      language: "plpgsql",
      security_definer: true,
      prosrc: expected.createBody,
      comment: expected.createComment,
      search_path: "public, pg_temp",
    },
    {
      proname: "sbg_create_founding_property_for_user",
      args: "p_user_id text, p_code text, p_name text, p_locality text, p_iana_timezone text, p_currency text",
      result: "TABLE(hotel_id uuid, provider_id uuid)",
      language: "plpgsql",
      security_definer: true,
      prosrc: expected.propertyBody,
      comment: expected.propertyComment,
      search_path: "pg_catalog, public",
    },
    {
      proname: "sbg_ensure_founding_organisation",
      args: "p_user_id text, p_name text",
      result: "TABLE(organisation_id uuid, name text, organisation_type text)",
      language: "plpgsql",
      security_definer: true,
      prosrc: expected.ensureBody,
      comment: expected.ensureComment,
      search_path: "pg_catalog, public",
    },
  ];
}

function privileges() {
  return {
    app_property: true,
    runtime_property: false,
    public_property: false,
    app_creator: true,
    runtime_creator: false,
    app_ensure: true,
    runtime_ensure: false,
    app_select: false,
    app_insert: false,
    app_update: false,
    app_delete: false,
  };
}

function baseLedger() {
  return ACCEPTED_LEDGER.map((name) => ({ name }));
}

function fakeDb(state) {
  const queries = [];
  const db = {
    queries,
    ended: false,
    async query(text, params) {
      const sql = String(text);
      queries.push({ text: sql, params });
      if (sql.includes("sbg_organisations_one_founding_creator_uidx") && sql.includes("create unique index")) {
        state.installed = true;
        return { rows: [] };
      }
      if (sql.includes("insert into public._migrations")) {
        state.ledgered = true;
        state.inserted = params;
        return { rows: [] };
      }
      if (sql === "begin read only" || sql === "begin" || sql === "rollback" || sql === "commit" || sql.startsWith("lock table")) {
        if (sql === "commit") state.committed = true;
        if (sql === "rollback") state.rolledBack = true;
        return { rows: [] };
      }
      if (sql.includes("neon.project_id")) {
        return { rows: [{
          database: EXPECTED_DATABASE,
          current_user: EXPECTED_ROLE,
          session_user: EXPECTED_ROLE,
          project_id: EXPECTED_PROJECT,
          branch_id: EXPECTED_BRANCH,
          endpoint_id: ENDPOINT,
        }] };
      }
      if (sql.includes("pg_get_function_identity_arguments")) return { rows: functionRows() };
      if (sql.includes("pg_get_constraintdef")) {
        return { rows: [
          { name: "sbg_approved_property_agreement_versions_not_provisional", def: "CHECK ((agreement_version <> 'terms-v1'::text))" },
          { name: "sbg_approved_property_agreement_versions_pkey", def: "PRIMARY KEY (agreement_version)" },
          { name: "sbg_approved_property_agreement_versions_token", def: "CHECK ((agreement_version ~ '^[a-z0-9][a-z0-9._/-]{0,120}$'::text))" },
        ] };
      }
      if (sql.includes("ordinal_position")) {
        return { rows: [{ name: "agreement_version", data_type: "text", is_nullable: "NO" }] };
      }
      if (sql.includes("pg_class')")) return { rows: [{ comment: expected.tableComment }] };
      if (sql.includes("has_function_privilege")) return { rows: [privileges()] };
      if (sql.includes("creator_index")) {
        const on = state.installed === true;
        return { rows: [{ creator_index: on, effective_column: on, effective_index: on }] };
      }
      if (sql.includes("having count(*) > 1")) return { rows: [{ n: state.duplicates ?? 0 }] };
      if (sql.includes("from public.hotels")) return { rows: [{ organisations: 2, hotels: 11 }] };
      if (sql.includes("from public._migrations")) {
        const names = state.ledgered ? [...ACCEPTED_LEDGER, ...(state.include35 ? [MIGRATION_35] : []), MIGRATION_36] : [...ACCEPTED_LEDGER, ...(state.include35 ? [MIGRATION_35] : [])];
        return { rows: names.map((name) => ({ name })) };
      }
      if (sql.includes("requires_effective")) {
        const on = state.installed === true;
        return { rows: [
          { proname: "sbg_create_organisation_for_user", rejects_second: on, requires_effective: false },
          { proname: "sbg_create_founding_property_for_user", rejects_second: false, requires_effective: on },
        ] };
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 140)}`);
    },
    async end() {
      this.ended = true;
    },
  };
  return db;
}

function env(overrides = {}) {
  return {
    A3M36_INSTALL_CONFIRMATION: INSTALL_CONFIRMATION,
    AETHER_0036_ISOLATED_OWNER_URL: OWNER_URL,
    ...overrides,
  };
}

test("reviewed 0035 objects match the source files and a drift blocks", () => {
  assert.equal(sha256(sql36), DIGEST_36);
  assert.equal(expected.digest35, sha256(sql35));
  assert.ok(expected.createBody.includes("for update"));
  assert.equal(expected.createBody.includes("founding organisation already exists"), false);
  assert.ok(expected.propertyBody.includes("terms are not approved for property creation"));
  assert.equal(expected.propertyBody.includes("v.effective"), false);
  const catalog = {
    functions: Object.fromEntries(functionRows().map((row) => [row.proname, {
      args: row.args,
      result: row.result,
      language: row.language,
      securityDefiner: true,
      searchPath: row.search_path,
      prosrc: row.prosrc,
      comment: row.comment,
    }])),
    columns: [{ name: "agreement_version", dataType: "text", nullable: false }],
    constraints: [
      { name: "sbg_approved_property_agreement_versions_pkey", def: "PRIMARY KEY (agreement_version)" },
      { name: "sbg_approved_property_agreement_versions_token", def: "CHECK ((agreement_version ~ '^[a-z0-9][a-z0-9._/-]{0,120}$'::text))" },
      { name: "sbg_approved_property_agreement_versions_not_provisional", def: "CHECK ((agreement_version <> 'terms-v1'::text))" },
    ],
    tableComment: expected.tableComment,
    privileges: privileges(),
    creatorIndex: false,
    effectiveColumn: false,
    effectiveIndex: false,
  };
  assert.equal(assess0035Equivalence(sql35, sql33, catalog).ok, true);
  catalog.functions.sbg_create_organisation_for_user.prosrc += "\n-- drifted";
  const drifted = assess0035Equivalence(sql35, sql33, catalog);
  assert.equal(drifted.ok, false);
  assert.ok(drifted.failures.includes("function-create"));
});

test("ledger handling never backfills 0035", () => {
  const missing = ledgerDisposition(ACCEPTED_LEDGER);
  assert.equal(missing.ok, true);
  assert.equal(missing.reason, "0035-unledgered");
  assert.equal(missing.insert0035, false);
  assert.equal(missing.insert0036, true);
  assert.equal(missing.genericMigratorSafe, false);
  const present = ledgerDisposition([...ACCEPTED_LEDGER, MIGRATION_35]);
  assert.equal(present.reason, "0035-ledgered");
  assert.equal(present.insert0035, false);
  assert.equal(present.genericMigratorSafe, true);
  assert.equal(ledgerDisposition([...ACCEPTED_LEDGER, "0037_future.sql"]).ok, false);
  assert.equal(ledgerDisposition(ACCEPTED_LEDGER.slice(0, -1)).reason, "missing-accepted-ledger");
  const apply = installDecision({
    equivalenceOk: true,
    ledger: missing,
    duplicateCreators: 0,
    schema36: "absent",
    functions36: "absent",
  });
  assert.equal(apply.action, "apply");
  assert.equal(apply.insert0035, false);
  assert.equal(installDecision({
    equivalenceOk: false,
    ledger: missing,
    duplicateCreators: 0,
    schema36: "absent",
    functions36: "absent",
  }).verdict, "BLOCKED — 0035 EQUIVALENCE FAILED");
  assert.equal(installDecision({
    equivalenceOk: true,
    ledger: ledgerDisposition([...ACCEPTED_LEDGER, MIGRATION_36]),
    duplicateCreators: 0,
    schema36: "present",
    functions36: "present",
  }).verdict, ALREADY_APPLIED);
  assert.equal(installDecision({
    equivalenceOk: true,
    ledger: missing,
    duplicateCreators: 0,
    schema36: "present",
    functions36: "absent",
  }).verdict, "BLOCKED — 0036 PARTIAL");
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(baseLedger().length, ACCEPTED_LEDGER.length);
});

test("the install workflow is manual and distinct from preflight", () => {
  assert.equal(INSTALL_CONFIRMATION === PREFLIGHT_CONFIRMATION, false);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /INSTALL-0036-ISOLATED/);
  assert.match(workflow, /secrets\.AETHER_0036_ISOLATED_OWNER_URL/);
  assert.match(workflow, /node scripts\/a3-m36-isolated-install\.mjs/);
  assert.doesNotMatch(workflow, /DATABASE_URL|AETHER_DATABASE_OWNER_URL|NEON_API_KEY|0026/);
  assert.doesNotMatch(workflow, /echo "\$AETHER_0036_ISOLATED_OWNER_URL"|set -x/);
  assert.match(preflightWorkflow, /PREFLIGHT-0036-ISOLATED/);
  assert.doesNotMatch(preflightWorkflow, /a3-m36-isolated-install/);
  assert.equal(endpointPinFailures(OWNER_URL).length, 0);
  assert.ok(endpointPinFailures(`postgres://${EXPECTED_ROLE}:secret@ep-withered-haze-b1fd9hse.eu.neon.tech/neondb`).includes("production-endpoint"));
});

test("a bad phrase, a production host, or a digest mismatch does not connect", async () => {
  let connects = 0;
  const connect = async () => {
    connects += 1;
    throw new Error("connect");
  };
  const phrase = await runInstall({ env: env({ A3M36_INSTALL_CONFIRMATION: PREFLIGHT_CONFIRMATION }), connect, readSources: sources() });
  assert.equal(phrase.exitCode, 1);
  assert.match(phrase.lines.join("\n"), /CONFIRMATION PHRASE INVALID/);
  const fallback = await runInstall({ env: env({ DATABASE_URL: OWNER_URL }), connect, readSources: sources() });
  assert.match(fallback.lines.join("\n"), /DATABASE_URL must not be set/);
  const host = await runInstall({
    env: env({ AETHER_0036_ISOLATED_OWNER_URL: `postgres://${EXPECTED_ROLE}:secret@ep-other.eu.neon.tech/neondb` }),
    connect,
    readSources: sources(),
  });
  assert.match(host.lines.join("\n"), /endpoint-pin/);
  const digest = await runInstall({ env: env(), connect, readSources: async () => ({ sql35, sql33, sql36: `${sql36}\n` }) });
  assert.match(digest.lines.join("\n"), /0036 DIGEST MISMATCH/);
  assert.equal(connects, 0);
  assert.doesNotMatch(digest.lines.join("\n"), /secret/);
});

test("equivalent unledgered 0035 installs only 0036 in one transaction", async () => {
  const state = { installed: false, ledgered: false, include35: false, duplicates: 0 };
  const db = fakeDb(state);
  const result = await runInstall({ env: env(), connect: async () => db, readSources: sources() });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 0, text);
  assert.match(text, /0035_equivalence: pass/);
  assert.match(text, /ledger_disposition: 0035-unledgered/);
  assert.match(text, /ledger_0035_insert: refused/);
  assert.match(text, /generic_migrator_safe: false/);
  assert.match(text, new RegExp(APPLIED));
  assert.equal(state.committed, true);
  assert.deepEqual(state.inserted, [MIGRATION_36]);
  assert.equal(db.queries.filter((query) => query.text.includes("insert into public._migrations")).length, 1);
  assert.equal(db.queries.some((query) => query.text.includes("$m35lock$")), false);
  assert.equal(db.queries.filter((query) => query.text === "commit").length, 1);
  assert.equal(db.ended, true);
  assert.doesNotMatch(text, /secret/);
});

test("a ledgered 0035 still is not replayed, and a drift or a partial 0036 does not commit", async () => {
  const ledgered = { installed: false, ledgered: false, include35: true, duplicates: 0 };
  const ledgeredDb = fakeDb(ledgered);
  const ledgeredResult = await runInstall({ env: env(), connect: async () => ledgeredDb, readSources: sources() });
  assert.equal(ledgeredResult.exitCode, 0, ledgeredResult.lines.join("\n"));
  assert.match(ledgeredResult.lines.join("\n"), /generic_migrator_safe: true/);
  assert.equal(ledgeredDb.queries.some((query) => query.text.includes("$m35lock$")), false);

  const mutated = await runInstall({
    env: env(),
    connect: async () => fakeDb({ installed: false, ledgered: false, include35: false, duplicates: 0 }),
    readSources: async () => ({ sql35: sql35.replaceAll("account not found", "account missing"), sql33, sql36 }),
  });
  assert.equal(mutated.exitCode, 1);
  assert.match(mutated.lines.join("\n"), /BLOCKED — 0035 EQUIVALENCE FAILED/);
  assert.equal(mutated.lines.includes(APPLIED), false);

  const partialDb = fakeDb({ installed: false, ledgered: false, include35: false, duplicates: 0 });
  const real = partialDb.query.bind(partialDb);
  partialDb.query = async (text, params) => {
    if (String(text).includes("creator_index")) return { rows: [{ creator_index: true, effective_column: false, effective_index: false }] };
    return real(text, params);
  };
  const partialResult = await runInstall({ env: env(), connect: async () => partialDb, readSources: sources() });
  assert.match(partialResult.lines.join("\n"), /BLOCKED — 0036 PARTIAL/);
  assert.equal(partialResult.lines.some((line) => line === "transaction: committed"), false);

  const naked = fakeDb({ installed: true, ledgered: false, include35: false, duplicates: 0 });
  const nakedResult = await runInstall({ env: env(), connect: async () => naked, readSources: sources() });
  assert.match(nakedResult.lines.join("\n"), /0036 OBJECTS WITHOUT LEDGER/);
  assert.equal(naked.queries.some((query) => query.text === "commit"), false);
});
