/**
 * CP30.05E-2D-2C.1 — 0034 controller contract. No Production connection.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING, isAuthorisedPending } from "./production-db-preflight.mjs";
import {
  ALREADY_APPLIED,
  APPLIED_VERIFIED,
  AUTHORISED,
  CONFIRM_BLOCKED,
  CONTRACT_BLOCKED,
  DIGEST_BLOCKED,
  NEON_BLOCKED,
  POST_BLOCKED,
  PRODUCTION_BRANCH_ID,
  PRODUCTION_ENDPOINT_ID,
  PRODUCTION_PROJECT_ID,
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNEXPECTED_PLAN,
  apply0034Transaction,
  evaluate0034Baseline,
  productionNeonFailures,
  productionOwnerHostFailures,
} from "./cp3005e2d2c1-0034-production-migrate.mjs";
import { spawnSync } from "node:child_process";
import { databaseHost, directOwnerUrl, EXPECTED_BRANCH, EXPECTED_PROJECT, FORBIDDEN_BRANCH, FORBIDDEN_ENDPOINT, hostIsProductionEndpoint, ISOLATED_CONFIRMATION, ISOLATED_OWNER_ENV, acceptancePrivilegeFailures, captureQuery, disposableMarkerOrgProblem, isDisposableMarkerUser, isolatedGateFailures, isolatedLedgerMode, sameDatabaseHost } from "./cp3005e2d2c1-neon-concurrency.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sql = readFileSync(join(root, "migrations", TARGET_MIGRATION), "utf8");
const src = readFileSync(join(here, "cp3005e2d2c1-0034-production-migrate.mjs"), "utf8");
const race = readFileSync(join(here, "cp3005e2d2c1-neon-concurrency.mjs"), "utf8");
const file = { name: TARGET_MIGRATION, sql, digest: TARGET_DIGEST };

function fn(args, appExecute) {
  return {
    present: true,
    securityDefiner: true,
    args,
    searchPath: "pg_catalog, public",
    owner: "neondb_owner",
    appExecute,
    runtimeExecute: false,
    publicExecute: false,
  };
}

function installed(overrides = {}) {
  return {
    target: fn("p_user_id text", false),
    classify: fn("p_user_id text, p_type text", true),
    accept: fn("p_user_id text", true),
    read: fn("p_user_id text", true),
    appOrgUpdate: false,
    classifyForUpdate: true,
    acceptTermsToken: true,
    acceptConflict: true,
    classifyWritesAcceptance: false,
    readWrites: false,
    bodyHotel: false,
    bodyBillingWrite: false,
    bodyStripe: false,
    ...overrides,
  };
}

function facts(overrides = {}) {
  return {
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    projectId: PRODUCTION_PROJECT_ID,
    branchId: PRODUCTION_BRANCH_ID,
    endpointId: PRODUCTION_ENDPOINT_ID,
    confirmation: REQUIRED_CONFIRMATION,
    ownerUrl: "postgres://owner@localhost/neondb",
    ledger: [...REQUIRED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    organisationCount: 1,
    memberCount: 1,
    classifiedCount: 0,
    acceptanceCount: 0,
    licensedQuantity: 3,
    allocationCount: 4,
    bookingCount: 0,
    paymentCount: 0,
    hotels: [{ code: "sbg-verify-a5", status: "configured", organisationId: null }],
    commerce: { present: true, liveMapping: false, liveCheckout: false },
    onboarding: installed(),
    acceptance: {
      immutableTrigger: true,
      truncateTrigger: true,
      appSelect: false,
      appInsert: false,
      appUpdate: false,
      appDelete: false,
    },
    ...overrides,
  };
}

test("0034 digest is pinned and the controller ledger stays frozen at 0001-0033", () => {
  assert.equal(createHash("sha256").update(sql).digest("hex"), TARGET_DIGEST);
  assert.deepEqual(
    REQUIRED_LEDGER,
    ACCEPTED_LEDGER.filter((name) => name !== TARGET_MIGRATION),
  );
  assert.equal(ACCEPTED_LEDGER.at(-1), TARGET_MIGRATION);
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.equal(REQUIRED_LEDGER.at(-1), "0033_cp3005e2d2b_founding_organisation.sql");
  assert.equal(REQUIRED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.doesNotMatch(src, /REQUIRED_LEDGER\s*=\s*\[\s*\.\.\.ACCEPTED_LEDGER/);
  assert.doesNotMatch(src, /from "\.\/production-db-migrate\.mjs"/);
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /STRIPE_SECRET|sk_live|sk_test|api\.stripe\.com/);
  assert.equal(existsSync(join(root, ".github/workflows/cp3005e2d2c1-0034-production-apply.yml")), false);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["db:migrate:0034"], undefined);
  assert.match(race, /BLOCKED — ISOLATED VERIFICATION UNAVAILABLE/);
  assert.match(race, /BEGIN READ ONLY/);
  assert.match(race, /quiet-sound-53513710/);
  assert.match(race, /br-late-paper-b15gkfj3/);
  assert.doesNotMatch(race, /console\.neon\.tech/);
  assert.doesNotMatch(race, /NEON_API_KEY/);
  assert.doesNotMatch(race, /process\.env\.AETHER_DATABASE_OWNER_URL\s*=/);
  assert.doesNotMatch(race, /round-sunset-/);
  const verify = readFileSync(join(root, ".github/workflows/cp3005e2d2c1-0034-isolated-verify.yml"), "utf8");
  assert.match(verify, /VERIFY-0034-ISOLATED/);
  assert.match(verify, /AETHER_0034_ISOLATED_OWNER_URL/);
  assert.doesNotMatch(verify, /AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(verify, /NEON_API_KEY/);
  assert.doesNotMatch(verify, /production-migrate\.mjs/);
  assert.doesNotMatch(verify, /Apply migration 0034 only/);
  const workflows = readdirSync(join(root, ".github/workflows")).sort();
  assert.deepEqual(workflows, [
    "a3-m36-isolated-verification.yml",
    "cp3005e2d2c1-0034-isolated-verify.yml",
    "production-database.yml",
  ]);
});

test("a verify branch must not be the production host", () => {
  assert.equal(directOwnerUrl("postgres://u@ep-a-pooler.eu.neon.tech/neondb"), "postgres://u@ep-a.eu.neon.tech/neondb");
  assert.equal(sameDatabaseHost("postgres://u@ep-a-pooler.eu.neon.tech/db", "postgres://o@ep-a.eu.neon.tech/db"), true);
  assert.equal(sameDatabaseHost("postgres://u@ep-branch.eu.neon.tech/db", "postgres://o@ep-prod.eu.neon.tech/db"), false);
  assert.equal(databaseHost("not a url"), "");
});

test("the isolated gate accepts only the named quiet-sound branch", () => {
  assert.equal(hostIsProductionEndpoint("postgres://u@ep-withered-haze-b1fd9hse-pooler.eu.neon.tech/neondb"), true);
  assert.equal(hostIsProductionEndpoint("postgres://u@ep-other.eu.neon.tech/neondb"), false);
  const schema = { organisationType: true, acceptances: true, hotels: true, founding: true, immutableTrigger: true };
  const identity = {
    projectId: EXPECTED_PROJECT,
    branchId: EXPECTED_BRANCH,
    endpointId: "ep-isolated-example",
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
  };
  assert.deepEqual(isolatedGateFailures({ identity, ledger: [...REQUIRED_LEDGER], schema }), []);
  assert.deepEqual(
    isolatedGateFailures({ identity: { ...identity, projectId: "round-sunset-69114165" }, ledger: [...REQUIRED_LEDGER], schema }),
    ["project"],
  );
  assert.deepEqual(
    isolatedGateFailures({ identity: { ...identity, branchId: FORBIDDEN_BRANCH }, ledger: [...REQUIRED_LEDGER], schema }),
    ["branch", "production-branch"],
  );
  assert.deepEqual(
    isolatedGateFailures({ identity: { ...identity, endpointId: FORBIDDEN_ENDPOINT }, ledger: [...REQUIRED_LEDGER], schema }),
    ["endpoint"],
  );
  assert.equal(isolatedLedgerMode([...REQUIRED_LEDGER]), "apply");
  assert.equal(isolatedLedgerMode([...REQUIRED_LEDGER, TARGET_MIGRATION]), "verify-installed");
  assert.deepEqual(isolatedGateFailures({ identity, ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION], schema }), []);
  assert.deepEqual(
    isolatedGateFailures({ identity, ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION, "0035_later.sql"], schema }),
    ["ledger"],
  );
  assert.equal(isolatedLedgerMode([...REQUIRED_LEDGER, TARGET_MIGRATION, TARGET_MIGRATION]), "rejected");
  assert.equal(isolatedLedgerMode([TARGET_MIGRATION]), "rejected");
  assert.equal(isolatedLedgerMode([...REQUIRED_LEDGER.slice(0, -1), TARGET_MIGRATION]), "rejected");
  assert.deepEqual(isolatedGateFailures({ identity, ledger: [...REQUIRED_LEDGER], schema: { ...schema, founding: false } }), ["schema"]);
  assert.equal(ISOLATED_CONFIRMATION, "VERIFY-0034-ISOLATED");
  assert.equal(ISOLATED_OWNER_ENV, "AETHER_0034_ISOLATED_OWNER_URL");
});

test("the production controller rejects every database that is not the production endpoint", () => {
  const host = `postgres://owner@${PRODUCTION_ENDPOINT_ID}-pooler.eu-central-1.aws.neon.tech/neondb`;
  assert.deepEqual(productionOwnerHostFailures(host), []);
  assert.deepEqual(
    productionOwnerHostFailures("postgres://owner@ep-snowy-meadow-b1bgiqe2.eu-central-1.aws.neon.tech/neondb"),
    ["endpoint-host"],
  );
  assert.deepEqual(productionOwnerHostFailures("not a url"), ["endpoint-host"]);
  assert.deepEqual(productionNeonFailures(facts()), []);
  const wrongProject = evaluate0034Baseline(facts({ projectId: "round-sunset-69114165" }), file);
  assert.equal(wrongProject.verdict, NEON_BLOCKED);
  assert.deepEqual(wrongProject.failures, ["project", "wrong-project"]);
  const isolated = evaluate0034Baseline(
    facts({ branchId: "br-late-paper-b15gkfj3", endpointId: "ep-snowy-meadow-b1bgiqe2" }),
    file,
  );
  assert.equal(isolated.verdict, NEON_BLOCKED);
  assert.deepEqual(isolated.failures, ["branch", "isolated-branch", "endpoint", "isolated-endpoint"]);
  assert.equal(evaluate0034Baseline(facts({ projectId: "" }), file).verdict, NEON_BLOCKED);
  assert.match(src, /current_setting\('neon\.project_id'/);
  assert.match(src, /BLOCKED — PRODUCTION ENDPOINT HOST MISMATCH/);
  assert.doesNotMatch(src, /NEON_API_KEY/);
});

test("confirmation and an unexpected migration fail closed", () => {
  assert.equal(evaluate0034Baseline(facts({ confirmation: "nope" }), file).verdict, CONFIRM_BLOCKED);
  assert.equal(
    evaluate0034Baseline(facts({ ownerUrl: "" }), file).verdict,
    "BLOCKED — AETHER_DATABASE_OWNER_URL is not configured",
  );
  const authorised = evaluate0034Baseline(facts(), file);
  assert.equal(authorised.ok, true);
  assert.equal(authorised.verdict, AUTHORISED);
  assert.equal(authorised.migrated, false);
  assert.deepEqual(authorised.pending, [TARGET_MIGRATION]);
  const extra = evaluate0034Baseline(
    facts({ sourceMigrations: [...REQUIRED_LEDGER, TARGET_MIGRATION, "0035_later.sql"] }),
    file,
  );
  assert.equal(extra.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(extra.unexpectedPending, ["0035_later.sql"]);
  assert.equal(evaluate0034Baseline(facts(), { ...file, digest: "0".repeat(64) }).verdict, DIGEST_BLOCKED);
});

test("an already applied 0034 contract does not mutate", () => {
  const again = evaluate0034Baseline(facts({ ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION] }), file);
  assert.equal(again.verdict, ALREADY_APPLIED);
  assert.equal(again.migrated, false);
  const broken = evaluate0034Baseline(
    facts({
      ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
      onboarding: installed({ appOrgUpdate: true }),
      acceptance: {
        immutableTrigger: true,
        truncateTrigger: true,
        appSelect: false,
        appInsert: true,
        appUpdate: false,
        appDelete: false,
      },
    }),
    file,
  );
  assert.equal(broken.verdict, CONTRACT_BLOCKED);
});

test("the transaction commits only when counts and zero acceptance rows hold", async () => {
  const calls = [];
  const applied = await apply0034Transaction({
    sql,
    before: facts(),
    query: async (text, params) => {
      calls.push({ text, params });
    },
    inspect: async () => facts({ ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION] }),
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.verdict, APPLIED_VERIFIED);
  assert.equal(calls[0].text, "BEGIN");
  assert.equal(calls[1].text, sql);
  assert.deepEqual(calls[2].params, [TARGET_MIGRATION]);
  assert.equal(calls.at(-1).text, "COMMIT");

  const rolled = [];
  const rejected = await apply0034Transaction({
    sql,
    before: facts(),
    query: async (text) => {
      rolled.push(text);
    },
    inspect: async () => facts({ ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION], acceptanceCount: 1 }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.verdict, POST_BLOCKED);
  assert.equal(rolled.at(-1), "ROLLBACK");
  assert.equal(rejected.committed, false);
});

test("a conflicting classification rejection is captured before Node can treat it as unhandled", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
  process.on("unhandledRejection", onUnhandled);
  try {
    let rejectWaiter;
    const inner = new Promise((resolve, reject) => {
      rejectWaiter = () => reject(Object.assign(new Error("organisation type is already set"), { code: "42501" }));
    });
    const query = inner.catch((err) => {
      throw err;
    });
    const captured = captureQuery(query);
    await Promise.resolve();
    rejectWaiter();
    await new Promise((resolve) => setImmediate(resolve));
    const settled = await captured;
    assert.equal(settled.result, null);
    assert.match(settled.error, /organisation type is already set/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.match(sql, /if v_current is null or v_current is distinct from p_type then/);
    assert.match(sql, /raise exception 'organisation type is already set'/);
    assert.match(race, /captureQuery\(waiter\.query/);
    assert.match(race, /test2_waiter_rejected/);
    assert.match(race, /BLOCKED — CONFLICTING CLASSIFICATION OVERWROTE/);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("catching the waiter only after another turn is an unhandled rejection", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const unhandled = [];
       process.on("unhandledRejection", (reason) => {
         unhandled.push(String(reason?.message ?? reason));
       });
       const waiterPromise = Promise.reject(new Error("organisation type is already set"));
       await new Promise((resolve) => setImmediate(resolve));
       let waiterError = "";
       try { await waiterPromise; } catch (err) { waiterError = String(err?.message ?? err); }
       if (!/already set/.test(waiterError)) process.exit(2);
       if (unhandled.length !== 1 || !/already set/.test(unhandled[0])) process.exit(3);`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("only the failed run's marker users and their prefixed organisations are disposable", () => {
  const user = {
    id: "e2d2c1-11111111-1111-1111-1111-111111111111",
    email: "e2d2c1-proof-e2d2c1-11111111-1111-1111-1111-111111111111@invalid.scanbookgo.test",
    name: "E2D2C1 conflict",
  };
  assert.equal(isDisposableMarkerUser(user), true);
  assert.equal(isDisposableMarkerUser({ ...user, email: "owner@scanbookgo.com" }), false);
  assert.equal(isDisposableMarkerUser({ ...user, name: "Kos Transfers Limited" }), false);
  assert.equal(isDisposableMarkerUser({ ...user, id: "real-user" }), false);
  assert.equal(disposableMarkerOrgProblem({ name: "E2D2C1 Conflict", createdBy: user.id }, [user.id]), "");
  assert.equal(
    disposableMarkerOrgProblem({ name: "E2D2C1 Conflict", createdBy: "someone-else" }, [user.id]),
    "org-creator-not-marker",
  );
  assert.equal(disposableMarkerOrgProblem({ name: "Portobello Royal", createdBy: user.id }, [user.id]), "org-not-marker");
  assert.match(race, /removePriorMarkers/);
  assert.match(race, /isolated_0034_apply_invoked/);
  assert.match(race, /BLOCKED — INSTALLED 0034 WAS APPLIED AGAIN/);
});

test("owner cannot SET ROLE aether_app and runtime still has no acceptance DML", () => {
  const denied = {
    insert: false,
    update: false,
    delete: false,
    select: false,
    runtimeExecute: false,
    publicExecute: false,
    ownerCanSetApp: false,
  };
  assert.deepEqual(acceptancePrivilegeFailures(denied), []);
  assert.deepEqual(acceptancePrivilegeFailures({ ...denied, insert: true }), ["app-insert"]);
  assert.deepEqual(acceptancePrivilegeFailures({ ...denied, select: true }), ["app-select"]);
  assert.deepEqual(acceptancePrivilegeFailures({ ...denied, runtimeExecute: true }), ["runtime-execute"]);
  assert.deepEqual(acceptancePrivilegeFailures({ ...denied, publicExecute: true }), ["public-execute"]);
  assert.deepEqual(acceptancePrivilegeFailures({ ...denied, ownerCanSetApp: true }), ["owner-set-role"]);
  assert.deepEqual(acceptancePrivilegeFailures({ ...denied, ownerCanSetApp: null }), ["owner-set-role"]);
  assert.deepEqual(
    acceptancePrivilegeFailures({ ...denied, update: true, ownerCanSetApp: true }),
    ["app-update", "owner-set-role"],
  );
  assert.doesNotMatch(race, /SET\s+(LOCAL\s+)?ROLE\s+aether_app/);
  assert.match(race, /pg_has_role\(current_user, 'aether_app', 'SET'\)/);
  assert.match(race, /has_table_privilege\('aether_app', 'public\.sbg_organisation_acceptances', 'INSERT'\)/);
  const roleMigration = readFileSync(join(root, "migrations", "0014_cp13a_production_app_role.sql"), "utf8");
  assert.match(roleMigration, /Do not grant this role to the connecting owner/);
});
