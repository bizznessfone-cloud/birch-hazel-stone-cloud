/**
 * CP26C-O3.2 source verification, reconciled in O3.2C.
 * 0026 is on the accepted ledger. 0027+ stays fail-closed. No Production connection.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ACCEPTED_LEDGER,
  AUTHORISED_PENDING,
  REVIEWED_DIGESTS,
  evaluatePreflight,
  isAuthorisedPending,
} from "./production-db-preflight.mjs";
import { evaluateMigrationBaseline, runGuardedMigrate } from "./production-db-migrate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationName = "0026_cp26co3_commercial_catalogue.sql";
const sql = readFileSync(join(root, "migrations", migrationName), "utf8");

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

function sourceMigrations() {
  return readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql"));
}

function acceptedFacts() {
  return {
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: sourceMigrations(),
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    schemaPhase: "owner",
    checkpoint: "cp26c-o2",
    aetherAppExists: true,
    tableOwners: {},
    occupancy,
    hotel: { code: "demo-kos", status: "live" },
  };
}

test("0026 exists once and 0001-0025 are unchanged versus the source commit", () => {
  const files = readdirSync(join(root, "migrations")).filter((name) => name.startsWith("0026"));
  assert.deepEqual(files, [migrationName]);
  const changed = execFileSync("git", ["diff", "--name-only", "baa820f5530433e46606962bbff3dac2f5c8f385", "--", "migrations"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(changed, [
    `migrations/${migrationName}`,
    "migrations/0027_cp26co41_organisation_property_licence.sql",
  ]);
  for (const [name, digest] of Object.entries(REVIEWED_DIGESTS)) {
    const bytes = readFileSync(join(root, "migrations", name));
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(hash, digest, name);
  }
});

test("Gate B accepts 0001-0026 and refuses the unapplied 0027 source file", async () => {
  assert.equal(ACCEPTED_LEDGER.at(-1), migrationName);
  assert.equal(ACCEPTED_LEDGER.includes(migrationName), true);
  assert.equal(ACCEPTED_LEDGER.includes("0027_cp26co41_organisation_property_licence.sql"), false);
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(migrationName), false);
  assert.equal(isAuthorisedPending("0027_cp26co41_organisation_property_licence.sql"), false);
  assert.equal(isAuthorisedPending("0027_later.sql"), false);

  const acceptedOnly = evaluatePreflight({
    ...acceptedFacts(),
    sourceMigrations: [...ACCEPTED_LEDGER],
  });
  assert.equal(acceptedOnly.ok, true);
  assert.deepEqual(acceptedOnly.pending, []);
  const baseline = evaluateMigrationBaseline(acceptedOnly);
  assert.equal(baseline.ok, true);
  assert.equal(baseline.migrated, false);

  const live = evaluatePreflight(acceptedFacts());
  assert.equal(live.ok, false);
  assert.deepEqual(live.unexpectedPending, ["0027_cp26co41_organisation_property_licence.sql"]);

  const future = evaluatePreflight({
    ...acceptedFacts(),
    sourceMigrations: [...ACCEPTED_LEDGER, "0027_later.sql"],
  });
  assert.equal(future.ok, false);
  assert.deepEqual(future.unexpectedPending, ["0027_later.sql"]);

  let applied = 0;
  const guarded = await runGuardedMigrate({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    loadFacts: async () => acceptedFacts(),
    applyMigrations: async () => {
      applied += 1;
    },
  });
  assert.equal(applied, 0);
  assert.equal(guarded.migrated, false);
  assert.equal(guarded.ok, false);
});

test("generic migrator cannot apply 0026 and the spent dispatch surface is gone", () => {
  const workflows = readdirSync(join(root, ".github/workflows"));
  assert.deepEqual(workflows.sort(), [
    "cp26co2a-0025-production-migrate.yml",
    "production-database.yml",
  ]);
  for (const name of workflows) {
    const text = readFileSync(join(root, ".github/workflows", name), "utf8");
    assert.equal(text.includes("0026"), false, name);
    assert.equal(text.includes(migrationName), false, name);
    assert.equal(text.includes("cp26co32a-0026-production-migrate.mjs"), false, name);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["db:migrate:0026"], undefined);
  assert.doesNotMatch(pkg.scripts.build, /0026|cp26co3/);
  const controller = readFileSync(join(root, "scripts/cp26co2a-0025-production-migrate.mjs"), "utf8");
  assert.match(controller, /0025_cp26co2_platform_owners\.sql/);
  assert.doesNotMatch(controller, /0026_cp26co3_commercial_catalogue/);
  const generic = readFileSync(join(root, "scripts/production-db-migrate.mjs"), "utf8");
  assert.match(generic, /Accepted Production history is 0001–0026/);
  assert.doesNotMatch(generic, /AUTHORISED_PENDING\s*=\s*\[[^\]]+\]/);
  const dedicatedController = readFileSync(join(root, "scripts/cp26co32a-0026-production-migrate.mjs"), "utf8");
  assert.match(dedicatedController, /0026_cp26co3_commercial_catalogue\.sql/);
  assert.doesNotMatch(dedicatedController, /production-db-migrate/);
  assert.match(dedicatedController, /REQUIRED_LEDGER is the frozen pre-apply pin/);
});

test("0026 source seeds identities only and cannot raise live locks", () => {
  assert.match(sql, /create table if not exists sbg_saas_plans/);
  assert.match(sql, /create table if not exists sbg_saas_price_versions/);
  assert.match(sql, /create table if not exists sbg_saas_stripe_mappings/);
  assert.match(sql, /create table if not exists sbg_saas_commerce_locks/);
  assert.match(sql, /values \('basic', 'Basic', '', 10, true\), \('pro', 'Pro', '', 20, true\), \('premium', 'Premium', '', 30, true\)/);
  assert.match(sql, /values \(1, false, false\)/);
  assert.match(sql, /catalogue\.plan\.created/);
  assert.match(sql, /'source', 'migration:0026'/);
  const seed = sql.slice(sql.lastIndexOf("insert into sbg_saas_plans"));
  assert.match(seed, /sbg_saas_plans/);
  assert.match(seed, /sbg_saas_commerce_locks/);
  assert.match(seed, /sbg_owner_audit_events/);
  assert.doesNotMatch(seed, /sbg_saas_price_versions|sbg_saas_stripe_mappings/);
  assert.doesNotMatch(sql, /live_mapping_enabled\s*=\s*true/i);
  assert.doesNotMatch(sql, /live_checkout_enabled\s*=\s*true/i);
  assert.doesNotMatch(sql, /sbg_billing_accounts|sbg_stripe_events|sbg_apply_billing_event|update\s+hotels/i);
  assert.doesNotMatch(sql, /sbg_grant_platform_owner|sbg_revoke_platform_owner|sbg_bootstrap_platform_owner/);
  assert.doesNotMatch(sql, /SBG_SAAS_COMMERCE|STRIPE_BASIC_PRICE_ID|sk_live|sk_test|whsec_/);
  assert.doesNotMatch(sql, /5900|6900|9900|@[a-z0-9.-]+\.[a-z]{2,}/i);
  assert.match(sql, /from sbg_saas_plans where code = v_plan_code for update/);
  assert.match(sql, /v_count <> 1/);
  assert.match(sql, /set search_path = public, pg_temp/);
  assert.doesNotMatch(sql, /execute\s+format\s*\(/i);

  const example = readFileSync(join(root, ".env.example"), "utf8");
  assert.match(example, /^SBG_SAAS_COMMERCE=off$/m);
  assert.match(example, /^STRIPE_BASIC_PRICE_ID=$/m);
  assert.match(example, /^STRIPE_PRO_PRICE_ID=$/m);
  assert.match(example, /^STRIPE_PREMIUM_PRICE_ID=$/m);
  assert.doesNotMatch(example, /SBG_SAAS_TEST_HOTEL_IDS=.+/);
});
