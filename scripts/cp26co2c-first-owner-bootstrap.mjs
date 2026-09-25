#!/usr/bin/env node
/**
 * CP26C-O2C.1 — single-use first Production platform Owner bootstrap.
 *
 * Discovers the Better Auth user who owns hotel code sbg-verify-a5 and
 * calls sbg_bootstrap_platform_owner once. Schema already applied by 0025.
 *
 * Never uses DATABASE_URL. Never prints secrets, emails, or user ids.
 * Never deploys. Never migrates. Never grants/revokes. Never inserts.
 *
 * Dispatch of this workflow was CP26C-O2C.2 (GHA 36116463589) and is retired.
 * The workflow file was deleted in CP26C-O2C.3. Do not recreate it.
 * This script remains historical audit evidence. It is not a package script.
 * This commit is not authorization to execute again.
 */
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
  redact,
} from "./production-db-preflight.mjs";
import {
  AUTH_TABLES,
  OCCUPANCY,
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  evaluateOwnerIdentity,
  hotelSnapshotKey,
  roleIsSafe,
} from "./cp26a2-0023-production-migrate.mjs";
import { billingSnapshotKey } from "./cp26b2-0024-production-migrate.mjs";
import {
  EXPECTED_FUNCTIONS,
  OWNER_TABLES,
  TARGET_DIGEST as DIGEST_0025,
  TARGET_MIGRATION as MIGRATION_0025,
  inspect0025State,
  ownerInstalledContractFailures,
  ownerUrlFromEnv,
  sha256,
  verifyHotelKey,
} from "./cp26co2a-0025-production-migrate.mjs";

export { IDENTITY_BLOCKED, OWNER_BLOCKED, EXPECTED_DATABASE, EXPECTED_OWNER, EXPECTED_RUNTIME, ownerUrlFromEnv };

export const TARGET_HOTEL_CODE = "sbg-verify-a5";
export const TARGET_HOTEL_STATUS = "configured";
export const DEMO_HOTEL_CODE = "demo-kos";
export const DEMO_HOTEL_STATUS = "live";
export const REQUIRED_CONFIRMATION = "BOOTSTRAP-FIRST-OWNER";
export const REQUIRED_NOTE = "CP26C-O2C first Production platform Owner";
export const TARGET_USER_REDACTED = "OPERATOR CONTROLLED / REDACTED";
export const MIGRATION_0025_DIGEST = DIGEST_0025;

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
  "0025_cp26co2_platform_owners.sql",
];

export const AUTHORISED = "GATE PASS — FIRST OWNER BOOTSTRAP AUTHORISED";
export const ALREADY_BOOTSTRAPPED = "FIRST OWNER ALREADY BOOTSTRAPPED — NO MUTATION";
export const BOOTSTRAPPED_VERIFIED = "GATE PASS — FIRST OWNER BOOTSTRAPPED AND VERIFIED";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const ROLE_BLOCKED = "BLOCKED — AETHER_APP ROLE ESCALATED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const PENDING_BLOCKED = "BLOCKED — PENDING MIGRATION PRESENT";
export const CONTRACT_INVALID = "BLOCKED — OWNER SCHEMA CONTRACT INVALID";
export const DIGEST_BLOCKED = "BLOCKED — 0025 DIGEST MISMATCH";
export const NO_HOTEL = "BLOCKED — VERIFY HOTEL ABSENT";
export const DUP_HOTEL = "BLOCKED — VERIFY HOTEL DUPLICATE";
export const HOTEL_NOT_CONFIGURED = "BLOCKED — VERIFY HOTEL NOT CONFIGURED";
export const NO_OWNERSHIP = "BLOCKED — VERIFY HOTEL OWNERSHIP MISSING";
export const MULTI_OWNERSHIP = "BLOCKED — VERIFY HOTEL OWNERSHIP AMBIGUOUS";
export const NO_USER = "BLOCKED — TARGET USER MISSING";
export const AMBIGUOUS_USER = "BLOCKED — TARGET USER AMBIGUOUS";
export const DEMO_BLOCKED = "BLOCKED — DEMO-KOS INVARIANT NOT PROVEN";
export const OWNERS_NOT_ZERO = "BLOCKED — ACTIVE OWNER COUNT NOT ZERO";
export const TOO_MANY_OWNERS = "BLOCKED — MULTIPLE ACTIVE OWNERS";
export const WRONG_OWNER = "BLOCKED — FIRST OWNER IDENTITY MISMATCH";
export const APPLY_FAILED = "BLOCKED — BOOTSTRAP APPLICATION FAILED";
export const POST_BLOCKED = "BLOCKED — POST-BOOTSTRAP VERIFICATION FAILED";
export const UNAUTHORISED_CALL = "BLOCKED — UNAUTHORISED BOOTSTRAP CALL";
export const NOTE_BLOCKED = "BLOCKED — BOOTSTRAP NOTE INVALID";

