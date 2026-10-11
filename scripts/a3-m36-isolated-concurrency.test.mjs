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
import { EXPECTED_DATABASE, EXPECTED_ROLE } from "./a3-m36-isolated-preflight.mjs";
import { REQUIRED_TRIGGERS } from "./a3-m36-isolated-cleanup.mjs";
import {
  CONCURRENCY_CONFIRMATION,
  FIXTURE_EFFECTIVE,
  INCOMPLETE_VERDICT,
  PASS_VERDICT,
  PROTECTED_BRANCHES,
  PROTECTED_ENDPOINTS,
  RETAINED_CLEANUP,
  appUrlFailures,
  cleanupFailure,
  concurrencyLedgerOk,
  disposableIdentityFailures,
  disposablePinFailures,
  disposableUrlFailures,
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
} from "./a3-m36-isolated-concurrency.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "scripts/a3-m36-isolated-concurrency.mjs"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/a3-m36-isolated-concurrency.yml"), "utf8");
const ENDPOINT = "ep-disposable-review1";
const BRANCH = "br-disposable-review1";
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
  const incomplete = overallVerdict({ concurrency: "PASS", terms: "PASS", runtime: "NOT TESTED", cleanup: RETAINED_CLEANUP });
  assert.equal(incomplete.exitCode, 2);
  assert.equal(incomplete.full, false);
  assert.equal(incomplete.verdict, INCOMPLETE_VERDICT);
  assert.notEqual(incomplete.verdict, PASS_VERDICT);
  const deleted = overallVerdict({ concurrency: "PASS", terms: "PASS", runtime: "PASS", cleanup: "PASS" });
  assert.equal(deleted.exitCode, 1);
  assert.equal(deleted.full, false);
  const full = overallVerdict({ concurrency: "PASS", terms: "PASS", runtime: "PASS", cleanup: RETAINED_CLEANUP });
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

test("the app connection cannot fall back to the owner or a protected branch", () => {
  assert.deepEqual(appUrlFailures("", OWNER_URL, ENDPOINT), ["absent"]);
  assert.deepEqual(appUrlFailures(APP_URL, OWNER_URL, ENDPOINT), []);
  assert.ok(appUrlFailures(OWNER_URL, OWNER_URL, ENDPOINT).includes("role"));
  assert.ok(appUrlFailures(`postgres://aether_app:secret@${PROTECTED_ENDPOINTS[1]}.eu.neon.tech/neondb`, OWNER_URL, ENDPOINT).includes("protected-endpoint"));
  assert.ok(disposablePinFailures({ branch: PROTECTED_BRANCHES[0], endpoint: ENDPOINT }).includes("protected-branch"));
  assert.ok(disposablePinFailures({ branch: BRANCH, endpoint: PROTECTED_ENDPOINTS[0] }).includes("protected-endpoint"));
  assert.deepEqual(disposablePinFailures({ branch: BRANCH, endpoint: ENDPOINT }), []);
  assert.ok(disposableUrlFailures(OWNER_URL, "ep-other-endpoint").includes("endpoint-pin"));
  assert.deepEqual(disposableIdentityFailures({
    projectId: "quiet-sound-53513710",
    branchId: BRANCH,
    endpointId: ENDPOINT,
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
  }, `${ENDPOINT}.eu-central-1.aws.neon.tech`, { branch: BRANCH, endpoint: ENDPOINT }), []);
  assert.equal(CONCURRENCY_CONFIRMATION === INSTALL_CONFIRMATION, false);
});

