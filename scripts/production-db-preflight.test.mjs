import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  BLOCKED_OWNER_URL,
  PASS_VERDICT,
  ACCEPTED_LEDGER,
  REVIEWED_DIGESTS,
  classifyAuth,
  evaluatePreflight,
  historicalSourceMigrations,
  isAuthorisedPending,
  redact,
} from "./production-db-preflight.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "production-db-preflight.mjs"), "utf8");
const workflow = readFileSync(join(here, "../.github/workflows/production-database.yml"), "utf8");
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));

const SOURCE = [...ACCEPTED_LEDGER];

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
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: SOURCE,
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

test("accepted 0001-0025 ledger with empty pending passes", () => {
  const result = evaluatePreflight(baseFacts());
  assert.equal(result.ok, true);
  assert.equal(result.verdict, PASS_VERDICT);
  assert.equal(result.authClass, "A");
  assert.deepEqual(result.pending, []);
  assert.deepEqual(historicalSourceMigrations(SOURCE), LEDGER_0017);
  assert.equal(ACCEPTED_LEDGER.includes("0024_cp26b2_ordered_billing_events.sql"), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0025_cp26co2_platform_owners.sql");
});

test("pending 0024 is stale, not a newly authorised migration", () => {
  const ledger = ACCEPTED_LEDGER.filter(
    (name) => name !== "0024_cp26b2_ordered_billing_events.sql",
  );
  const result = evaluatePreflight(baseFacts({ ledger }));
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "BLOCKED — MIGRATION LEDGER INCONSISTENT");
  assert.deepEqual(result.pending, ["0024_cp26b2_ordered_billing_events.sql"]);
  assert.deepEqual(result.unexpectedPending, ["0024_cp26b2_ordered_billing_events.sql"]);
  assert.deepEqual(result.missingAccepted, ["0024_cp26b2_ordered_billing_events.sql"]);
});

test("pending 0023 is stale, not a newly authorised migration", () => {
  const ledger = ACCEPTED_LEDGER.filter(
    (name) => name !== "0023_cp26a2_entitlement_publication_decoupling.sql",
  );
  const result = evaluatePreflight(baseFacts({ ledger }));
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "BLOCKED — MIGRATION LEDGER INCONSISTENT");
  assert.deepEqual(result.pending, ["0023_cp26a2_entitlement_publication_decoupling.sql"]);
  assert.deepEqual(result.unexpectedPending, ["0023_cp26a2_entitlement_publication_decoupling.sql"]);
});

test("pending 0024 is rejected as unauthorised when treated as extra future file", () => {
  const result = evaluatePreflight(
    baseFacts({
      sourceMigrations: [...SOURCE, "0024_future.sql"],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "BLOCKED — MIGRATION LEDGER INCONSISTENT");
  assert.deepEqual(result.unexpectedPending, ["0024_future.sql"]);
  assert.equal(isAuthorisedPending("0024_cp26b2_ordered_billing_events.sql"), false);
  assert.equal(isAuthorisedPending("0024_future.sql"), false);
});

test("pending 0025+ is rejected", () => {
  const result = evaluatePreflight(
    baseFacts({
      sourceMigrations: [...SOURCE, "0025_later.sql"],
    }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpectedPending, ["0025_later.sql"]);
  assert.equal(isAuthorisedPending("0025_later.sql"), false);
});

test("pending 0026+ is rejected", () => {
  const result = evaluatePreflight(
    baseFacts({
      sourceMigrations: [...SOURCE, "0026_later.sql"],
    }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpectedPending, ["0026_later.sql"]);
  assert.equal(isAuthorisedPending("0026_later.sql"), false);
});

test("no pending migration is automatically authorised", () => {
  assert.equal(isAuthorisedPending("0001_auth.sql"), false);
  assert.equal(isAuthorisedPending("0022_cp25g3_better_auth_runtime_privileges.sql"), false);
  assert.equal(isAuthorisedPending("0023_cp26a2_entitlement_publication_decoupling.sql"), false);
  assert.equal(isAuthorisedPending("0024_cp26b2_ordered_billing_events.sql"), false);
  assert.equal(isAuthorisedPending("0024_future.sql"), false);
  assert.equal(isAuthorisedPending("0025_cp26co2_platform_owners.sql"), false);
  assert.equal(isAuthorisedPending("0025_later.sql"), false);
  assert.equal(isAuthorisedPending("0026_later.sql"), false);
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

test("reviewed 0020-0025 source checksums remain intact", () => {
  for (const [name, expected] of Object.entries(REVIEWED_DIGESTS)) {
    const bytes = readFileSync(join(here, "../migrations", name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name);
  }
});

test("spent single-use and generic production migrate workflows stay retired", () => {
  const workflows = join(here, "../.github/workflows");
  assert.equal(existsSync(join(workflows, "cp26a2-0023-production-migrate.yml")), false);
  assert.equal(existsSync(join(workflows, "cp25g3-0022-production-migrate.yml")), false);
  assert.equal(existsSync(join(workflows, "cp26b2-0024-production-migrate.yml")), false);
  assert.equal(existsSync(join(workflows, "production-database-migrate.yml")), false);
  assert.equal(existsSync(join(workflows, "production-database.yml")), true);
  assert.equal(existsSync(join(workflows, "cp26co2a-0025-production-migrate.yml")), true);
  assert.equal(existsSync(join(workflows, "cp26co2c-first-owner-bootstrap.yml")), false);
  const yaml = readdirSync(workflows).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).sort();
  assert.deepEqual(yaml, [
    "cp26co2a-0025-production-migrate.yml",
    "production-database.yml",
  ]);
});
