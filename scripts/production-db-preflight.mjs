#!/usr/bin/env node
/**
 * CP25C Phase 1 — read-only production database preflight (Gate B).
 *
 * Requires AETHER_DATABASE_OWNER_URL. Never reads DATABASE_URL.
 * Never migrates, never mutates, never SET ROLE, never prints secrets.
 */
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";

export const EXPECTED_DATABASE = "neondb";
export const EXPECTED_OWNER = "neondb_owner";
export const EXPECTED_RUNTIME = "aether_app";
export const PASS_VERDICT = "GATE B PASS — MIGRATION PLAN PROVEN";
export const BLOCKED_OWNER_URL = "BLOCKED — AETHER_DATABASE_OWNER_URL is not configured";

const HISTORICAL_RE = /^00(0[2-9]|1[0-7])_.*\.sql$/;
const AUTH_TABLES = ["user", "session", "account", "verification"];
const OCCUPANCY_CONSTRAINTS = [
  "bookings_vehicle_occupancy_excl",
  "bookings_driver_occupancy_excl",
];

/** Accepted Production history after CP26C-O3.2C. Not a future-pending allowlist. */
export const ACCEPTED_LEDGER = [
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
  "0022_cp25g3_better_auth_runtime_privileges.sql",
  "0023_cp26a2_entitlement_publication_decoupling.sql",
  "0024_cp26b2_ordered_billing_events.sql",
  "0025_cp26co2_platform_owners.sql",
  "0026_cp26co3_commercial_catalogue.sql",
];

export const REVIEWED_DIGESTS = {
  "0020_cp24_stripe_billing.sql":
    "e554f58f72ebe71a7048786b16890aaa4e125642f314407d49ab863ac8365e0c",
  "0021_cp25_hotel_guest_payments.sql":
    "b51166aab2016c2223cfe2e495d0e72e6677bfd216bfe029f1064ae18ae1e86a",
  "0022_cp25g3_better_auth_runtime_privileges.sql":
    "bf2563cbc13f773d0ec75865745ce1b6b6aa87ce7846fc8961c53beda77bccc3",
  "0023_cp26a2_entitlement_publication_decoupling.sql":
    "469eeee3c8707beb40a2a268bea53c77620265efb969bfbff12c524e17585ba1",
  "0024_cp26b2_ordered_billing_events.sql":
    "23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0",
  "0025_cp26co2_platform_owners.sql":
    "575aabcb7322fc8ca63c8a3dd137d358f76375f1777ed59cf04c1d98d6c066fd",
  "0026_cp26co3_commercial_catalogue.sql":
    "4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446",
};

/** No pending migration is automatically authorised. Future files need their own checkpoint. */
export const AUTHORISED_PENDING = [];

export function isAuthorisedPending(name) {
  return AUTHORISED_PENDING.includes(String(name));
}

export function redact(text) {
  return String(text ?? "")
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s"'`]+/gi, "postgres://redacted")
    .replace(/AETHER_DATABASE_OWNER_URL[^\s]*/gi, "AETHER_DATABASE_OWNER_URL=redacted")
    .replace(/(password\s*=\s*)[^\s&]+/gi, "$1redacted");
}

export function historicalSourceMigrations(sourceFiles) {
  return [...sourceFiles].filter((name) => HISTORICAL_RE.test(name)).sort((a, b) => a.localeCompare(b));
}

export function classifyAuth(ledgerHas0001, tables) {
  const states = AUTH_TABLES.map((name) => tables?.[name] === "PRESENT");
  const allPresent = states.every(Boolean);
  const allAbsent = states.every((present) => !present);
  if (ledgerHas0001 && allPresent) return "A";
  if (!ledgerHas0001 && allAbsent) return "B";
  if (!ledgerHas0001 && allPresent) return "C";
  if (ledgerHas0001 && allAbsent) return "D";
  return "INCOHERENT";
}

