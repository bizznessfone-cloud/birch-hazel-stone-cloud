#!/usr/bin/env node
/**
 * CP27.2 — single-use production controller for 0029 only.
 *
 * Applies migrations/0029_cp272_domain_a_checkout_claims.sql and nothing else.
 * Never uses DATABASE_URL. Never prints secrets. Never calls Stripe.
 * Does not invoke the generic production migrator or the historical applier.
 * Does not enable commerce. Does not write hotels.status, licensed_quantity,
 * property allocations, or Domain B payment rows.
 *
 * REQUIRED_LEDGER is the frozen pre-apply pin (0001–0028). It must not follow Gate B.
 * Re-running against an already-applied valid 0029 contract must not mutate.
 *
 * DO NOT RUN until a later checkpoint authorises Production apply.
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
  REVIEWED_DIGESTS as PRIOR_REVIEWED_DIGESTS,
  redact,
} from "./production-db-preflight.mjs";

export const TARGET_MIGRATION = "0029_cp272_domain_a_checkout_claims.sql";
export const TARGET_DIGEST =
  "e5897eda1a4f3c8c4025e16235b9d11a677b3cc7994934058142934d4dea7adc";
export const REQUIRED_CONFIRMATION = "APPLY-0029";
/** Frozen pre-apply ledger. Do not replace this with ACCEPTED_LEDGER. */
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
  "0026_cp26co3_commercial_catalogue.sql",
  "0027_cp26co41_organisation_property_licence.sql",
  "0028_cp26fin_property_licence_catalogue.sql",
];

export const REVIEWED_DIGESTS = {
  ...PRIOR_REVIEWED_DIGESTS,
  [TARGET_MIGRATION]: TARGET_DIGEST,
};

export const AUTHORISED = "GATE PASS — 0029 AUTHORISED";
export const ALREADY_APPLIED = "0029 ALREADY APPLIED — NO MUTATION";
export const APPLIED_VERIFIED = "GATE PASS — 0029 APPLIED AND VERIFIED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const DIGEST_BLOCKED = "BLOCKED — 0029 DIGEST MISMATCH";
export const REVIEWED_DIGEST_BLOCKED = "BLOCKED — REVIEWED MIGRATION DIGEST MISMATCH";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const APPLY_FAILED = "BLOCKED — 0029 APPLICATION FAILED";
export const UNAUTHORISED_MIGRATION = "BLOCKED — UNAUTHORISED MIGRATION";
export const PARTIAL_BLOCKED = "BLOCKED — 0029 PARTIAL / LEDGER SPLIT";
export const CONTRACT_BLOCKED = "BLOCKED — 0029 CLAIM CONTRACT INVALID";
export const IDENTITY_BLOCKED = "BLOCKED — DATABASE IDENTITY MISMATCH";
export const OWNER_BLOCKED = "BLOCKED — OWNER IDENTITY MISMATCH";

const ALLOWED_LEDGER = new Set([...REQUIRED_LEDGER, TARGET_MIGRATION]);
const CLAIM_FN = "sbg_claim_domain_a_checkout(text,uuid,integer,integer)";
const ATTACH_FN = "sbg_attach_domain_a_checkout_session(text,uuid,uuid,text,text)";
const RELEASE_FN = "sbg_release_domain_a_checkout_claim(text,uuid,uuid)";

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
  const text = String(file?.sql ?? file?.text ?? "");
  const digest = String(file?.digest ?? sha256(Buffer.from(file?.bytes ?? text)));
  if (name !== TARGET_MIGRATION) {
    return { ok: false, verdict: UNAUTHORISED_MIGRATION, migrated: false, name };
  }
  if (digest !== TARGET_DIGEST) {
    return { ok: false, verdict: DIGEST_BLOCKED, migrated: false, digest };
  }
  return { ok: true, name, digest };
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

function blocked(verdict, extra = {}) {
  return { ok: false, verdict, migrated: false, ...extra };
}

