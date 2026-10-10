/**
 * A3-M36 isolated concurrency gate. No database is opened.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ACCEPTED_LEDGER } from "./production-db-preflight.mjs";
import { MIGRATION_35, MIGRATION_36 } from "./a3-m36-0035-equivalence.mjs";
import { INSTALL_CONFIRMATION } from "./a3-m36-isolated-install.mjs";
import { EXPECTED_DATABASE, EXPECTED_ROLE, FORBIDDEN_ENDPOINT } from "./a3-m36-isolated-preflight.mjs";
import {
  CONCURRENCY_CONFIRMATION,
  FIXTURE_EFFECTIVE,
  appUrlFailures,
  concurrencyLedgerOk,
  duplicateCodeVerdict,
  isMarkerUser,
  isolationVerdict,
  overlapFailure,
  overallVerdict,
  propertyPairVerdict,
  rollbackVerdict,
  runConcurrency,
  runtimeRoleVerdict,
  sameCreatorVerdict,
  termsVerdict,
  uncommittedVerdict,
  INCOMPLETE_VERDICT,
  PASS_VERDICT,
  cleanupFailure,
} from "./a3-m36-isolated-concurrency.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "scripts/a3-m36-isolated-concurrency.mjs"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/a3-m36-isolated-concurrency.yml"), "utf8");
const ENDPOINT = "ep-damp-dust-b1rdfp34";
const OWNER_URL = `postgres://${EXPECTED_ROLE}:secret@${ENDPOINT}.eu-central-1.aws.neon.tech/${EXPECTED_DATABASE}`;
const APP_URL = `postgres://aether_app:secret@${ENDPOINT}.eu-central-1.aws.neon.tech/${EXPECTED_DATABASE}`;

const overlap = { distinctPids: true, lockWaitObserved: true, waiterSeen: true };
const counts = { organisations: 2, hotels: 11, providers: 4, users: 3, members: 2, acceptances: 0, approvals: 0, bookings: 1 };

test("a passing gate requires an observed lock wait", () => {
  assert.equal(overlapFailure({ distinctPids: true, lockWaitObserved: false, waiterSeen: true }), "BLOCKED — TRANSACTIONS DID NOT OVERLAP");
  assert.equal(overlapFailure(overlap), "");
  assert.equal(sameCreatorVerdict({
    overlap,
    orgCount: 1,
    memberCount: 1,
    waiterError: "founding organisation already exists",
    holderId: "org-1",
    ensureId: "org-1",
  }), "");
  assert.match(sameCreatorVerdict({
    overlap: { distinctPids: true, lockWaitObserved: false, waiterSeen: true },
    orgCount: 1,
    memberCount: 1,
    waiterError: "founding organisation already exists",
    holderId: "org-1",
    ensureId: "org-1",
  }), /DID NOT OVERLAP/);
  assert.equal(propertyPairVerdict({
    overlap,
    orgCount: 1,
    hotelIds: ["h1", "h2"],
    organisationIds: ["org-1", "org-1"],
  }), "");
  assert.match(duplicateCodeVerdict({ overlap, hotelDelta: 2, providerDelta: 2, waiterError: "hotel code already exists" }), /EXTRA ROWS/);
  assert.equal(duplicateCodeVerdict({ overlap, hotelDelta: 1, providerDelta: 1, waiterError: "hotel code already exists" }), "");
  assert.equal(rollbackVerdict({ error: "terms are not approved for property creation", before: counts, after: counts }), "");
  assert.match(rollbackVerdict({ error: "terms are not approved for property creation", before: counts, after: { ...counts, hotels: 12 } }), /PERSISTED/);
  assert.equal(uncommittedVerdict({ before: counts, after: counts }), "");
  assert.match(uncommittedVerdict({ before: counts, after: { ...counts, hotels: 12 } }), /PERSISTED/);
});

test("terms, isolation, runtime role, and ledger rules reject silent success", () => {
  assert.equal(termsVerdict({
    effectiveHotel: "h1",
    bothHotel: "h2",
    supersededError: "terms are not approved for property creation",
    provisionalError: "terms are not approved for property creation",
    unapprovedError: "terms are not approved for property creation",
    termsV1InsertError: 'new row violates check constraint "sbg_approved_property_agreement_versions_not_provisional"',
    termsV1ApprovalRows: 0,
  }), "");
  assert.match(termsVerdict({
    effectiveHotel: "h1",
    bothHotel: "h2",
    supersededError: "",
    provisionalError: "terms are not approved for property creation",
    unapprovedError: "terms are not approved for property creation",
    termsV1InsertError: "violates check constraint",
    termsV1ApprovalRows: 0,
  }), /SUPERSEDED/);
  assert.match(termsVerdict({
    effectiveHotel: "h1",
    bothHotel: "h2",
    supersededError: "terms are not approved for property creation",
    provisionalError: "terms are not approved for property creation",
    unapprovedError: "terms are not approved for property creation",
    termsV1InsertError: "",
    termsV1ApprovalRows: 1,
  }), /TERMS-V1/);
  assert.equal(isolationVerdict({
    leftId: "a",
    rightId: "b",
    leftCount: 1,
    rightCount: 1,
    leftName: "A3M36 Left",
    rightName: "A3M36 Right",
    memberInserted: true,
  }), "");
  assert.match(isolationVerdict({
    leftId: "a",
    rightId: "a",
    leftCount: 1,
    rightCount: 1,
    leftName: "A3M36 Left",
    rightName: "A3M36 Right",
    memberInserted: true,
  }), /NOT ISOLATED/);
  assert.equal(runtimeRoleVerdict({ catalogMatch: true, appConnection: "absent", live: null }), "NOT TESTED");
  assert.match(runtimeRoleVerdict({ catalogMatch: false, appConnection: "absent", live: null }), /RUNTIME PRIVILEGE CATALOG/);
  assert.match(runtimeRoleVerdict({
    catalogMatch: true,
    appConnection: "present",
    live: {
      sameIdentity: true,
      role: "aether_app",
      selectAllowed: true,
      insertAllowed: false,
      updateAllowed: false,
      executeCreate: true,
      runtimeExecute: false,
      publicExecute: false,
    },
  }), /READ OR WROTE/);
  assert.equal(runtimeRoleVerdict({
    catalogMatch: true,
    appConnection: "present",
    live: {
      sameIdentity: true,
      role: "aether_app",
      selectAllowed: false,
      insertAllowed: false,
      updateAllowed: false,
      executeCreate: true,
      runtimeExecute: false,
      publicExecute: false,
    },
  }), "");
  const incomplete = overallVerdict({ concurrency: "PASS", terms: "PASS", runtime: "NOT TESTED", cleanup: "PASS" });
  assert.equal(incomplete.exitCode, 2);
  assert.equal(incomplete.full, false);
  assert.equal(incomplete.verdict, INCOMPLETE_VERDICT);
  assert.notEqual(incomplete.verdict, PASS_VERDICT);
  const full = overallVerdict({ concurrency: "PASS", terms: "PASS", runtime: "PASS", cleanup: "PASS" });
  assert.equal(full.exitCode, 0);
  assert.equal(full.full, true);
  assert.equal(full.verdict, PASS_VERDICT);
  const blockedCleanup = overallVerdict({
    concurrency: "PASS",
    terms: "PASS",
    runtime: "NOT TESTED",
    cleanup: "BLOCKED — CLEANUP STOPPED AT sbg_organisation_acceptances",
  });
  assert.equal(blockedCleanup.exitCode, 1);
  assert.equal(blockedCleanup.full, false);
  assert.match(blockedCleanup.verdict, /CLEANUP STOPPED/);
  assert.match(cleanupFailure("sbg_organisation_acceptances", {
    message: "organisation acceptance evidence is immutable",
    table: "sbg_organisation_acceptances",
    constraint: "sbg_organisation_acceptances_immutable",
    code: "P0001",
  }), /BLOCKED — CLEANUP STOPPED AT sbg_organisation_acceptances table sbg_organisation_acceptances constraint sbg_organisation_acceptances_immutable sqlstate P0001/);
  assert.equal(concurrencyLedgerOk([...ACCEPTED_LEDGER, MIGRATION_36]), true);
  assert.equal(concurrencyLedgerOk([...ACCEPTED_LEDGER, MIGRATION_35, MIGRATION_36]), true);
  assert.equal(concurrencyLedgerOk(ACCEPTED_LEDGER), false);
  assert.equal(concurrencyLedgerOk([...ACCEPTED_LEDGER, MIGRATION_36, "0037_future.sql"]), false);
  assert.equal(isMarkerUser({ id: "a3m36-1", email: "a3m36-proof-a3m36-1@invalid.scanbookgo.test", name: "A3M36 Same" }), true);
  assert.equal(isMarkerUser({ id: "user-1", email: "owner@example.com", name: "Owner" }), false);
  assert.notEqual(FIXTURE_EFFECTIVE, "terms-v1");
});

test("the app connection cannot fall back to the owner or Production", () => {
  assert.deepEqual(appUrlFailures("", OWNER_URL), ["absent"]);
  assert.deepEqual(appUrlFailures(APP_URL, OWNER_URL), []);
  assert.ok(appUrlFailures(OWNER_URL, OWNER_URL).includes("role"));
  assert.ok(appUrlFailures(`postgres://aether_app:secret@${FORBIDDEN_ENDPOINT}.eu.neon.tech/neondb`, OWNER_URL).includes("production-endpoint"));
  assert.equal(CONCURRENCY_CONFIRMATION === INSTALL_CONFIRMATION, false);
});

test("the concurrency workflow is manual and does not install", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /CONCURRENCY-0036-ISOLATED/);
  assert.match(workflow, /node scripts\/a3-m36-isolated-concurrency\.mjs/);
  assert.doesNotMatch(workflow, /a3-m36-isolated-install/);
  assert.doesNotMatch(workflow, /DATABASE_URL|AETHER_DATABASE_OWNER_URL|NEON_API_KEY|0026/);
  assert.match(src, /BLOCKED — TRANSACTIONS DID NOT OVERLAP/);
  assert.match(src, /wait_event_type/);
  assert.match(src, /postgresql_concurrency:/);
  assert.match(src, /agreement_version_enforcement:/);
  assert.match(src, /runtime_role_security:/);
  assert.match(src, /NOT TESTED/);
  assert.doesNotMatch(src, /runInstall\(/);
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /process\.env\.AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(src, /process\.env\.NEON_API_KEY/);
  assert.doesNotMatch(src, /disable trigger/i);
  assert.doesNotMatch(src, /enable trigger/i);
  assert.doesNotMatch(src, /setDeleteTriggers/);
  assert.doesNotMatch(src, /alter table/i);
  assert.match(src, /async function runStep/);
  assert.match(src, /terms-v1/);
  assert.doesNotMatch(src, /values \('terms-v1'/);
});

test("rejected confirmation and a production host do not connect", async () => {
  let connects = 0;
  const connect = () => {
    connects += 1;
    throw new Error("connect");
  };
  const phrase = await runConcurrency({ env: { A3M36_CONCURRENCY_CONFIRMATION: INSTALL_CONFIRMATION, AETHER_0036_ISOLATED_OWNER_URL: OWNER_URL }, connect });
  assert.equal(phrase.exitCode, 1);
  assert.match(phrase.lines.join("\n"), /CONFIRMATION PHRASE INVALID/);
  const host = await runConcurrency({
    env: {
      A3M36_CONCURRENCY_CONFIRMATION: CONCURRENCY_CONFIRMATION,
      AETHER_0036_ISOLATED_OWNER_URL: `postgres://${EXPECTED_ROLE}:secret@${FORBIDDEN_ENDPOINT}.eu.neon.tech/neondb`,
    },
    connect,
  });
  assert.match(host.lines.join("\n"), /production-endpoint/);
  const fallback = await runConcurrency({
    env: { A3M36_CONCURRENCY_CONFIRMATION: CONCURRENCY_CONFIRMATION, AETHER_0036_ISOLATED_OWNER_URL: OWNER_URL, DATABASE_URL: OWNER_URL },
    connect,
  });
  assert.match(fallback.lines.join("\n"), /DATABASE_URL must not be set/);
  assert.equal(connects, 0);
  assert.doesNotMatch(`${phrase.lines.join("\n")}\n${host.lines.join("\n")}`, /secret/);
});
