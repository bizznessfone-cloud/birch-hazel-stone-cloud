/**
 * A3-M36 recovery preflight. No database is opened.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ACCEPTED_LEDGER } from "./production-db-preflight.mjs";
import { MIGRATION_36 } from "./a3-m36-0035-equivalence.mjs";
import { INSTALL_CONFIRMATION } from "./a3-m36-isolated-install.mjs";
import { CONCURRENCY_CONFIRMATION } from "./a3-m36-isolated-concurrency.mjs";
import { RECOVERY_CONFIRMATION } from "./a3-m36-isolated-recovery.mjs";
import { CONFIRMATION as ISOLATED_PREFLIGHT } from "./a3-m36-isolated-preflight.mjs";
import { EXPECTED_BRANCH, EXPECTED_DATABASE, EXPECTED_PROJECT, EXPECTED_ROLE, FORBIDDEN_ENDPOINT } from "./a3-m36-isolated-preflight.mjs";
import { EXPECTED_EDGES, FIXTURE_EFFECTIVE, REQUIRED_TRIGGERS, mapCleanupCatalog } from "./a3-m36-isolated-cleanup.mjs";
import { EXPECTED_DELETE, NOT_LEGAL, PREFLIGHT_CONFIRMATION, VERDICT_NOT_SAFE, VERDICT_RECOVERY_ONLY, VERDICT_SAFE, foreignKeyStatus, runRecoveryPreflight } from "./a3-m36-isolated-recovery-preflight.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "scripts/a3-m36-isolated-recovery-preflight.mjs"), "utf8");
const cleanup = readFileSync(join(root, "scripts/a3-m36-isolated-cleanup.mjs"), "utf8");
const recovery = readFileSync(join(root, "scripts/a3-m36-isolated-recovery.mjs"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/a3-m36-isolated-recovery-preflight.yml"), "utf8");
const ENDPOINT = "ep-damp-dust-b1rdfp34";
const OWNER_URL = `postgres://${EXPECTED_ROLE}:secret@${ENDPOINT}.eu-central-1.aws.neon.tech/${EXPECTED_DATABASE}`;
const USER_ID = "a3m36-one";
const ORG_ID = "11111111-1111-4111-8111-111111111111";

function edges() {
  return EXPECTED_EDGES.map((edge) => ({
    child_schema: "public",
    child_table: edge.child,
    parent_table: edge.parent,
    constraint_name: `${edge.child}_${edge.column}_fkey`,
    delete_action: EXPECTED_DELETE[`${edge.child}→${edge.parent}`],
    child_columns: [edge.column],
    parent_columns: ["id"],
  }));
}

function fakeDb(state = {}) {
  const queries = [];
  const db = {
    queries,
    ended: false,
    async query(text) {
      const sql = String(text);
      queries.push(sql);
      if (/\b(insert into|update |delete from|alter table|commit|truncate)\b/i.test(sql)) throw new Error(`write ${sql.slice(0, 60)}`);
      if (sql === "begin read only" || sql === "rollback") return { rows: [] };
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
      if (sql.includes("a3m36-trigger-guard")) return { rows: REQUIRED_TRIGGERS.map((tgname) => ({ tgname, tgenabled: "O" })) };
      if (sql.includes("a3m36-load-users")) return { rows: state.users ?? [] };
      if (sql.includes("a3m36-load-orgs")) return { rows: state.orgs ?? [] };
      if (sql.includes("a3m36-load-hotels")) return { rows: [] };
      if (sql.includes("a3m36-load-providers")) return { rows: [] };
      if (sql.includes("a3m36-load-agreements")) return { rows: [] };
      if (sql.includes("a3m36-load-accounts")) return { rows: [] };
      if (sql.includes("a3m36-load-members")) return { rows: state.members ?? [] };
      if (sql.includes("a3m36-load-acceptances")) return { rows: state.acceptances ?? [] };
      if (sql.includes("a3m36-load-approvals")) return { rows: state.approvals ?? [] };
      if (sql.includes("a3m36-foreign-keys")) return { rows: state.foreignKeys ?? edges() };
      if (sql.includes("a3m36-residual")) return { rows: [{ n: 0 }] };
      if (sql.includes("a3m36-approval-catalogue")) return { rows: state.catalogue ?? [] };
      if (sql.includes("a3m36-acceptance-versions")) return { rows: state.acceptanceVersions ?? [] };
      if (sql.includes("a3m36-0036-objects")) {
        return { rows: [{ creator_index: true, effective_column: true, effective_index: true, rejects_second: true, requires_effective: true }] };
      }
      if (sql.includes("a3m36-ledger")) return { rows: [...ACCEPTED_LEDGER, MIGRATION_36].map((name) => ({ name })) };
      if (sql.includes("a3m36-duplicate-creators")) return { rows: [{ n: 0 }] };
      throw new Error(`unexpected sql: ${sql.slice(0, 180)}`);
    },
    async end() {
      this.ended = true;
    },
  };
  return db;
}

function env(overrides = {}) {
  return {
    A3M36_RECOVERY_PREFLIGHT_CONFIRMATION: PREFLIGHT_CONFIRMATION,
    AETHER_0036_ISOLATED_OWNER_URL: OWNER_URL,
    ...overrides,
  };
}

test("the recovery preflight is manual, read-only, and does not weaken recovery", () => {
  assert.notEqual(PREFLIGHT_CONFIRMATION, RECOVERY_CONFIRMATION);
  assert.notEqual(PREFLIGHT_CONFIRMATION, CONCURRENCY_CONFIRMATION);
  assert.notEqual(PREFLIGHT_CONFIRMATION, INSTALL_CONFIRMATION);
  assert.notEqual(PREFLIGHT_CONFIRMATION, ISOLATED_PREFLIGHT);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /PREFLIGHT-0036-RECOVERY/);
  assert.match(workflow, /node scripts\/a3-m36-isolated-recovery-preflight\.mjs/);
  assert.doesNotMatch(workflow, /a3-m36-isolated-recovery\.mjs/);
  assert.doesNotMatch(workflow, /DATABASE_URL|AETHER_DATABASE_OWNER_URL|NEON_API_KEY|0026/);
  assert.match(src, /begin read only/);
  assert.match(src, /planFixtureCleanup/);
  assert.doesNotMatch(src, /cleanupFixtures\(|runRecovery\(|runInstall\(|runConcurrency\(/);
  assert.doesNotMatch(src, /\b(insert into|update |delete from|alter table|truncate |create table|create unique|create index)\b/i);
  assert.doesNotMatch(src, /disable trigger|enable trigger|session_replication_role/i);
  assert.match(cleanup, /export async function planFixtureCleanup/);
  assert.match(cleanup, /export async function cleanupFixtures/);
  assert.match(recovery, /cleanupFixtures\(db, \{ discover: true, approvals: true \}\)/);
  assert.doesNotMatch(recovery, /planFixtureCleanup/);
});

test("a rejected confirmation, production host, or forbidden credential does not connect", async () => {
  let connects = 0;
  const connect = () => {
    connects += 1;
    throw new Error("connect");
  };
  const phrase = await runRecoveryPreflight({
    env: env({ A3M36_RECOVERY_PREFLIGHT_CONFIRMATION: RECOVERY_CONFIRMATION }),
    connect,
  });
  assert.equal(phrase.exitCode, 1);
  assert.match(phrase.lines.join("\n"), /CONFIRMATION PHRASE INVALID/);
  const host = await runRecoveryPreflight({
    env: env({ AETHER_0036_ISOLATED_OWNER_URL: `postgres://${EXPECTED_ROLE}:secret@${FORBIDDEN_ENDPOINT}.eu.neon.tech/neondb` }),
    connect,
  });
  assert.match(host.lines.join("\n"), /production-endpoint/);
  const fallback = await runRecoveryPreflight({ env: env({ DATABASE_URL: OWNER_URL }), connect });
  assert.match(fallback.lines.join("\n"), /DATABASE_URL must not be set/);
  assert.equal(connects, 0);
});

test("raw name[] catalogue rows are recognised as the ten validated foreign keys", async () => {
  const nameArrays = EXPECTED_EDGES.map((edge) => ({
    child_schema: "public",
    child_table: edge.child,
    parent_table: edge.parent,
    constraint_name: `${edge.child}_${edge.column}_fkey`,
    delete_action: EXPECTED_DELETE[`${edge.child}→${edge.parent}`],
    child_columns: `{${edge.column}}`,
    parent_columns: "{id}",
  }));
  const db = fakeDb({ foreignKeys: nameArrays });
  const result = await runRecoveryPreflight({ env: env(), connect: async () => db });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 0, text);
  assert.match(text, /foreign_keys: pass/);
  assert.doesNotMatch(text, /foreign_key_failure:/);
  assert.match(text, new RegExp(VERDICT_SAFE));
  const missing = nameArrays.filter((row) => row.child_table !== "hotels");
  const absent = await runRecoveryPreflight({ env: env(), connect: async () => fakeDb({ foreignKeys: missing }) });
  assert.match(absent.lines.join("\n"), /foreign_keys: fail/);
  assert.match(absent.lines.join("\n"), /missing hotels→sbg_organisations\.organisation_id/);
  assert.match(absent.lines.join("\n"), new RegExp(VERDICT_NOT_SAFE));
  const mapped = mapCleanupCatalog(nameArrays);
  const hotel = mapped.find((row) => row.childTable === "hotels");
  const duplicated = foreignKeyStatus([...mapped, hotel]);
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.failures.join("\n"), /duplicate hotels→sbg_organisations\.organisation_id/);
  const composite = foreignKeyStatus(mapCleanupCatalog(nameArrays.map((row) => row.child_table === "hotels"
    ? { ...row, child_columns: "{organisation_id,extra}", parent_columns: "{id,id}" }
    : row)));
  assert.equal(composite.ok, false);
  assert.match(composite.failures.join("\n"), /missing hotels→sbg_organisations\.organisation_id/);
  const malformed = foreignKeyStatus(mapCleanupCatalog(nameArrays.map((row) => row.child_table === "hotels"
    ? { ...row, child_columns: "{" }
    : row)));
  assert.equal(malformed.ok, false);
  assert.match(malformed.failures.join("\n"), /malformed hotels_organisation_id_fkey/);
});

test("an empty catalogue is safe for recovery and concurrency", async () => {
  const db = fakeDb();
  const result = await runRecoveryPreflight({ env: env(), connect: async () => db });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 0, text);
  assert.match(text, /isolated_identity: PASS/);
  assert.match(text, /recovery_prediction: clean/);
  assert.match(text, /fixture_not_legal: absent/);
  assert.match(text, /approval_catalogue: empty/);
  assert.match(text, /foreign_keys: pass/);
  assert.match(text, /deletion_order_status: pass/);
  assert.match(text, /0036_installed: true/);
  assert.match(text, /recovery_safe: true/);
  assert.match(text, /concurrency_safe: true/);
  assert.match(text, new RegExp(VERDICT_SAFE));
  assert.equal(db.queries.some((sql) => /\b(insert into|update |delete from|commit)\b/i.test(sql)), false);
  assert.equal(db.ended, true);
});

test("fixture-not-legal is inventoried and recovery will not delete it", async () => {
  const db = fakeDb({
    catalogue: [{ agreement_version: NOT_LEGAL, effective: false }],
    acceptanceVersions: [{ agreement_version: NOT_LEGAL, n: 2 }],
  });
  const result = await runRecoveryPreflight({ env: env(), connect: async () => db });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 0, text);
  assert.match(text, /recovery_prediction: clean/);
  assert.match(text, new RegExp(`approval ${NOT_LEGAL} effective=false acceptances=2 recovery=untouched`));
  assert.match(text, /fixture_not_legal: present/);
  assert.match(text, /approval_rows_after_recovery: 1/);
  assert.match(text, /recovery_safe: false/);
  assert.match(text, /concurrency_safe: false/);
  assert.match(text, new RegExp(VERDICT_NOT_SAFE));
});

test("a fixture approval with no immutable rows would be deleted by recovery", async () => {
  const db = fakeDb({
    approvals: [{ agreement_version: FIXTURE_EFFECTIVE }],
    catalogue: [{ agreement_version: FIXTURE_EFFECTIVE, effective: true }],
  });
  const result = await runRecoveryPreflight({ env: env(), connect: async () => db });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 0, text);
  assert.match(text, /recovery_prediction: would-commit/);
  assert.match(text, new RegExp(`approval ${FIXTURE_EFFECTIVE} effective=true acceptances=0 recovery=would-delete`));
  assert.match(text, /recovery_safe: true/);
  assert.match(text, /concurrency_safe: false/);
  assert.match(text, new RegExp(VERDICT_RECOVERY_ONLY));
});

test("marker organisation rows would be preserved because recovery rolls back", async () => {
  const db = fakeDb({
    users: [{ id: USER_ID, name: "A3M36 One", email: "a3m36-proof-one@invalid.scanbookgo.test" }],
    orgs: [{ id: ORG_ID, name: "A3M36 Org", created_by_user_id: USER_ID }],
    members: [{ id: "22222222-2222-4222-8222-222222222222", organisation_id: ORG_ID, user_id: USER_ID }],
    acceptances: [{ id: "33333333-3333-4333-8333-333333333333", organisation_id: ORG_ID, user_id: USER_ID }],
  });
  const result = await runRecoveryPreflight({ env: env(), connect: async () => db });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 0, text);
  assert.match(text, /recovery_prediction: would-block/);
  assert.match(text, new RegExp(`preserve user ${USER_ID}`));
  assert.match(text, new RegExp(`preserve sbg_organisations ${ORG_ID}`));
  assert.match(text, /preserve sbg_organisation_members /);
  assert.match(text, /preserve sbg_organisation_acceptances /);
  assert.match(text, /recovery_safe: false/);
  assert.match(text, /concurrency_safe: false/);
  assert.match(text, new RegExp(VERDICT_NOT_SAFE));
  assert.equal(db.queries.some((sql) => sql === "commit"), false);
});