function sameList(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function ledgerState(facts) {
  const ledger = [...(facts?.ledger ?? [])].map(String);
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  const unexpectedApplied = ledger.filter((name) => !ALLOWED_LEDGER.has(name));
  const missingHistorical = REQUIRED_LEDGER.filter((name) => !ledger.includes(name));
  const unexpectedPending = pending.filter((name) => name !== TARGET_MIGRATION);
  return { ledger, pending, appliedCount, unexpectedApplied, missingHistorical, unexpectedPending };
}

export function claimContractFailures(facts) {
  const contract = facts?.claim ?? {};
  const failures = [];
  if (contract.tablePresent !== true) failures.push("claim-table");
  if (contract.claimFunction !== true) failures.push("claim-fn");
  if (contract.attachFunction !== true) failures.push("attach-fn");
  if (contract.releaseFunction !== true) failures.push("release-fn");
  if (contract.appSelect !== true) failures.push("app-select");
  if (contract.appInsert !== false) failures.push("app-insert");
  if (contract.appUpdate !== false) failures.push("app-update");
  if (contract.appDelete !== false) failures.push("app-delete");
  if (contract.publicExecute !== false) failures.push("public-execute");
  if (contract.appExecute !== true) failures.push("app-execute");
  if (Number(contract.claimRows ?? -1) !== 0) failures.push("claim-rows");
  return failures;
}

function platformFailures(facts) {
  const failures = [];
  if (facts?.database !== EXPECTED_DATABASE) failures.push(IDENTITY_BLOCKED);
  if (facts?.currentUser !== EXPECTED_OWNER || facts?.sessionUser !== EXPECTED_OWNER) {
    failures.push(OWNER_BLOCKED);
  }
  if (!facts?.ledgerReadable) failures.push("ledger-unreadable");
  return failures;
}

function snapshotFailures(facts, before) {
  const failures = [];
  if (JSON.stringify(facts?.hotels ?? null) !== JSON.stringify(before?.hotels ?? null)) {
    failures.push("hotel-status");
  }
  if (Number(facts?.licensedQuantity ?? -1) !== Number(before?.licensedQuantity ?? -2)) {
    failures.push("licensed-quantity");
  }
  if (Number(facts?.allocationCount ?? -1) !== Number(before?.allocationCount ?? -2)) {
    failures.push("allocations");
  }
  if (Number(facts?.bookingPaymentCount ?? -1) !== Number(before?.bookingPaymentCount ?? -2)) {
    failures.push("domain-b-payments");
  }
  return failures;
}

export function evaluate0029Baseline(facts, file) {
  const confirm = assertConfirmation(facts?.confirmation);
  if (!confirm.ok) return confirm;
  if (!ownerUrlFromEnv(facts?.env ?? { AETHER_DATABASE_OWNER_URL: facts?.ownerUrl })) {
    return blocked(BLOCKED_OWNER_URL);
  }
  const fileGate = assertMigrationFile(file);
  if (!fileGate.ok) return fileGate;
  const platform = platformFailures(facts);
  if (platform.includes(IDENTITY_BLOCKED)) return blocked(IDENTITY_BLOCKED, { failures: platform });
  if (platform.includes(OWNER_BLOCKED)) return blocked(OWNER_BLOCKED, { failures: platform });

  const { pending, appliedCount, unexpectedApplied, missingHistorical, unexpectedPending } = ledgerState(facts);
  if (appliedCount > 1 || unexpectedApplied.length || missingHistorical.length || unexpectedPending.length) {
    return blocked(unexpectedPending.length ? UNEXPECTED_PLAN : PARTIAL_BLOCKED, {
      pending,
      appliedCount,
      unexpectedApplied,
      missingHistorical,
      unexpectedPending,
    });
  }

  if (appliedCount === 1) {
    const contract = claimContractFailures(facts);
    if (pending.length || platform.length || contract.length) {
      return blocked(pending.length ? UNEXPECTED_PLAN : CONTRACT_BLOCKED, {
        pending,
        failures: [...platform, ...contract],
      });
    }
    return { ok: true, alreadyApplied: true, verdict: ALREADY_APPLIED, pending: [], migrated: false };
  }

  if (platform.length) return blocked(PARTIAL_BLOCKED, { failures: platform });
  if (sameList(pending, [TARGET_MIGRATION])) {
    return { ok: true, authorised: true, alreadyApplied: false, verdict: AUTHORISED, pending, migrated: false };
  }
  return blocked(UNEXPECTED_PLAN, { pending });
}

export function evaluate0029Aftermath(facts, before) {
  const failures = [];
  const { pending, appliedCount, unexpectedApplied, unexpectedPending } = ledgerState(facts);
  if (appliedCount !== 1) failures.push("0029-ledger");
  if (unexpectedApplied.length || unexpectedPending.length) failures.push("unexpected-ledger");
  if (pending.length) failures.push("pending-remain");
  failures.push(...claimContractFailures(facts));
  failures.push(...platformFailures(facts));
  failures.push(...snapshotFailures(facts, before));
  if (failures.length) return { ok: false, verdict: POST_BLOCKED, failures, pending, migrated: false, committed: false };
  return { ok: true, verdict: APPLIED_VERIFIED, pending: [], migrated: true, committed: true };
}

export async function apply0029Transaction({ sql, before, query, inspect }) {
  if (typeof query !== "function" || typeof inspect !== "function") {
    throw new Error("BLOCKED — 0029 EXECUTOR MISSING");
  }
  if (sha256(Buffer.from(String(sql ?? ""))) !== TARGET_DIGEST) {
    const err = new Error(DIGEST_BLOCKED);
    err.verdict = DIGEST_BLOCKED;
    throw err;
  }
  let began = false;
  try {
    await query("BEGIN");
    began = true;
    await query(sql);
    await query("INSERT INTO _migrations (name) VALUES ($1)", [TARGET_MIGRATION]);
    const after = await inspect();
    const aftermath = evaluate0029Aftermath(after, before);
    if (!aftermath.ok) {
      await query("ROLLBACK");
      began = false;
      return { ...aftermath, committed: false, migrated: false, postflight: after };
    }
    await query("COMMIT");
    began = false;
    return { ...aftermath, committed: true, migrated: true, postflight: after };
  } catch (err) {
    if (began) {
      try {
        await query("ROLLBACK");
      } catch {
        // keep the original error
      }
    }
    throw err;
  }
}

export async function runSingleUse0029({ env, confirmation, file, sourceChecksums, loadFacts, mutate }) {
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
  const baseline = evaluate0029Baseline({ ...before, confirmation, env, ownerUrl }, file);
  if (!baseline.ok || baseline.alreadyApplied) {
    return { ...baseline, preflight: before, migrated: false };
  }
  if (typeof mutate !== "function") return blocked("BLOCKED — 0029 EXECUTOR MISSING");
  try {
    const applied = await mutate({ sql: file.sql ?? file.text, before });
    return { ...applied, preflight: before };
  } catch (err) {
    return {
      ok: false,
      verdict: err?.verdict || APPLY_FAILED,
      migrated: false,
      committed: false,
      error: redact(err?.message || err),
      preflight: before,
    };
  }
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
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], facts?.ledger ?? []).map((row) => row.name);
  say("pending:");
  for (const name of pending) say(`  ${name}`);
  if (!pending.length) say("  (none)");
  say(`claim_table: ${facts?.claim?.tablePresent === true ? "PRESENT" : "ABSENT"}`);
  say(`licensed_quantity_sum: ${facts?.licensedQuantity ?? "UNKNOWN"}`);
  say(`allocations: ${facts?.allocationCount ?? "UNKNOWN"}`);
  say(`domain_b.booking_payments: ${facts?.bookingPaymentCount ?? "UNKNOWN"}`);
  say("stripe: UNTOUCHED");
  say("commerce: UNTOUCHED");
}

