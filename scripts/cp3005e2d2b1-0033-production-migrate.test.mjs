/**
 * CP30.05E-2D-2B.1 — 0033 controller contract. No Production connection. Do not apply.
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
  apply0033Transaction,
  evaluate0033Baseline,
  runSingleUse0033,
} from "./cp3005e2d2b1-0033-production-migrate.mjs";
import { MARKER, NAME_PREFIX, assertConfirmation, directOwnerUrl } from "./cp3005e2d2b1-neon-concurrency.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sql = readFileSync(join(root, "migrations", TARGET_MIGRATION), "utf8");
const src = readFileSync(join(here, "cp3005e2d2b1-0033-production-migrate.mjs"), "utf8");
const race = readFileSync(join(here, "cp3005e2d2b1-neon-concurrency.mjs"), "utf8");
const file = { name: TARGET_MIGRATION, sql, digest: TARGET_DIGEST };

function installedFounding(overrides = {}) {
  return {
    present: true,
    securityDefiner: true,
    args: "p_user_id text, p_name text",
    searchPath: "pg_catalog, public",
    owner: "neondb_owner",
    appExecute: true,
    runtimeExecute: false,
    publicExecute: false,
    appOrgSelect: true,
    appOrgInsert: false,
    appOrgUpdate: false,
    appOrgDelete: false,
    appMemberSelect: true,
    appMemberInsert: false,
    appMemberUpdate: false,
    appMemberDelete: false,
    createdByIndex: true,
    createdByUnique: false,
    userIdUnique: false,
    bodyForUpdate: true,
    bodyMember: true,
    bodyBilling: true,
    bodyHotel: false,
    bodyBillingWrite: false,
    bodyAcceptance: false,
    bodyStripe: false,
    bodyTypeAssign: false,
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
    hotels: [{ code: "sbg-verify-a5", status: "configured", organisationId: null }],
    commerce: { present: true, liveMapping: false, liveCheckout: false },
    founding: installedFounding(),
    ...overrides,
  };
}

function appliedFacts(overrides = {}) {
  return facts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    ...overrides,
  });
}

test("0033 digest is pinned and the controller ledger stays frozen at 0001-0032", () => {
  assert.equal(createHash("sha256").update(sql).digest("hex"), TARGET_DIGEST);
  assert.deepEqual(
    REQUIRED_LEDGER,
    ACCEPTED_LEDGER.filter((name) => name !== TARGET_MIGRATION),
  );
  assert.equal(ACCEPTED_LEDGER.at(-1), TARGET_MIGRATION);
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.equal(REQUIRED_LEDGER.at(-1), "0032_cp3005e2c1_organisation_acceptance.sql");
  assert.equal(REQUIRED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.doesNotMatch(src, /REQUIRED_LEDGER\s*=\s*\[\s*\.\.\.ACCEPTED_LEDGER/);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.equal(isAuthorisedPending("0034_later.sql"), false);
  assert.doesNotMatch(src, /from "\.\/production-db-migrate\.mjs"/);
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /STRIPE_SECRET|sk_live|sk_test|api\.stripe\.com/);
  assert.equal(existsSync(join(root, ".github/workflows/cp3005e2d2b1-0033-production-apply.yml")), false);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["db:migrate:0033"], undefined);
  assert.doesNotMatch(pkg.scripts.build, /0033|cp3005e2d2b1/);
});

test("confirmation, owner URL, and an unexpected migration fail closed", () => {
  assert.equal(evaluate0033Baseline(facts({ confirmation: "nope" }), file).verdict, CONFIRM_BLOCKED);
  assert.equal(
    evaluate0033Baseline(facts({ ownerUrl: "" }), file).verdict,
    "BLOCKED — AETHER_DATABASE_OWNER_URL is not configured",
  );
  const authorised = evaluate0033Baseline(facts(), file);
  assert.equal(authorised.ok, true);
  assert.equal(authorised.verdict, AUTHORISED);
  assert.equal(authorised.migrated, false);
  assert.deepEqual(authorised.pending, [TARGET_MIGRATION]);
  const extra = evaluate0033Baseline(
    facts({ sourceMigrations: [...REQUIRED_LEDGER, TARGET_MIGRATION, "0034_later.sql"] }),
    file,
  );
  assert.equal(extra.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(extra.unexpectedPending, ["0034_later.sql"]);
  assert.equal(evaluate0033Baseline(facts(), { ...file, digest: "0".repeat(64) }).verdict, DIGEST_BLOCKED);
});

test("an already applied 0033 contract does not mutate", () => {
  const again = evaluate0033Baseline(appliedFacts(), file);
  assert.equal(again.verdict, ALREADY_APPLIED);
  assert.equal(again.migrated, false);
  const broken = evaluate0033Baseline(
    appliedFacts({ founding: installedFounding({ appOrgInsert: true, publicExecute: true }) }),
    file,
  );
  assert.equal(broken.verdict, CONTRACT_BLOCKED);
});

test("the transaction commits a valid function and rolls back a changed hotel snapshot", async () => {
  const calls = [];
  const applied = await apply0033Transaction({
    sql,
    before: facts(),
    query: async (text, params) => {
      calls.push({ text, params });
    },
    inspect: async () => appliedFacts(),
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.verdict, APPLIED_VERIFIED);
  assert.equal(applied.committed, true);
  assert.equal(calls[0].text, "BEGIN");
  assert.equal(calls[1].text, sql);
  assert.deepEqual(calls[2].params, [TARGET_MIGRATION]);
  assert.equal(calls.at(-1).text, "COMMIT");

  const rolled = [];
  const rejected = await apply0033Transaction({
    sql,
    before: facts(),
    query: async (text) => {
      rolled.push(text);
    },
    inspect: async () =>
      appliedFacts({
        organisationCount: 2,
        hotels: [{ code: "sbg-verify-a5", status: "live", organisationId: "changed" }],
        founding: installedFounding({ appMemberInsert: true }),
      }),
  });
  assert.equal(rejected.verdict, POST_BLOCKED);
  assert.equal(rejected.committed, false);
  assert.ok(rejected.failures.includes("organisation-count"));
  assert.ok(rejected.failures.includes("hotels"));
  assert.ok(rejected.failures.includes("app-member-insert"));
  assert.equal(rolled.at(-1), "ROLLBACK");
  assert.equal(rolled.includes("COMMIT"), false);
});

test("runSingleUse0033 does not call mutate when already applied or the phrase is wrong", async () => {
  let mutated = 0;
  const skipped = await runSingleUse0033({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@localhost/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file,
    loadFacts: async () => appliedFacts(),
    mutate: async () => {
      mutated += 1;
      return { ok: true };
    },
  });
  assert.equal(skipped.verdict, ALREADY_APPLIED);
  assert.equal(mutated, 0);
  const phrase = await runSingleUse0033({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@localhost/neondb" },
    confirmation: "APPLY",
    file,
    loadFacts: async () => facts(),
    mutate: async () => {
      mutated += 1;
      return { ok: true };
    },
  });
  assert.equal(phrase.verdict, CONFIRM_BLOCKED);
  assert.equal(mutated, 0);
});

test("the concurrency harness is marker-scoped and does not open a generic migrator", () => {
  assert.equal(
    directOwnerUrl("postgres://owner:secret@ep-example-pooler.eu-central-1.aws.neon.tech/neondb"),
    "postgres://owner:secret@ep-example.eu-central-1.aws.neon.tech/neondb",
  );
  assert.equal(
    directOwnerUrl("postgres://owner:secret@ep-example.eu-central-1.aws.neon.tech/neondb"),
    "postgres://owner:secret@ep-example.eu-central-1.aws.neon.tech/neondb",
  );
  assert.equal(assertConfirmation(REQUIRED_CONFIRMATION), true);
  assert.equal(assertConfirmation("nope"), false);
  assert.equal(MARKER, "e2d2b1");
  assert.match(NAME_PREFIX, /^E2D2B1 /);
  assert.match(race, /sbg_organisations_no_delete/);
  assert.match(race, /sbg_organisation_members_no_delete/);
  assert.match(race, /verb = enabled \? "ENABLE" : "DISABLE"/);
  assert.match(race, /sbg_organisations_no_delete/);
  assert.doesNotMatch(race, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(race, /sk_live|sk_test|api\.stripe\.com/i);
  assert.doesNotMatch(race, /from "\.\/production-db-migrate\.mjs"/);
  assert.doesNotMatch(race, /delete from hotels/i);
  assert.match(race, /created_by_user_id = any/);
  const workflows = readdirSync(join(root, ".github/workflows")).sort();
  assert.deepEqual(workflows, ["cp3005e2d2c1-0034-production-apply.yml", "production-database.yml"]);
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(AUTHORISED_PENDING.includes(TARGET_MIGRATION), false);
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
});