export function assertConfirmation(value) {
  if (String(value ?? "") !== REQUIRED_CONFIRMATION) {
    return { ok: false, verdict: CONFIRM_BLOCKED, migrated: false };
  }
  return { ok: true };
}

export function assertBootstrapCall({ userId, note }) {
  if (String(note ?? "") !== REQUIRED_NOTE) {
    return { ok: false, verdict: NOTE_BLOCKED, migrated: false };
  }
  if (typeof userId !== "string" || charLength(userId) === 0) {
    return { ok: false, verdict: NO_USER, migrated: false };
  }
  return { ok: true };
}

function charLength(value) {
  return String(value ?? "").trim().length;
}

function blocked(verdict, extra = {}) {
  return { ok: false, verdict, migrated: false, ...extra };
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

function sameList(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function unique(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? "")).filter(Boolean))];
}

export function publicTargetReport(discovery) {
  return {
    "target.user": TARGET_USER_REDACTED,
    "ownership.match": Number(discovery?.ownershipMatch ?? 0),
    "hotel.code": TARGET_HOTEL_CODE,
  };
}

export function evaluateTargetDiscovery(facts) {
  const hotels = Array.isArray(facts?.targetHotels) ? facts.targetHotels : [];
  if (hotels.length === 0) return blocked(NO_HOTEL, { ownershipMatch: 0 });
  if (hotels.length > 1) return blocked(DUP_HOTEL, { ownershipMatch: 0, hotelCount: hotels.length });
  const hotel = hotels[0];
  if (String(hotel?.code ?? "") !== TARGET_HOTEL_CODE) return blocked(NO_HOTEL);
  if (String(hotel?.status ?? "") !== TARGET_HOTEL_STATUS) {
    return blocked(HOTEL_NOT_CONFIGURED, { status: hotel?.status });
  }
  const mappings = Array.isArray(facts?.targetMappings) ? facts.targetMappings : [];
  if (mappings.length === 0) return blocked(NO_OWNERSHIP, { ownershipMatch: 0 });
  if (mappings.length > 1) {
    return blocked(MULTI_OWNERSHIP, { ownershipMatch: mappings.length });
  }
  const userIds = unique(mappings.map((row) => row?.userId));
  if (userIds.length === 0) return blocked(NO_USER, { ownershipMatch: 0 });
  if (userIds.length > 1) return blocked(AMBIGUOUS_USER, { ownershipMatch: userIds.length });
  if (facts?.targetUserExists !== true) return blocked(NO_USER, { ownershipMatch: 1 });
  return {
    ok: true,
    userId: userIds[0],
    ownershipMatch: 1,
    hotelCode: TARGET_HOTEL_CODE,
    hotelStatus: TARGET_HOTEL_STATUS,
  };
}

