/**
 * CP27.2 — 0030 controller contract. No Production connection. Do not apply.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING, isAuthorisedPending, evaluatePreflight } from "./production-db-preflight.mjs";
import { evaluateMigrationBaseline, LEDGER_CURRENT } from "./production-db-migrate.mjs";
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
  REVIEWED_DIGESTS,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNEXPECTED_PLAN,
  apply0030Transaction,
  evaluate0030Aftermath,
  evaluate0030Baseline,
  runSingleUse0030,
} from "./cp272-0030-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sql = readFileSync(join(root, "migrations", TARGET_MIGRATION), "utf8");
const prior = readFileSync(join(root, "migrations/0021_cp25_hotel_guest_payments.sql"), "utf8");
const src = readFileSync(join(here, "cp272-0030-production-migrate.mjs"), "utf8");
const file = { name: TARGET_MIGRATION, sql, digest: TARGET_DIGEST };

const occupancy = [
  {
    name: "bookings_driver_occupancy_excl",
    definition: "EXCLUDE USING gist (driver_id WITH =, occupies WITH &&)",
    owner: "neondb_owner",
  },
  {
    name: "bookings_vehicle_occupancy_excl",
    definition: "EXCLUDE USING gist (vehicle_id WITH =, occupies WITH &&)",
    owner: "neondb_owner",
  },
];

function installedPrepare(overrides = {}) {
  return {
    functionPresent: true,
    securityDefiner: true,
    searchPath: "pg_catalog, public",
    qualifiedReturning: true,
    variableConflict: true,
    appSelect: true,
    appInsert: false,
    appUpdate: false,
    appDelete: false,
    publicExecute: false,
    appExecute: true,
    runtimeExecute: true,
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
    hotels: [{ code: "demo-kos", status: "live" }],
    licensedQuantity: 3,
    allocationCount: 4,
    bookingPaymentCount: 0,
    claimRowCount: 0,
    prepare: {
      functionPresent: true,
      securityDefiner: true,
      searchPath: "public",
      qualifiedReturning: false,
      variableConflict: false,
      appSelect: true,
      appInsert: false,
      appUpdate: false,
      appDelete: false,
      publicExecute: false,
      appExecute: true,
      runtimeExecute: true,
    },
    confirmation: REQUIRED_CONFIRMATION,
    ownerUrl: "postgres://owner@localhost/neondb",
    ...overrides,
  };
}

test("0030 digest is pinned, accepted, and the controller ledger stays frozen at 0001-0029", () => {
  const hash = createHash("sha256").update(sql).digest("hex");
  assert.equal(hash, TARGET_DIGEST);
  assert.equal(REVIEWED_DIGESTS[TARGET_MIGRATION], TARGET_DIGEST);
  assert.deepEqual(
    REQUIRED_LEDGER,
    ACCEPTED_LEDGER.filter(
      (name) =>
        name !== TARGET_MIGRATION &&
        name !== "0031_cp3005e2c_organisation_type.sql" &&
        name !== "0032_cp3005e2c1_organisation_acceptance.sql" &&
        name !== "0033_cp3005e2d2b_founding_organisation.sql",
    ),
  );
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0033_cp3005e2d2b_founding_organisation.sql");
  assert.notDeepEqual(REQUIRED_LEDGER, [...ACCEPTED_LEDGER]);
  assert.equal(REQUIRED_LEDGER.at(-1), "0029_cp272_domain_a_checkout_claims.sql");
  assert.equal(REQUIRED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.doesNotMatch(src, /REQUIRED_LEDGER\s*=\s*\[\s*\.\.\.ACCEPTED_LEDGER/);
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.equal(isAuthorisedPending("0030_later.sql"), false);
  assert.equal(isAuthorisedPending("0031_later.sql"), false);
  assert.match(prior, /returning id, booking_id, amount_minor, currency, status, stripe_checkout_session_id, stripe_checkout_url/);
  assert.match(sql, /public\.sbg_booking_payments\.booking_id/);
  assert.match(sql, /#variable_conflict use_column/);
  assert.match(src, /to_regprocedure\(\$1::text\)/);
  assert.doesNotMatch(src, /identity_arguments\(p\.oid\) = 'text'/);
  assert.doesNotMatch(sql, /create or replace function[\s\S]*sbg_set_booking_checkout_session|create or replace function[\s\S]*sbg_apply_payment_event/);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete)/i);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /aether_runtime/);
  assert.match(sql, /revoke all on function public\.sbg_prepare_booking_payment\(text\) from public/);
  assert.match(sql, /grant execute on function public\.sbg_prepare_booking_payment\(text\) to aether_app/);
  assert.doesNotMatch(src, /from "\.\/migrate\.mjs"/);
  assert.doesNotMatch(src, /from "\.\/production-db-migrate\.mjs"/);
  assert.doesNotMatch(src, /db:migrate/);
  assert.equal(existsSync(join(root, ".github/workflows/cp272-0030-production-apply.yml")), false);
  const workflows = readdirSync(join(root, ".github/workflows")).sort();
  assert.deepEqual(workflows, ["cp3005e2d2c1-0034-production-apply.yml", "production-database.yml"]);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["db:migrate:0030"], undefined);
  assert.doesNotMatch(pkg.scripts.build, /0030|cp272-0030/);
});

test("confirmation and owner URL are required before a plan is authorised", () => {
  assert.equal(evaluate0030Baseline(facts({ confirmation: "nope" }), file).verdict, CONFIRM_BLOCKED);
  assert.equal(evaluate0030Baseline(facts({ ownerUrl: "" }), file).verdict, "BLOCKED — AETHER_DATABASE_OWNER_URL is not configured");
  const authorised = evaluate0030Baseline(facts(), file);
  assert.equal(authorised.ok, true);
  assert.equal(authorised.verdict, AUTHORISED);
  assert.equal(authorised.migrated, false);
  assert.deepEqual(authorised.pending, [TARGET_MIGRATION]);
});

test("0031 and a wrong digest are rejected", () => {
  const extra = evaluate0030Baseline(
    facts({ sourceMigrations: [...REQUIRED_LEDGER, TARGET_MIGRATION, "0031_later.sql"] }),
    file,
  );
  assert.equal(extra.ok, false);
  assert.equal(extra.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(extra.unexpectedPending, ["0031_later.sql"]);
  const digest = evaluate0030Baseline(facts(), { ...file, digest: "0".repeat(64) });
  assert.equal(digest.verdict, DIGEST_BLOCKED);
});

test("already applied valid contract does not mutate", () => {
  const applied = evaluate0030Baseline(
    facts({
      ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
      prepare: installedPrepare(),
    }),
    file,
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.alreadyApplied, true);
  assert.equal(applied.verdict, ALREADY_APPLIED);
  assert.equal(applied.migrated, false);
});

test("already applied with a broken contract does not rewrite SQL", () => {
  const broken = evaluate0030Baseline(
    facts({
      ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
      prepare: installedPrepare({ qualifiedReturning: false }),
    }),
    file,
  );
  assert.equal(broken.ok, false);
  assert.equal(broken.verdict, CONTRACT_BLOCKED);
  assert.equal(broken.migrated, false);
});

test("aftermath rolls back when protected state or privileges drift", async () => {
  const queries = [];
  const before = facts();
  const result = await apply0030Transaction({
    sql,
    before,
    query: async (text) => {
      queries.push(text);
      return { rows: [] };
    },
    inspect: async () =>
      facts({
        ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
        prepare: installedPrepare({ appInsert: true, runtimeExecute: false }),
        bookingPaymentCount: 1,
      }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, POST_BLOCKED);
  assert.equal(result.committed, false);
  assert.equal(result.migrated, false);
  assert.ok(result.failures.includes("app-insert"));
  assert.ok(result.failures.includes("runtime-execute"));
  assert.ok(result.failures.includes("domain-b-payments"));
  assert.ok(queries.includes("BEGIN"));
  assert.ok(queries.includes("ROLLBACK"));
  assert.equal(queries.includes("COMMIT"), false);
});

test("a clean aftermath commits only 0030", async () => {
  const queries = [];
  const before = facts();
  const after = facts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    prepare: installedPrepare(),
  });
  const result = await apply0030Transaction({
    sql,
    before,
    query: async (text) => {
      queries.push(text);
      return { rows: [] };
    },
    inspect: async () => after,
  });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, APPLIED_VERIFIED);
  assert.equal(result.committed, true);
  assert.equal(result.migrated, true);
  assert.ok(queries.some((text) => text.startsWith("INSERT INTO _migrations")));
  assert.ok(queries.includes("COMMIT"));
  const direct = evaluate0030Aftermath(after, before);
  assert.equal(direct.ok, true);
});

test("runSingleUse0030 does not connect or mutate when confirmation fails", async () => {
  let calls = 0;
  const blocked = await runSingleUse0030({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner:secret@localhost/neondb" },
    confirmation: "APPLY-0029",
    file,
    loadFacts: async () => {
      calls += 1;
      return facts();
    },
    mutate: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  assert.equal(blocked.verdict, CONFIRM_BLOCKED);
  assert.equal(calls, 0);
  assert.equal(blocked.migrated, false);
});

test("runSingleUse0030 already-applied path does not call mutate", async () => {
  let mutations = 0;
  const result = await runSingleUse0030({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@localhost/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file,
    loadFacts: async () =>
      facts({
        ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
        prepare: installedPrepare(),
      }),
    mutate: async () => {
      mutations += 1;
      return { ok: true, migrated: true };
    },
  });
  assert.equal(result.verdict, ALREADY_APPLIED);
  assert.equal(result.migrated, false);
  assert.equal(mutations, 0);
});

test("Gate B accepts applied 0030 and the generic migrator still applies nothing", () => {
  const gate = evaluatePreflight({
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...ACCEPTED_LEDGER],
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    aetherAppExists: true,
    occupancy,
    tableOwners: { hotels: "neondb_owner", bookings: "neondb_owner" },
    hotel: { code: "demo-kos", status: "live" },
  });
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.pending, []);
  assert.equal(gate.ledger.includes(TARGET_MIGRATION), true);
  const generic = evaluateMigrationBaseline(gate);
  assert.equal(generic.ok, true);
  assert.equal(generic.migrated, false);
  assert.equal(generic.verdict, LEDGER_CURRENT);

  const extra = evaluatePreflight({
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...ACCEPTED_LEDGER, "0031_later.sql"],
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    aetherAppExists: true,
    occupancy,
    tableOwners: { hotels: "neondb_owner", bookings: "neondb_owner" },
    hotel: { code: "demo-kos", status: "live" },
  });
  assert.equal(extra.ok, false);
  assert.equal(extra.verdict, "BLOCKED — MIGRATION LEDGER INCONSISTENT");
  assert.deepEqual(extra.unexpectedPending, ["0031_later.sql"]);
});

test("controller entry refuses to run without the confirmation phrase", async () => {
  const { stdout, stderr, code } = await execFileAsync(
    process.execPath,
    [join(here, "cp272-0030-production-migrate.mjs")],
    {
      env: {
        PATH: process.env.PATH,
        AETHER_DATABASE_OWNER_URL: "postgres://owner:secret@host/neondb",
      },
    },
  ).catch((err) => err);
  const out = `${stdout || ""}${stderr || ""}`;
  assert.match(out, new RegExp(CONFIRM_BLOCKED));
  assert.doesNotMatch(out, /secret/);
  assert.doesNotMatch(out, /postgres:\/\/owner/);
  assert.equal(code === 0, false);
});