function bool(value) {
  return value === true;
}

export async function inspect0029State(client, sourceMigrations) {
  const identity = (
    await client.query("select current_database() as database, current_user, session_user")
  ).rows[0];
  let ledger = [];
  let ledgerReadable = true;
  try {
    ledger = (await client.query("select name from _migrations order by name")).rows.map((row) => row.name);
  } catch {
    ledgerReadable = false;
  }

  const installed = (
    await client.query(
      `select to_regclass('public.sbg_domain_a_checkout_claims') is not null as table_present,
              to_regprocedure($1) is not null as claim_fn,
              to_regprocedure($2) is not null as attach_fn,
              to_regprocedure($3) is not null as release_fn`,
      [CLAIM_FN, ATTACH_FN, RELEASE_FN],
    )
  ).rows[0];

  const present = installed?.table_present === true && installed?.claim_fn === true;
  const privileges = present
    ? (
        await client.query(
          `select has_table_privilege('aether_app', 'public.sbg_domain_a_checkout_claims', 'SELECT') as app_select,
                  has_table_privilege('aether_app', 'public.sbg_domain_a_checkout_claims', 'INSERT') as app_insert,
                  has_table_privilege('aether_app', 'public.sbg_domain_a_checkout_claims', 'UPDATE') as app_update,
                  has_table_privilege('aether_app', 'public.sbg_domain_a_checkout_claims', 'DELETE') as app_delete,
                  has_function_privilege('public', $1, 'EXECUTE') as public_execute,
                  has_function_privilege('aether_app', $1, 'EXECUTE') as app_execute,
                  (select count(*)::int from public.sbg_domain_a_checkout_claims) as claim_rows`,
          [CLAIM_FN],
        )
      ).rows[0]
    : null;

  const hotels = (
    await client.query("select code, status from hotels order by code")
  ).rows.map((row) => ({ code: row.code, status: row.status }));
  const licensed = (
    await client.query("select coalesce(sum(licensed_quantity), 0)::int as n from sbg_organisation_billing")
  ).rows[0];
  const allocations = (
    await client.query("select count(*)::int as n from sbg_property_licence_allocations")
  ).rows[0];
  const payments = (
    await client.query("select count(*)::int as n from sbg_booking_payments")
  ).rows[0];

  return {
    database: identity?.database,
    currentUser: identity?.current_user,
    sessionUser: identity?.session_user,
    ledger,
    ledgerReadable,
    sourceMigrations,
    hotels,
    licensedQuantity: Number(licensed?.n ?? 0),
    allocationCount: Number(allocations?.n ?? 0),
    bookingPaymentCount: Number(payments?.n ?? 0),
    claim: {
      tablePresent: installed?.table_present === true,
      claimFunction: installed?.claim_fn === true,
      attachFunction: installed?.attach_fn === true,
      releaseFunction: installed?.release_fn === true,
      appSelect: bool(privileges?.app_select),
      appInsert: privileges ? privileges.app_insert === true : false,
      appUpdate: privileges ? privileges.app_update === true : false,
      appDelete: privileges ? privileges.app_delete === true : false,
      publicExecute: privileges ? privileges.public_execute === true : false,
      appExecute: bool(privileges?.app_execute),
      claimRows: privileges ? Number(privileges.claim_rows) : 0,
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
    checksums[name] = sha256(await readFile(join(rootDir, "migrations", name)));
  }
  return checksums;
}

async function withOwner(ownerUrl, fn) {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function inspectWithOwner(ownerUrl, sourceMigrations) {
  return withOwner(ownerUrl, async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      return await inspect0029State(client, sourceMigrations);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

async function apply0029OnOwner(ownerUrl, sql, sourceMigrations, before) {
  return withOwner(ownerUrl, (client) =>
    apply0029Transaction({
      sql,
      before,
      query: (text, params) => client.query(text, params),
      inspect: () => inspect0029State(client, sourceMigrations),
    }),
  );
}

async function main() {
  const ownerUrl = ownerUrlFromEnv(process.env);
  const confirmation = process.env.CP272_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  say("note: checkout claims only — no Stripe call, no commerce change, no hotel publication change");

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
    fail(checksumGate.verdict);
    return;
  }

  const bytes = await readFile(join(rootDir, "migrations", TARGET_MIGRATION));
  const file = { name: TARGET_MIGRATION, bytes, digest: sha256(bytes), sql: bytes.toString("utf8") };
  say(`0029 digest: ${file.digest}`);
  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUse0029({
    env: process.env,
    confirmation,
    file,
    sourceChecksums,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    mutate: ({ sql, before }) => apply0029OnOwner(ownerUrl, sql, sourceMigrations, before),
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
