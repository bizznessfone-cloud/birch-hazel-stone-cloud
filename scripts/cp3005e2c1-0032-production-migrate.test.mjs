/**
 * CP30.05E-2C.1 — 0032 controller contract. No Production connection. Do not apply.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING, isAuthorisedPending } from "./production-db-preflight.mjs";
import {
  ALREADY_APPLIED,
  APPLIED_VERIFIED,
  APPLY_FAILED,
  AUTHORISED,
  CONFIRM_BLOCKED,
  CONTRACT_BLOCKED,
  DIGEST_BLOCKED,
  POST_BLOCKED,
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  REVIEWED_DIGESTS,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNEXPECTED_PLAN,
  apply0032Transaction,
  evaluate0032Aftermath,
  evaluate0032Baseline,
  runSingleUse0032,
} from "./cp3005e2c1-0032-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sql = readFileSync(join(root, "migrations", TARGET_MIGRATION), "utf8");
const src = readFileSync(join(here, "cp3005e2c1-0032-production-migrate.mjs"), "utf8");
const file = { name: TARGET_MIGRATION, sql, digest: TARGET_DIGEST };

function installedAcceptance(overrides = {}) {
  return {
    present: true,
    versionType: "text",
    versionNullable: false,
    acceptedAtType: "timestamptz",
    acceptedAtNullable: false,
    booleanColumns: 0,
    hotelColumn: false,
    quantityColumn: false,
    uniqueVersion: true,
    immutableTrigger: true,
    truncateTrigger: true,
    appSelect: false,
    appInsert: false,
    appUpdate: false,
    appDelete: false,
    appExecute: false,
    createFunctionArgs: "p_user_id text, p_name text",
    organisationTypePresent: true,
    organisationTypeNullable: true,
    organisationTypeDefault: null,
    ...overrides,
  };
}

function facts(overrides = {}) {
  return {
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...REQUIRED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    organisationCount: 1,
    classifiedCount: 0,
    acceptanceCount: 0,
    members: [{ organisationId: "org-1", userId: "user-1", role: "member", billingAuthority: true }],
    licensedQuantity: 3,
    allocationCount: 4,
    hotels: [{ code: "one", status: "configured", organisationId: "org-1" }],
    commerce: { present: true, liveMapping: false, liveCheckout: false },
    acceptance: installedAcceptance({
      present: false,
      versionType: "",
      versionNullable: true,
      acceptedAtType: "",
      acceptedAtNullable: true,
      uniqueVersion: false,
      immutableTrigger: false,
      truncateTrigger: false,
    }),
    confirmation: REQUIRED_CONFIRMATION,
    ownerUrl: "postgres://owner@localhost/neondb",
    ...overrides,
  };
}

function appliedFacts(overrides = {}) {
  return facts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    acceptance: installedAcceptance(),
    acceptanceCount: 0,
    ...overrides,
  });
}

test("0032 digest is pinned and the controller ledger stays frozen at 0001-0031", () => {
  const hash = createHash("sha256").update(sql).digest("hex");
  assert.equal(hash, TARGET_DIGEST);
  assert.equal(REVIEWED_DIGESTS[TARGET_MIGRATION], TARGET_DIGEST);
  assert.deepEqual(
    REQUIRED_LEDGER,
    ACCEPTED_LEDGER.filter(
      (name) => name !== TARGET_MIGRATION && name !== "0033_cp3005e2d2b_founding_organisation.sql",
    ),
  );
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0033_cp3005e2d2b_founding_organisation.sql");
  assert.notDeepEqual(REQUIRED_LEDGER, [...ACCEPTED_LEDGER]);
  assert.equal(REQUIRED_LEDGER.at(-1), "0031_cp3005e2c_organisation_type.sql");
  assert.equal(REQUIRED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.doesNotMatch(src, /REQUIRED_LEDGER\s*=\s*\[\s*\.\.\.ACCEPTED_LEDGER/);
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.equal(isAuthorisedPending("0032_later.sql"), false);
  assert.equal(isAuthorisedPending("0033_later.sql"), false);
  assert.equal(isAuthorisedPending("0033_cp3005e2d2b_founding_organisation.sql"), false);
  assert.equal(ACCEPTED_LEDGER.includes("0033_cp3005e2d2b_founding_organisation.sql"), true);
  assert.deepEqual(
    readdirSync(join(root, "migrations")).filter((name) => name.startsWith("0033")).sort(),
    ["0033_cp3005e2d2b_founding_organisation.sql"],
  );
  const executable = sql.replace(/--.*$/gm, "");
  assert.doesNotMatch(executable, /\binsert\s+into\b/i);
  assert.doesNotMatch(executable, /\bgrant\b/i);
  assert.doesNotMatch(executable, /licensed_quantity/);
  assert.doesNotMatch(executable, /\bhotels\b/);
  assert.doesNotMatch(executable, /organisation_type/);
  assert.doesNotMatch(executable, /sbg_create_organisation_for_user/);
  assert.doesNotMatch(executable, /terms_accepted/);
  assert.doesNotMatch(src, /from "\.\/production-db-migrate\.mjs"/);
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /STRIPE_SECRET|sk_live|sk_test|api\.stripe\.com/);
  assert.equal(existsSync(join(root, ".github/workflows/cp3005e2c1-0032-production-apply.yml")), false);
  const workflows = readdirSync(join(root, ".github/workflows")).sort();
  assert.deepEqual(workflows, ["cp3005e2d2c1-0034-isolated-verify.yml", "cp3005e2d2c1-0034-production-apply.yml", "production-database.yml"]);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["db:migrate:0032"], undefined);
  assert.doesNotMatch(pkg.scripts.build, /0032|cp3005e2c1/);
  assert.match(pkg.scripts["test:aether"], /cp3005e2c1-0032-production-migrate\.test\.mjs/);
});

test("confirmation and owner URL are required before 0032 is authorised", () => {
  assert.equal(evaluate0032Baseline(facts({ confirmation: "nope" }), file).verdict, CONFIRM_BLOCKED);
  assert.equal(
    evaluate0032Baseline(facts({ ownerUrl: "" }), file).verdict,
    "BLOCKED — AETHER_DATABASE_OWNER_URL is not configured",
  );
  const authorised = evaluate0032Baseline(facts(), file);
  assert.equal(authorised.ok, true);
  assert.equal(authorised.verdict, AUTHORISED);
  assert.equal(authorised.migrated, false);
  assert.deepEqual(authorised.pending, [TARGET_MIGRATION]);
});

test("0033 and a wrong digest are rejected", () => {
  const extra = evaluate0032Baseline(
    facts({ sourceMigrations: [...REQUIRED_LEDGER, TARGET_MIGRATION, "0033_later.sql"] }),
    file,
  );
  assert.equal(extra.ok, false);
  assert.equal(extra.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(extra.unexpectedPending, ["0033_later.sql"]);
  const digest = evaluate0032Baseline(facts(), { ...file, digest: "0".repeat(64) });
  assert.equal(digest.verdict, DIGEST_BLOCKED);
});

test("an already applied 0032 contract does not mutate and pending is empty", () => {
  const again = evaluate0032Baseline(appliedFacts(), file);
  assert.equal(again.ok, true);
  assert.equal(again.verdict, ALREADY_APPLIED);
  assert.deepEqual(again.pending, []);
  assert.equal(again.migrated, false);
  const broken = evaluate0032Baseline(
    appliedFacts({ acceptance: installedAcceptance({ appInsert: true }) }),
    file,
  );
  assert.equal(broken.verdict, CONTRACT_BLOCKED);
});

test("the transaction moves the ledger from 0001-0031 to 0001-0032 and rolls back a fabricated acceptance", async () => {
  const calls = [];
  const applied = await apply0032Transaction({
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
  assert.deepEqual(applied.pending, []);
  assert.equal(calls[0].text, "BEGIN");
  assert.equal(calls[1].text, sql);
  assert.deepEqual(calls[2].params, [TARGET_MIGRATION]);
  assert.equal(calls.at(-1).text, "COMMIT");
  assert.equal(evaluate0032Aftermath(appliedFacts(), facts()).pending.length, 0);

  const rolled = [];
  const rejected = await apply0032Transaction({
    sql,
    before: facts(),
    query: async (text) => {
      rolled.push(text);
    },
    inspect: async () =>
      appliedFacts({
        acceptanceCount: 1,
        acceptance: installedAcceptance({ booleanColumns: 1, appInsert: true }),
        classifiedCount: 1,
      }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.verdict, POST_BLOCKED);
  assert.equal(rejected.committed, false);
  assert.equal(rejected.migrated, false);
  assert.ok(rejected.failures.includes("acceptance-rows"));
  assert.ok(rejected.failures.includes("boolean-column"));
  assert.ok(rejected.failures.includes("app-insert"));
  assert.ok(rejected.failures.includes("classified-rows"));
  assert.equal(rolled.at(-1), "ROLLBACK");
  assert.equal(rolled.includes("COMMIT"), false);
});

test("a membership, quantity, or allocation change during apply is rolled back", async () => {
  const calls = [];
  const changed = await apply0032Transaction({
    sql,
    before: facts(),
    query: async (text) => {
      calls.push(text);
    },
    inspect: async () =>
      appliedFacts({
        members: [{ organisationId: "org-1", userId: "user-1", role: "owner", billingAuthority: true }],
        licensedQuantity: 9,
        allocationCount: 8,
      }),
  });
  assert.equal(changed.verdict, POST_BLOCKED);
  assert.ok(changed.failures.includes("membership"));
  assert.ok(changed.failures.includes("licensed-quantity"));
  assert.ok(changed.failures.includes("allocations"));
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("runSingleUse0032 does not call mutate when already applied or the phrase is wrong", async () => {
  let mutated = 0;
  const skipped = await runSingleUse0032({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@localhost/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file,
    loadFacts: async () => appliedFacts(),
    mutate: async () => {
      mutated += 1;
      return { ok: true, migrated: true };
    },
  });
  assert.equal(skipped.verdict, ALREADY_APPLIED);
  assert.equal(mutated, 0);
  const phrase = await runSingleUse0032({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@localhost/neondb" },
    confirmation: "APPLY-0031",
    file,
    loadFacts: async () => facts(),
    mutate: async () => {
      mutated += 1;
    },
  });
  assert.equal(phrase.verdict, CONFIRM_BLOCKED);
  assert.equal(mutated, 0);
});

test("controller script refuses to start without the owner secret and redacts failures", async () => {
  await execFileAsync(process.execPath, ["--check", join(here, "cp3005e2c1-0032-production-migrate.mjs")]);
  const refused = await execFileAsync(process.execPath, [join(here, "cp3005e2c1-0032-production-migrate.mjs")], {
    env: { PATH: process.env.PATH, CP3005E2C1_CONFIRMATION: REQUIRED_CONFIRMATION },
  }).catch((err) => err);
  const out = `${refused.stdout || ""}${refused.stderr || ""}`;
  assert.match(out, /AETHER_DATABASE_OWNER_URL is not configured/);
  assert.equal(out.includes("GATE PASS"), false);
  const redacted = await runSingleUse0032({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner:secret@localhost/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file,
    loadFacts: async () => facts(),
    mutate: async () => {
      throw new Error("permission denied postgres://owner:secret@localhost/neondb");
    },
  });
  assert.equal(redacted.ok, false);
  assert.equal(redacted.verdict, APPLY_FAILED);
  assert.match(redacted.error, /redacted/);
  assert.doesNotMatch(redacted.error, /secret/);
});
