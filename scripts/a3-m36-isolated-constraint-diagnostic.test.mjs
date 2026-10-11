/**
 * A3-M36 constraint diagnostic. No Neon connection is opened.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { INSTALL_CONFIRMATION } from "./a3-m36-isolated-install.mjs";
import { CONCURRENCY_CONFIRMATION } from "./a3-m36-isolated-concurrency.mjs";
import { RECOVERY_CONFIRMATION } from "./a3-m36-isolated-recovery.mjs";
import { CONFIRMATION as PREFLIGHT_CONFIRMATION, EXPECTED_BRANCH, EXPECTED_DATABASE, EXPECTED_PROJECT, EXPECTED_ROLE, FORBIDDEN_ENDPOINT } from "./a3-m36-isolated-preflight.mjs";
import {
  AUTOMATIC_NOT_NULL_DEFINITION,
  AUTOMATIC_NOT_NULL_NAME,
  CONSTRAINT_SQL,
  DIAGNOSTIC_CONFIRMATION,
  RECOMMENDATION_AUTOMATIC,
  VERDICT_AUTOMATIC,
  VERDICT_MISSING,
  VERDICT_THREE,
  VERDICT_UNEXPECTED,
  classifyApprovalConstraints,
  expectedConstraintsFrom0035,
  runDiagnostic,
} from "./a3-m36-isolated-constraint-diagnostic.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "scripts/a3-m36-isolated-constraint-diagnostic.mjs"), "utf8");
const equivalence = readFileSync(join(root, "scripts/a3-m36-0035-equivalence.mjs"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/a3-m36-isolated-constraint-diagnostic.yml"), "utf8");
const sql35 = readFileSync(join(root, "migrations/0035_cp3005e2d2d_founding_property.sql"), "utf8");
const ENDPOINT = "ep-damp-dust-b1rdfp34";
const OWNER_URL = `postgres://${EXPECTED_ROLE}:secret@${ENDPOINT}.eu-central-1.aws.neon.tech/${EXPECTED_DATABASE}`;
const expected = expectedConstraintsFrom0035(sql35);

const PRIMARY = {
  name: "sbg_approved_property_agreement_versions_pkey",
  type: "p",
  validated: true,
  is_local: true,
  inherit_count: 0,
  columns: "agreement_version",
  definition: "PRIMARY KEY (agreement_version)",
};
const TOKEN = {
  name: "sbg_approved_property_agreement_versions_token",
  type: "c",
  validated: true,
  is_local: true,
  inherit_count: 0,
  columns: "agreement_version",
  definition: "CHECK (agreement_version ~ '^[a-z0-9][a-z0-9._/-]{0,120}$'::text)",
};
const PROVISIONAL = {
  name: "sbg_approved_property_agreement_versions_not_provisional",
  type: "c",
  validated: true,
  is_local: true,
  inherit_count: 0,
  columns: "agreement_version",
  definition: "CHECK (agreement_version <> 'terms-v1'::text)",
};
const NOT_NULL = {
  name: AUTOMATIC_NOT_NULL_NAME,
  type: "n",
  validated: true,
  is_local: true,
  inherit_count: 0,
  columns: "agreement_version",
  definition: AUTOMATIC_NOT_NULL_DEFINITION,
};

function identity(overrides = {}) {
  return {
    database: EXPECTED_DATABASE,
    current_user: EXPECTED_ROLE,
    session_user: EXPECTED_ROLE,
    project_id: EXPECTED_PROJECT,
    branch_id: EXPECTED_BRANCH,
    endpoint_id: ENDPOINT,
    ...overrides,
  };
}

function fakeDb({ rows = [NOT_NULL, PROVISIONAL, PRIMARY, TOKEN], version = "180003", present = true, identityRow = identity() } = {}) {
  const queries = [];
  const db = {
    queries,
    async connect() {},
    async query(text) {
      const sql = String(text);
      queries.push(sql);
      if (sql.startsWith("set ") || sql === "begin read only" || sql === "rollback") return { rows: [] };
      if (sql.includes("neon.project_id")) return { rows: [identityRow] };
      if (sql.includes("server_version")) return { rows: [{ server_version: "18.3", server_version_num: version }] };
      if (sql.includes("to_regclass")) return { rows: [{ present }] };
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ column_name: "agreement_version", data_type: "text", is_nullable: "NO" }] };
      }
      if (sql.includes("pg_get_constraintdef")) return { rows };
      throw new Error(`unexpected sql: ${sql.slice(0, 120)}`);
    },
    async end() {
      this.ended = true;
    },
  };
  return db;
}

function env(overrides = {}) {
  return {
    A3M36_CONSTRAINT_CONFIRMATION: DIAGNOSTIC_CONFIRMATION,
    AETHER_0036_ISOLATED_OWNER_URL: OWNER_URL,
    ...overrides,
  };
}

test("the diagnostic is manual, read-only, and does not weaken the three 0035 checks", () => {
  assert.notEqual(DIAGNOSTIC_CONFIRMATION, INSTALL_CONFIRMATION);
  assert.notEqual(DIAGNOSTIC_CONFIRMATION, CONCURRENCY_CONFIRMATION);
  assert.notEqual(DIAGNOSTIC_CONFIRMATION, RECOVERY_CONFIRMATION);
  assert.notEqual(DIAGNOSTIC_CONFIRMATION, PREFLIGHT_CONFIRMATION);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /DIAGNOSE-0036-CONSTRAINTS/);
  assert.match(workflow, /node scripts\/a3-m36-isolated-constraint-diagnostic\.mjs/);
  assert.match(workflow, /secrets\.AETHER_0036_ISOLATED_OWNER_URL/);
  assert.doesNotMatch(workflow, /DATABASE_URL|AETHER_DATABASE_OWNER_URL|NEON_API_KEY|0026/);
  assert.doesNotMatch(workflow, /echo "\$AETHER_0036_ISOLATED_OWNER_URL"|set -x/);
  assert.match(src, /pg_constraint/);
  assert.match(src, /pg_get_constraintdef/);
  assert.match(CONSTRAINT_SQL, /pg_get_constraintdef/);
  assert.doesNotMatch(src, /\b(insert into|update |delete from|alter table|create table|create unique|drop )\b/i);
  assert.doesNotMatch(src, /runInstall\(|runConcurrency\(|cleanupFixtures\(/);
  assert.match(equivalence, /constraint-primary-key/);
  assert.match(equivalence, /constraint-token/);
  assert.match(equivalence, /constraint-provisional/);
  assert.match(equivalence, /isPostgres18AutomaticNotNull/);
  assert.doesNotMatch(equivalence, /constraints\.length !== 3/);
  assert.equal(AUTOMATIC_NOT_NULL_NAME.length, 63);
  assert.ok(expected);
});

test("a rejected confirmation, production host, or forbidden credential does not connect", async () => {
  let connects = 0;
  const connect = () => {
    connects += 1;
    throw new Error("connect");
  };
  const phrase = await runDiagnostic({
    env: env({ A3M36_CONSTRAINT_CONFIRMATION: INSTALL_CONFIRMATION }),
    connect,
  });
  assert.equal(phrase.exitCode, 1);
  assert.match(phrase.lines.join("\n"), /CONFIRMATION PHRASE INVALID/);
  const host = await runDiagnostic({
    env: env({
      AETHER_0036_ISOLATED_OWNER_URL: `postgres://${EXPECTED_ROLE}:secret@${FORBIDDEN_ENDPOINT}.eu.neon.tech/neondb`,
    }),
    connect,
  });
  assert.match(host.lines.join("\n"), /production-endpoint/);
  const fallback = await runDiagnostic({
    env: env({ DATABASE_URL: OWNER_URL }),
    connect,
  });
  assert.match(fallback.lines.join("\n"), /DATABASE_URL must not be set/);
  const digest = await runDiagnostic({
    env: env(),
    connect,
    readSql: async () => "create table altered ();",
  });
  assert.match(digest.lines.join("\n"), /digest_0035: mismatch/);
  assert.equal(connects, 0);
  assert.doesNotMatch(`${phrase.lines.join("\n")}\n${host.lines.join("\n")}`, /secret/);
});

test("an identity mismatch rolls back before the constraint catalogue is read", async () => {
  const db = fakeDb({ identityRow: identity({ project_id: "other-project" }) });
  const result = await runDiagnostic({ env: env(), connect: async () => db });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join("\n"), /BLOCKED — ISOLATED IDENTITY/);
  assert.equal(db.queries.some((sql) => sql.includes("pg_get_constraintdef")), false);
  assert.equal(db.queries.includes("rollback"), true);
  assert.equal(db.queries.includes("commit"), false);
});

test("the postgresql 18 not-null row is classified without changing the verifier", async () => {
  const db = fakeDb();
  const result = await runDiagnostic({ env: env(), connect: async () => db });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 0);
  assert.match(text, /isolated_identity: PASS/);
  assert.match(text, /constraint_count: 4/);
  assert.match(text, new RegExp(`name=${AUTOMATIC_NOT_NULL_NAME} type=n \\(not-null\\) validated=true`));
  assert.match(text, /origin=automatically-generated-postgresql-constraint/);
  assert.match(text, /0035_primary-key: pass/);
  assert.match(text, /0035_token: pass/);
  assert.match(text, /0035_provisional: pass/);
  assert.match(text, /verifier_change_recommended: true/);
  assert.match(text, /verifier_changed: false/);
  assert.match(text, /transaction: read-only-rolled-back/);
  assert.match(text, new RegExp(VERDICT_AUTOMATIC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /Do not replace the count check with a minimum of three/);
  assert.equal(db.queries.includes("commit"), false);
  assert.equal(db.ended, true);
  const classified = classifyApprovalConstraints([NOT_NULL, PROVISIONAL, PRIMARY, TOKEN], {
    serverVersionNum: "180003",
    expected,
  });
  assert.equal(classified.recommendVerifierChange, true);
  assert.equal(classified.reason, RECOMMENDATION_AUTOMATIC);
});

test("any other extra constraint or a missing mandatory check does not recommend a verifier change", () => {
  const unique = {
    name: "sbg_approved_property_agreement_versions_extra",
    type: "u",
    validated: true,
    columns: "agreement_version",
    definition: "UNIQUE (agreement_version)",
  };
  const extra = classifyApprovalConstraints([NOT_NULL, PROVISIONAL, PRIMARY, TOKEN, unique], {
    serverVersionNum: 180003,
    expected,
  });
  assert.equal(extra.verdict, VERDICT_UNEXPECTED);
  assert.equal(extra.recommendVerifierChange, false);
  const renamed = classifyApprovalConstraints([{ ...NOT_NULL, name: "agreement_version_not_null" }, PROVISIONAL, PRIMARY, TOKEN], {
    serverVersionNum: 180003,
    expected,
  });
  assert.equal(renamed.recommendVerifierChange, false);
  assert.equal(renamed.rows.find((row) => row.type === "n").class, "not-null-name-differs");
  const oldServer = classifyApprovalConstraints([NOT_NULL, PROVISIONAL, PRIMARY, TOKEN], {
    serverVersionNum: 170007,
    expected,
  });
  assert.equal(oldServer.recommendVerifierChange, false);
  assert.equal(oldServer.rows.find((row) => row.type === "n").origin, "unexpected-database-modification");
  const missing = classifyApprovalConstraints([PRIMARY, TOKEN], { serverVersionNum: 180003, expected });
  assert.equal(missing.verdict, VERDICT_MISSING);
  assert.equal(missing.recommendVerifierChange, false);
  const exact = classifyApprovalConstraints([PROVISIONAL, PRIMARY, TOKEN], { serverVersionNum: 180003, expected });
  assert.equal(exact.verdict, VERDICT_THREE);
  assert.equal(exact.wouldFailConstraintCount, false);
  assert.equal(exact.recommendVerifierChange, false);
});

test("creating only the 0035 table on postgresql 18 yields the automatic not-null constraint", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const start = sql35.indexOf("create table if not exists sbg_approved_property_agreement_versions");
  const end = sql35.indexOf("comment on table sbg_approved_property_agreement_versions", start);
  const pg = new PGlite();
  try {
    const version = await pg.query("select current_setting('server_version_num') as server_version_num");
    await pg.query(sql35.slice(start, end));
    const rows = await pg.query(CONSTRAINT_SQL);
    const classified = classifyApprovalConstraints(rows.rows, {
      serverVersionNum: version.rows[0].server_version_num,
      expected,
    });
    assert.equal(classified.count, 4);
    assert.equal(classified.verdict, VERDICT_AUTOMATIC);
    assert.equal(classified.recommendVerifierChange, true);
    assert.equal(classified.mandatory.every((item) => item.present && item.definitionOk && item.validated), true);
    const extra = classified.extras[0];
    assert.equal(extra.name, AUTOMATIC_NOT_NULL_NAME);
    assert.equal(extra.type, "n");
    assert.equal(extra.validated, true);
    assert.equal(extra.definition, AUTOMATIC_NOT_NULL_DEFINITION);
    assert.equal(extra.origin, "automatically-generated-postgresql-constraint");
  } finally {
    await pg.close();
  }
});
