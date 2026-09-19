#!/usr/bin/env node
/**
 * CP25E — guarded production migration controller.
 *
 * Read-only preflight + exact baseline guard, then scripts/migrate.mjs,
 * then read-only post-migration verification.
 *
 * Never uses DATABASE_URL. Never prints secrets. Never deploys.
 * Never calls entitlement/provision/Stripe/booking functions.
 */
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
  BLOCKED_OWNER_URL,
  EXPECTED_DATABASE,
  EXPECTED_OWNER,
  EXPECTED_RUNTIME,
  evaluatePreflight,
  inspectProduction,
  redact,
  report,
} from "./production-db-preflight.mjs";
import { readdir } from "node:fs/promises";
import { resolveMigratePlan } from "./migrate-policy.mjs";

const execFileAsync = promisify(execFile);

export const EXPECTED_PENDING_PLAN = [
  "0001_auth.sql",
  "0018_cp22_saas_onboarding.sql",
  "0019_cp23_public_hotel_slug.sql",
  "0020_cp24_stripe_billing.sql",
  "0021_cp25_hotel_guest_payments.sql",
];

export const EXPECTED_HISTORICAL_LEDGER = [
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
];

export const EXPECTED_BASELINE_CHECKPOINT = "16";
export const EXPECTED_POST_CHECKPOINT = "23";
export const EXPECTED_SCHEMA_PHASE = "16";
export const BASELINE_PASS = "GATE B+ BASELINE PASS — MIGRATION AUTHORISED";
export const POST_PASS = "GATE C PASS — PRODUCTION MIGRATION VERIFIED";
export const BASELINE_BLOCKED = "BLOCKED — MIGRATION BASELINE NOT MET";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const MIGRATE_FAILED = "BLOCKED — MIGRATION FAILED";

const AUTH_TABLES = ["user", "session", "account", "verification"];
const OCCUPANCY = ["bookings_driver_occupancy_excl", "bookings_vehicle_occupancy_excl"];

