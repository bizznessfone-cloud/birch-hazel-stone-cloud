#!/usr/bin/env node
/**
 * CP25G.3C.1 — single-use production controller for 0022 only.
 *
 * Applies migrations/0022_cp25g3_better_auth_runtime_privileges.sql and
 * nothing else. Never uses DATABASE_URL. Never prints secrets. Never deploys.
 * Does not invoke the generic production migrator.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";
import {
  BLOCKED_OWNER_URL,
  EXPECTED_DATABASE,
  EXPECTED_OWNER,
  EXPECTED_RUNTIME,
  inspectProduction,
  redact,
} from "./production-db-preflight.mjs";

export const TARGET_MIGRATION = "0022_cp25g3_better_auth_runtime_privileges.sql";
export const TARGET_DIGEST =
  "bf2563cbc13f773d0ec75865745ce1b6b6aa87ce7846fc8961c53beda77bccc3";
export const REVIEWED_SOURCE_SHA = "92d3c41a0ada1eb6c9f3c3cd7998747d55b10356";
export const REQUIRED_CONFIRMATION = "APPLY-CP25G3-0022-PRODUCTION";

export const REQUIRED_LEDGER = [
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

export const AUTH_TABLES = ["user", "session", "account", "verification"];
export const DML_PRIVILEGES = ["select", "insert", "update", "delete"];
export const FORBIDDEN_PRIVILEGES = ["truncate", "references", "trigger"];
export const OCCUPANCY = ["bookings_driver_occupancy_excl", "bookings_vehicle_occupancy_excl"];

export const AUTHORISED = "GATE PASS — 0022 AUTHORISED";
export const ALREADY_APPLIED = "0022 ALREADY APPLIED — NO MUTATION";
export const APPLIED_VERIFIED = "GATE PASS — 0022 APPLIED AND VERIFIED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const DIGEST_BLOCKED = "BLOCKED — 0022 DIGEST MISMATCH";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const IDENTITY_BLOCKED = "BLOCKED — DATABASE IDENTITY MISMATCH";
export const OWNER_BLOCKED = "BLOCKED — OWNER IDENTITY MISMATCH";
export const ROLE_BLOCKED = "BLOCKED — AETHER_APP ROLE ESCALATED";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const APPLY_FAILED = "BLOCKED — 0022 APPLICATION FAILED";
export const UNAUTHORISED_MIGRATION = "BLOCKED — UNAUTHORISED MIGRATION";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertConfirmation(value) {
  if (String(value ?? "") !== REQUIRED_CONFIRMATION) {
    return { ok: false, verdict: CONFIRM_BLOCKED, migrated: false };
  }
  return { ok: true };
}

export function assertMigrationFile(file) {
  const name = String(file?.name ?? "");
  const digest = String(file?.digest ?? sha256(Buffer.from(file?.bytes ?? file?.text ?? "")));
  if (name !== TARGET_MIGRATION) {
    return { ok: false, verdict: UNAUTHORISED_MIGRATION, migrated: false, name };
  }
  if (digest !== TARGET_DIGEST) {
    return { ok: false, verdict: DIGEST_BLOCKED, migrated: false, digest };
  }
  return { ok: true, name, digest };
}

export function assertAuthorisedMigrationName(name) {
  if (name !== TARGET_MIGRATION) {
    return { ok: false, verdict: UNAUTHORISED_MIGRATION, migrated: false, name };
  }
  return { ok: true, name };
}

export function ownerUrlFromEnv(env) {
  return String(env?.AETHER_DATABASE_OWNER_URL ?? "").trim();
}

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

function authPresent(tables) {
  return AUTH_TABLES.every((name) => tables?.[name] === "PRESENT");
}

function authOwnersAreOwner(owners) {
  return AUTH_TABLES.every((name) => owners?.[name] === EXPECTED_OWNER);
}

export function roleIsSafe(role) {
  return Boolean(
    role &&
      role.login === true &&
      role.superuser === false &&
      role.createdb === false &&
      role.createrole === false &&
      role.replication === false &&
      role.bypassrls === false,
  );
}

export function privilegeCell(privileges, table, priv) {
  return Boolean(privileges?.[table]?.[priv]);
}

export function dmlGranted(privileges) {
  return AUTH_TABLES.every((table) =>
    DML_PRIVILEGES.every((priv) => privilegeCell(privileges, table, priv) === true),
  );
}

export function forbiddenAbsent(privileges) {
  return AUTH_TABLES.every((table) =>
    FORBIDDEN_PRIVILEGES.every((priv) => privilegeCell(privileges, table, priv) === false),
  );
}

function blocked(verdict, extra = {}) {
  return { ok: false, verdict, migrated: false, ...extra };
}

export function evaluateOwnerIdentity(facts) {
  if (String(facts?.database ?? "") !== EXPECTED_DATABASE) {
    return blocked(IDENTITY_BLOCKED, { database: facts?.database });
  }
  if (
    String(facts?.currentUser ?? "") !== EXPECTED_OWNER ||
    String(facts?.sessionUser ?? "") !== EXPECTED_OWNER
  ) {
    return blocked(OWNER_BLOCKED, {
      currentUser: facts?.currentUser,
      sessionUser: facts?.sessionUser,
    });
  }
  return { ok: true };
}

export function evaluate0022Baseline(facts, file) {
  const confirm = assertConfirmation(facts?.confirmation);
  if (!confirm.ok) return confirm;
  if (!ownerUrlFromEnv(facts?.env ?? { AETHER_DATABASE_OWNER_URL: facts?.ownerUrl })) {
    return blocked(BLOCKED_OWNER_URL);
  }
  const fileGate = assertMigrationFile(file);
  if (!fileGate.ok) return fileGate;
  const identity = evaluateOwnerIdentity(facts);
  if (!identity.ok) return identity;
  if (!facts?.ledgerReadable) {
    return blocked("BLOCKED — PRODUCTION MIGRATION LEDGER CANNOT BE READ");
  }
  if (!facts?.aetherAppExists) return blocked("BLOCKED — AETHER_APP ROLE MISSING");
  if (!roleIsSafe(facts?.aetherAppRole)) return blocked(ROLE_BLOCKED);
  if (!authPresent(facts?.authTables)) return blocked("BLOCKED — AUTH TABLES MISSING");
  if (!authOwnersAreOwner(facts?.authTableOwners)) {
    return blocked("BLOCKED — AUTH TABLE OWNERSHIP INVALID");
  }
  if (facts?.schemaCreate === true) return blocked("BLOCKED — SCHEMA CREATE GRANTED");
  if (!occupancyIntact(facts?.occupancy)) {
    return blocked("BLOCKED — OCCUPANCY INVARIANT NOT PROVEN");
  }
  if (!hotelMatches(facts?.hotel)) return blocked("BLOCKED — DEMO-KOS INVARIANT NOT PROVEN");

  const ledger = [...(facts?.ledger ?? [])].map(String);
  const missingHistorical = REQUIRED_LEDGER.filter((name) => !ledger.includes(name));
  if (missingHistorical.length) {
    return blocked("BLOCKED — MISSING HISTORICAL MIGRATION", { missingHistorical });
  }

  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  if (appliedCount > 1) {
    return blocked("BLOCKED — 0022 LEDGER DUPLICATE", { pending, appliedCount });
  }
  if (appliedCount === 1) {
    if (pending.length === 0) {
      return { ok: true, alreadyApplied: true, verdict: ALREADY_APPLIED, pending: [], migrated: false };
    }
    return blocked(UNEXPECTED_PLAN, { pending, alreadyApplied: true });
  }
  if (sameList(pending, [TARGET_MIGRATION])) {
    return {
      ok: true,
      authorised: true,
      alreadyApplied: false,
      verdict: AUTHORISED,
      pending,
      migrated: false,
      prePrivileges: facts?.privileges ?? null,
    };
  }
  return blocked(UNEXPECTED_PLAN, { pending });
}

export function evaluate0022Aftermath(facts) {
  const identity = evaluateOwnerIdentity(facts);
  if (!identity.ok) return { ...identity, migrated: true };
  const failures = [];
  const ledger = [...(facts?.ledger ?? [])].map(String);
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  if (appliedCount !== 1) failures.push("0022-ledger");
  if (pending.length > 0) failures.push("pending-remain");
  if (!authPresent(facts?.authTables)) failures.push("auth-tables");
  if (!authOwnersAreOwner(facts?.authTableOwners)) failures.push("auth-owners");
  if (!dmlGranted(facts?.privileges)) failures.push("dml-privileges");
  if (!forbiddenAbsent(facts?.privileges)) failures.push("forbidden-privileges");
  if (facts?.schemaCreate === true) failures.push("schema-create");
  if (!roleIsSafe(facts?.aetherAppRole)) failures.push("role-escalation");
  if (!occupancyIntact(facts?.occupancy)) failures.push("occupancy");
  if (!hotelMatches(facts?.hotel)) failures.push("demo-kos");
  if (failures.length) {
    return { ok: false, verdict: POST_BLOCKED, failures, pending, migrated: true };
  }
  return { ok: true, verdict: APPLIED_VERIFIED, pending: [], migrated: true };
}

export async function applyExact0022({ name, sql, execute }) {
  const gate = assertAuthorisedMigrationName(name);
  if (!gate.ok) {
    const err = new Error(gate.verdict);
    err.verdict = gate.verdict;
    throw err;
  }
  if (typeof execute !== "function") {
    throw new Error("BLOCKED — 0022 EXECUTOR MISSING");
  }
  return execute(sql);
}

export async function runSingleUse0022({ env, confirmation, file, loadFacts, applyMigration }) {
  const ownerUrl = ownerUrlFromEnv(env);
  const confirm = assertConfirmation(confirmation);
  if (!confirm.ok) return confirm;
  if (!ownerUrl) return blocked(BLOCKED_OWNER_URL);
  const fileGate = assertMigrationFile(file);
  if (!fileGate.ok) return fileGate;

  const before = await loadFacts();
  const baseline = evaluate0022Baseline(
    { ...before, confirmation, env, ownerUrl },
    file,
  );
  if (!baseline.ok || baseline.alreadyApplied) {
    return { ...baseline, preflight: before, migrated: false };
  }

  let applyError = null;
  try {
    await applyExact0022({
      name: TARGET_MIGRATION,
      sql: file.sql ?? file.text,
      execute: applyMigration,
    });
  } catch (err) {
    applyError = err;
  }

  const after = await loadFacts();
  if (applyError) {
    return {
      ok: false,
      verdict: applyError?.verdict || APPLY_FAILED,
      migrated: false,
      error: redact(applyError?.message || applyError),
      preflight: before,
      postflight: after,
    };
  }
  const aftermath = evaluate0022Aftermath(after);
  return { ...aftermath, preflight: before, postflight: after };
}

function say(line) {
  console.log(line);
}

function fail(verdict, extra = "") {
  say(verdict);
  if (extra) say(redact(extra));
  process.exitCode = 1;
}

function reportPrivileges(privileges) {
  say("aether_app table privileges:");
  say("table            SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER");
  for (const table of AUTH_TABLES) {
    const row = privileges?.[table] ?? {};
    const cells = [...DML_PRIVILEGES, ...FORBIDDEN_PRIVILEGES].map((priv) =>
      row[priv] === true ? "T" : row[priv] === false ? "F" : "?",
    );
    say(`${table.padEnd(16)} ${cells.join("      ")}`);
  }
}

function reportFacts(label, facts) {
  say(label);
  say(`database: ${facts?.database ?? ""}`);
  say(`current_user: ${facts?.currentUser ?? ""}`);
  say(`session_user: ${facts?.sessionUser ?? ""}`);
  say("ledger:");
  for (const name of facts?.ledger ?? []) say(`  ${name}`);
  if (!(facts?.ledger ?? []).length) say("  (empty)");
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], facts?.ledger ?? []).map(
    (row) => row.name,
  );
  say("pending:");
  for (const name of pending) say(`  ${name}`);
  if (!pending.length) say("  (none)");
  say(`aether_app: ${facts?.aetherAppExists ? "PRESENT" : "ABSENT"}`);
  const role = facts?.aetherAppRole ?? {};
  say(`LOGIN: ${role.login === true ? "true" : "false"}`);
  say(`SUPERUSER: ${role.superuser === true ? "true" : "false"}`);
  say(`CREATEDB: ${role.createdb === true ? "true" : "false"}`);
  say(`CREATEROLE: ${role.createrole === true ? "true" : "false"}`);
  say(`REPLICATION: ${role.replication === true ? "true" : "false"}`);
  say(`BYPASSRLS: ${role.bypassrls === true ? "true" : "false"}`);
  const authOwners = facts?.authTableOwners ?? {};
  for (const name of AUTH_TABLES) say(`owner.${name}: ${authOwners[name] ?? "UNKNOWN"}`);
  say(`schema CREATE: ${facts?.schemaCreate === true ? "true" : "false"}`);
  reportPrivileges(facts?.privileges);
  if (facts?.hotel) {
    say("demo-kos:");
    say(`  status: ${facts.hotel.status}`);
    say(`  provider_count: ${facts.hotel.providerCount}`);
    say(`  destination_count: ${facts.hotel.destinationCount}`);
  } else {
    say("demo-kos: ABSENT");
  }
}

export async function inspect0022State(client, sourceMigrations) {
  const base = await inspectProduction(client, sourceMigrations);
  const role = (
    await client.query(
      `select rolcanlogin as login,
              rolsuper as superuser,
              rolcreatedb as createdb,
              rolcreaterole as createrole,
              rolreplication as replication,
              rolbypassrls as bypassrls
         from pg_roles
        where rolname = $1`,
      [EXPECTED_RUNTIME],
    )
  ).rows[0];

  const owners = (
    await client.query(
      `select c.relname as name, r.rolname as owner
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r on r.oid = c.relowner
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname = any($1::text[])`,
      [AUTH_TABLES],
    )
  ).rows;
  const authTableOwners = Object.fromEntries(owners.map((row) => [row.name, row.owner]));

  const schemaCreate = (
    await client.query("select has_schema_privilege($1, 'public', 'CREATE') as ok", [
      EXPECTED_RUNTIME,
    ])
  ).rows[0]?.ok === true;

  const privileges = {};
  for (const table of AUTH_TABLES) {
    const row = (
      await client.query(
        `select
           has_table_privilege($1, format('%I.%I', 'public', $2::text), 'SELECT') as "select",
           has_table_privilege($1, format('%I.%I', 'public', $2::text), 'INSERT') as "insert",
           has_table_privilege($1, format('%I.%I', 'public', $2::text), 'UPDATE') as "update",
           has_table_privilege($1, format('%I.%I', 'public', $2::text), 'DELETE') as "delete",
           has_table_privilege($1, format('%I.%I', 'public', $2::text), 'TRUNCATE') as "truncate",
           has_table_privilege($1, format('%I.%I', 'public', $2::text), 'REFERENCES') as "references",
           has_table_privilege($1, format('%I.%I', 'public', $2::text), 'TRIGGER') as "trigger"`,
        [EXPECTED_RUNTIME, table],
      )
    ).rows[0];
    privileges[table] = {
      select: row?.select === true,
      insert: row?.insert === true,
      update: row?.update === true,
      delete: row?.delete === true,
      truncate: row?.truncate === true,
      references: row?.references === true,
      trigger: row?.trigger === true,
    };
  }

  return {
    ...base,
    aetherAppRole: {
      login: role?.login === true,
      superuser: role?.superuser === true,
      createdb: role?.createdb === true,
      createrole: role?.createrole === true,
      replication: role?.replication === true,
      bypassrls: role?.bypassrls === true,
    },
    authTableOwners,
    schemaCreate,
    privileges,
  };
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
    return await inspect0022State(client, sourceMigrations);
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

async function apply0022OnOwner(ownerUrl, sql) {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO _migrations (name) VALUES ($1)", [TARGET_MIGRATION]);
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // keep original error
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const ownerUrl = ownerUrlFromEnv(process.env);
  const confirmation = process.env.CP25G3_CONFIRMATION;
  const confirm = assertConfirmation(confirmation);
  if (!confirm.ok) {
    fail(confirm.verdict);
    return;
  }
  if (!ownerUrl) {
    fail(BLOCKED_OWNER_URL);
    return;
  }

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const migrationPath = join(rootDir, "migrations", TARGET_MIGRATION);
  const bytes = await readFile(migrationPath);
  const file = {
    name: TARGET_MIGRATION,
    bytes,
    digest: sha256(bytes),
    sql: bytes.toString("utf8"),
  };
  say(`0022 digest: ${file.digest}`);
  say(`reviewed source sha: ${REVIEWED_SOURCE_SHA}`);

  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUse0022({
    env: process.env,
    confirmation,
    file,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    applyMigration: (sql) => apply0022OnOwner(ownerUrl, sql),
  });
  if (result.preflight) reportFacts("pre-migration:", result.preflight);
  if (result.failures?.length) {
    say("gate failures:");
    for (const name of result.failures) say(`  ${name}`);
  }
  if (result.postflight) reportFacts("post-migration:", result.postflight);
  if (result.error) say(redact(result.error));
  say(result.verdict);
  if (!result.ok) process.exitCode = 1;
}

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    fail(APPLY_FAILED, err?.message || err);
    process.exit(1);
  });
}
