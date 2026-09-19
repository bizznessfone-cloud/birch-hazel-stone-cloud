import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  BLOCKED_OWNER_URL,
  PASS_VERDICT,
  classifyAuth,
  evaluatePreflight,
  historicalSourceMigrations,
  redact,
} from "./production-db-preflight.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "production-db-preflight.mjs"), "utf8");
const workflow = readFileSync(join(here, "../.github/workflows/production-database.yml"), "utf8");
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

function baseFacts(overrides = {}) {
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
      status: "configured",
      providerCount: 1,
      destinationCount: 2,
    },
    ...overrides,
  };
}

test("missing owner URL fails closed without using DATABASE_URL", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [join(here, "production-db-preflight.mjs")], {
    env: { PATH: process.env.PATH, DATABASE_URL: "postgres://should-not-be-used" },
  }).catch((err) => err);
  const out = `${stdout || ""}${stderr || ""}`;
  assert.match(out, new RegExp(BLOCKED_OWNER_URL));
  assert.equal(out.includes("GATE B PASS"), false);
  assert.doesNotMatch(out, /postgres:\/\/should-not-be-used/);
});

test("wrong database fails", () => {
  const result = evaluatePreflight(baseFacts({ database: "postgres" }));
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "BLOCKED — DATABASE IDENTITY MISMATCH");
});

test("wrong owner role fails", () => {
  const result = evaluatePreflight(baseFacts({ currentUser: "aether_app", sessionUser: "aether_app" }));
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "BLOCKED — OWNER IDENTITY MISMATCH");
});

test("missing historical migration fails", () => {
  const ledger = LEDGER_0017.filter((name) => name !== "0012_cp12_tenancy.sql");
  const result = evaluatePreflight(baseFacts({ ledger }));
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "BLOCKED — MIGRATION LEDGER INCONSISTENT");
  assert.deepEqual(result.missingHistorical, ["0012_cp12_tenancy.sql"]);
});

test("missing occupancy invariant fails", () => {
  const result = evaluatePreflight(baseFacts({ occupancy: [] }));
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "BLOCKED — OCCUPANCY INVARIANT NOT PROVEN");
});

test("coherent migration plan succeeds with 0001 plus 0018-0021 pending", () => {
  const result = evaluatePreflight(baseFacts());
  assert.equal(result.ok, true);
  assert.equal(result.verdict, PASS_VERDICT);
  assert.equal(result.authClass, "B");
  assert.deepEqual(result.pending, [
    "0001_auth.sql",
    "0018_cp22_saas_onboarding.sql",
    "0019_cp23_public_hotel_slug.sql",
    "0020_cp24_stripe_billing.sql",
    "0021_cp25_hotel_guest_payments.sql",
  ]);
  assert.deepEqual(historicalSourceMigrations(SOURCE), LEDGER_0017);
});

test("auth classification A/B pass and C/D fail", () => {
  assert.equal(
    classifyAuth(true, { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" }),
    "A",
  );
  assert.equal(
    classifyAuth(false, { user: "ABSENT", session: "ABSENT", account: "ABSENT", verification: "ABSENT" }),
    "B",
  );
  assert.equal(
    classifyAuth(false, { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" }),
    "C",
  );
  assert.equal(
    classifyAuth(true, { user: "ABSENT", session: "ABSENT", account: "ABSENT", verification: "ABSENT" }),
    "D",
  );
  const incoherent = evaluatePreflight(
    baseFacts({
      ledger: [...LEDGER_0017, "0001_auth.sql"],
      authTables: { user: "ABSENT", session: "ABSENT", account: "ABSENT", verification: "ABSENT" },
    }),
  );
  assert.equal(incoherent.verdict, "BLOCKED — AUTH SCHEMA INCONSISTENT");
});

test("preflight SQL is read-only and never uses DATABASE_URL or migrate", () => {
  assert.match(src, /BEGIN READ ONLY/);
  assert.match(src, /ROLLBACK/);
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /db:migrate/);
  assert.doesNotMatch(src, /scripts\/migrate\.mjs/);
  assert.doesNotMatch(src, /\bCOMMIT\b/);
  const sql = [
    ...src.matchAll(/\.query\(\s*`([^`]+)`/g),
    ...src.matchAll(/\.query\(\s*"([^"]+)"/g),
    ...src.matchAll(/readOnlyQuery\(\s*client,\s*`([^`]+)`/g),
    ...src.matchAll(/readOnlyQuery\(\s*client,\s*"([^"]+)"/g),
  ]
    .map((m) => m[1])
    .join("\n");
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\s+[a-z_]+\s+SET\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+(TABLE|ROLE|FUNCTION|TRIGGER)\b/i);
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|TRIGGER|FUNCTION|CONSTRAINT|EXTENSION)\b/i);
  assert.doesNotMatch(sql, /\bCREATE\s+(TABLE|ROLE|FUNCTION|TRIGGER|INDEX)\b/i);
  assert.doesNotMatch(sql, /\bGRANT\b/i);
  assert.doesNotMatch(sql, /\bREVOKE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /SET\s+ROLE/i);
  assert.match(sql, /current_database|_migrations|pg_constraint/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*process\.env/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*ownerUrl/);
  assert.match(src, /postgres:\/\/redacted/);
  assert.equal(redact("postgres://owner:secret@host/neondb boom"), "postgres://redacted boom");
});

test("workflow is dispatch-only, read-only, and does not migrate", () => {
  assert.match(workflow, /workflow_dispatch/);
  assert.doesNotMatch(workflow, /\bpush\s*:/);
  assert.doesNotMatch(workflow, /\bpull_request\s*:/);
  assert.doesNotMatch(workflow, /\bschedule\s*:/);
  assert.doesNotMatch(workflow, /\bworkflow_run\s*:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/s);
  assert.match(workflow, /secrets\.AETHER_DATABASE_OWNER_URL/);
  assert.match(workflow, /node scripts\/production-db-preflight\.mjs/);
  assert.doesNotMatch(workflow, /db:migrate/);
  assert.doesNotMatch(workflow, /migrate\.mjs/);
  assert.doesNotMatch(workflow, /DATABASE_URL/);
  assert.doesNotMatch(workflow, /set -x/);
  assert.equal(pkg.scripts["db:preflight"], "node scripts/production-db-preflight.mjs");
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkg.scripts.build, /db:preflight/);
});
