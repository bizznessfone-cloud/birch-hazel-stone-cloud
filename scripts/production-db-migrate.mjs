#!/usr/bin/env node
/**
 * CP25E generic production migrator — RETIRED as an apply path (CP26A.2C).
 *
 * Accepted Production history is 0001–0028. No pending migration is
 * automatically authorised. This script never applies SQL and never
 * connects to Production. Future migrations need a dedicated single-use
 * controller plus explicit checkpoint authorisation.
 *
 * Never uses DATABASE_URL. Never prints secrets. Never deploys.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCKED_OWNER_URL,
  EXPECTED_DATABASE,
  EXPECTED_OWNER,
  ACCEPTED_LEDGER,
  evaluatePreflight,
  redact,
} from "./production-db-preflight.mjs";
import { resolveMigratePlan } from "./migrate-policy.mjs";

export const EXPECTED_PENDING_PLAN = [];
export const GENERIC_MIGRATE_BLOCKED = "BLOCKED — NO GENERIC PRODUCTION MIGRATION AUTHORISED";
export const LEDGER_CURRENT = "GATE PASS — PRODUCTION LEDGER CURRENT — NO MUTATION";

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

export function evaluateMigrationBaseline(preflight) {
  if (!preflight?.ok) {
    return {
      ok: false,
      verdict: preflight?.verdict || BASELINE_BLOCKED,
      migrated: false,
    };
  }
  if ((preflight.pending ?? []).length > 0) {
    return {
      ok: false,
      verdict: GENERIC_MIGRATE_BLOCKED,
      pending: preflight.pending,
      migrated: false,
    };
  }
  const ledger = [...(preflight.ledger ?? [])].map(String);
  const missingAccepted = ACCEPTED_LEDGER.filter((name) => !ledger.includes(name));
  if (missingAccepted.length) {
    return {
      ok: false,
      verdict: BASELINE_BLOCKED,
      failures: ["accepted-ledger"],
      missingAccepted,
      migrated: false,
    };
  }
  return {
    ok: true,
    alreadyCurrent: true,
    verdict: LEDGER_CURRENT,
    pending: [],
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
  if (!ledgerHasAll(preflight.ledger, ACCEPTED_LEDGER)) failures.push("accepted-ledger");
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

export async function runGuardedMigrate({ env, loadFacts }) {
  const owner = String(env.AETHER_DATABASE_OWNER_URL ?? "").trim();
  if (!owner) {
    return { ok: false, verdict: BLOCKED_OWNER_URL, migrated: false };
  }
  const before = await loadFacts();
  const pre = evaluatePreflight(before);
  const baseline = evaluateMigrationBaseline(pre);
  return { ...baseline, preflight: pre, migrated: false };
}

function say(line) {
  console.log(line);
}

function fail(verdict, extra = "") {
  say(verdict);
  if (extra) say(redact(extra));
  process.exitCode = 1;
}

async function main() {
  const ownerUrl = String(process.env.AETHER_DATABASE_OWNER_URL ?? "").trim();
  if (!ownerUrl) {
    fail(BLOCKED_OWNER_URL);
    return;
  }
  fail(GENERIC_MIGRATE_BLOCKED);
}

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    fail(MIGRATE_FAILED, err?.message || err);
    process.exit(1);
  });
}
