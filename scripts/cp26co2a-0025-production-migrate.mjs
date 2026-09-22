#!/usr/bin/env node
/**
 * CP26C-O2A — single-use production controller for 0025 only.
 *
 * Applies migrations/0025_cp26co2_platform_owners.sql and nothing else.
 * Never uses DATABASE_URL. Never prints secrets. Never deploys.
 * Does not invoke the generic production migrator.
 * Does not bootstrap a platform Owner. Schema only.
 *
 * Dispatch of this workflow is a later authorised checkpoint.
 * This commit is BUILD ONLY — not authorization to execute.
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
  AETHER_RUNTIME_ROLE,
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  buildHotelSnapshot,
  evaluateOwnerIdentity,
  hotelSnapshotKey,
  roleIsSafe,
} from "./cp26a2-0023-production-migrate.mjs";
import { billingSnapshotKey } from "./cp26b2-0024-production-migrate.mjs";

export { IDENTITY_BLOCKED, OWNER_BLOCKED, EXPECTED_DATABASE, EXPECTED_OWNER, EXPECTED_RUNTIME };

export const TARGET_MIGRATION = "0025_cp26co2_platform_owners.sql";
export const TARGET_DIGEST =
  "575aabcb7322fc8ca63c8a3dd137d358f76375f1777ed59cf04c1d98d6c066fd";
export const REQUIRED_CONFIRMATION = "APPLY-0025";

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
  "0025_cp26co2_platform_owners.sql": TARGET_DIGEST,
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
  "0024_cp26b2_ordered_billing_events.sql",
];

export const OWNER_TABLES = ["sbg_platform_owners", "sbg_owner_audit_events"];
export const OWNER_FUNCTION_NAMES = [
  "sbg_bootstrap_platform_owner",
  "sbg_grant_platform_owner",
  "sbg_revoke_platform_owner",
];

export const EXPECTED_FUNCTIONS = [
  {
    name: "sbg_bootstrap_platform_owner",
    nargs: 2,
    argTypes: ["text", "text"],
    argNames: ["p_user_id", "p_note"],
    returnType: "void",
    securityDefiner: true,
    searchPath: "public, pg_temp",
    executeAetherApp: false,
    executePublic: false,
  },
  {
    name: "sbg_grant_platform_owner",
    nargs: 3,
    argTypes: ["text", "text", "text"],
    argNames: ["p_actor_user_id", "p_user_id", "p_note"],
    returnType: "void",
    securityDefiner: true,
    searchPath: "public, pg_temp",
    executeAetherApp: true,
    executePublic: false,
  },
  {
    name: "sbg_revoke_platform_owner",
    nargs: 3,
    argTypes: ["text", "text", "text"],
    argNames: ["p_actor_user_id", "p_user_id", "p_note"],
    returnType: "void",
    securityDefiner: true,
    searchPath: "public, pg_temp",
    executeAetherApp: true,
    executePublic: false,
  },
];

export const AUTHORISED = "GATE PASS — 0025 AUTHORISED";
export const ALREADY_APPLIED = "0025 ALREADY APPLIED — NO MUTATION";
export const APPLIED_VERIFIED = "GATE PASS — 0025 APPLIED AND VERIFIED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const DIGEST_BLOCKED = "BLOCKED — 0025 DIGEST MISMATCH";
export const REVIEWED_DIGEST_BLOCKED = "BLOCKED — REVIEWED MIGRATION DIGEST MISMATCH";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const APPLY_FAILED = "BLOCKED — 0025 APPLICATION FAILED";
export const UNAUTHORISED_MIGRATION = "BLOCKED — UNAUTHORISED MIGRATION";
export const PARTIAL_BLOCKED = "BLOCKED — 0025 PARTIAL / LEDGER SPLIT";
export const CONTRACT_INVALID = "BLOCKED — 0025 INSTALLED CONTRACT INVALID";
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

export function normalizePgType(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^pg_catalog\./, "");
  if (raw === "timestamptz") return "timestamp with time zone";
  if (raw === "bool") return "boolean";
  if (raw === "int8") return "bigint";
  return raw;
}

export function normalizeSearchPath(value) {
  return String(value ?? "")
    .replace(/^search_path=/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

function tableState(schema, name) {
  return schema?.tables?.[name] ?? {
    present: false,
    owner: null,
    selectApp: false,
    insertApp: false,
    updateApp: false,
    deleteApp: false,
    truncateApp: false,
  };
}

function functionState(schema, name) {
  return schema?.functions?.[name] ?? {
    count: 0,
    nargs: null,
    argTypes: [],
    argNames: [],
    returnType: null,
    owner: null,
    securityDefiner: false,
    searchPath: "",
    executeAetherApp: false,
    executePublic: false,
  };
}

export function ownerSchemaPresentNames(schema) {
  const present = [];
  for (const name of OWNER_TABLES) {
    if (tableState(schema, name).present) present.push(name);
  }
  for (const name of OWNER_FUNCTION_NAMES) {
    if (Number(functionState(schema, name).count ?? 0) > 0) present.push(name);
  }
  return present;
}

export function verifyHotelKey(hotel) {
  if (!hotel) return JSON.stringify(null);
  return JSON.stringify({
    code: String(hotel.code ?? ""),
    status: String(hotel.status ?? ""),
  });
}

export function ownerFunctionContractFailures(fn, expected) {
  const failures = [];
  const prefix = expected.name;
  if (Number(fn?.count ?? 0) !== 1) failures.push(`${prefix}-count`);
  const nargs = Number(fn?.nargs ?? -1);
  if (nargs !== expected.nargs) failures.push(`${prefix}-nargs`);
  const types = [...(fn?.argTypes ?? [])].map(normalizePgType);
  if (
    types.length !== expected.nargs ||
    expected.argTypes.some((want, index) => types[index] !== want)
  ) {
    failures.push(`${prefix}-arg-types`);
  }
  const names = Array.isArray(fn?.argNames) ? fn.argNames.map((name) => String(name ?? "")) : [];
  if (names.length > 0) {
    if (
      names.length !== expected.nargs ||
      expected.argNames.some((want, index) => names[index] !== want)
    ) {
      failures.push(`${prefix}-arg-names`);
    }
  }
  if (normalizePgType(fn?.returnType) !== expected.returnType) {
    failures.push(`${prefix}-return-type`);
  }
  if (String(fn?.owner ?? "") !== EXPECTED_OWNER) failures.push(`${prefix}-owner`);
  if (fn?.securityDefiner !== true) failures.push(`${prefix}-security-definer`);
  if (normalizeSearchPath(fn?.searchPath) !== normalizeSearchPath(expected.searchPath)) {
    failures.push(`${prefix}-search-path`);
  }
  if (Boolean(fn?.executeAetherApp) !== expected.executeAetherApp) {
    failures.push(`${prefix}-execute-app`);
  }
  if (fn?.executePublic !== false) failures.push(`${prefix}-execute-public`);
  return failures;
}

export function ownerTableContractFailures(table, name) {
  const failures = [];
  if (table?.present !== true) failures.push(`${name}-missing`);
  if (String(table?.owner ?? "") !== EXPECTED_OWNER) failures.push(`${name}-owner`);
  if (table?.selectApp !== true) failures.push(`${name}-select`);
  if (table?.insertApp !== false) failures.push(`${name}-insert`);
  if (table?.updateApp !== false) failures.push(`${name}-update`);
  if (table?.deleteApp !== false) failures.push(`${name}-delete`);
  if (table?.truncateApp !== false) failures.push(`${name}-truncate`);
  return failures;
}

export function ownerInstalledContractFailures(facts, { requireZeroGrants = false } = {}) {
  const failures = [];
  const schema = facts?.ownerSchema ?? {};
  for (const name of OWNER_TABLES) {
    failures.push(...ownerTableContractFailures(tableState(schema, name), name));
  }
  for (const expected of EXPECTED_FUNCTIONS) {
    failures.push(...ownerFunctionContractFailures(functionState(schema, expected.name), expected));
  }
  if (schema.stripeEventsSelectApp !== true) failures.push("stripe-events-select");
  if (requireZeroGrants && Number(schema.grantCount ?? -1) !== 0) {
    failures.push("owner-grant-created");
  }
  return failures;
}

export function evaluate0025Baseline(facts, file) {
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
  const present = ownerSchemaPresentNames(facts?.ownerSchema);

  if (appliedCount > 1) {
    return blocked("BLOCKED — 0025 LEDGER DUPLICATE", { pending, appliedCount });
  }
  if (appliedCount === 1) {
    if (pending.length === 0) {
      const contract = ownerInstalledContractFailures(facts);
      if (contract.length) {
        return blocked(CONTRACT_INVALID, { pending: [], failures: contract });
      }
      return {
        ok: true,
        alreadyApplied: true,
        verdict: ALREADY_APPLIED,
        pending: [],
        migrated: false,
      };
    }
    return blocked(UNEXPECTED_PLAN, { pending, alreadyApplied: true });
  }
  if (present.length) {
    return blocked(PARTIAL_BLOCKED, { pending, present });
  }
  if (sameList(pending, [TARGET_MIGRATION])) {
    return {
      ok: true,
      authorised: true,
      alreadyApplied: false,
      verdict: AUTHORISED,
      pending,
      migrated: false,
      hotelSnapshot: facts?.hotelSnapshot ?? null,
      billingSnapshot: facts?.billingSnapshot ?? null,
      verifyHotel: facts?.verifyHotel ?? null,
    };
  }
  return blocked(UNEXPECTED_PLAN, { pending });
}

export function evaluate0025Aftermath(facts, beforeHotel, beforeBilling, beforeVerify) {
  const identity = evaluateOwnerIdentity(facts);
  if (!identity.ok) return { ...identity, migrated: true };
  const failures = [];
  const ledger = [...(facts?.ledger ?? [])].map(String);
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  if (appliedCount !== 1) failures.push("0025-ledger");
  if (pending.length > 0) failures.push("pending-remain");
  for (const failure of ownerInstalledContractFailures(facts, { requireZeroGrants: true })) {
    if (!failures.includes(failure)) failures.push(failure);
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
  if (verifyHotelKey(facts?.verifyHotel) !== verifyHotelKey(beforeVerify)) {
    failures.push("verify-hotel-invariance");
  }
  if (failures.length) {
    return { ok: false, verdict: POST_BLOCKED, failures, pending, migrated: true };
  }
  return { ok: true, verdict: APPLIED_VERIFIED, pending: [], migrated: true };
}

export async function applyExact0025({ name, sql, execute }) {
  const gate = assertAuthorisedMigrationName(name);
  if (!gate.ok) {
    const err = new Error(gate.verdict);
    err.verdict = gate.verdict;
    throw err;
  }
  if (typeof execute !== "function") {
    throw new Error("BLOCKED — 0025 EXECUTOR MISSING");
  }
  return execute(sql);
}

export async function runSingleUse0025({
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
  const baseline = evaluate0025Baseline({ ...before, confirmation, env, ownerUrl }, file);
  if (!baseline.ok || baseline.alreadyApplied) {
    return { ...baseline, preflight: before, migrated: false };
  }

  let applyError = null;
  try {
    await applyExact0025({
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
  const aftermath = evaluate0025Aftermath(
    after,
    before.hotelSnapshot,
    before.billingSnapshot,
    before.verifyHotel,
  );
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
  say(`owner.schema.present: ${ownerSchemaPresentNames(facts?.ownerSchema).join(",") || "(none)"}`);
  say(`owner.grants: ${facts?.ownerSchema?.grantCount ?? "UNKNOWN"}`);
  say(`hotels.total: ${facts?.hotelSnapshot?.hotelCount ?? "UNKNOWN"}`);
  say(`demo-kos.status: ${facts?.hotelSnapshot?.demoKos?.status ?? "UNKNOWN"}`);
  say(`verify-a5.status: ${facts?.verifyHotel?.status ?? "ABSENT"}`);
  say(`billing.accounts: ${facts?.billingSnapshot?.accountCount ?? "UNKNOWN"}`);
  say(`stripe.events: ${facts?.billingSnapshot?.eventCount ?? "UNKNOWN"}`);
}

async function inspectTable(client, name) {
  const found = (
    await client.query(
      `select r.rolname as owner
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r on r.oid = c.relowner
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname = $1`,
      [name],
    )
  ).rows[0];
  if (!found) {
    return {
      present: false,
      owner: null,
      selectApp: false,
      insertApp: false,
      updateApp: false,
      deleteApp: false,
      truncateApp: false,
    };
  }
  const priv = async (who, privilege) =>
    (
      await client.query("select has_table_privilege($1, $2::regclass, $3) as ok", [
        who,
        `public.${name}`,
        privilege,
      ])
    ).rows[0]?.ok === true;
  return {
    present: true,
    owner: found.owner,
    selectApp: await priv(EXPECTED_RUNTIME, "SELECT"),
    insertApp: await priv(EXPECTED_RUNTIME, "INSERT"),
    updateApp: await priv(EXPECTED_RUNTIME, "UPDATE"),
    deleteApp: await priv(EXPECTED_RUNTIME, "DELETE"),
    truncateApp: await priv(EXPECTED_RUNTIME, "TRUNCATE"),
  };
}

async function inspectFunctions(client) {
  const rows = (
    await client.query(
      `select p.oid,
              p.proname as name,
              p.pronargs as nargs,
              p.proargnames as arg_names,
              p.prorettype::regtype::text as return_type,
              p.prosecdef as security_definer,
              p.proconfig as config,
              r.rolname as owner,
              (select coalesce(array_agg(format_type(u.t, null) order by u.ord), '{}'::text[])
                 from unnest(p.proargtypes) with ordinality as u(t, ord)
              ) as arg_types
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_roles r on r.oid = p.proowner
        where n.nspname = 'public'
          and p.proname = any($1::text[])`,
      [OWNER_FUNCTION_NAMES],
    )
  ).rows;

  const grouped = Object.fromEntries(
    OWNER_FUNCTION_NAMES.map((name) => [
      name,
      {
        count: 0,
        nargs: null,
        argTypes: [],
        argNames: [],
        returnType: null,
        owner: null,
        securityDefiner: false,
        searchPath: "",
        executeAetherApp: false,
        executePublic: false,
      },
    ]),
  );

  for (const row of rows) {
    const name = String(row.name);
    const current = grouped[name];
    if (!current) continue;
    current.count += 1;
    if (current.count !== 1) continue;
    current.nargs = Number(row.nargs ?? 0);
    current.argNames = Array.isArray(row.arg_names) ? row.arg_names : [];
    current.argTypes = Array.isArray(row.arg_types) ? row.arg_types : [];
    current.returnType = row.return_type ?? "";
    current.owner = row.owner;
    current.securityDefiner = row.security_definer === true;
    const config = Array.isArray(row.config) ? row.config : [];
    const search = config.find((item) => /^search_path=/i.test(String(item ?? "")));
    current.searchPath = normalizeSearchPath(search ?? "");
    current.executeAetherApp =
      (
        await client.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [
          EXPECTED_RUNTIME,
          row.oid,
        ])
      ).rows[0]?.ok === true;
    current.executePublic =
      (
        await client.query("select has_function_privilege('public', $1::oid, 'EXECUTE') as ok", [
          row.oid,
        ])
      ).rows[0]?.ok === true;
  }
  return grouped;
}

export async function inspect0025State(client, sourceMigrations) {
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

  const tables = {};
  for (const name of OWNER_TABLES) {
    tables[name] = await inspectTable(client, name);
  }
  const functions = await inspectFunctions(client);

  let stripeEventsSelectApp = false;
  const stripeEventsExists =
    (
      await client.query(
        `select exists(
            select 1 from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public'
               and c.relkind = 'r'
               and c.relname = 'sbg_stripe_events'
          ) as ok`,
      )
    ).rows[0]?.ok === true;
  if (stripeEventsExists) {
    stripeEventsSelectApp =
      (
        await client.query("select has_table_privilege($1, 'sbg_stripe_events'::regclass, 'SELECT') as ok", [
          EXPECTED_RUNTIME,
        ])
      ).rows[0]?.ok === true;
  }

  let grantCount = 0;
  let auditCount = 0;
  if (tables.sbg_platform_owners.present) {
    grantCount = Number(
      (await client.query("select count(*)::int as n from sbg_platform_owners")).rows[0]?.n ?? 0,
    );
  }
  if (tables.sbg_owner_audit_events.present) {
    auditCount = Number(
      (await client.query("select count(*)::int as n from sbg_owner_audit_events")).rows[0]?.n ?? 0,
    );
  }

  const hotelCount = Number(
    (await client.query("select count(*)::int as n from hotels")).rows[0]?.n ?? 0,
  );
  const statusRows = (
    await client.query("select status, count(*)::int as n from hotels group by status order by status")
  ).rows;
  const demoKos = (
    await client.query("select id::text as id, code, status from hotels where code = 'demo-kos'")
  ).rows[0];
  const verifyHotelRow = (
    await client.query("select id::text as id, code, status from hotels where code = 'sbg-verify-a5'")
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
    ownerSchema: {
      tables,
      functions,
      stripeEventsSelectApp,
      grantCount,
      auditCount,
    },
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
    verifyHotel: verifyHotelRow
      ? { code: String(verifyHotelRow.code), status: String(verifyHotelRow.status) }
      : null,
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
    return await inspect0025State(client, sourceMigrations);
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

async function apply0025OnOwner(ownerUrl, sql) {
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
  const confirmation = process.env.CP26CO2A_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  const dispatched = String(process.env.GITHUB_SHA ?? "").trim();
  if (dispatched) say(`dispatched sha: ${dispatched}`);
  say("note: this controller is build-complete; dispatch is a later authorised checkpoint");
  say("note: schema only — this controller does not grant a platform Owner");

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
  say(`0025 digest: ${file.digest}`);

  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUse0025({
    env: process.env,
    confirmation,
    file,
    sourceChecksums,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    applyMigration: (sql) => apply0025OnOwner(ownerUrl, sql),
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