test("the concurrency workflow is manual and does not install", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /CONCURRENCY-0036-DISPOSABLE/);
  assert.match(workflow, /node scripts\/a3-m36-isolated-concurrency\.mjs/);
  assert.doesNotMatch(workflow, /a3-m36-isolated-install/);
  assert.doesNotMatch(workflow, /AETHER_0036_ISOLATED_OWNER_URL|DATABASE_URL|AETHER_DATABASE_OWNER_URL|NEON_API_KEY|0026/);
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
  assert.doesNotMatch(src, /cleanupFixtures\(/);
  assert.match(src, /immutable_delete: not-attempted/);
  assert.match(src, /AETHER_0036_DISPOSABLE_APP_URL/);
  assert.match(workflow, /secrets.AETHER_0036_DISPOSABLE_APP_URL/);
  assert.match(src, /return await conclude\(\)/);
  assert.doesNotMatch(src, /return conclude\(\)/);
  assert.match(src, /terms-v1/);
  assert.doesNotMatch(src, /values \('terms-v1'/);
});

test("rejected confirmation and a production host do not connect", async () => {
  let connects = 0;
  const connect = () => {
    connects += 1;
    throw new Error("connect");
  };
  const phrase = await runConcurrency({ env: { A3M36_CONCURRENCY_CONFIRMATION: INSTALL_CONFIRMATION, AETHER_0036_DISPOSABLE_OWNER_URL: OWNER_URL, A3M36_DISPOSABLE_BRANCH: BRANCH, A3M36_DISPOSABLE_ENDPOINT: ENDPOINT }, connect });
  assert.equal(phrase.exitCode, 1);
  assert.match(phrase.lines.join("\n"), /CONFIRMATION PHRASE INVALID/);
  const host = await runConcurrency({
    env: {
      A3M36_CONCURRENCY_CONFIRMATION: CONCURRENCY_CONFIRMATION,
      AETHER_0036_DISPOSABLE_OWNER_URL: `postgres://${EXPECTED_ROLE}:secret@ep-withered-haze-b1fd9hse.eu.neon.tech/neondb`,
      A3M36_DISPOSABLE_BRANCH: BRANCH,
      A3M36_DISPOSABLE_ENDPOINT: "ep-withered-haze-b1fd9hse",
    },
    connect,
  });
  assert.match(host.lines.join("\n"), /protected-endpoint/);
  const parent = await runConcurrency({
    env: {
      A3M36_CONCURRENCY_CONFIRMATION: CONCURRENCY_CONFIRMATION,
      AETHER_0036_DISPOSABLE_OWNER_URL: OWNER_URL,
      A3M36_DISPOSABLE_BRANCH: "br-dawn-hat-b1b4uqhn",
      A3M36_DISPOSABLE_ENDPOINT: ENDPOINT,
    },
    connect,
  });
  assert.match(parent.lines.join("\n"), /protected-branch/);
  const fallback = await runConcurrency({
    env: {
      A3M36_CONCURRENCY_CONFIRMATION: CONCURRENCY_CONFIRMATION,
      AETHER_0036_DISPOSABLE_OWNER_URL: OWNER_URL,
      A3M36_DISPOSABLE_BRANCH: BRANCH,
      A3M36_DISPOSABLE_ENDPOINT: ENDPOINT,
      DATABASE_URL: OWNER_URL,
    },
    connect,
  });
  assert.match(fallback.lines.join("\n"), /DATABASE_URL must not be set/);
  assert.equal(connects, 0);
  assert.doesNotMatch(`${phrase.lines.join("\n")}\n${host.lines.join("\n")}`, /secret/);
});

function disposableEnv() {
  return {
    A3M36_CONCURRENCY_CONFIRMATION: CONCURRENCY_CONFIRMATION,
    AETHER_0036_DISPOSABLE_OWNER_URL: OWNER_URL,
    A3M36_DISPOSABLE_BRANCH: BRANCH,
    A3M36_DISPOSABLE_ENDPOINT: ENDPOINT,
  };
}