function sameList(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function hotelMatches(hotel) {
  return Boolean(
    hotel &&
      hotel.code === "demo-kos" &&
      hotel.status === "live" &&
      Number(hotel.providerCount) === 1 &&
      Number(hotel.destinationCount) === 4,
  );
}

function occupancyIntact(occupancy) {
  const names = new Set((occupancy ?? []).map((row) => row.name));
  return (
    OCCUPANCY.every((name) => names.has(name)) &&
    (occupancy ?? []).every((row) => /EXCLUDE/i.test(String(row.definition ?? "")))
  );
}

function authAll(tables, expected) {
  return AUTH_TABLES.every((name) => tables?.[name] === expected);
}

function ownersAreOwner(owners) {
  return owners?.hotels === EXPECTED_OWNER && owners?.bookings === EXPECTED_OWNER;
}

function ledgerHasAll(ledger, names) {
  const set = new Set(ledger ?? []);
  return names.every((name) => set.has(name));
}

function ledgerHasNone(ledger, names) {
  const set = new Set(ledger ?? []);
  return names.every((name) => !set.has(name));
}

export function evaluateMigrationBaseline(preflight) {
  if (!preflight?.ok) {
    return {
      ok: false,
      verdict: preflight?.verdict || BASELINE_BLOCKED,
      migrated: false,
    };
  }
  const failures = [];
  if (preflight.database !== EXPECTED_DATABASE) failures.push("database");
  if (preflight.currentUser !== EXPECTED_OWNER || preflight.sessionUser !== EXPECTED_OWNER) {
    failures.push("owner");
  }
  if (!ledgerHasAll(preflight.ledger, EXPECTED_HISTORICAL_LEDGER)) failures.push("historical-ledger");
  if (!ledgerHasNone(preflight.ledger, EXPECTED_PENDING_PLAN)) failures.push("pending-already-applied");
  if (!sameList(preflight.pending, EXPECTED_PENDING_PLAN)) failures.push("pending-plan");
  if (preflight.authClass !== "B") failures.push("auth-class");
  if (!authAll(preflight.authTables, "ABSENT")) failures.push("auth-tables");
  if (String(preflight.schemaPhase) !== EXPECTED_SCHEMA_PHASE) failures.push("schema-phase");
  if (String(preflight.checkpoint) !== EXPECTED_BASELINE_CHECKPOINT) failures.push("checkpoint");
  if (!preflight.aetherAppExists) failures.push("aether-app");
  if (!ownersAreOwner(preflight.tableOwners)) failures.push("table-owners");
  if (!occupancyIntact(preflight.occupancy)) failures.push("occupancy");
  if (!hotelMatches(preflight.hotel)) failures.push("demo-kos");
  if (failures.length) {
    return { ok: false, verdict: BASELINE_BLOCKED, failures, migrated: false };
  }
  return {
    ok: true,
    verdict: BASELINE_PASS,
    pending: preflight.pending,
    migrated: false,
  };
}

export function evaluateMigrationAftermath(preflight) {
  if (!preflight?.ok) {
    return {
      ok: false,
      verdict: preflight?.verdict || POST_BLOCKED,
      migrated: true,
    };
  }
  const failures = [];
  if (preflight.database !== EXPECTED_DATABASE) failures.push("database");
  if (preflight.currentUser !== EXPECTED_OWNER || preflight.sessionUser !== EXPECTED_OWNER) {
    failures.push("owner");
  }
  if (!ledgerHasAll(preflight.ledger, EXPECTED_HISTORICAL_LEDGER)) failures.push("historical-ledger");
  if (!ledgerHasAll(preflight.ledger, EXPECTED_PENDING_PLAN)) failures.push("applied-plan");
  if ((preflight.pending ?? []).length > 0) failures.push("pending-remain");
  if (preflight.authClass !== "A") failures.push("auth-class");
  if (!authAll(preflight.authTables, "PRESENT")) failures.push("auth-tables");
  if (String(preflight.schemaPhase) !== EXPECTED_SCHEMA_PHASE) failures.push("schema-phase");
  if (String(preflight.checkpoint) !== EXPECTED_POST_CHECKPOINT) failures.push("checkpoint");
  if (!preflight.aetherAppExists) failures.push("aether-app");
  if (!ownersAreOwner(preflight.tableOwners)) failures.push("table-owners");
  if (!occupancyIntact(preflight.occupancy)) failures.push("occupancy");
  if (!hotelMatches(preflight.hotel)) failures.push("demo-kos");
  if (failures.length) {
    return { ok: false, verdict: POST_BLOCKED, failures, migrated: true };
  }
  return { ok: true, verdict: POST_PASS, pending: [], migrated: true };
}

export function productionMigrateChildEnv(env) {
  const owner = String(env.AETHER_DATABASE_OWNER_URL ?? "").trim();
  return {
    PATH: env.PATH || "/usr/bin",
    NODE_ENV: "production",
    AETHER_RESTORE_TARGET: "production",
    AETHER_DATABASE_OWNER_URL: owner,
  };
}

export function assertProductionMigrateWillNotSkip(env) {
  const plan = resolveMigratePlan(productionMigrateChildEnv(env));
  if (plan.action !== "migrate") {
    return { ok: false, verdict: "BLOCKED — MIGRATE POLICY WOULD SKIP OR FAIL", plan };
  }
  return { ok: true, plan };
}

export async function runGuardedMigrate({ env, loadFacts, applyMigrations }) {
  const owner = String(env.AETHER_DATABASE_OWNER_URL ?? "").trim();
  if (!owner) {
    return { ok: false, verdict: BLOCKED_OWNER_URL, migrated: false };
  }
  const before = await loadFacts();
  const pre = evaluatePreflight(before);
  const baseline = evaluateMigrationBaseline(pre);
  if (!baseline.ok) {
    return { ...baseline, preflight: pre, migrated: false };
  }
  const mode = assertProductionMigrateWillNotSkip(env);
  if (!mode.ok) {
    return { ...mode, preflight: pre, migrated: false };
  }
  let applyError = null;
  try {
    await applyMigrations(productionMigrateChildEnv(env));
  } catch (err) {
    applyError = err;
  }
  const after = await loadFacts();
  const postPre = evaluatePreflight(after);
  if (applyError) {
    return {
      ok: false,
      verdict: MIGRATE_FAILED,
      migrated: true,
      error: redact(applyError?.message || applyError),
      preflight: pre,
      postflight: postPre,
      ledger: after?.ledger ?? [],
    };
  }
  const aftermath = evaluateMigrationAftermath(postPre);
  return { ...aftermath, preflight: pre, postflight: postPre, migrated: true };
}

function say(line) {
  console.log(line);
}

function fail(verdict, extra = "") {
  say(verdict);
  if (extra) say(redact(extra));
  process.exitCode = 1;
}

async function loadSourceMigrations(rootDir) {
  const entries = await readdir(join(rootDir, "migrations"));
  return entries.filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
}

async function inspectWithOwner(ownerUrl, sourceMigrations) {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN READ ONLY");
    began = true;
    return await inspectProduction(client, sourceMigrations);
  } finally {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (err) {
        say(redact(err?.message || err));
      }
    }
    client.release();
    await pool.end();
  }
}

async function applyProductionMigrations(childEnv) {
  const script = join(dirname(fileURLToPath(import.meta.url)), "migrate.mjs");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script], {
      env: childEnv,
    });
    const out = redact(`${stdout || ""}${stderr || ""}`);
    if (out.trim()) say(out.trimEnd());
  } catch (err) {
    const out = redact(`${err?.stdout || ""}${err?.stderr || ""}${err?.message || err}`);
    if (out.trim()) say(out.trimEnd());
    throw err;
  }
}

async function main() {
  const ownerUrl = String(process.env.AETHER_DATABASE_OWNER_URL ?? "").trim();
  if (!ownerUrl) {
    fail(BLOCKED_OWNER_URL);
    return;
  }
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runGuardedMigrate({
    env: process.env,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    applyMigrations: applyProductionMigrations,
  });
  if (result.preflight) report(result.preflight);
  if (result.failures?.length) {
    say("guard failures:");
    for (const name of result.failures) say(`  ${name}`);
  }
  if (result.postflight) {
    say("post-migration:");
    report(result.postflight);
  }
  say(result.verdict);
  if (!result.ok) process.exitCode = 1;
}

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    fail(MIGRATE_FAILED, err?.message || err);
    process.exit(1);
  });
}
