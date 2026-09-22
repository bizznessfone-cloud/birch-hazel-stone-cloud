#!/usr/bin/env node
/**
 * CP26B.2 — single-use production controller for 0024 only.
 *
 * Applies migrations/0024_cp26b2_ordered_billing_events.sql and nothing else.
 * Never uses DATABASE_URL. Never prints secrets. Never deploys.
 * Does not invoke the generic production migrator.
 * Do not dispatch until CP26B.3.
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
import {
  AUTH_TABLES,
  OCCUPANCY,
  buildHotelSnapshot,
  classifyEntitlementFunction,
  evaluateOwnerIdentity,
  hotelSnapshotKey,
  plpgsqlBody,
  roleIsSafe,
} from "./cp26a2-0023-production-migrate.mjs";

export const TARGET_MIGRATION = "0024_cp26b2_ordered_billing_events.sql";
export const TARGET_DIGEST =
  "23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0";
export const REQUIRED_CONFIRMATION = "APPLY-0024";
export const AETHER_RUNTIME_ROLE = "aether_runtime";
export const EXPECTED_FUNCTION_IDENTITY =
  "text, text, bigint, uuid, text, text, text, text, timestamp with time zone, boolean";
export const REQUIRED_BILLING_COLUMNS = [
  "last_stripe_event_created",
  "last_stripe_event_id",
  "cancel_at_period_end",
];
export const REQUIRED_EVENT_COLUMNS = ["hotel_id", "stripe_created", "outcome"];

export const REVIEWED_DIGESTS = {
  "0020_cp24_stripe_billing.sql":
    "e554f58f72ebe71a7048786b16890aaa4e125642f314407d49ab863ac8365e0c",
  "0021_cp25_hotel_guest_payments.sql":
    "b51166aab2016c2223cfe2e495d0e72e6677bfd216bfe029f1064ae18ae1e86a",
  "0022_cp25g3_better_auth_runtime_privileges.sql":
    "bf2563cbc13f773d0ec75865745ce1b6b6aa87ce7846fc8961c53beda77bccc3",
  "0023_cp26a2_entitlement_publication_decoupling.sql":
    "469eeee3c8707beb40a2a268bea53c77620265efb969bfbff12c524e17585ba1",
  "0024_cp26b2_ordered_billing_events.sql": TARGET_DIGEST,
};

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
  "0022_cp25g3_better_auth_runtime_privileges.sql",
  "0023_cp26a2_entitlement_publication_decoupling.sql",
];

export const AUTHORISED = "GATE PASS — 0024 AUTHORISED";
export const ALREADY_APPLIED = "0024 ALREADY APPLIED — NO MUTATION";
export const APPLIED_VERIFIED = "GATE PASS — 0024 APPLIED AND VERIFIED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const DIGEST_BLOCKED = "BLOCKED — 0024 DIGEST MISMATCH";
export const REVIEWED_DIGEST_BLOCKED = "BLOCKED — REVIEWED MIGRATION DIGEST MISMATCH";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const APPLY_FAILED = "BLOCKED — 0024 APPLICATION FAILED";
export const UNAUTHORISED_MIGRATION = "BLOCKED — UNAUTHORISED MIGRATION";
export const FUNCTION_NOT_HISTORICAL = "BLOCKED — INSTALLED BILLING FUNCTION NOT HISTORICAL LAST-WRITE-WINS";
export const FUNCTION_LEDGER_SPLIT = "BLOCKED — 0024 LEDGER APPLIED BUT FUNCTION NOT ORDERED";
export const IDENTITY_BLOCKED = "BLOCKED — DATABASE IDENTITY MISMATCH";
export const OWNER_BLOCKED = "BLOCKED — OWNER IDENTITY MISMATCH";
export const ROLE_BLOCKED = "BLOCKED — AETHER_APP ROLE ESCALATED";

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

export function assertReviewedChecksums(checksums) {
  for (const [name, expected] of Object.entries(REVIEWED_DIGESTS)) {
    const actual = String(checksums?.[name] ?? "");
    if (actual !== expected) {
      return {
        ok: false,
        verdict: name === TARGET_MIGRATION ? DIGEST_BLOCKED : REVIEWED_DIGEST_BLOCKED,
        name,
        digest: actual,
        expected,
        migrated: false,
      };
    }
  }
  return { ok: true };
}

export function ownerUrlFromEnv(env) {
  return String(env?.AETHER_DATABASE_OWNER_URL ?? "").trim();
}

export function classifyBillingApplyFunction(definition) {
  const text = String(definition ?? "");
  const start = text.search(/function sbg_apply_billing_event/i);
  const sliced = start >= 0 ? text.slice(start) : text;
  const nextFn = sliced.slice(1).search(/create or replace function/i);
  const fnText = nextFn >= 0 ? sliced.slice(0, nextFn + 1) : sliced;
  const body = plpgsqlBody(fnText);
  if (!body.trim()) return "missing";
  const hasCreated = /p_event_created/i.test(fnText);
  const hasStale = /'stale'/i.test(body);
  const hasAmbiguous = /'ambiguous'/i.test(body);
  const updatesHotels = /update\s+hotels/i.test(body);
  const lastWriteWins =
    /on conflict \(hotel_id\) do update/i.test(body) && !/last_stripe_event_created/i.test(body);
  if (updatesHotels) return "unexpected";
  if (hasCreated && hasStale && hasAmbiguous) return "ordered";
  if (lastWriteWins && !hasCreated) return "historical";
  return "unexpected";
}

function sameList(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
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

function blocked(verdict, extra = {}) {
  return { ok: false, verdict, migrated: false, ...extra };
}

export function billingSnapshotKey(snapshot) {
  const statusCounts = Object.fromEntries(
    Object.entries(snapshot?.statusCounts ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({
    accountCount: Number(snapshot?.accountCount ?? -1),
    statusCounts,
    eventCount: Number(snapshot?.eventCount ?? -1),
  });
}

export function evaluate0024Baseline(facts, file) {
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
  if (facts?.hotelSnapshot?.demoKos?.code !== "demo-kos" || facts?.hotelSnapshot?.demoKos?.status !== "live") {
    return blocked("BLOCKED — DEMO-KOS INVARIANT NOT PROVEN");
  }
  if (String(facts?.tableOwners?.hotels ?? "") !== EXPECTED_OWNER) {
    return blocked("BLOCKED — HOTELS OWNERSHIP INVALID");
  }

  const ledger = [...(facts?.ledger ?? [])].map(String);
  const missingHistorical = REQUIRED_LEDGER.filter((name) => !ledger.includes(name));
  if (missingHistorical.length) {
    return blocked("BLOCKED — MISSING HISTORICAL MIGRATION", { missingHistorical });
  }

  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  const kind = classifyBillingApplyFunction(facts?.functionDefinition);

  if (appliedCount > 1) {
    return blocked("BLOCKED — 0024 LEDGER DUPLICATE", { pending, appliedCount });
  }
  if (appliedCount === 1) {
    if (pending.length === 0 && kind === "ordered") {
      return {
        ok: true,
        alreadyApplied: true,
        verdict: ALREADY_APPLIED,
        pending: [],
        migrated: false,
        functionKind: kind,
      };
    }
    if (kind !== "ordered") {
      return blocked(FUNCTION_LEDGER_SPLIT, { pending, functionKind: kind });
    }
    return blocked(UNEXPECTED_PLAN, { pending, alreadyApplied: true, functionKind: kind });
  }
  if (kind !== "historical") {
    return blocked(FUNCTION_NOT_HISTORICAL, { functionKind: kind, pending });
  }
  if (sameList(pending, [TARGET_MIGRATION])) {
    return {
      ok: true,
      authorised: true,
      alreadyApplied: false,
      verdict: AUTHORISED,
      pending,
      migrated: false,
      functionKind: kind,
      hotelSnapshot: facts?.hotelSnapshot ?? null,
      billingSnapshot: facts?.billingSnapshot ?? null,
    };
  }
  return blocked(UNEXPECTED_PLAN, { pending, functionKind: kind });
}

export function evaluate0024Aftermath(facts, beforeHotel, beforeBilling) {
  const identity = evaluateOwnerIdentity(facts);
  if (!identity.ok) return { ...identity, migrated: true };
  const failures = [];
  const ledger = [...(facts?.ledger ?? [])].map(String);
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  const kind = classifyBillingApplyFunction(facts?.functionDefinition);
  if (appliedCount !== 1) failures.push("0024-ledger");
  if (pending.length > 0) failures.push("pending-remain");
  if (kind !== "ordered") failures.push("function-not-ordered");
  if (Number(facts?.functionCount ?? 0) !== 1) failures.push("function-count");
  if (String(facts?.functionIdentity ?? "") !== EXPECTED_FUNCTION_IDENTITY) failures.push("function-identity");
  if (facts?.functionExecuteAetherApp !== true) failures.push("execute-grant");
  if (String(facts?.functionOwner ?? "") !== EXPECTED_OWNER) failures.push("function-owner");
  if (facts?.paymentFunctionPresent !== true) failures.push("payment-function");
  if (classifyEntitlementFunction(facts?.entitlementDefinition) !== "decoupled") {
    failures.push("entitlement-not-decoupled");
  }
  for (const name of REQUIRED_BILLING_COLUMNS) {
    if (!facts?.billingColumns?.includes(name)) failures.push(`column-${name}`);
  }
  for (const name of REQUIRED_EVENT_COLUMNS) {
    if (!facts?.eventColumns?.includes(name)) failures.push(`event-column-${name}`);
  }
  if (!authPresent(facts?.authTables)) failures.push("auth-tables");
  if (!authOwnersAreOwner(facts?.authTableOwners)) failures.push("auth-owners");
  if (facts?.schemaCreate === true) failures.push("schema-create");
  if (!roleIsSafe(facts?.aetherAppRole)) failures.push("role-escalation");
  if (!occupancyIntact(facts?.occupancy)) failures.push("occupancy");
  if (!hotelMatches(facts?.hotel)) failures.push("demo-kos");
  if (hotelSnapshotKey(facts?.hotelSnapshot) !== hotelSnapshotKey(beforeHotel)) {
    failures.push("hotel-invariance");
  }
  if (billingSnapshotKey(facts?.billingSnapshot) !== billingSnapshotKey(beforeBilling)) {
    failures.push("billing-invariance");
  }
  if (failures.length) {
    return { ok: false, verdict: POST_BLOCKED, failures, pending, migrated: true, functionKind: kind };
  }
  return { ok: true, verdict: APPLIED_VERIFIED, pending: [], migrated: true, functionKind: kind };
}

export async function applyExact0024({ name, sql, execute }) {
  const gate = assertAuthorisedMigrationName(name);
  if (!gate.ok) {
    const err = new Error(gate.verdict);
    err.verdict = gate.verdict;
    throw err;
  }
  if (typeof execute !== "function") {
    throw new Error("BLOCKED — 0024 EXECUTOR MISSING");
  }
  return execute(sql);
}

export async function runSingleUse0024({
  env,
  confirmation,
  file,
  sourceChecksums,
  loadFacts,
  applyMigration,
}) {
  const ownerUrl = ownerUrlFromEnv(env);
  const confirm = assertConfirmation(confirmation);
  if (!confirm.ok) return confirm;
  if (!ownerUrl) return blocked(BLOCKED_OWNER_URL);
  const fileGate = assertMigrationFile(file);
  if (!fileGate.ok) return fileGate;
  if (sourceChecksums) {
    const checksums = assertReviewedChecksums(sourceChecksums);
    if (!checksums.ok) return checksums;
  }

  const before = await loadFacts();
  const baseline = evaluate0024Baseline({ ...before, confirmation, env, ownerUrl }, file);
  if (!baseline.ok || baseline.alreadyApplied) {
    return { ...baseline, preflight: before, migrated: false };
  }

  let applyError = null;
  try {
    await applyExact0024({
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
  const aftermath = evaluate0024Aftermath(after, before.hotelSnapshot, before.billingSnapshot);
  if (!aftermath.ok) {
    return { ...aftermath, preflight: before, postflight: after };
  }
  return {
    ...aftermath,
    preflight: before,
    postflight: after,
  };
}

function say(line) {
  console.log(line);
}

function fail(verdict, extra = "") {
  say(verdict);
  if (extra) say(redact(extra));
  process.exitCode = 1;
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
  say(`billing.function.kind: ${classifyBillingApplyFunction(facts?.functionDefinition)}`);
  say(`billing.function.identity: ${facts?.functionIdentity ?? "UNKNOWN"}`);
  say(`billing.function.count: ${facts?.functionCount ?? "UNKNOWN"}`);
  say(`hotels.total: ${facts?.hotelSnapshot?.hotelCount ?? "UNKNOWN"}`);
  say(`billing.accounts: ${facts?.billingSnapshot?.accountCount ?? "UNKNOWN"}`);
  say(`stripe.events: ${facts?.billingSnapshot?.eventCount ?? "UNKNOWN"}`);
}

export async function inspect0024State(client, sourceMigrations) {
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

  const schemaCreate =
    (
      await client.query("select has_schema_privilege($1, 'public', 'CREATE') as ok", [
        EXPECTED_RUNTIME,
      ])
    ).rows[0]?.ok === true;

  const fnRows = (
    await client.query(
      `select p.oid,
              pg_get_functiondef(p.oid) as definition,
              pg_get_function_identity_arguments(p.oid) as identity,
              r.rolname as owner
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_roles r on r.oid = p.proowner
        where n.nspname = 'public'
          and p.proname = 'sbg_apply_billing_event'`,
    )
  ).rows;

  let functionDefinition = null;
  let functionOwner = null;
  let functionIdentity = null;
  let functionExecuteAetherApp = false;
  if (fnRows.length === 1) {
    functionDefinition = fnRows[0].definition;
    functionOwner = fnRows[0].owner;
    functionIdentity = fnRows[0].identity;
    functionExecuteAetherApp =
      (
        await client.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [
          EXPECTED_RUNTIME,
          fnRows[0].oid,
        ])
      ).rows[0]?.ok === true;
  }

  const entitlement = (
    await client.query(
      `select pg_get_functiondef(p.oid) as definition
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'sbg_sync_hotel_entitlement'
          and p.pronargs = 1`,
    )
  ).rows[0];

  const payment = (
    await client.query(
      `select exists(
          select 1 from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname = 'sbg_apply_payment_event'
        ) as ok`,
    )
  ).rows[0];

  const billingColumns = (
    await client.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'sbg_billing_accounts'
        order by column_name`,
    )
  ).rows.map((row) => row.column_name);
  const eventColumns = (
    await client.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'sbg_stripe_events'
        order by column_name`,
    )
  ).rows.map((row) => row.column_name);

  const hotelCount = Number(
    (await client.query("select count(*)::int as n from hotels")).rows[0]?.n ?? 0,
  );
  const statusRows = (
    await client.query("select status, count(*)::int as n from hotels group by status order by status")
  ).rows;
  const demoKos = (
    await client.query("select id::text as id, code, status from hotels where code = 'demo-kos'")
  ).rows[0];
  const liveHotels = (
    await client.query(
      `select id::text as id, code, status
         from hotels
        where status = 'live'
        order by code, id`,
    )
  ).rows;

  const accountCount = Number(
    (await client.query("select count(*)::int as n from sbg_billing_accounts")).rows[0]?.n ?? 0,
  );
  const billingStatusRows = (
    await client.query(
      "select status, count(*)::int as n from sbg_billing_accounts group by status order by status",
    )
  ).rows;
  const eventCount = Number(
    (await client.query("select count(*)::int as n from sbg_stripe_events")).rows[0]?.n ?? 0,
  );
  const billingStatusCounts = {};
  for (const row of billingStatusRows) billingStatusCounts[String(row.status)] = Number(row.n);

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
    functionDefinition,
    functionOwner,
    functionIdentity,
    functionCount: fnRows.length,
    functionExecuteAetherApp,
    entitlementDefinition: entitlement?.definition ?? "",
    paymentFunctionPresent: payment?.ok === true,
    billingColumns,
    eventColumns,
    hotelSnapshot: buildHotelSnapshot({
      hotelCount,
      statusRows,
      demoKos,
      liveHotels,
    }),
    billingSnapshot: {
      accountCount,
      statusCounts: billingStatusCounts,
      eventCount,
    },
  };
}

async function loadSourceMigrations(rootDir) {
  const entries = await readdir(join(rootDir, "migrations"));
  return entries.filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
}

async function loadReviewedChecksums(rootDir) {
  const checksums = {};
  for (const name of Object.keys(REVIEWED_DIGESTS)) {
    const bytes = await readFile(join(rootDir, "migrations", name));
    checksums[name] = sha256(bytes);
  }
  return checksums;
}

async function inspectWithOwner(ownerUrl, sourceMigrations) {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN READ ONLY");
    began = true;
    return await inspect0024State(client, sourceMigrations);
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

async function apply0024OnOwner(ownerUrl, sql) {
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
  const confirmation = process.env.CP26B2_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  const dispatched = String(process.env.GITHUB_SHA ?? "").trim();
  if (dispatched) say(`dispatched sha: ${dispatched}`);
  say("note: migration file digest is authoritative; do not dispatch until CP26B.3");

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
  const sourceChecksums = await loadReviewedChecksums(rootDir);
  const checksumGate = assertReviewedChecksums(sourceChecksums);
  if (!checksumGate.ok) {
    say(`checksum name: ${checksumGate.name}`);
    say(`checksum digest: ${checksumGate.digest}`);
    fail(checksumGate.verdict);
    return;
  }
  for (const [name, digest] of Object.entries(sourceChecksums)) {
    say(`${name} digest: ${digest}`);
  }

  const migrationPath = join(rootDir, "migrations", TARGET_MIGRATION);
  const bytes = await readFile(migrationPath);
  const file = {
    name: TARGET_MIGRATION,
    bytes,
    digest: sha256(bytes),
    sql: bytes.toString("utf8"),
  };
  say(`0024 digest: ${file.digest}`);

  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUse0024({
    env: process.env,
    confirmation,
    file,
    sourceChecksums,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    applyMigration: (sql) => apply0024OnOwner(ownerUrl, sql),
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