export function evaluatePreflight(input) {
  const database = String(input.database ?? "");
  const currentUser = String(input.currentUser ?? "");
  const sessionUser = String(input.sessionUser ?? "");
  const ledger = [...(input.ledger ?? [])].map(String).sort((a, b) => a.localeCompare(b));
  const sourceMigrations = [...(input.sourceMigrations ?? [])].map(String);
  const historical = historicalSourceMigrations(sourceMigrations);
  const pending = pendingMigrations(sourceMigrations, ledger).map((row) => row.name);
  const unexpectedPending = pending.filter((name) => !isAuthorisedPending(name));
  const missingHistorical = historical.filter((name) => !ledger.includes(name));
  const missingAccepted = ACCEPTED_LEDGER.filter((name) => !ledger.includes(name));
  const ledgerHas0001 = ledger.includes("0001_auth.sql");
  const authClass = classifyAuth(ledgerHas0001, input.authTables ?? {});
  const occupancy = input.occupancy ?? [];
  const occupancyNames = new Set(occupancy.map((row) => row.name));
  const missingOccupancy = OCCUPANCY_CONSTRAINTS.filter((name) => !occupancyNames.has(name));
  const occupancyWithoutExclude = occupancy.filter(
    (row) => occupancyNames.has(row.name) && !/EXCLUDE/i.test(String(row.definition ?? "")),
  );

  if (database !== EXPECTED_DATABASE) {
    return blocked("BLOCKED — DATABASE IDENTITY MISMATCH", { database, currentUser, sessionUser, pending });
  }
  if (currentUser !== EXPECTED_OWNER || sessionUser !== EXPECTED_OWNER) {
    return blocked("BLOCKED — OWNER IDENTITY MISMATCH", { database, currentUser, sessionUser, pending });
  }
  if (!input.ledgerReadable) {
    return blocked("BLOCKED — PRODUCTION MIGRATION LEDGER CANNOT BE READ", { pending: [] });
  }
  if (missingHistorical.length > 0 || missingAccepted.length > 0 || unexpectedPending.length > 0) {
    return blocked("BLOCKED — MIGRATION LEDGER INCONSISTENT", {
      missingHistorical,
      missingAccepted,
      unexpectedPending,
      pending,
    });
  }
  if (authClass === "C" || authClass === "D" || authClass === "INCOHERENT") {
    return blocked("BLOCKED — AUTH SCHEMA INCONSISTENT", { authClass, pending });
  }
  if (!input.aetherAppExists) {
    return blocked("BLOCKED — AETHER_APP ROLE MISSING", { pending });
  }
  if (missingOccupancy.length > 0 || occupancyWithoutExclude.length > 0) {
    return blocked("BLOCKED — OCCUPANCY INVARIANT NOT PROVEN", {
      missingOccupancy,
      pending,
    });
  }

  return {
    ok: true,
    verdict: PASS_VERDICT,
    database,
    currentUser,
    sessionUser,
    ledger,
    pending,
    authClass,
    authTables: input.authTables ?? {},
    schemaPhase: input.schemaPhase ?? "",
    checkpoint: input.checkpoint ?? "",
    aetherAppExists: Boolean(input.aetherAppExists),
    tableOwners: input.tableOwners ?? {},
    occupancy,
    hotel: input.hotel ?? null,
  };
}

function blocked(verdict, extra = {}) {
  return { ok: false, verdict, ...extra };
}

function say(line) {
  console.log(line);
}

function fail(verdict, extra = "") {
  say(verdict);
  if (extra) say(redact(extra));
  process.exitCode = 1;
}

function ownerUrlFromEnv(env) {
  return String(env.AETHER_DATABASE_OWNER_URL ?? "").trim();
}

async function loadSourceMigrations(rootDir) {
  const entries = await readdir(join(rootDir, "migrations"));
  return entries.filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
}

async function readOnlyQuery(client, text, params = []) {
  return client.query(text, params);
}

export async function inspectProduction(client, sourceMigrations) {
  const identity = (
    await readOnlyQuery(
      client,
      "select current_database() as database, current_user, session_user",
    )
  ).rows[0];

  let ledger = [];
  let ledgerReadable = true;
  try {
    ledger = (await readOnlyQuery(client, "select name from _migrations order by name")).rows.map(
      (row) => row.name,
    );
  } catch (err) {
    ledgerReadable = false;
    return {
      database: identity?.database,
      currentUser: identity?.current_user,
      sessionUser: identity?.session_user,
      ledger,
      ledgerReadable,
      sourceMigrations,
      error: redact(err?.message || err),
    };
  }

  const authTables = {};
  for (const name of AUTH_TABLES) {
    const row = (
      await readOnlyQuery(client, "select to_regclass($1) is not null as present", [`public.${name}`])
    ).rows[0];
    authTables[name] = row?.present ? "PRESENT" : "ABSENT";
  }

  const metaRows = (
    await readOnlyQuery(
      client,
      "select key, value from aether_meta where key in ('schema_phase', 'checkpoint')",
    )
  ).rows;
  const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));

  const aetherApp = (
    await readOnlyQuery(client, "select exists(select 1 from pg_roles where rolname = $1) as ok", [
      EXPECTED_RUNTIME,
    ])
  ).rows[0];

  const owners = (
    await readOnlyQuery(
      client,
      `select c.relname as name, r.rolname as owner
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r on r.oid = c.relowner
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname in ('hotels', 'bookings')
        order by c.relname`,
    )
  ).rows;
  const tableOwners = Object.fromEntries(owners.map((row) => [row.name, row.owner]));

  const occupancy = (
    await readOnlyQuery(
      client,
      `select c.conname as name,
              pg_get_constraintdef(c.oid) as definition,
              r.rolname as owner
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join pg_roles r on r.oid = t.relowner
        where n.nspname = 'public'
          and t.relname = 'bookings'
          and c.contype = 'x'
          and c.conname = any($1::text[])
        order by c.conname`,
      [OCCUPANCY_CONSTRAINTS],
    )
  ).rows;

  const hotel = (
    await readOnlyQuery(
      client,
      `select h.code,
              h.name,
              h.status,
              (select count(*)::int from hotel_provider_agreements a
                where a.hotel_id = h.id and a.active) as provider_count,
              (select count(*)::int from hotel_destinations d
                where d.hotel_id = h.id) as destination_count
         from hotels h
        where h.code = 'demo-kos'`,
    )
  ).rows[0];

  return {
    database: identity?.database,
    currentUser: identity?.current_user,
    sessionUser: identity?.session_user,
    ledger,
    ledgerReadable,
    sourceMigrations,
    authTables,
    schemaPhase: meta.schema_phase ?? "",
    checkpoint: meta.checkpoint ?? "",
    aetherAppExists: Boolean(aetherApp?.ok),
    tableOwners,
    occupancy,
    hotel: hotel
      ? {
          code: hotel.code,
          name: hotel.name,
          status: hotel.status,
          providerCount: Number(hotel.provider_count),
          destinationCount: Number(hotel.destination_count),
        }
      : null,
  };
}

