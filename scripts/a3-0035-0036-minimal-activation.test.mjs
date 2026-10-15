import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateEnvironment, runProductionAdmission, TARGET } from "./a3-0035-0036-production-admission.STAGED.mjs";

test("isolated activation preparation rejects absent production approval before connection", async () => {
  assert.equal(TARGET.database, "neondb");
  assert.ok(validateEnvironment({}).length > 0);
  let connected = false;
  const result = await runProductionAdmission({
    env: {},
    connect: async () => { connected = true; throw Error("unexpected connection"); },
  });
  assert.equal(result.verdict, "BLOCKED");
  assert.equal(connected, false);
});

test("isolated preparation does not install an active production workflow", async () => {
  const entry = await readFile(new URL("./a3-0035-0036-production-admission-entry.STAGED.mjs", import.meta.url), "utf8");
  assert.ok(entry.includes("runProductionAdmission"));
  assert.ok(entry.includes("process.exitCode = 2"));
});

const approved = Object.freeze({
  A3_PRODUCTION_APPLY_CONFIRMATION: "APPLY-0035-0036-PRODUCTION-EXPLICIT-AUTHORISATION",
  A3_PRODUCTION_APPROVAL_RECORD: "APPROVED-0035-0036-PRODUCTION",
  A3_PRODUCTION_APPLY_OWNER_URL: "postgresql://neondb_owner:offline-test-only@ep-withered-haze-b1fd9hse.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW: "A3 0035-0036 production admission APPROVAL REQUIRED",
  SBG_ADMISSION_PROJECT_ID: TARGET.project,
  SBG_ADMISSION_BRANCH_ID: TARGET.branch,
  SBG_ADMISSION_ENDPOINT_ID: TARGET.endpoint,
});

test("exact approved workflow context passes validation without connecting", () => {
  assert.deepEqual(validateEnvironment(approved), []);
});

test("every critical production admission guard fails closed when tampered", () => {
  const mutations = [
    ["confirmation", { A3_PRODUCTION_APPLY_CONFIRMATION: "wrong" }],
    ["approval-record", { A3_PRODUCTION_APPROVAL_RECORD: "" }],
    ["workflow-context", { GITHUB_REF: "refs/heads/review" }],
    ["workflow-context", { GITHUB_EVENT_NAME: "push" }],
    ["workflow-identity", { GITHUB_WORKFLOW: "unapproved workflow" }],
    ["target-pin", { SBG_ADMISSION_PROJECT_ID: "wrong-project" }],
    ["target-pin", { SBG_ADMISSION_BRANCH_ID: "wrong-branch" }],
    ["target-pin", { SBG_ADMISSION_ENDPOINT_ID: "wrong-endpoint" }],
    ["endpoint", { A3_PRODUCTION_APPLY_OWNER_URL: approved.A3_PRODUCTION_APPLY_OWNER_URL.replace("ep-withered-haze-b1fd9hse", "ep-other") }],
    ["role", { A3_PRODUCTION_APPLY_OWNER_URL: approved.A3_PRODUCTION_APPLY_OWNER_URL.replace("neondb_owner", "app_role") }],
    ["database", { A3_PRODUCTION_APPLY_OWNER_URL: approved.A3_PRODUCTION_APPLY_OWNER_URL.replace("/neondb?", "/other?") }],
    ["connection-options", { A3_PRODUCTION_APPLY_OWNER_URL: approved.A3_PRODUCTION_APPLY_OWNER_URL.replace("sslmode=require", "sslmode=disable") }],
    ["ambient-credentials", { DATABASE_URL: "postgresql://unexpected" }],
    ["owner-url", { A3_PRODUCTION_APPLY_OWNER_URL: "" }],
  ];
  for (const [expectedFailure, change] of mutations) {
    const failures = validateEnvironment({ ...approved, ...change });
    assert.ok(failures.includes(expectedFailure), `Expected ${expectedFailure}: ${JSON.stringify(failures)}`);
  }
});

test("altered migration SQL blocks before any database connection", async () => {
  let connects = 0;
  let reads = 0;
  const result = await runProductionAdmission({
    env: approved,
    read: async () => { reads++; return Buffer.from("tampered migration SQL"); },
    connect: async () => { connects++; throw Error("must not connect"); },
  });
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.failures.some(f => f.startsWith("migration-digest-")));
  assert.equal(reads, 1);
  assert.equal(connects, 0);
});

test("wrong live database identity blocks before migration execution", async () => {
  const statements = [];
  const db = {
    query: async sql => {
      statements.push(sql);
      if (sql.includes("current_database() AS database")) return { rows: [{ database: "wrong", role: TARGET.role, session_role: TARGET.role, project: TARGET.project, branch: TARGET.branch, endpoint: TARGET.endpoint }] };
      return { rows: [] };
    },
    end: async () => {},
  };
  const fs = await import("node:fs/promises");
  const result = await runProductionAdmission({
    env: approved,
    read: fs.readFile,
    connect: async () => db,
  });
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.failures.includes("live-identity"));
  assert.ok(!statements.some(sql => sql.includes("INSERT INTO public._migrations")));
  assert.ok(statements.includes("ROLLBACK"));
});

test("inactive activation template is source-pinned, portable and credentials scoped to execution", async () => {
  const template = await readFile(new URL("../docs/a3-0035-0036-production-apply.WORKFLOW-TEMPLATE.txt", import.meta.url), "utf8");
  assert.ok(template.includes("A3_APPROVED_SOURCE_SHA"));
  assert.ok(template.includes('test "$GITHUB_SHA" = "$EXPECTED_SHA"'));
  assert.ok(template.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'));
  assert.ok(template.includes("ref: ${{ github.sha }}"));
  assert.ok(template.includes("node --test scripts/a3-0035-0036-minimal-activation.test.mjs"));
  assert.ok(template.includes("node scripts/a3-0035-0036-production-admission-entry.STAGED.mjs"));
  assert.ok(!template.includes("REVIEWED_SHA_REQUIRED"));
  assert.ok(!template.includes("production-admission-executor.DRAFT.test.mjs"));
  assert.ok(!template.includes("production-admission.STAGED.test.mjs"));
  const secret = "A3_PRODUCTION_APPLY_OWNER_URL: ${{ secrets.A3_PRODUCTION_APPLY_OWNER_URL }}";
  assert.equal(template.split(secret).length - 1, 1);
  assert.ok(template.indexOf(secret) > template.indexOf("Verify checkout and offline safety tests"));
  assert.ok(!template.includes("pull_request:\\n"));
});
