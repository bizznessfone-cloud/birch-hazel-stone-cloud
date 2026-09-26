import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING, isAuthorisedPending } from "./production-db-preflight.mjs";
import {
  ALREADY_APPLIED,
  APPLIED_VERIFIED,
  AUTHORISED,
  CONFIRM_BLOCKED,
  DIGEST_BLOCKED,
  HISTORICAL_PLANS,
  PROPERTY_LICENCE_PLAN,
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  REVIEWED_DIGESTS,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNEXPECTED_COMMERCIAL,
  UNEXPECTED_PLAN,
  apply0028Transaction,
  assertConfirmation,
  assertMigrationFile,
  evaluate0028Aftermath,
  evaluate0028Baseline,
  runSingleUse0028,
  sha256,
} from "./cp26fin-0028-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "cp26fin-0028-production-migrate.mjs"), "utf8");
const sql = readFileSync(join(here, "../migrations", TARGET_MIGRATION), "utf8");
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
const file = {
  name: TARGET_MIGRATION,
  sql,
  digest: TARGET_DIGEST,
};

function plans(activeHistorical, includeLicence) {
  const rows = HISTORICAL_PLANS.map((plan) => ({ ...plan, active: activeHistorical }));
  if (includeLicence) rows.push({ ...PROPERTY_LICENCE_PLAN, active: true });
  return rows;
}

function facts(overrides = {}) {
  return {
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledgerReadable: true,
    ledger: [...REQUIRED_LEDGER],
    sourceMigrations: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    confirmation: REQUIRED_CONFIRMATION,
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    activeOwnerCount: 1,
    hotelSnapshot: { hotelCount: 4, demoKos: { code: "demo-kos", status: "live" } },
    verifyHotel: { code: "sbg-verify-a5", status: "configured" },
    billingSnapshot: { accountCount: 0, eventCount: 0 },
    domain: { paymentFunctionPresent: true, bookingPaymentCount: 0, hotelAccountCount: 1 },
    organisation: { counts: { organisations: 0, members: 0, billing: 0, allocations: 0, attachedHotels: 0 } },
    catalogue: {
      plans: plans(true, false),
      priceVersionCount: 0,
      mappingCount: 0,
      lock: { liveMappingEnabled: false, liveCheckoutEnabled: false },
    },
    catalogueContractFailures: [],
    organisationContractFailures: [],
    hotelApplyFailures: [],
    priceCreateRejectsHistorical: false,
    ...overrides,
  };
}

test("0028 digest is pinned, accepted, and the controller ledger stays frozen at 0001-0027", () => {
  assert.equal(sha256(Buffer.from(sql)), TARGET_DIGEST);
  assert.equal(assertMigrationFile(file).ok, true);
  assert.equal(ACCEPTED_LEDGER.at(-1), TARGET_MIGRATION);
  assert.equal(ACCEPTED_LEDGER.includes("0027_cp26co41_organisation_property_licence.sql"), true);
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.deepEqual(
    REQUIRED_LEDGER,
    ACCEPTED_LEDGER.filter((name) => name !== TARGET_MIGRATION),
  );
  assert.equal(REQUIRED_LEDGER.at(-1), "0027_cp26co41_organisation_property_licence.sql");
  assert.equal(REQUIRED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.notDeepEqual(REQUIRED_LEDGER, [...ACCEPTED_LEDGER]);
  assert.doesNotMatch(src, /REQUIRED_LEDGER\s*=\s*\[\s*\.\.\.ACCEPTED_LEDGER/);
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.equal(REVIEWED_DIGESTS["0027_cp26co41_organisation_property_licence.sql"],
    "1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef");
  assert.doesNotMatch(sql, /\b179\b/);
  assert.doesNotMatch(sql, /€/);
  assert.match(sql, /historical plan cannot receive a price version/);
  assert.match(sql, /plan inactive/);
  assert.match(sql, /property_licence/);
});

test("pre-state authorises only an empty property-licence catalogue cutover", () => {
  assert.equal(evaluate0028Baseline(facts(), file).verdict, AUTHORISED);
  assert.equal(evaluate0028Baseline(facts({ catalogue: { ...facts().catalogue, priceVersionCount: 1 } }), file).verdict, UNEXPECTED_COMMERCIAL);
  assert.equal(evaluate0028Baseline(facts({ catalogue: { ...facts().catalogue, mappingCount: 1 } }), file).verdict, UNEXPECTED_COMMERCIAL);
  assert.equal(
    evaluate0028Baseline(facts({ organisation: { counts: { organisations: 1, members: 0, billing: 0, allocations: 0, attachedHotels: 0 } } }), file).verdict,
    UNEXPECTED_COMMERCIAL,
  );
  assert.equal(evaluate0028Baseline(facts({ sourceMigrations: [...REQUIRED_LEDGER] }), file).verdict, UNEXPECTED_PLAN);
  assert.equal(assertConfirmation("APPLY-0027").verdict, CONFIRM_BLOCKED);
  assert.equal(assertMigrationFile({ name: TARGET_MIGRATION, sql: `${sql}\n-- 179` }).verdict, DIGEST_BLOCKED);
});

test("already-applied 0028 does not mutate when the cutover contract holds", () => {
  const applied = facts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    catalogue: {
      plans: plans(false, true),
      priceVersionCount: 0,
      mappingCount: 0,
      lock: { liveMappingEnabled: false, liveCheckoutEnabled: false },
    },
    priceCreateRejectsHistorical: true,
  });
  const result = evaluate0028Baseline(applied, file);
  assert.equal(result.verdict, ALREADY_APPLIED);
  assert.equal(result.migrated, false);
  const aftermath = evaluate0028Aftermath(applied, applied);
  assert.equal(aftermath.verdict, APPLIED_VERIFIED);
});