function harness({ failFinalGuard = false } = {}) {
  const events = [];
  let nextPid = 10;
  let lockHeld = false;
  let orgN = 0;
  let hotels = 0;
  let providers = 0;
  let approvals = 0;
  let guardCalls = 0;
  const orgs = new Map();
  const names = new Map();
  const accepted = new Map();
  const codes = new Set();
  const ok = (rows = [], rowCount = 0) => ({ rows, rowCount });
  function connect() {
    const pid = ++nextPid;
    let ended = false;
    let inTx = false;
    let pendingHotels = 0;
    let pendingProviders = 0;
    return {
      async connect() {},
      async end() {
        ended = true;
        events.push(`end:${pid}`);
      },
      async query(sql, params = []) {
        if (ended) {
          events.push("query-after-end");
          throw new Error("Client was closed and is not queryable");
        }
        const text = String(sql);
        if (text === "begin" || text === "begin read only") {
          inTx = true;
          return ok();
        }
        if (text === "commit") {
          hotels += pendingHotels;
          providers += pendingProviders;
          pendingHotels = 0;
          pendingProviders = 0;
          inTx = false;
          lockHeld = false;
          return ok();
        }
        if (text === "rollback") {
          pendingHotels = 0;
          pendingProviders = 0;
          inTx = false;
          lockHeld = false;
          return ok();
        }
        if (text.includes("for update")) {
          lockHeld = true;
          return ok([{ id: params[0] }]);
        }
        if (lockHeld && !inTx && (text.includes("sbg_create_organisation_for_user") || text.includes("sbg_create_founding_property_for_user"))) {
          await new Promise((resolve) => {
            const timer = setInterval(() => {
              if (!lockHeld) {
                clearInterval(timer);
                resolve();
              }
            }, 5);
          });
        }
        if (text.includes("pg_backend_pid")) return ok([{ pid }]);
        if (text.includes("pg_stat_activity")) return ok([{ wait_event_type: "Lock" }]);
        if (text.includes("neon.project_id")) {
          return ok([{
            database: "neondb",
            current_user: "neondb_owner",
            session_user: "neondb_owner",
            project_id: "quiet-sound-53513710",
            branch_id: BRANCH,
            endpoint_id: ENDPOINT,
          }]);
        }
        if (text.includes("from public._migrations")) return ok([...ACCEPTED_LEDGER, MIGRATION_35, MIGRATION_36].map((name) => ({ name })));
        if (text.includes("creator_index")) return ok([{ creator_index: true, effective_column: true, effective_index: true }]);
        if (text.includes("proname")) {
          return ok([
            { proname: "sbg_create_organisation_for_user", rejects_second: true, requires_effective: false },
            { proname: "sbg_create_founding_property_for_user", rejects_second: false, requires_effective: true },
          ]);
        }
        if (text.includes("having count(*) > 1")) return ok([{ n: 0 }]);
        if (text.includes("agreement_version = 'terms-v1'")) return ok([{ n: 0 }]);
        if (text.includes("effective_n")) return ok([{ n: approvals, effective_n: approvals ? 1 : 0 }]);
        if (text.includes("a3m36-trigger-guard")) {
          guardCalls += 1;
          events.push("trigger-guard");
          if (failFinalGuard && guardCalls > 1) throw new Error("finalisation query failed");
          return ok(REQUIRED_TRIGGERS.map((tgname) => ({ tgname, tgenabled: "O" })));
        }
        if (text.includes("as organisations")) {
          return ok([{
            organisations: orgs.size,
            hotels,
            providers,
            users: 1,
            members: orgs.size,
            acceptances: 1,
            approvals,
            bookings: 0,
          }]);
        }
        if (text.includes('insert into public."user"')) return ok([], 1);
        if (text.includes("insert into public.sbg_approved_property_agreement_versions")) {
          if (params[0] === "terms-v1") throw new Error("violates check constraint sbg_approved_property_agreement_versions_not_provisional");
          approvals += 2;
          return ok([], 2);
        }
        if (text.includes("has_function_privilege")) {
          return ok([{
            app_creator: true,
            runtime_creator: false,
            public_creator: false,
            app_property: true,
            runtime_property: false,
            app_select: false,
            app_insert: false,
            app_update: false,
          }]);
        }
        if (text.includes("sbg_create_organisation_for_user")) {
          const user = params[0];
          if (orgs.has(user)) throw new Error("founding organisation already exists");
          orgN += 1;
          const organisationId = `00000000-0000-4000-8000-${String(orgN).padStart(12, "0")}`;
          orgs.set(user, organisationId);
          names.set(organisationId, params[1]);
          return ok([{ organisation_id: organisationId }]);
        }
        if (text.includes("sbg_ensure_founding_organisation") || text.includes("sbg_classify_founding_organisation")) {
          return ok([{ organisation_id: orgs.get(params[0]) }]);
        }
        if (text.includes("insert into public.sbg_organisation_acceptances")) {
          const versions = accepted.get(params[1]) ?? new Set();
          versions.add(params[2]);
          accepted.set(params[1], versions);
          return ok([], 1);
        }
        if (text.includes("sbg_create_founding_property_for_user")) {
          const versions = accepted.get(params[0]) ?? new Set();
          if (!versions.has("a3m36-fixture-effective")) throw new Error("terms are not approved for property creation");
          if (codes.has(params[1])) throw new Error("hotel code already exists");
          codes.add(params[1]);
          if (inTx) {
            pendingHotels += 1;
            pendingProviders += 1;
          } else {
            hotels += 1;
            providers += 1;
          }
          const suffix = String(codes.size).padStart(12, "0");
          return ok([{ hotel_id: `11111111-1111-4111-8111-${suffix}`, provider_id: `22222222-2222-4222-8222-${suffix}` }]);
        }
        if (text.includes("sbg_organisations where created_by_user_id")) return ok([{ n: orgs.has(params[0]) ? 1 : 0 }]);
        if (text.includes("sbg_organisation_members where user_id")) return ok([{ n: 1 }]);
        if (text.includes("from public.hotels where id = any")) return ok((params[0] ?? []).map(() => ({ id: orgs.get([...orgs.keys()].at(-1)) })));
        if (text.includes("select name from public.sbg_organisations")) return ok([{ name: names.get(params[0]) }]);
        if (text.includes("insert into public.sbg_organisation_members")) return ok([], 1);
        throw new Error(`unexpected sql ${text.split("\n")[0].slice(0, 180)}`);
      },
    };
  }
  return { connect, events };
}