export function evaluateFirstOwnerBaseline(facts) {
  const confirm = assertConfirmation(facts?.confirmation);
  if (!confirm.ok) return confirm;
  if (!ownerUrlFromEnv(facts?.env ?? { AETHER_DATABASE_OWNER_URL: facts?.ownerUrl })) {
    return blocked(BLOCKED_OWNER_URL);
  }
  if (facts?.sourceDigest0025 && facts.sourceDigest0025 !== MIGRATION_0025_DIGEST) {
    return blocked(DIGEST_BLOCKED, { digest: facts.sourceDigest0025 });
  }
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

  const ledger = [...(facts?.ledger ?? [])].map(String);
  const missingHistorical = REQUIRED_LEDGER.filter((name) => !ledger.includes(name));
  if (missingHistorical.length) {
    return blocked(UNEXPECTED_PLAN, { missingHistorical });
  }
  const extra = ledger.filter((name) => !REQUIRED_LEDGER.includes(name));
  if (extra.length) return blocked(UNEXPECTED_PLAN, { extra });
  const applied0025 = ledger.filter((name) => name === MIGRATION_0025).length;
  if (applied0025 !== 1) return blocked(UNEXPECTED_PLAN, { applied0025 });

  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  if (pending.length) return blocked(PENDING_BLOCKED, { pending });

  const contract = ownerInstalledContractFailures(facts);
  if (contract.length) return blocked(CONTRACT_INVALID, { failures: contract });

  if (String(facts?.hotelSnapshot?.demoKos?.code ?? "") !== DEMO_HOTEL_CODE) {
    return blocked(DEMO_BLOCKED);
  }
  if (String(facts?.hotelSnapshot?.demoKos?.status ?? "") !== DEMO_HOTEL_STATUS) {
    return blocked(DEMO_BLOCKED);
  }
  if (String(facts?.verifyHotel?.code ?? "") !== TARGET_HOTEL_CODE) return blocked(NO_HOTEL);
  if (String(facts?.verifyHotel?.status ?? "") !== TARGET_HOTEL_STATUS) {
    return blocked(HOTEL_NOT_CONFIGURED, { status: facts?.verifyHotel?.status });
  }

  const discovery = evaluateTargetDiscovery(facts);
  if (!discovery.ok) return discovery;

  const activeIds = unique(facts?.activeOwnerUserIds);
  const activeCount = Number(facts?.ownerSchema?.activeGrantCount ?? activeIds.length);
  if (activeCount > 1 || activeIds.length > 1) {
    return blocked(TOO_MANY_OWNERS, { activeCount: Math.max(activeCount, activeIds.length) });
  }
  if (activeCount === 1 || activeIds.length === 1) {
    const current = activeIds[0];
    if (current !== discovery.userId) return blocked(WRONG_OWNER);
    return {
      ok: true,
      alreadyBootstrapped: true,
      verdict: ALREADY_BOOTSTRAPPED,
      migrated: false,
      ownershipMatch: 1,
      hotelCode: TARGET_HOTEL_CODE,
    };
  }
  if (activeCount !== 0) return blocked(OWNERS_NOT_ZERO, { activeCount });

  return {
    ok: true,
    authorised: true,
    alreadyBootstrapped: false,
    verdict: AUTHORISED,
    migrated: false,
    userId: discovery.userId,
    ownershipMatch: 1,
    hotelCode: TARGET_HOTEL_CODE,
    hotelSnapshot: facts?.hotelSnapshot ?? null,
    billingSnapshot: facts?.billingSnapshot ?? null,
    verifyHotel: facts?.verifyHotel ?? null,
    auditCount: Number(facts?.ownerSchema?.auditCount ?? 0),
  };
}

export function evaluateFirstOwnerAftermath(facts, before, targetUserId) {
  const identity = evaluateOwnerIdentity(facts);
  if (!identity.ok) return { ...identity, migrated: true };
  const failures = [];
  const ledger = [...(facts?.ledger ?? [])].map(String);
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  if (!REQUIRED_LEDGER.every((name) => ledger.includes(name))) failures.push("ledger");
  if (ledger.some((name) => !REQUIRED_LEDGER.includes(name))) failures.push("ledger-extra");
  if (pending.length > 0) failures.push("pending-remain");
  for (const failure of ownerInstalledContractFailures(facts)) {
    if (!failures.includes(failure)) failures.push(failure);
  }
  const activeIds = unique(facts?.activeOwnerUserIds);
  const activeCount = Number(facts?.ownerSchema?.activeGrantCount ?? activeIds.length);
  if (activeCount !== 1 || activeIds.length !== 1) failures.push("owner-count");
  if (activeIds[0] !== targetUserId) failures.push("owner-identity");
  if (facts?.targetUserExists !== true) failures.push("target-user");
  const discovery = evaluateTargetDiscovery(facts);
  if (!discovery.ok || discovery.userId !== targetUserId) failures.push("ownership");
  if (String(facts?.verifyHotel?.code ?? "") !== TARGET_HOTEL_CODE) failures.push("verify-hotel");
  if (String(facts?.verifyHotel?.status ?? "") !== TARGET_HOTEL_STATUS) {
    failures.push("verify-hotel-status");
  }
  if (String(facts?.hotelSnapshot?.demoKos?.status ?? "") !== DEMO_HOTEL_STATUS) {
    failures.push("demo-kos");
  }
  if (hotelSnapshotKey(facts?.hotelSnapshot) !== hotelSnapshotKey(before?.hotelSnapshot)) {
    failures.push("hotel-invariance");
  }
  if (billingSnapshotKey(facts?.billingSnapshot) !== billingSnapshotKey(before?.billingSnapshot)) {
    failures.push("billing-invariance");
  }
  if (verifyHotelKey(facts?.verifyHotel) !== verifyHotelKey(before?.verifyHotel)) {
    failures.push("verify-hotel-invariance");
  }
  const beforeAudit = Number(before?.ownerSchema?.auditCount ?? 0);
  const afterAudit = Number(facts?.ownerSchema?.auditCount ?? -1);
  if (afterAudit !== beforeAudit + 1) failures.push("audit-count");
  const last = facts?.lastAudit ?? {};
  if (String(last.action ?? "") !== "owner.granted") failures.push("audit-action");
  if (last.bootstrap !== true) failures.push("audit-bootstrap");
  if (!authPresent(facts?.authTables)) failures.push("auth-tables");
  if (!roleIsSafe(facts?.aetherAppRole)) failures.push("role-escalation");
  if (failures.length) {
    return { ok: false, verdict: POST_BLOCKED, failures, migrated: true };
  }
  return {
    ok: true,
    verdict: BOOTSTRAPPED_VERIFIED,
    migrated: true,
    ownershipMatch: 1,
    hotelCode: TARGET_HOTEL_CODE,
  };
}