test("transaction rolls back when the ledger insert fails and never prints secrets", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      apply0028Transaction({
        sql,
        before: facts(),
        query: async (text) => {
          calls.push(String(text));
          if (String(text).startsWith("INSERT")) throw new Error("permission denied postgres://owner:secret@host/neondb");
        },
        inspect: async () => facts(),
      }),
    /permission denied/,
  );
  assert.equal(calls[0], "BEGIN");
  assert.equal(calls.at(-1), "ROLLBACK");
  const guarded = await runSingleUse0028({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file,
    loadFacts: async () => facts(),
    mutate: async () => {
      throw new Error("permission denied postgres://owner:secret@host/neondb");
    },
  });
  assert.equal(guarded.ok, false);
  assert.match(guarded.error, /redacted/);
  assert.doesNotMatch(guarded.error, /secret/);
});

test("0028 dispatch is retired and build does not apply 0028", () => {
  const workflows = readdirSync(join(here, "../.github/workflows")).sort();
  assert.equal(existsSync(join(here, "../.github/workflows/cp26co42-0027-production-migrate.yml")), false);
  assert.equal(existsSync(join(here, "../.github/workflows/cp26fin-0028-production-migrate.yml")), false);
  assert.equal(existsSync(join(here, "cp26fin-0028-production-migrate.mjs")), true);
  assert.deepEqual(workflows, [
    "cp26co2a-0025-production-migrate.yml",
    "production-database.yml",
  ]);
  for (const name of workflows) {
    const text = readFileSync(join(here, "../.github/workflows", name), "utf8");
    assert.equal(text.includes("cp26fin-0028-production-migrate.mjs"), false, name);
    assert.equal(text.includes("APPLY-0028"), false, name);
    assert.equal(text.includes("cp26co42-0027-production-migrate.mjs"), false, name);
  }
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /STRIPE_SECRET|sk_live|sk_test|api\.stripe\.com/);
  assert.doesNotMatch(src, /SBG_SAAS_COMMERCE\s*=/);
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.equal(pkg.scripts["db:migrate:0028"], undefined);
  assert.match(pkg.scripts["test:aether"], /cp26fin-0028-production-migrate\.test\.mjs/);
});

test("controller script is syntactically valid and refuses to start without the owner secret", async () => {
  await execFileAsync("node", ["--check", join(here, "cp26fin-0028-production-migrate.mjs")]);
  const ran = await execFileAsync("node", [join(here, "cp26fin-0028-production-migrate.mjs")], {
    env: { PATH: process.env.PATH, CP26FIN_CONFIRMATION: REQUIRED_CONFIRMATION, DATABASE_URL: "postgres://runtime:secret@host/neondb" },
  }).catch((err) => err);
  const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  assert.match(output, /AETHER_DATABASE_OWNER_URL: ABSENT/);
  assert.doesNotMatch(output, /secret/);
});