function reportLines(text) {
  for (const line of ["postgresql_concurrency:", "agreement_version_enforcement:", "runtime_role_security:", "triggers_still_enabled:", "overall:"]) {
    assert.match(text, new RegExp(line));
  }
}

test("finalisation records the report before any connection is closed", async () => {
  const db = harness();
  const result = await runConcurrency({ env: disposableEnv(), connect: db.connect });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 2, text);
  assert.match(text, /test_same_creator: PASS/);
  assert.match(text, /test_property_pair: PASS/);
  assert.match(text, /test_duplicate_code: PASS/);
  assert.match(text, /test_failed_rollback: PASS/);
  assert.match(text, /test_uncommitted_rollback: PASS/);
  assert.match(text, /test_isolation: PASS/);
  assert.match(text, /test_terms: PASS/);
  assert.match(text, /triggers_still_enabled: true/);
  assert.match(text, new RegExp(INCOMPLETE_VERDICT));
  reportLines(text);
  assert.equal(db.events.includes("query-after-end"), false);
  const guardAt = db.events.lastIndexOf("trigger-guard");
  const endAt = db.events.findIndex((event) => event.startsWith("end:"));
  assert.ok(guardAt >= 0 && endAt > guardAt);
});

test("a final trigger-guard failure still reports every section and closes afterwards", async () => {
  const db = harness({ failFinalGuard: true });
  const result = await runConcurrency({ env: disposableEnv(), connect: db.connect });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 1, text);
  assert.match(text, /triggers_still_enabled: false/);
  assert.match(text, /BLOCKED — TRIGGER GUARD finalisation query failed/);
  assert.match(text, /test_terms: PASS/);
  reportLines(text);
  assert.equal(db.events.includes("query-after-end"), false);
  const guardAt = db.events.lastIndexOf("trigger-guard");
  const endAt = db.events.findIndex((event) => event.startsWith("end:"));
  assert.ok(guardAt >= 0 && endAt > guardAt);
});