export async function applyExactBootstrap({ userId, note, execute }) {
  const gate = assertBootstrapCall({ userId, note });
  if (!gate.ok) {
    const err = new Error(gate.verdict);
    err.verdict = gate.verdict;
    throw err;
  }
  if (typeof execute !== "function") {
    throw new Error("BLOCKED — BOOTSTRAP EXECUTOR MISSING");
  }
  return execute(userId, note);
}

export async function runSingleUseFirstOwner({ env, confirmation, sourceDigest0025, loadFacts, applyBootstrap }) {
  const ownerUrl = ownerUrlFromEnv(env);
  const confirm = assertConfirmation(confirmation);
  if (!confirm.ok) return confirm;
  if (!ownerUrl) return blocked(BLOCKED_OWNER_URL);
  if (sourceDigest0025 && sourceDigest0025 !== MIGRATION_0025_DIGEST) {
    return blocked(DIGEST_BLOCKED, { digest: sourceDigest0025 });
  }

  const before = await loadFacts();
  const baseline = evaluateFirstOwnerBaseline({
    ...before,
    confirmation,
    env,
    ownerUrl,
    sourceDigest0025: sourceDigest0025 ?? before?.sourceDigest0025,
  });
  if (!baseline.ok || baseline.alreadyBootstrapped) {
    return { ...baseline, preflight: before, migrated: false };
  }

  let applyError = null;
  let applied = null;
  try {
    applied = await applyExactBootstrap({
      userId: baseline.userId,
      note: REQUIRED_NOTE,
      execute: (userId, note) => applyBootstrap({ userId, note, before }),
    });
  } catch (err) {
    applyError = err;
  }

  if (applyError) {
    return {
      ok: false,
      verdict: applyError?.verdict || APPLY_FAILED,
      migrated: false,
      error: redact(applyError?.message || applyError),
      preflight: before,
    };
  }
  if (applied && typeof applied === "object" && "ok" in applied) {
    return { ...applied, preflight: before };
  }
  const after = applied?.postflight ?? (await loadFacts());
  const aftermath = evaluateFirstOwnerAftermath(after, before, baseline.userId);
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
  say(`owner.grants.active: ${facts?.ownerSchema?.activeGrantCount ?? facts?.activeOwnerUserIds?.length ?? "UNKNOWN"}`);
  say(`owner.audit: ${facts?.ownerSchema?.auditCount ?? "UNKNOWN"}`);
  say(`target.user: ${TARGET_USER_REDACTED}`);
  say(`ownership.match: ${Array.isArray(facts?.targetMappings) ? facts.targetMappings.length : "UNKNOWN"}`);
  say(`hotel.code: ${TARGET_HOTEL_CODE}`);
  say(`hotels.total: ${facts?.hotelSnapshot?.hotelCount ?? "UNKNOWN"}`);
  say(`demo-kos.status: ${facts?.hotelSnapshot?.demoKos?.status ?? "UNKNOWN"}`);
  say(`verify-a5.status: ${facts?.verifyHotel?.status ?? "ABSENT"}`);
  say(`billing.accounts: ${facts?.billingSnapshot?.accountCount ?? "UNKNOWN"}`);
  say(`stripe.events: ${facts?.billingSnapshot?.eventCount ?? "UNKNOWN"}`);
}

