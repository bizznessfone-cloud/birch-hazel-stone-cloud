import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { BLOCKED_OWNER_URL, evaluatePreflight } from "./production-db-preflight.mjs";
import { resolveMigratePlan } from "./migrate-policy.mjs";
import {
  BASELINE_BLOCKED,
  BASELINE_PASS,
  EXPECTED_PENDING_PLAN,
  MIGRATE_FAILED,
  POST_BLOCKED,
  POST_PASS,
  assertProductionMigrateWillNotSkip,
  evaluateMigrationAftermath,
  evaluateMigrationBaseline,
  productionMigrateChildEnv,
  runGuardedMigrate,
} from "./production-db-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "production-db-migrate.mjs"), "utf8");
const workflow = readFileSync(join(here, "../.github/workflows/production-database-migrate.yml"), "utf8");
const readonlyWorkflow = readFileSync(join(here, "../.github/workflows/production-database.yml"), "utf8");
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));

const SOURCE = [
  "0001_auth.sql",
  "0002_foundation.sql",
  "0003_occupancy.sql",
  "0004_ops_auth.sql",
  "0005_time_domain.sql",
  "0006_booking_engine.sql",
  "0007_inventory.sql",
  "0008_guest_ux.sql",
  "0009_ops_desk.sql",
  "0010_hotel_white_label.sql",
  "0011_production_hardening.sql",
  "0012_cp12_tenancy.sql",
  "0013_cp12b_runtime_login.sql",
  "0014_cp13a_production_app_role.sql",
  "0015_cp14_hotel_configuration.sql",
  "0016_cp14_hotel_timezone.sql",
  "0017_cp16_runtime_privilege_hardening.sql",
  "0018_cp22_saas_onboarding.sql",
  "0019_cp23_public_hotel_slug.sql",
  "0020_cp24_stripe_billing.sql",
  "0021_cp25_hotel_guest_payments.sql",
];

const LEDGER_0017 = SOURCE.filter((name) => /^00(0[2-9]|1[0-7])_/.test(name));

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

function baselineFacts(overrides = {}) {
  return {
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: LEDGER_0017,
    ledgerReadable: true,
    sourceMigrations: SOURCE,
    authTables: {
      user: "ABSENT",
      session: "ABSENT",
      account: "ABSENT",
      verification: "ABSENT",
    },
    aetherAppExists: true,
    occupancy,
    tableOwners: { hotels: "neondb_owner", bookings: "neondb_owner" },
    schemaPhase: "16",
    checkpoint: "16",
    hotel: {
      code: "demo-kos",
      name: "Aether Demo Hotel",
      status: "live",
      providerCount: 1,
      destinationCount: 4,
    },
    ...overrides,
  };
}

function postFacts(overrides = {}) {
  return baselineFacts({
    ledger: [...LEDGER_0017, ...EXPECTED_PENDING_PLAN],
    authTables: {
      user: "PRESENT",
      session: "PRESENT",
      account: "PRESENT",
      verification: "PRESENT",
    },
    checkpoint: "23",
    schemaPhase: "16",
    ...overrides,
  });
}

test("missing owner URL fails closed and does not migrate", async () => {
  let applied = 0;
  const result = await runGuardedMigrate({
    env: { DATABASE_URL: "postgres://runtime:secret@host/neondb" },
    loadFacts: async () => baselineFacts(),
    applyMigrations: async () => {
      applied += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, BLOCKED_OWNER_URL);
  assert.equal(result.migrated, false);
  assert.equal(applied, 0);
});

test("spawned controller without owner URL never uses DATABASE_URL", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [join(here, "production-db-migrate.mjs")], {
    env: { PATH: process.env.PATH, DATABASE_URL: "postgres://should-not-be-used" },
  }).catch((err) => err);
  const out = `${stdout || ""}${stderr || ""}`;
  assert.match(out, new RegExp(BLOCKED_OWNER_URL));
  assert.doesNotMatch(out, /postgres:\/\/should-not-be-used/);
  assert.doesNotMatch(out, /GATE C PASS/);
});

test("exact pending plan is required before migrate", () => {
  const ok = evaluateMigrationBaseline(evaluatePreflight(baselineFacts()));
  assert.equal(ok.ok, true);
  assert.equal(ok.verdict, BASELINE_PASS);
  assert.deepEqual(ok.pending, EXPECTED_PENDING_PLAN);

  const extra = evaluateMigrationBaseline(
    evaluatePreflight(baselineFacts({ hotel: { code: "demo-kos", status: "configured", providerCount: 1, destinationCount: 4 } })),
  );
  assert.equal(extra.ok, false);
  assert.equal(extra.verdict, BASELINE_BLOCKED);
});

test("db:migrate cannot execute if baseline differs", async () => {
  const cases = [
    baselineFacts({ checkpoint: "15" }),
    baselineFacts({ schemaPhase: "17" }),
    baselineFacts({ hotel: { code: "demo-kos", status: "configured", providerCount: 1, destinationCount: 4 } }),
    baselineFacts({ hotel: { code: "demo-kos", status: "live", providerCount: 1, destinationCount: 3 } }),
    baselineFacts({ occupancy: [] }),
    baselineFacts({ tableOwners: { hotels: "aether_app", bookings: "neondb_owner" } }),
    baselineFacts({ ledger: [...LEDGER_0017, "0001_auth.sql"] }),
    baselineFacts({
      authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    }),
  ];
  for (const facts of cases) {
    let applied = 0;
    const result = await runGuardedMigrate({
      env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
      loadFacts: async () => facts,
      applyMigrations: async () => {
        applied += 1;
      },
    });
    assert.equal(result.ok, false, result.verdict);
    assert.equal(result.migrated, false, result.verdict);
    assert.equal(applied, 0, result.verdict);
  }
});

