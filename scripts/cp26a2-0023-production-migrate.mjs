#!/usr/bin/env node
/**
 * CP26A.2B-GHA — single-use production controller for 0023 only.
 *
 * Applies migrations/0023_cp26a2_entitlement_publication_decoupling.sql
 * and nothing else. Never uses DATABASE_URL. Never prints secrets.
 * Never deploys. Does not invoke the generic production migrator.
 * Does not reactivate the 0022 controller.
 *
 * The migration file is pinned by SHA-256 to the reviewed source
 * commit 71cc457df26a91f111357ca2e091e2af0dc3cf14. The controller
 * commit may differ; the file digest is authoritative.
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

export const TARGET_MIGRATION = "0023_cp26a2_entitlement_publication_decoupling.sql";
export const TARGET_DIGEST =
  "469eeee3c8707beb40a2a268bea53c77620265efb969bfbff12c524e17585ba1";
export const REVIEWED_MIGRATION_SOURCE_SHA = "71cc457df26a91f111357ca2e091e2af0dc3cf14";
export const REQUIRED_CONFIRMATION = "APPLY-0023";
export const AETHER_RUNTIME_ROLE = "aether_runtime";

export const REVIEWED_DIGESTS = {
  "0020_cp24_stripe_billing.sql":
    "e554f58f72ebe71a7048786b16890aaa4e125642f314407d49ab863ac8365e0c",
  "0021_cp25_hotel_guest_payments.sql":
    "b51166aab2016c2223cfe2e495d0e72e6677bfd216bfe029f1064ae18ae1e86a",
  "0022_cp25g3_better_auth_runtime_privileges.sql":
    "bf2563cbc13f773d0ec75865745ce1b6b6aa87ce7846fc8961c53beda77bccc3",
  "0023_cp26a2_entitlement_publication_decoupling.sql": TARGET_DIGEST,
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
];

export const AUTH_TABLES = ["user", "session", "account", "verification"];
export const OCCUPANCY = ["bookings_driver_occupancy_excl", "bookings_vehicle_occupancy_excl"];
export const MISSING_HOTEL_UUID = "00000000-0000-0000-0000-000000000000";

export const AUTHORISED = "GATE PASS — 0023 AUTHORISED";
export const ALREADY_APPLIED = "0023 ALREADY APPLIED — NO MUTATION";
export const APPLIED_VERIFIED = "GATE PASS — 0023 APPLIED AND VERIFIED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const DIGEST_BLOCKED = "BLOCKED — 0023 DIGEST MISMATCH";
export const REVIEWED_DIGEST_BLOCKED = "BLOCKED — REVIEWED MIGRATION DIGEST MISMATCH";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const IDENTITY_BLOCKED = "BLOCKED — DATABASE IDENTITY MISMATCH";
export const OWNER_BLOCKED = "BLOCKED — OWNER IDENTITY MISMATCH";
export const ROLE_BLOCKED = "BLOCKED — AETHER_APP ROLE ESCALATED";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const APPLY_FAILED = "BLOCKED — 0023 APPLICATION FAILED";
export const UNAUTHORISED_MIGRATION = "BLOCKED — UNAUTHORISED MIGRATION";
export const FUNCTION_NOT_COUPLED = "BLOCKED — INSTALLED FUNCTION NOT HISTORICAL 0020 COUPLING";
export const FUNCTION_LEDGER_SPLIT = "BLOCKED — 0023 LEDGER APPLIED BUT FUNCTION NOT DECOUPLED";
export const ENTITLEMENT_PROOF_FAILED = "BLOCKED — ENTITLEMENT PROOF FAILED";
export const P0002_NOT_PROVEN = "BLOCKED — MISSING-HOTEL P0002 NOT PROVEN";

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

export function plpgsqlBody(definition) {
  const text = String(definition ?? "");
  const asFunction = text.match(/as\s+\$function\$(.*)\$function\$/is);
  if (asFunction) return asFunction[1];
  const asDollar = text.match(/as\s+\$\$(.*)\$\$/is);
  if (asDollar) return asDollar[1];
  return text;
}

export function classifyEntitlementFunction(definition) {
  const body = plpgsqlBody(definition);
  if (!body.trim()) return "missing";
  const updateHotels = /update\s+hotels/i.test(body);
  const billing = /sbg_billing_accounts/i.test(body);
  const connect = /sbg_stripe_connections/i.test(body);
  const catalogue =
    /hotel_services/i.test(body) ||
    /hotel_destinations/i.test(body) ||
    /hotel_provider_agreements/i.test(body);
  const assignsLive = /status\s*=\s*'live'/i.test(body);
  const assignsConfigured = /status\s*=\s*'configured'/i.test(body);
  const p0002 = /P0002/.test(body);
  const selectStatus = /select\s+status/i.test(body);
  const returnsCurrent = /return\s+v_current_status/i.test(body);

  const coupled = updateHotels && billing && connect && (assignsLive || assignsConfigured);
  const decoupled =
    !updateHotels &&
    !billing &&
    !connect &&
    !catalogue &&
    !assignsLive &&
    !assignsConfigured &&
    p0002 &&
    selectStatus &&
    returnsCurrent;

  if (coupled && !decoupled) return "coupled";
  if (decoupled && !coupled) return "decoupled";
  return "unexpected";
}

export function functionFlags(definition) {
  const body = plpgsqlBody(definition);
  return {
    kind: classifyEntitlementFunction(definition),
    updateHotels: /update\s+hotels/i.test(body),
    billing: /sbg_billing_accounts/i.test(body),
    connect: /sbg_stripe_connections/i.test(body),
    p0002: /P0002/.test(body),
    selectStatus: /select\s+status/i.test(body),
  };
}

export function buildHotelSnapshot({ hotelCount, statusRows, demoKos, liveHotels }) {
  const statusCounts = {};
  for (const row of statusRows ?? []) {
    if (row?.status == null) continue;
    statusCounts[String(row.status)] = Number(row.n);
  }
  return {
    hotelCount: Number(hotelCount ?? 0),
    statusCounts,
    demoKos: demoKos
      ? {
          id: String(demoKos.id),
          code: String(demoKos.code),
          status: String(demoKos.status),
        }
      : null,
    liveHotels: [...(liveHotels ?? [])].map((row) => ({
      id: String(row.id),
      code: String(row.code),
      status: String(row.status),
    })),
  };
}

export function hotelSnapshotKey(snapshot) {
  const statusCounts = Object.fromEntries(
    Object.entries(snapshot?.statusCounts ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  const live = [...(snapshot?.liveHotels ?? [])]
    .map((row) => `${row.id}:${row.code}:${row.status}`)
    .sort();
  return JSON.stringify({
    hotelCount: Number(snapshot?.hotelCount ?? -1),
    statusCounts,
    demoKos: snapshot?.demoKos
      ? {
          id: snapshot.demoKos.id,
          code: snapshot.demoKos.code,
          status: snapshot.demoKos.status,
        }
      : null,
    live,
  });
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

function blocked(verdict, extra = {}) {
  return { ok: false, verdict, migrated: false, ...extra };
}

export function evaluateOwnerIdentity(facts) {
  const currentUser = String(facts?.currentUser ?? "");
  const sessionUser = String(facts?.sessionUser ?? "");
  if (String(facts?.database ?? "") !== EXPECTED_DATABASE) {
    return blocked(IDENTITY_BLOCKED, { database: facts?.database });
  }
  if (currentUser === EXPECTED_RUNTIME || sessionUser === EXPECTED_RUNTIME) {
    return blocked(OWNER_BLOCKED, { currentUser, sessionUser });
  }
  if (currentUser === AETHER_RUNTIME_ROLE || sessionUser === AETHER_RUNTIME_ROLE) {
    return blocked(OWNER_BLOCKED, { currentUser, sessionUser });
  }
  if (currentUser !== EXPECTED_OWNER || sessionUser !== EXPECTED_OWNER) {
    return blocked(OWNER_BLOCKED, { currentUser, sessionUser });
  }
  return { ok: true };
}

export function evaluate0023Baseline(facts, file) {
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
  if (!facts?.hotelSnapshot?.demoKos?.id) {
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
  const kind = classifyEntitlementFunction(facts?.functionDefinition);

  if (appliedCount > 1) {
    return blocked("BLOCKED — 0023 LEDGER DUPLICATE", { pending, appliedCount });
  }
  if (appliedCount === 1) {
    if (pending.length === 0 && kind === "decoupled") {
      return {
        ok: true,
        alreadyApplied: true,
        verdict: ALREADY_APPLIED,
        pending: [],
        migrated: false,
        functionKind: kind,
      };
    }
    if (kind !== "decoupled") {
      return blocked(FUNCTION_LEDGER_SPLIT, { pending, functionKind: kind });
    }
    return blocked(UNEXPECTED_PLAN, { pending, alreadyApplied: true, functionKind: kind });
  }
  if (kind !== "coupled") {
    return blocked(FUNCTION_NOT_COUPLED, { functionKind: kind, pending });
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
    };
  }
  return blocked(UNEXPECTED_PLAN, { pending, functionKind: kind });
}

export function evaluate0023Aftermath(facts, beforeSnapshot) {
  const identity = evaluateOwnerIdentity(facts);
  if (!identity.ok) return { ...identity, migrated: true };
  const failures = [];
  const ledger = [...(facts?.ledger ?? [])].map(String);
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  const kind = classifyEntitlementFunction(facts?.functionDefinition);
  if (appliedCount !== 1) failures.push("0023-ledger");
  if (pending.length > 0) failures.push("pending-remain");
  if (kind !== "decoupled") failures.push("function-not-decoupled");
  if (facts?.functionExecuteAetherApp !== true) failures.push("execute-grant");
  if (String(facts?.functionOwner ?? "") !== EXPECTED_OWNER) failures.push("function-owner");
  if (!authPresent(facts?.authTables)) failures.push("auth-tables");
  if (!authOwnersAreOwner(facts?.authTableOwners)) failures.push("auth-owners");
  if (facts?.schemaCreate === true) failures.push("schema-create");
  if (!roleIsSafe(facts?.aetherAppRole)) failures.push("role-escalation");
  if (!occupancyIntact(facts?.occupancy)) failures.push("occupancy");
  if (!hotelMatches(facts?.hotel)) failures.push("demo-kos");
  if (facts?.hotelSnapshot?.demoKos?.code !== "demo-kos" || facts?.hotelSnapshot?.demoKos?.status !== "live") {
    failures.push("demo-kos-snapshot");
  }
  if (hotelSnapshotKey(facts?.hotelSnapshot) !== hotelSnapshotKey(beforeSnapshot)) {
    failures.push("hotel-invariance");
  }
  if (failures.length) {
    return { ok: false, verdict: POST_BLOCKED, failures, pending, migrated: true, functionKind: kind };
  }
  return { ok: true, verdict: APPLIED_VERIFIED, pending: [], migrated: true, functionKind: kind };
}

export function evaluateEntitlementProof(proof) {
  const before = String(proof?.beforeStatus ?? "");
  const returned = String(proof?.returnedStatus ?? "");
  const after = String(proof?.afterStatus ?? "");
  if (!before || before !== returned || returned !== after) {
    return { ok: false, verdict: ENTITLEMENT_PROOF_FAILED, migrated: true };
  }
  if (!(proof?.missingHotel?.raised === true && proof?.missingHotel?.code === "P0002")) {
    return { ok: false, verdict: P0002_NOT_PROVEN, migrated: true };
  }
  return { ok: true };
}

export async function applyExact0023({ name, sql, execute }) {
  const gate = assertAuthorisedMigrationName(name);
  if (!gate.ok) {
    const err = new Error(gate.verdict);
    err.verdict = gate.verdict;
    throw err;
  }
  if (typeof execute !== "function") {
    throw new Error("BLOCKED — 0023 EXECUTOR MISSING");
  }
  return execute(sql);
}

export async function runSingleUse0023({
  env,
  confirmation,
  file,
  sourceChecksums,
  loadFacts,
  applyMigration,
  proveEntitlement,
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
  const baseline = evaluate0023Baseline(
    { ...before, confirmation, env, ownerUrl },
    file,
  );
  if (!baseline.ok || baseline.alreadyApplied) {
    return { ...baseline, preflight: before, migrated: false };
  }

  let applyError = null;
  try {
    await applyExact0023({
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
  const aftermath = evaluate0023Aftermath(after, before.hotelSnapshot);
  if (!aftermath.ok) {
    return { ...aftermath, preflight: before, postflight: after };
  }
  if (typeof proveEntitlement !== "function") {
    return {
      ok: false,
      verdict: POST_BLOCKED,
      failures: ["entitlement-proof-executor"],
      migrated: true,
      preflight: before,
      postflight: after,
    };
  }
  const proof = await proveEntitlement({
    demoKosId: after.hotelSnapshot?.demoKos?.id,
    expectedStatus: after.hotelSnapshot?.demoKos?.status,
  });
  const proofGate = evaluateEntitlementProof(proof);
  if (!proofGate.ok) {
    return { ...proofGate, preflight: before, postflight: after, entitlementProof: proof };
  }
  return {
    ...aftermath,
    preflight: before,
    postflight: after,
    entitlementProof: proof,
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
  say(`hotels owner: ${facts?.tableOwners?.hotels ?? "UNKNOWN"}`);
  const flags = functionFlags(facts?.functionDefinition);
  say(`function.kind: ${flags.kind}`);
  say(`function.update_hotels: ${flags.updateHotels}`);
  say(`function.billing: ${flags.billing}`);
  say(`function.connect: ${flags.connect}`);
  say(`function.p0002: ${flags.p0002}`);
  say(`function.owner: ${facts?.functionOwner ?? "UNKNOWN"}`);
  say(`function.execute.aether_app: ${facts?.functionExecuteAetherApp === true ? "true" : "false"}`);
  const snapshot = facts?.hotelSnapshot;
  say(`hotels.total: ${snapshot?.hotelCount ?? "UNKNOWN"}`);
  const statuses = Object.keys(snapshot?.statusCounts ?? {}).sort();
  if (statuses.length) {
    for (const status of statuses) say(`hotels.status.${status}: ${snapshot.statusCounts[status]}`);
  } else {
    say("hotels.status: (none)");
  }
  if (snapshot?.demoKos) {
    say("demo-kos:");
    say(`  id: ${snapshot.demoKos.id}`);
    say(`  code: ${snapshot.demoKos.code}`);
    say(`  status: ${snapshot.demoKos.status}`);
  } else {
    say("demo-kos: ABSENT");
  }
  say(`live.hotels: ${(snapshot?.liveHotels ?? []).length}`);
  for (const row of snapshot?.liveHotels ?? []) {
    say(`  ${row.code} ${row.status}`);
  }
  if (facts?.hotel) {
    say(`demo-kos.provider_count: ${facts.hotel.providerCount}`);
    say(`demo-kos.destination_count: ${facts.hotel.destinationCount}`);
  }
}

export async function inspect0023State(client, sourceMigrations) {
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
              r.rolname as owner
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_roles r on r.oid = p.proowner
        where n.nspname = 'public'
          and p.proname = 'sbg_sync_hotel_entitlement'
          and p.pronargs = 1
          and pg_catalog.format_type(p.proargtypes[0], null) = 'uuid'`,
    )
  ).rows;

  let functionDefinition = null;
  let functionOwner = null;
  let functionExecuteAetherApp = false;
  if (fnRows.length === 1) {
    functionDefinition = fnRows[0].definition;
    functionOwner = fnRows[0].owner;
    functionExecuteAetherApp =
      (
        await client.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [
          EXPECTED_RUNTIME,
          fnRows[0].oid,
        ])
      ).rows[0]?.ok === true;
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
  const liveHotels = (
    await client.query(
      `select id::text as id, code, status
         from hotels
        where status = 'live'
        order by code, id`,
    )
  ).rows;

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
    functionExecuteAetherApp,
    hotelSnapshot: buildHotelSnapshot({
      hotelCount,
      statusRows,
      demoKos,
      liveHotels,
    }),
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
    return await inspect0023State(client, sourceMigrations);
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

async function apply0023OnOwner(ownerUrl, sql) {
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

async function proveEntitlementOnOwner(ownerUrl, { demoKosId }) {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  try {
    const before = (await client.query("select status from hotels where id = $1::uuid", [demoKosId]))
      .rows[0]?.status;
    const returned = (
      await client.query("select sbg_sync_hotel_entitlement($1::uuid) as status", [demoKosId])
    ).rows[0]?.status;
    const after = (await client.query("select status from hotels where id = $1::uuid", [demoKosId]))
      .rows[0]?.status;
    let missingHotel = { raised: false, code: null };
    try {
      await client.query("select sbg_sync_hotel_entitlement($1::uuid)", [MISSING_HOTEL_UUID]);
    } catch (err) {
      missingHotel = { raised: true, code: err?.code ?? null };
    }
    return {
      beforeStatus: before,
      returnedStatus: returned,
      afterStatus: after,
      missingHotel,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const ownerUrl = ownerUrlFromEnv(process.env);
  const confirmation = process.env.CP26A2_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  const dispatched = String(process.env.GITHUB_SHA ?? "").trim();
  if (dispatched) say(`dispatched sha: ${dispatched}`);
  say(`reviewed migration source sha: ${REVIEWED_MIGRATION_SOURCE_SHA}`);
  say("note: controller commit may differ; migration file digest is authoritative");

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
  say(`0023 digest: ${file.digest}`);

  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUse0023({
    env: process.env,
    confirmation,
    file,
    sourceChecksums,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    applyMigration: (sql) => apply0023OnOwner(ownerUrl, sql),
    proveEntitlement: (args) => proveEntitlementOnOwner(ownerUrl, args),
  });
  if (result.preflight) reportFacts("pre-migration:", result.preflight);
  if (result.failures?.length) {
    say("gate failures:");
    for (const name of result.failures) say(`  ${name}`);
  }
  if (result.postflight) reportFacts("post-migration:", result.postflight);
  if (result.entitlementProof) {
    say("entitlement proof:");
    say(`  before: ${result.entitlementProof.beforeStatus ?? ""}`);
    say(`  returned: ${result.entitlementProof.returnedStatus ?? ""}`);
    say(`  after: ${result.entitlementProof.afterStatus ?? ""}`);
    say(
      `  missing_hotel_p0002: ${
        result.entitlementProof.missingHotel?.raised === true &&
        result.entitlementProof.missingHotel?.code === "P0002"
          ? "true"
          : "false"
      }`,
    );
  }
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