async function inspectFirstOwnerState(client, sourceMigrations) {
  const base = await inspect0025State(client, sourceMigrations);
  const targetHotels = (
    await client.query(
      `select id::text as id, code, status, name
         from hotels
        where code = $1
        order by id`,
      [TARGET_HOTEL_CODE],
    )
  ).rows.map((row) => ({
    id: String(row.id),
    code: String(row.code),
    status: String(row.status),
    name: String(row.name ?? ""),
  }));
  const targetMappings = (
    await client.query(
      `select aha.user_id as user_id, aha.hotel_id::text as hotel_id
         from app_hotel_accounts aha
         join hotels h on h.id = aha.hotel_id
        where h.code = $1
        order by aha.user_id, aha.hotel_id`,
      [TARGET_HOTEL_CODE],
    )
  ).rows.map((row) => ({
    userId: String(row.user_id),
    hotelId: String(row.hotel_id),
  }));
  const userIds = unique(targetMappings.map((row) => row.userId));
  let targetUserExists = false;
  if (userIds.length === 1) {
    targetUserExists =
      (
        await client.query(`select exists(select 1 from "user" where id = $1) as ok`, [userIds[0]])
      ).rows[0]?.ok === true;
  }

  let activeOwnerUserIds = [];
  let activeGrantCount = 0;
  if (base.ownerSchema?.tables?.sbg_platform_owners?.present) {
    activeOwnerUserIds = (
      await client.query(
        `select user_id from sbg_platform_owners where revoked_at is null order by user_id`,
      )
    ).rows.map((row) => String(row.user_id));
    activeGrantCount = activeOwnerUserIds.length;
  }

  let lastAudit = null;
  if (base.ownerSchema?.tables?.sbg_owner_audit_events?.present) {
    const row = (
      await client.query(
        `select action, coalesce(metadata->>'bootstrap','') as bootstrap
           from sbg_owner_audit_events
          order by at desc, id desc
          limit 1`,
      )
    ).rows[0];
    if (row) {
      lastAudit = {
        action: String(row.action ?? ""),
        bootstrap: String(row.bootstrap ?? "") === "true",
      };
    }
  }

  return {
    ...base,
    targetHotels,
    targetMappings,
    targetUserExists,
    activeOwnerUserIds,
    lastAudit,
    ownerSchema: {
      ...base.ownerSchema,
      activeGrantCount,
    },
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
    return await inspectFirstOwnerState(client, sourceMigrations);
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

async function bootstrapOnOwner(ownerUrl, sourceMigrations, { userId, note, before }) {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("select sbg_bootstrap_platform_owner($1::text, $2::text)", [userId, note]);
    const after = await inspectFirstOwnerState(client, sourceMigrations);
    const aftermath = evaluateFirstOwnerAftermath(after, before, userId);
    if (!aftermath.ok) {
      await client.query("ROLLBACK");
      return { ...aftermath, migrated: false, rolledBack: true, postflight: after };
    }
    await client.query("COMMIT");
    return { ...aftermath, migrated: true, rolledBack: false, postflight: after };
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
  const confirmation = process.env.CP26CO2C_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  const dispatched = String(process.env.GITHUB_SHA ?? "").trim();
  if (dispatched) say(`dispatched sha: ${dispatched}`);
  say("note: this controller is build-complete; dispatch is a later authorised checkpoint");
  say("note: first Owner bootstrap only — target hotel code sbg-verify-a5");
  say("note: user identity is never printed");

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
  const bytes0025 = await readFile(join(rootDir, "migrations", MIGRATION_0025));
  const sourceDigest0025 = sha256(bytes0025);
  say(`0025 digest: ${sourceDigest0025}`);
  if (sourceDigest0025 !== MIGRATION_0025_DIGEST) {
    fail(DIGEST_BLOCKED);
    return;
  }

  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUseFirstOwner({
    env: process.env,
    confirmation,
    sourceDigest0025,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    applyBootstrap: (args) => bootstrapOnOwner(ownerUrl, sourceMigrations, args),
  });
  if (result.preflight) reportFacts("pre-bootstrap:", result.preflight);
  const report = publicTargetReport(result);
  say(`target.user: ${report["target.user"]}`);
  say(`ownership.match: ${report["ownership.match"]}`);
  say(`hotel.code: ${report["hotel.code"]}`);
  if (result.failures?.length) {
    say("gate failures:");
    for (const name of result.failures) say(`  ${name}`);
  }
  if (result.postflight) reportFacts("post-bootstrap:", result.postflight);
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