test("child env is owner-only production migrate mode and cannot skip", () => {
  const child = productionMigrateChildEnv({
    AETHER_DATABASE_OWNER_URL: "postgres://owner:secret@host/neondb",
    DATABASE_URL: "postgres://runtime:secret@host/neondb",
    PATH: "/usr/bin",
    VERCEL_ENV: "production",
  });
  assert.equal(child.AETHER_RESTORE_TARGET, "production");
  assert.equal(child.NODE_ENV, "production");
  assert.equal(child.AETHER_DATABASE_OWNER_URL, "postgres://owner:secret@host/neondb");
  assert.equal(Object.hasOwn(child, "DATABASE_URL"), false);
  const plan = resolveMigratePlan(child);
  assert.equal(plan.action, "migrate");
  assert.equal(assertProductionMigrateWillNotSkip({ AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" }).ok, true);
  assert.equal(assertProductionMigrateWillNotSkip({ AETHER_DATABASE_OWNER_URL: "" }).plan.action, "fail");
});

test("successful guard applies once then requires Gate C", async () => {
  let applied = 0;
  let childSeen = null;
  const result = await runGuardedMigrate({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb", DATABASE_URL: "postgres://runtime@host/neondb" },
    loadFacts: async () => (applied === 0 ? baselineFacts() : postFacts()),
    applyMigrations: async (childEnv) => {
      applied += 1;
      childSeen = childEnv;
    },
  });
  assert.equal(applied, 1);
  assert.equal(Object.hasOwn(childSeen, "DATABASE_URL"), false);
  assert.equal(childSeen.AETHER_RESTORE_TARGET, "production");
  assert.equal(result.ok, true);
  assert.equal(result.verdict, POST_PASS);
  assert.equal(result.migrated, true);
  assert.equal(result.postflight.checkpoint, "23");
  assert.equal(result.postflight.schemaPhase, "16");
  assert.deepEqual(result.postflight.pending, []);
  assert.equal(result.postflight.authClass, "A");
});

test("post-migration verification fails if demo-kos or occupancy drifted", () => {
  const drifted = evaluateMigrationAftermath(
    evaluatePreflight(postFacts({ hotel: { code: "demo-kos", status: "live", providerCount: 2, destinationCount: 4 } })),
  );
  assert.equal(drifted.ok, false);
  assert.equal(drifted.verdict, POST_BLOCKED);
  assert.ok(drifted.failures.includes("demo-kos"));

  const occupancyLost = evaluateMigrationAftermath(evaluatePreflight(postFacts({ occupancy: [] })));
  assert.equal(occupancyLost.ok, false);
});

test("migration apply failure stops and still inspects current state", async () => {
  let applied = 0;
  const result = await runGuardedMigrate({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    loadFacts: async () => (applied === 0 ? baselineFacts() : baselineFacts({ ledger: [...LEDGER_0017, "0001_auth.sql"] })),
    applyMigrations: async () => {
      applied += 1;
      const err = new Error("[migrate] error applying 0018_cp22_saas_onboarding.sql postgres://owner:secret@host/neondb");
      throw err;
    },
  });
  assert.equal(applied, 1);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, MIGRATE_FAILED);
  assert.doesNotMatch(result.error, /secret/);
  assert.match(result.error, /0018_cp22_saas_onboarding\.sql/);
});

test("controller source never logs secrets, never deploys, never syncs entitlements", () => {
  assert.match(src, /BEGIN READ ONLY/);
  assert.match(src, /ROLLBACK/);
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /sbg_sync_hotel_entitlement/);
  assert.doesNotMatch(src, /provision-hotel/);
  assert.doesNotMatch(src, /vercel/i);
  assert.doesNotMatch(src, /stripe\.(checkout|webhooks)/i);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*process\.env/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*ownerUrl/);
  assert.match(src, /migrate\.mjs/);
  assert.match(src, /AETHER_RESTORE_TARGET/);
});

test("migration workflow is dispatch-only, read-only perms, preflight then migrate", () => {
  assert.match(workflow, /workflow_dispatch/);
  assert.doesNotMatch(workflow, /\bpush\s*:/);
  assert.doesNotMatch(workflow, /\bpull_request\s*:/);
  assert.doesNotMatch(workflow, /\bschedule\s*:/);
  assert.doesNotMatch(workflow, /\bworkflow_run\s*:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/s);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /node-version:\s*"22"/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /node scripts\/production-db-preflight\.mjs/);
  assert.match(workflow, /node scripts\/production-db-migrate\.mjs/);
  const preflightAt = workflow.indexOf("production-db-preflight.mjs");
  const migrateAt = workflow.indexOf("production-db-migrate.mjs");
  assert.ok(preflightAt >= 0 && migrateAt > preflightAt);
  assert.doesNotMatch(workflow, /DATABASE_URL/);
  assert.doesNotMatch(workflow, /set -x/);
  assert.doesNotMatch(workflow, /vercel/i);
  assert.doesNotMatch(workflow, /deploy/i);
  assert.doesNotMatch(workflow, /sbg_sync_hotel_entitlement/);
  assert.match(workflow, /secrets\.AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(readonlyWorkflow, /production-db-migrate\.mjs/);
  assert.doesNotMatch(readonlyWorkflow, /db:migrate/);
  assert.equal(pkg.scripts["db:migrate"], "node scripts/migrate.mjs");
  assert.equal(pkg.scripts["db:migrate:production"], "node scripts/production-db-migrate.mjs");
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
});
