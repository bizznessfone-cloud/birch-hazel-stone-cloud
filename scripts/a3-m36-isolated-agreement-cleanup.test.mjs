/**
 * A3-M36 agreement cleanup. No database is opened.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EXPECTED_BRANCH, EXPECTED_DATABASE, EXPECTED_PROJECT, EXPECTED_ROLE, FORBIDDEN_BRANCH, FORBIDDEN_ENDPOINT } from "./a3-m36-isolated-preflight.mjs";
import { EXPECTED_ENDPOINT } from "./a3-m36-0035-equivalence.mjs";
import { REQUIRED_TRIGGERS } from "./a3-m36-isolated-cleanup.mjs";
import { ACCEPTANCE_ID, NOT_LEGAL, ORGANISATION_ID, RECOVERY_BRANCH, USER_ID, VERIFIED_FACTS } from "./a3-m36-agreement-fixture-plan.mjs";
import { CLEANUP_CONFIRMATION, DELETE_SQL, VERDICT_ABSENT, VERDICT_PASS, protectedRecordFailures, runAgreementCleanup, snapshotFailures } from "./a3-m36-isolated-agreement-cleanup.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "scripts/a3-m36-isolated-agreement-cleanup.mjs"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/a3-m36-isolated-agreement-cleanup.yml"), "utf8");
const concurrency = readFileSync(join(root, "scripts/a3-m36-isolated-concurrency.mjs"), "utf8");
const OWNER_URL = `postgres://${EXPECTED_ROLE}:secret@${EXPECTED_ENDPOINT}.eu-central-1.aws.neon.tech/${EXPECTED_DATABASE}`;

function identity(overrides = {}) {
  return {
    database: EXPECTED_DATABASE,
    current_user: EXPECTED_ROLE,
    session_user: EXPECTED_ROLE,
    project_id: EXPECTED_PROJECT,
    branch_id: EXPECTED_BRANCH,
    endpoint_id: EXPECTED_ENDPOINT,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    approval_count: 1,
    effective_count: 0,
    approval_version: NOT_LEGAL,
    approval_effective: false,
    version_acceptances: 1,
    acceptance_id: ACCEPTANCE_ID,
    organisation_id: ORGANISATION_ID,
    user_id: USER_ID,
    organisations: 1,
    users: 1,
    org_hotels: VERIFIED_FACTS.orgHotels,
    user_accounts: VERIFIED_FACTS.userAccounts,
    org_members: VERIFIED_FACTS.orgMembers,
    org_acceptances: VERIFIED_FACTS.orgAcceptances,
    user_organisations: VERIFIED_FACTS.userOrganisations,
    user_memberships: VERIFIED_FACTS.userMemberships,
    user_acceptances: VERIFIED_FACTS.userAcceptances,
    ...overrides,
  };
}

const DIGESTS = {
  acceptance_digest: "a".repeat(32),
  organisation_digest: "b".repeat(32),
  user_digest: "c".repeat(32),
  hotel_digest: "d".repeat(32),
  account_digest: "e".repeat(32),
  member_digest: "f".repeat(32),
};

function fakeDb(state = {}) {
  const queries = [];
  let removed = false;
  const db = {
    queries,
    ended: false,
    async query(text) {
      const sql = String(text);
      queries.push(sql);
      if (state.lockError && sql.includes("a3m36-agreement-lock-table")) {
        const err = new Error("canceling statement due to lock timeout");
        err.code = "55P03";
        throw err;
      }
      if (sql === "begin read only" || sql === "begin" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql === "commit") {
        if (state.commitError) throw new Error("commit failed");
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("neon.project_id")) return { rows: [identity(state.identity)] };
      if (sql.includes("a3m36-agreement-shape")) {
        return { rows: [{
          effective_column: state.effectiveColumn ?? true,
          effective_index: state.effectiveIndex ?? true,
          requires_effective: state.requiresEffective ?? true,
          approval_delete_trigger: state.approvalDeleteTrigger ?? false,
        }] };
      }
      if (sql.includes("a3m36-agreement-fk")) return { rows: state.foreignKeys ?? [] };
      if (sql.includes("a3m36-agreement-triggers")) {
        return { rows: REQUIRED_TRIGGERS.map((tgname) => ({ tgname, tgenabled: state.disabledTrigger === tgname ? "D" : "O" })) };
      }
      if (sql.includes("a3m36-agreement-lock")) return { rows: [], rowCount: 0 };
      if (sql.includes("a3m36-agreement-records")) {
        const row = { ...DIGESTS, ...(state.records ?? {}) };
        return { rows: [removed ? { ...row, ...(state.afterRecords ?? {}) } : row] };
      }
      if (sql.includes("a3m36-agreement-snapshot")) {
        const row = removed ? snapshot({ ...(state.after ?? {}), approval_count: state.afterCount ?? 0, approval_version: null, approval_effective: null, effective_count: state.afterEffective ?? 0 }) : snapshot(state.before);
        return { rows: [row] };
      }
      if (sql.includes("a3m36-agreement-delete")) {
        const rowCount = state.deleteRowCount ?? 1;
        if (rowCount === 1) removed = true;
        return { rows: [], rowCount };
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 160)}`);
    },
    async end() {
      this.ended = true;
    },
  };
  return db;
}

function env(overrides = {}) {
  return {
    A3M36_AGREEMENT_CLEANUP_CONFIRMATION: CLEANUP_CONFIRMATION,
    AETHER_0036_ISOLATED_OWNER_URL: OWNER_URL,
    GITHUB_SHA: "958c4b3f02105783a45d5f84a302185bca947f0e",
    GITHUB_RUN_ID: "not-dispatched",
    ...overrides,
  };
}

test("the agreement cleanup is manual and deletes only the inactive catalogue row", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /CLEANUP-0036-AGREEMENT-ISOLATED/);
  assert.match(workflow, /AETHER_0036_ISOLATED_OWNER_URL/);
  assert.doesNotMatch(workflow, /DATABASE_URL|AETHER_DATABASE_OWNER_URL|NEON_API_KEY/);
  assert.match(DELETE_SQL, /agreement_version = \$1/);
  assert.match(DELETE_SQL, /effective = false/);
  assert.equal(src.match(/delete from/gi).length, 1);
  assert.doesNotMatch(src, /session_replication_role|alter table|truncate |disable trigger/i);
  assert.match(concurrency, /APPROVAL TABLE IS NOT EMPTY/);
  assert.equal(snapshotFailures(snapshot()).length, 0);
});

test("a rejected confirmation, production host, or recovery branch does not delete", async () => {
  let connects = 0;
  const connect = () => {
    connects += 1;
    throw new Error("connect");
  };
  const phrase = await runAgreementCleanup({ env: env({ A3M36_AGREEMENT_CLEANUP_CONFIRMATION: "RECOVER-0036-ISOLATED" }), connect });
  assert.match(phrase.lines.join("\n"), /CONFIRMATION PHRASE INVALID/);
  const host = await runAgreementCleanup({
    env: env({ AETHER_0036_ISOLATED_OWNER_URL: `postgres://${EXPECTED_ROLE}:secret@${FORBIDDEN_ENDPOINT}.eu.neon.tech/neondb` }),
    connect,
  });
  assert.match(host.lines.join("\n"), /production-endpoint/);
  const fallback = await runAgreementCleanup({ env: env({ DATABASE_URL: OWNER_URL }), connect });
  assert.match(fallback.lines.join("\n"), /DATABASE_URL must not be set/);
  assert.equal(connects, 0);
  const recovery = fakeDb({ identity: { branch_id: RECOVERY_BRANCH, endpoint_id: EXPECTED_ENDPOINT } });
  const recoveryResult = await runAgreementCleanup({ env: env(), connect: async () => recovery });
  assert.match(recoveryResult.lines.join("\n"), /recovery-branch/);
  assert.equal(recovery.queries.some((sql) => sql === "begin"), false);
  const production = fakeDb({ identity: { branch_id: FORBIDDEN_BRANCH } });
  const productionResult = await runAgreementCleanup({ env: env(), connect: async () => production });
  assert.match(productionResult.lines.join("\n"), /production-branch/);
  const role = fakeDb({ identity: { current_user: "aether_app", session_user: "aether_app" } });
  const roleResult = await runAgreementCleanup({ env: env(), connect: async () => role });
  assert.match(roleResult.lines.join("\n"), /role/);
  const endpoint = await runAgreementCleanup({
    env: env({ AETHER_0036_ISOLATED_OWNER_URL: `postgres://${EXPECTED_ROLE}:secret@ep-other-endpoint.eu.neon.tech/neondb` }),
    connect,
  });
  assert.match(endpoint.lines.join("\n"), /endpoint-pin/);
  const drifted = fakeDb({ identity: { endpoint_id: "ep-other-endpoint" } });
  const driftedResult = await runAgreementCleanup({ env: env(), connect: async () => drifted });
  assert.match(driftedResult.lines.join("\n"), /endpoint-pin/);
  assert.equal(drifted.queries.some((sql) => sql === "begin"), false);
  const project = fakeDb({ identity: { project_id: "other-project" } });
  const projectResult = await runAgreementCleanup({ env: env(), connect: async () => project });
  assert.match(projectResult.lines.join("\n"), /BLOCKED — ISOLATED IDENTITY/);
  assert.equal(project.queries.some((sql) => sql.includes("a3m36-agreement-delete")), false);
});

test("the matching inactive row commits once and a second run changes nothing", async () => {
  const db = fakeDb();
  const result = await runAgreementCleanup({ env: env(), connect: async () => db });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 0, text);
  assert.match(text, /precondition_failures: none/);
  assert.match(text, /deleted_rows: 1 expected: 1/);
  assert.match(text, /acceptance_preserved: true/);
  assert.match(text, /organisation_preserved: true/);
  assert.match(text, /user_preserved: true/);
  assert.match(text, /org_hotels: 3/);
  assert.match(text, /user_accounts: 3/);
  assert.match(text, /protected_records: match/);
  assert.match(text, /transaction: committed/);
  assert.match(text, /approval_rows: 0/);
  assert.match(text, new RegExp(VERDICT_PASS));
  assert.equal(db.ended, true);
  const again = fakeDb({ before: { approval_count: 0, approval_version: null, approval_effective: null } });
  const repeat = await runAgreementCleanup({ env: env(), connect: async () => again });
  const repeatText = repeat.lines.join("\n");
  assert.equal(repeat.exitCode, 1);
  assert.match(repeatText, new RegExp(VERDICT_ABSENT));
  assert.match(repeatText, /transaction: rolled-back/);
  assert.equal(again.queries.some((sql) => sql.includes("a3m36-agreement-delete")), false);
  assert.equal(again.queries.some((sql) => sql === "commit"), false);
});

test("a swapped protected record rolls back even when the counts stay the same", async () => {
  assert.deepEqual(protectedRecordFailures(DIGESTS, DIGESTS), []);
  const swapped = "9".repeat(32);
  const changes = [
    ["hotel_digest", /changed-hotel_digest/],
    ["account_digest", /changed-account_digest/],
    ["member_digest", /changed-member_digest/],
    ["acceptance_digest", /changed-acceptance_digest/],
    ["organisation_digest", /changed-organisation_digest/],
    ["user_digest", /changed-user_digest/],
  ];
  for (const [key, pattern] of changes) {
    const db = fakeDb({ afterRecords: { [key]: swapped } });
    const result = await runAgreementCleanup({ env: env(), connect: async () => db });
    const text = result.lines.join("\n");
    assert.equal(result.exitCode, 1, text);
    assert.match(text, pattern, text);
    assert.match(text, /protected_records: mismatch/);
    assert.match(text, /transaction: rolled-back/);
    assert.equal(db.queries.filter((sql) => sql === "commit").length, 0);
  }
  const missing = fakeDb({ records: { hotel_digest: "" } });
  const blocked = await runAgreementCleanup({ env: env(), connect: async () => missing });
  assert.match(blocked.lines.join("\n"), /missing-hotel_digest/);
  assert.equal(missing.queries.some((sql) => sql.includes("a3m36-agreement-delete")), false);
});

test("triggers, catalogue foreign keys, delete counts, and postconditions each roll back", async () => {
  const cases = [
    [{ before: { approval_count: 2, approval_version: "other" } }, /approval-count/],
    [{ before: { approval_effective: true, effective_count: 1 } }, /approval-effective/],
    [{ before: { acceptance_id: "00000000-0000-4000-8000-000000000000" } }, /acceptance-id/],
    [{ before: { version_acceptances: 0, acceptance_id: null } }, /acceptance-count/],
    [{ before: { organisations: 0 } }, /organisation-missing/],
    [{ before: { users: 0 } }, /user-missing/],
    [{ before: { org_hotels: 4 } }, /org-hotels/],
    [{ before: { user_accounts: 2 } }, /user-accounts/],
    [{ before: { org_members: 0 } }, /org-members/],
    [{ foreignKeys: [{ conname: "unexpected_fkey" }] }, /catalogue-foreign-key/],
    [{ disabledTrigger: "sbg_organisation_acceptances_immutable" }, /trigger-disabled/],
    [{ effectiveColumn: false }, /schema-drift/],
    [{ deleteRowCount: 0 }, /DELETE COUNT/],
    [{ deleteRowCount: 2 }, /DELETE COUNT/],
    [{ afterCount: 1 }, /catalogue-not-empty/],
  ];
  for (const [state, pattern] of cases) {
    const db = fakeDb(state);
    const result = await runAgreementCleanup({ env: env(), connect: async () => db });
    const text = result.lines.join("\n");
    assert.equal(result.exitCode, 1, text);
    assert.match(text, pattern, text);
    assert.match(text, /transaction: rolled-back/);
    assert.equal(db.queries.filter((sql) => sql === "commit").length, 0);
  }
});

test("a lock conflict rolls back and does not delete", async () => {
  const db = fakeDb({ lockError: true });
  const result = await runAgreementCleanup({ env: env(), connect: async () => db });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 1);
  assert.match(text, /LOCK CONFLICT/);
  assert.match(text, /transaction: rolled-back/);
  assert.equal(db.queries.some((sql) => sql.includes("a3m36-agreement-delete")), false);
});
