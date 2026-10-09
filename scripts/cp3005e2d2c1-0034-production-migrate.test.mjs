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
  POST_BLOCKED,
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNEXPECTED_PLAN,
  apply0034Transaction,
  evaluate0034Baseline,
} from "./cp3005e2d2c1-0034-production-migrate.mjs";
import { databaseHost, directOwnerUrl, matchingEndpointBranchIds, projectIdFromScopedKeyError, sameDatabaseHost } from "./cp3005e2d2c1-neon-concurrency.mjs";

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
  assert.deepEqual(REQUIRED_LEDGER, ACCEPTED_LEDGER);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0033_cp3005e2d2b_founding_organisation.sql");
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.doesNotMatch(src, /REQUIRED_LEDGER\s*=\s*\[\s*\.\.\.ACCEPTED_LEDGER/);
  assert.doesNotMatch(src, /from "\.\/production-db-migrate\.mjs"/);
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /STRIPE_SECRET|sk_live|sk_test|api\.stripe\.com/);
  assert.equal(existsSync(join(root, ".github/workflows/cp3005e2d2c1-0034-production-apply.yml")), true);
  const workflow = readFileSync(join(root, ".github/workflows/cp3005e2d2c1-0034-production-apply.yml"), "utf8");
  assert.match(workflow, /ref: 4082093537dc4a7af5ee3278213ed4959cebeaa8/);
  assert.match(workflow, /APPLY-0034/);
  assert.doesNotMatch(workflow, /production-db-migrate\.mjs/);
  assert.match(race, /BLOCKED — ISOLATED VERIFICATION UNAVAILABLE/);
  assert.match(race, /BEGIN READ ONLY/);
  assert.match(race, /neon_project_source: scoped-key/);
  assert.match(race, /SCOPED NEON PROJECT DID NOT MATCH/);
  assert.match(race, /parent_id: parentBranchId/);
  assert.match(race, /PRODUCTION ENDPOINT DID NOT MATCH ONE BRANCH/);
  assert.doesNotMatch(race, /round-sunset-/);
  assert.doesNotMatch(race, /AETHER_DATABASE_OWNER_URL: branch/);
  const workflows = readdirSync(join(root, ".github/workflows")).sort();
  assert.deepEqual(workflows, ["cp3005e2d2c1-0034-production-apply.yml", "production-database.yml"]);
});

test("a verify branch must not be the production host", () => {
  assert.equal(directOwnerUrl("postgres://u@ep-a-pooler.eu.neon.tech/neondb"), "postgres://u@ep-a.eu.neon.tech/neondb");
  assert.equal(sameDatabaseHost("postgres://u@ep-a-pooler.eu.neon.tech/db", "postgres://o@ep-a.eu.neon.tech/db"), true);
  assert.equal(sameDatabaseHost("postgres://u@ep-branch.eu.neon.tech/db", "postgres://o@ep-prod.eu.neon.tech/db"), false);
  assert.equal(databaseHost("not a url"), "");
});

test("a verify branch must parent the production endpoint, not the project default", () => {
  const endpoints = [
    { id: "ep-prod", host: "ep-prod.eu.neon.tech", branch_id: "br-prod" },
    { id: "ep-default", host: "ep-default.eu.neon.tech", branch_id: "br-default" },
    { id: "ep-prod-ro", host: "ep-prod-ro.eu.neon.tech", branch_id: "br-prod" },
  ];
  assert.deepEqual(
    matchingEndpointBranchIds(endpoints, "postgres://u@ep-prod-pooler.eu.neon.tech/neondb"),
    ["br-prod"],
  );
  assert.deepEqual(matchingEndpointBranchIds(endpoints, "postgres://u@ep-missing.eu.neon.tech/neondb"), []);
  assert.deepEqual(
    matchingEndpointBranchIds(
      [
        { id: "ep-a", host: "ep-a.eu.neon.tech", branch_id: "br-a" },
        { id: "ep-b", host: "ep-a.eu.neon.tech", branch_id: "br-b" },
      ],
      "postgres://u@ep-a.eu.neon.tech/neondb",
    ),
    ["br-a", "br-b"],
  );
});

test("a scoped Neon key error names at most one project", () => {
  assert.equal(
    projectIdFromScopedKeyError({
      message:
        'not allowed to perform actions outside the project this key is scoped to; subject_project_id:"round-sunset-69114165"',
    }),
    "round-sunset-69114165",
  );
  assert.equal(
    projectIdFromScopedKeyError({
      message: "not allowed to perform actions outside the project this key is scoped to",
      details: { subject_project_id: "quiet-rain-1" },
    }),
    "quiet-rain-1",
  );
  assert.equal(
    projectIdFromScopedKeyError({
      message: 'subject_project_id:"alpha-1" subject_project_id:"beta-2"',
    }),
    "",
  );
  assert.equal(projectIdFromScopedKeyError({ message: "not found" }), "");
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
