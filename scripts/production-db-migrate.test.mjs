import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { ACCEPTED_LEDGER, BLOCKED_OWNER_URL, evaluatePreflight } from "./production-db-preflight.mjs";
import { resolveMigratePlan } from "./migrate-policy.mjs";
import {
  GENERIC_MIGRATE_BLOCKED,
  LEDGER_CURRENT,
  assertProductionMigrateWillNotSkip,
  evaluateMigrationBaseline,
  productionMigrateChildEnv,
  runGuardedMigrate,
} from "./production-db-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "production-db-migrate.mjs"), "utf8");
const readonlyWorkflow = readFileSync(join(here, "../.github/workflows/production-database.yml"), "utf8");
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));

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

function currentFacts(overrides = {}) {
  return {
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...ACCEPTED_LEDGER],
    authTables: {
      user: "PRESENT",
      session: "PRESENT",
      account: "PRESENT",
      verification: "PRESENT",
    },
    aetherAppExists: true,
    occupancy,
    tableOwners: { hotels: "neondb_owner", bookings: "neondb_owner" },
    schemaPhase: "16",
    checkpoint: "23",
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

test("missing owner URL fails closed and does not migrate", async () => {
  let loaded = 0;
  let applied = 0;
  const result = await runGuardedMigrate({
    env: { DATABASE_URL: "postgres://runtime:secret@host/neondb" },
    loadFacts: async () => {
      loaded += 1;
      return currentFacts();
    },
    applyMigrations: async () => {
      applied += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, BLOCKED_OWNER_URL);
  assert.equal(result.migrated, false);
  assert.equal(loaded, 0);
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

test("spawned controller with owner URL still never migrates", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [join(here, "production-db-migrate.mjs")], {
    env: {
      PATH: process.env.PATH,
      AETHER_DATABASE_OWNER_URL: "postgres://owner:secret@host/neondb",
    },
  }).catch((err) => err);
  const out = `${stdout || ""}${stderr || ""}`;
  assert.match(out, new RegExp(GENERIC_MIGRATE_BLOCKED));
  assert.doesNotMatch(out, /secret/);
  assert.doesNotMatch(out, /GATE C PASS/);
});

test("current 0001-0028 ledger is a no-mutation current state", () => {
  const result = evaluateMigrationBaseline(evaluatePreflight(currentFacts()));
  assert.equal(result.ok, true);
  assert.equal(result.alreadyCurrent, true);
  assert.equal(result.verdict, LEDGER_CURRENT);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.pending, []);
});

test("pending 0024/0025/0026 are not generically authorised", () => {
  const pending0024 = evaluateMigrationBaseline(
    evaluatePreflight(
      currentFacts({
        ledger: ACCEPTED_LEDGER.filter((name) => name !== "0024_cp26b2_ordered_billing_events.sql"),
      }),
    ),
  );
  assert.equal(pending0024.ok, false);

  for (const extra of ["0025_later.sql", "0026_later.sql", "0027_later.sql"]) {
    const result = evaluateMigrationBaseline(
      evaluatePreflight(currentFacts({ sourceMigrations: [...ACCEPTED_LEDGER, extra] })),
    );
    assert.equal(result.ok, false, extra);
    assert.match(result.verdict, /NO GENERIC PRODUCTION MIGRATION AUTHORISED|MIGRATION LEDGER INCONSISTENT/);
  }
});

test("runGuardedMigrate never applies even when ledger is current", async () => {
  let applied = 0;
  const result = await runGuardedMigrate({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    loadFacts: async () => currentFacts(),
    applyMigrations: async () => {
      applied += 1;
    },
  });
  assert.equal(applied, 0);
  assert.equal(result.migrated, false);
  assert.equal(result.verdict, LEDGER_CURRENT);
});

test("child env remains owner-only and never includes DATABASE_URL", () => {
  const child = productionMigrateChildEnv({
    AETHER_DATABASE_OWNER_URL: "postgres://owner:secret@host/neondb",
    DATABASE_URL: "postgres://runtime:secret@host/neondb",
    PATH: "/usr/bin",
    VERCEL_ENV: "production",
  });
  assert.equal(child.AETHER_RESTORE_TARGET, "production");
  assert.equal(Object.hasOwn(child, "DATABASE_URL"), false);
  const plan = resolveMigratePlan(child);
  assert.equal(plan.action, "migrate");
  assert.equal(assertProductionMigrateWillNotSkip({ AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" }).ok, true);
});

test("controller source never logs secrets, never deploys, never syncs entitlements", () => {
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /sbg_sync_hotel_entitlement/);
  assert.doesNotMatch(src, /provision-hotel/);
  assert.doesNotMatch(src, /vercel/i);
  assert.doesNotMatch(src, /stripe\.(checkout|webhooks)/i);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*process\.env/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*ownerUrl/);
  assert.match(src, /GENERIC_MIGRATE_BLOCKED/);
});

test("generic production migrate workflow is retired; preflight workflow remains read-only", () => {
  assert.equal(existsSync(join(here, "../.github/workflows/production-database-migrate.yml")), false);
  assert.match(readonlyWorkflow, /workflow_dispatch/);
  assert.doesNotMatch(readonlyWorkflow, /production-db-migrate\.mjs/);
  assert.doesNotMatch(readonlyWorkflow, /db:migrate/);
  assert.equal(pkg.scripts["db:migrate"], "node scripts/migrate.mjs");
  assert.equal(pkg.scripts["db:migrate:production"], "node scripts/production-db-migrate.mjs");
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
});