export function report(result) {
  say(`database: ${result.database ?? ""}`);
  say(`current_user: ${result.currentUser ?? ""}`);
  say(`session_user: ${result.sessionUser ?? ""}`);
  say("ledger:");
  for (const name of result.ledger ?? []) say(`  ${name}`);
  if (!(result.ledger ?? []).length) say("  (empty)");
  say(`0001_auth.sql ledger: ${(result.ledger ?? []).includes("0001_auth.sql") ? "PRESENT" : "ABSENT"}`);
  const tables = result.authTables ?? {};
  for (const name of AUTH_TABLES) say(`auth.${name}: ${tables[name] ?? "UNKNOWN"}`);
  if (result.authClass) say(`auth classification: ${result.authClass}`);
  say(`schema_phase: ${result.schemaPhase ?? ""}`);
  say(`checkpoint: ${result.checkpoint ?? ""}`);
  say(`aether_app: ${result.aetherAppExists ? "PRESENT" : "ABSENT"}`);
  const owners = result.tableOwners ?? {};
  say(`hotels owner: ${owners.hotels ?? "UNKNOWN"}`);
  say(`bookings owner: ${owners.bookings ?? "UNKNOWN"}`);
  say("occupancy:");
  for (const row of result.occupancy ?? []) {
    say(`  ${row.name}`);
    say(`    owner: ${row.owner ?? "UNKNOWN"}`);
    say(`    definition: ${row.definition ?? ""}`);
  }
  if (result.hotel) {
    say("demo-kos:");
    say(`  code: ${result.hotel.code}`);
    say(`  name: ${result.hotel.name}`);
    say(`  status: ${result.hotel.status}`);
    say(`  provider_count: ${result.hotel.providerCount}`);
    say(`  destination_count: ${result.hotel.destinationCount}`);
  } else {
    say("demo-kos: ABSENT");
  }
  say("pending:");
  for (const name of result.pending ?? []) say(`  ${name}`);
  if (!(result.pending ?? []).length) say("  (none)");
  if (result.missingHistorical?.length) {
    say("missing historical:");
    for (const name of result.missingHistorical) say(`  ${name}`);
  }
  if (result.missingAccepted?.length) {
    say("missing accepted:");
    for (const name of result.missingAccepted) say(`  ${name}`);
  }
  if (result.unexpectedPending?.length) {
    say("unexpected pending:");
    for (const name of result.unexpectedPending) say(`  ${name}`);
  }
  say(result.verdict);
}

async function main() {
  const ownerUrl = ownerUrlFromEnv(process.env);
  if (!ownerUrl) {
    fail(BLOCKED_OWNER_URL);
    return;
  }

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sourceMigrations = await loadSourceMigrations(rootDir);
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN READ ONLY");
    began = true;
    const facts = await inspectProduction(client, sourceMigrations);
    const result = evaluatePreflight(facts);
    report(result);
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    fail("BLOCKED — PRODUCTION MIGRATION LEDGER CANNOT BE READ", err?.message || err);
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

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    fail("BLOCKED — PRODUCTION MIGRATION LEDGER CANNOT BE READ", err?.message || err);
    process.exit(1);
  });
}
