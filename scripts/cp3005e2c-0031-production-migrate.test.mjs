/**
 * CP30.05E-2C — 0031 controller contract. No Production connection. Do not apply.
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
  apply0031Transaction,
  evaluate0031Aftermath,
  evaluate0031Baseline,
  runSingleUse0031,
} from "./cp3005e2c-0031-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sql = readFileSync(join(root, "migrations", TARGET_MIGRATION), "utf8");
const src = readFileSync(join(here, "cp3005e2c-0031-production-migrate.mjs"), "utf8");
const file = { name: TARGET_MIGRATION, sql, digest: TARGET_DIGEST };

function installedColumn(overrides = {}) {
  return {
    present: true,
    dataType: "text",
    nullable: true,
    columnDefault: null,
    checkAcceptsHotel: true,
    checkAcceptsTransfer: true,
    checkAllowsNull: true,
    appSelect: true,
    appInsert: false,
    appUpdate: false,
    appDelete: false,
    uniqueHotelOrganisation: false,
    licensedQuantityOnOrganisation: false,
    createFunctionArgs: "p_user_id text, p_name text",
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
    organisationCount: 2,
    classifiedCount: 0,
    members: [{ organisationId: "org-1", userId: "user-1", role: "member", billingAuthority: true }],
    licensedQuantity: 3,
    allocationCount: 1,
    hotels: [
      { code: "one", status: "configured", organisationId: "org-1" },
      { code: "two", status: "live", organisationId: "org-1" },
    ],
    commerce: { present: true, liveMapping: false, liveCheckout: false },
    organisationType: installedColumn({ present: false, dataType: "", nullable: false, checkAcceptsHotel: false, checkAcceptsTransfer: false, checkAllowsNull: false }),
    confirmation: REQUIRED_CONFIRMATION,
    ownerUrl: "postgres://owner@localhost/neondb",
    ...overrides,
  };
}

function appliedFacts(overrides = {}) {
  return facts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    organisationType: installedColumn(),
    classifiedCount: 0,
    ...overrides,
  });
}

test("0031 digest is pinned and the controller ledger stays frozen at 0001-0030", () => {
  const hash = createHash("sha256").update(sql).digest("hex");
  assert.equal(hash, TARGET_DIGEST);
  assert.equal(REVIEWED_DIGESTS[TARGET_MIGRATION], TARGET_DIGEST);
  assert.deepEqual(
    REQUIRED_LEDGER,
    ACCEPTED_LEDGER.filter(
      (name) =>
        name !== TARGET_MIGRATION &&
        name !== "0032_cp3005e2c1_organisation_acceptance.sql" &&
        name !== "0033_cp3005e2d2b_founding_organisation.sql",
    ),
  );
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0033_cp3005e2d2b_founding_organisation.sql");
  assert.notDeepEqual(REQUIRED_LEDGER, [...ACCEPTED_LEDGER]);
  assert.equal(REQUIRED_LEDGER.at(-1), "0030_cp272_fix_prepare_booking_payment.sql");
  assert.equal(REQUIRED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.doesNotMatch(src, /REQUIRED_LEDGER\s*=\s*\[\s*\.\.\.ACCEPTED_LEDGER/);
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.equal(isAuthorisedPending("0031_later.sql"), false);
  assert.equal(isAuthorisedPending("0032_later.sql"), false);
  assert.equal(isAuthorisedPending("0033_cp3005e2d2b_founding_organisation.sql"), false);
  assert.equal(ACCEPTED_LEDGER.includes("0033_cp3005e2d2b_founding_organisation.sql"), true);
  assert.deepEqual(
    readdirSync(join(root, "migrations")).filter((name) => name.startsWith("0033")).sort(),
    ["0033_cp3005e2d2b_founding_organisation.sql"],
  );
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\b(update|insert|grant)\b/i);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /sbg_create_organisation_for_user/);
  assert.doesNotMatch(src, /from "\.\/migrate\.mjs"/);
  assert.doesNotMatch(src, /from "\.\/production-db-migrate\.mjs"/);
  assert.doesNotMatch(src, /db:migrate/);
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /STRIPE_SECRET|sk_live|sk_test|api\.stripe\.com/);
  assert.equal(existsSync(join(root, ".github/workflows/cp3005e2c-0031-production-apply.yml")), false);
  const workflows = readdirSync(join(root, ".github/workflows")).sort();
  assert.deepEqual(workflows, ["cp3005e2d2c1-0034-production-apply.yml", "production-database.yml"]);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["db:migrate:0031"], undefined);
  assert.doesNotMatch(pkg.scripts.build, /0031|cp3005e2c/);
  assert.match(pkg.scripts["test:aether"], /cp3005e2c-0031-production-migrate\.test\.mjs/);
});

test("confirmation and owner URL are required before 0031 is authorised", () => {
  assert.equal(evaluate0031Baseline(facts({ confirmation: "nope" }), file).verdict, CONFIRM_BLOCKED);
  assert.equal(
    evaluate0031Baseline(facts({ ownerUrl: "" }), file).verdict,
    "BLOCKED — AETHER_DATABASE_OWNER_URL is not configured",
  );
  const authorised = evaluate0031Baseline(facts(), file);
  assert.equal(authorised.ok, true);
  assert.equal(authorised.verdict, AUTHORISED);
  assert.equal(authorised.migrated, false);
  assert.deepEqual(authorised.pending, [TARGET_MIGRATION]);
});

test("0032, a wrong digest, and a role-shaped value are rejected", () => {
  const extra = evaluate0031Baseline(
    facts({ sourceMigrations: [...REQUIRED_LEDGER, TARGET_MIGRATION, "0032_later.sql"] }),
    file,
  );
  assert.equal(extra.ok, false);
  assert.equal(extra.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(extra.unexpectedPending, ["0032_later.sql"]);
  const digest = evaluate0031Baseline(facts(), { ...file, digest: "0".repeat(64) });
  assert.equal(digest.verdict, DIGEST_BLOCKED);
  assert.doesNotMatch(sql, /organisation_type in \('member'/);
});

test("an already applied 0031 contract does not mutate and pending is empty", () => {
  const again = evaluate0031Baseline(appliedFacts(), file);
  assert.equal(again.ok, true);
  assert.equal(again.verdict, ALREADY_APPLIED);
  assert.deepEqual(again.pending, []);
  assert.equal(again.migrated, false);
  const broken = evaluate0031Baseline(
    appliedFacts({ organisationType: installedColumn({ uniqueHotelOrganisation: true }) }),
    file,
  );
  assert.equal(broken.verdict, CONTRACT_BLOCKED);
});

test("the transaction moves the ledger from 0001-0030 to 0001-0031 and rolls back a classification", async () => {
  const calls = [];
  const applied = await apply0031Transaction({
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
  assert.equal(
    evaluate0031Aftermath(appliedFacts(), facts()).pending.length,
    0,
  );

  const rolled = [];
  const rejected = await apply0031Transaction({
    sql,
    before: facts(),
    query: async (text) => {
      rolled.push(text);
    },
    inspect: async () => appliedFacts({ classifiedCount: 4, organisationType: installedColumn({ columnDefault: "'hotel'" }) }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.verdict, POST_BLOCKED);
  assert.equal(rejected.committed, false);
  assert.equal(rejected.migrated, false);
  assert.ok(rejected.failures.includes("classified-rows"));
  assert.ok(rejected.failures.includes("default"));
  assert.equal(rolled.at(-1), "ROLLBACK");
  assert.equal(rolled.includes("COMMIT"), false);
});

test("a membership or hotel change during apply is rolled back", async () => {
  const calls = [];
  const changed = await apply0031Transaction({
    sql,
    before: facts(),
    query: async (text) => {
      calls.push(text);
    },
    inspect: async () =>
      appliedFacts({
        members: [{ organisationId: "org-1", userId: "user-1", role: "transfer_operator", billingAuthority: true }],
        hotels: [{ code: "one", status: "configured", organisationId: "org-1" }],
      }),
  });
  assert.equal(changed.verdict, POST_BLOCKED);
  assert.ok(changed.failures.includes("membership"));
  assert.ok(changed.failures.includes("hotels"));
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("runSingleUse0031 does not call mutate when already applied or the phrase is wrong", async () => {
  let mutated = 0;
  const skipped = await runSingleUse0031({
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
  const phrase = await runSingleUse0031({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@localhost/neondb" },
    confirmation: "APPLY-0030",
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
  await execFileAsync(process.execPath, ["--check", join(here, "cp3005e2c-0031-production-migrate.mjs")]);
  const refused = await execFileAsync(process.execPath, [join(here, "cp3005e2c-0031-production-migrate.mjs")], {
    env: { PATH: process.env.PATH, CP3005E2C_CONFIRMATION: REQUIRED_CONFIRMATION },
  }).catch((err) => err);
  const out = `${refused.stdout || ""}${refused.stderr || ""}`;
  assert.match(out, /AETHER_DATABASE_OWNER_URL is not configured/);
  assert.equal(out.includes("GATE PASS"), false);
  const redacted = await runSingleUse0031({
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
