#!/usr/bin/env node
/**
 * CP30.05E-2D-2C.1 — single-use controller for migration 0034 only.
 *
 * Installs four functions. Does not insert an organisation, membership, hotel,
 * billing row, allocation, booking, or Terms acceptance. Does not call Stripe.
 * Does not change commerce. terms-v1 stays a provisional token.
 * Never uses DATABASE_URL. Never prints secrets. Does not invoke the generic
 * production migrator or any historical controller.
 *
 * REQUIRED_LEDGER is the frozen pre-apply pin (0001–0033). It must not follow
 * Gate B after 0034 is accepted. Re-running a valid installed contract must
 * return "0034 ALREADY APPLIED — NO MUTATION" and must not rewrite SQL.
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

export const TARGET_MIGRATION = "0034_cp3005e2d2c_founding_classification_acceptance.sql";
export const TARGET_DIGEST =
  "3a80e2ec5ff9ab474c8dabf562fe8e3e37b8fcaa77ef7e8467bd0127afdc433c";
export const REQUIRED_CONFIRMATION = "APPLY-0034";
/** Frozen pre-apply ledger. Do not replace this with a spread of ACCEPTED_LEDGER. */
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
  "0029_cp272_domain_a_checkout_claims.sql",
  "0030_cp272_fix_prepare_booking_payment.sql",
  "0031_cp3005e2c_organisation_type.sql",
  "0032_cp3005e2c1_organisation_acceptance.sql",
  "0033_cp3005e2d2b_founding_organisation.sql",
];

export const REVIEWED_DIGESTS = {
  ...PRIOR_REVIEWED_DIGESTS,
  [TARGET_MIGRATION]: TARGET_DIGEST,
};

export const AUTHORISED = "GATE PASS — 0034 AUTHORISED";
export const ALREADY_APPLIED = "0034 ALREADY APPLIED — NO MUTATION";
export const APPLIED_VERIFIED = "GATE PASS — 0034 APPLIED AND VERIFIED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const DIGEST_BLOCKED = "BLOCKED — 0034 DIGEST MISMATCH";
export const REVIEWED_DIGEST_BLOCKED = "BLOCKED — REVIEWED MIGRATION DIGEST MISMATCH";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const APPLY_FAILED = "BLOCKED — 0034 APPLICATION FAILED";
export const UNAUTHORISED_MIGRATION = "BLOCKED — UNAUTHORISED MIGRATION";
export const PARTIAL_BLOCKED = "BLOCKED — 0034 PARTIAL / LEDGER SPLIT";
export const CONTRACT_BLOCKED = "BLOCKED — 0034 CLASSIFICATION CONTRACT INVALID";
export const IDENTITY_BLOCKED = "BLOCKED — DATABASE IDENTITY MISMATCH";
export const OWNER_BLOCKED = "BLOCKED — OWNER IDENTITY MISMATCH";

const ALLOWED_LEDGER = new Set([...REQUIRED_LEDGER, TARGET_MIGRATION]);
const SEARCH_PATH = "pg_catalog, public";
const FUNCTIONS = {
  target: { name: "sbg_founding_onboarding_target", args: "p_user_id text", appExecute: false },
  classify: {
    name: "sbg_classify_founding_organisation",
    args: "p_user_id text, p_type text",
    appExecute: true,
  },
  accept: { name: "sbg_record_founding_terms_acceptance", args: "p_user_id text", appExecute: true },
  read: { name: "sbg_read_founding_onboarding_state", args: "p_user_id text", appExecute: true },
};

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
  const left = [...(actual ?? [])].map(String).sort((a, b) => a.localeCompare(b));
  const right = [...(expected ?? [])].map(String).sort((a, b) => a.localeCompare(b));
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function functionFailures(found, spec, label) {
  const failures = [];
  if (found?.present !== true) failures.push(`${label}-absent`);
  if (found?.securityDefiner !== true) failures.push(`${label}-security-definer`);
  if (found?.args !== spec.args) failures.push(`${label}-signature`);
  if (found?.searchPath !== SEARCH_PATH) failures.push(`${label}-search-path`);
  if (found?.owner !== EXPECTED_OWNER) failures.push(`${label}-owner`);
  if (found?.appExecute !== spec.appExecute) failures.push(`${label}-app-execute`);
  if (found?.runtimeExecute !== false) failures.push(`${label}-runtime-execute`);
  if (found?.publicExecute !== false) failures.push(`${label}-public-execute`);
  return failures;
}

export function contractFailures(facts) {
  const onboarding = facts?.onboarding ?? {};
  const acceptance = facts?.acceptance ?? {};
  const failures = [];
  failures.push(...functionFailures(onboarding.target, FUNCTIONS.target, "target"));
  failures.push(...functionFailures(onboarding.classify, FUNCTIONS.classify, "classify"));
  failures.push(...functionFailures(onboarding.accept, FUNCTIONS.accept, "accept"));
  failures.push(...functionFailures(onboarding.read, FUNCTIONS.read, "read"));
  if (onboarding.classifyForUpdate !== true) failures.push("classify-for-update");
  if (onboarding.acceptTermsToken !== true) failures.push("accept-terms-token");
  if (onboarding.acceptConflict !== true) failures.push("accept-conflict");
  if (onboarding.classifyWritesAcceptance !== false) failures.push("classify-writes-acceptance");
  if (onboarding.readWrites !== false) failures.push("read-writes");
  if (onboarding.bodyHotel !== false) failures.push("body-hotel");
  if (onboarding.bodyBillingWrite !== false) failures.push("body-billing-write");
  if (onboarding.bodyStripe !== false) failures.push("body-stripe");
  if (acceptance.immutableTrigger !== true) failures.push("acceptance-immutable");
  if (acceptance.truncateTrigger !== true) failures.push("acceptance-no-truncate");
  if (acceptance.appSelect !== false) failures.push("acceptance-app-select");
  if (acceptance.appInsert !== false) failures.push("acceptance-app-insert");
  if (acceptance.appUpdate !== false) failures.push("acceptance-app-update");
  if (acceptance.appDelete !== false) failures.push("acceptance-app-delete");
  if (onboarding.appOrgUpdate !== false) failures.push("app-org-update");
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
  for (const key of [
    "organisationCount",
    "memberCount",
    "classifiedCount",
    "acceptanceCount",
    "licensedQuantity",
    "allocationCount",
    "bookingCount",
    "paymentCount",
  ]) {
    if (Number(facts?.[key] ?? -1) !== Number(before?.[key] ?? -2)) failures.push(key);
  }
  if (JSON.stringify(facts?.hotels ?? null) !== JSON.stringify(before?.hotels ?? null)) failures.push("hotels");
  if (JSON.stringify(facts?.commerce ?? null) !== JSON.stringify(before?.commerce ?? null)) failures.push("commerce");
  return failures;
}

export function evaluate0034Baseline(facts, file) {
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
    const contract = contractFailures(facts);
    if (pending.length || platform.length || contract.length || !sameList(facts?.ledger, [...REQUIRED_LEDGER, TARGET_MIGRATION])) {
      return blocked(pending.length ? UNEXPECTED_PLAN : CONTRACT_BLOCKED, {
        pending,
        failures: [...platform, ...contract],
      });
    }
    return { ok: true, alreadyApplied: true, verdict: ALREADY_APPLIED, pending: [], migrated: false };
  }

  if (platform.length) return blocked(PARTIAL_BLOCKED, { failures: platform });
  if (sameList(pending, [TARGET_MIGRATION]) && sameList(facts?.ledger, REQUIRED_LEDGER)) {
    return { ok: true, authorised: true, alreadyApplied: false, verdict: AUTHORISED, pending, migrated: false };
  }
  return blocked(UNEXPECTED_PLAN, { pending });
}

export function evaluate0034Aftermath(facts, before) {
  const failures = [];
  const { pending, appliedCount, unexpectedApplied, unexpectedPending } = ledgerState(facts);
  if (appliedCount !== 1) failures.push("0034-ledger");
  if (!sameList(facts?.ledger, [...REQUIRED_LEDGER, TARGET_MIGRATION])) failures.push("ledger-contents");
  if (unexpectedApplied.length || unexpectedPending.length) failures.push("unexpected-ledger");
  if (pending.length) failures.push("pending-remain");
  failures.push(...contractFailures(facts));
  failures.push(...platformFailures(facts));
  failures.push(...snapshotFailures(facts, before));
  if (Number(facts?.classifiedCount) !== 0) failures.push("classified-not-zero");
  if (Number(facts?.acceptanceCount) !== 0) failures.push("acceptance-not-zero");
  if (failures.length) {
    return { ok: false, verdict: POST_BLOCKED, failures, pending, migrated: false, committed: false };
  }
  return { ok: true, verdict: APPLIED_VERIFIED, pending: [], migrated: true, committed: true };
}

export async function apply0034Transaction({ sql, before, query, inspect }) {
  if (typeof query !== "function" || typeof inspect !== "function") {
    throw new Error("BLOCKED — 0034 EXECUTOR MISSING");
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
    const aftermath = evaluate0034Aftermath(after, before);
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
    const wrapped = new Error(redact(err?.message || err));
    wrapped.verdict = err?.verdict || APPLY_FAILED;
    throw wrapped;
  }
}

export async function runSingleUse0034({ env, confirmation, file, sourceChecksums, loadFacts, mutate }) {
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
  const baseline = evaluate0034Baseline({ ...before, confirmation, env, ownerUrl }, file);
  if (!baseline.ok || baseline.alreadyApplied) {
    return { ...baseline, preflight: before, migrated: false };
  }
  if (typeof mutate !== "function") return blocked("BLOCKED — 0034 EXECUTOR MISSING");
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
  const onboarding = facts?.onboarding ?? {};
  const acceptance = facts?.acceptance ?? {};
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
  say(`organisation_rows: ${facts?.organisationCount ?? "UNKNOWN"}`);
  say(`member_rows: ${facts?.memberCount ?? "UNKNOWN"}`);
  say(`classified_rows: ${facts?.classifiedCount ?? "UNKNOWN"}`);
  say(`acceptance_rows: ${facts?.acceptanceCount ?? "UNKNOWN"}`);
  say(`licensed_quantity_sum: ${facts?.licensedQuantity ?? "UNKNOWN"}`);
  say(`allocations: ${facts?.allocationCount ?? "UNKNOWN"}`);
  say(`booking_rows: ${facts?.bookingCount ?? "UNKNOWN"}`);
  say(`payment_rows: ${facts?.paymentCount ?? "UNKNOWN"}`);
  for (const labelName of ["target", "classify", "accept", "read"]) {
    const row = onboarding[labelName] ?? {};
    say(`${labelName}_present: ${row.present === true}`);
    say(`${labelName}_security_definer: ${row.securityDefiner === true}`);
    say(`${labelName}_args: ${row.args ?? ""}`);
    say(`${labelName}_search_path: ${row.searchPath ?? ""}`);
    say(`${labelName}_owner: ${row.owner ?? ""}`);
    say(`${labelName}_aether_app_execute: ${row.appExecute === true}`);
    say(`${labelName}_aether_runtime_execute: ${row.runtimeExecute === true}`);
    say(`${labelName}_public_execute: ${row.publicExecute === true}`);
  }
  say(`acceptance_immutable: ${acceptance.immutableTrigger === true}`);
  say(`acceptance_no_truncate: ${acceptance.truncateTrigger === true}`);
  say(`aether_app_acceptance_select: ${acceptance.appSelect === true}`);
  say(`aether_app_acceptance_insert: ${acceptance.appInsert === true}`);
  say(`aether_app_acceptance_update: ${acceptance.appUpdate === true}`);
  say(`aether_app_acceptance_delete: ${acceptance.appDelete === true}`);
  say(`aether_app_org_update: ${onboarding.appOrgUpdate === true}`);
  say("stripe: UNTOUCHED");
  say("commerce: UNTOUCHED");
  say("terms_version: PROVISIONAL terms-v1");
  say("live_terms_acceptance: DISABLED");
}

function bool(value) {
  return value === true;
}

function blankFunction() {
  return {
    present: false,
    securityDefiner: false,
    args: "",
    searchPath: "",
    owner: "",
    appExecute: false,
    runtimeExecute: false,
    publicExecute: false,
    def: "",
  };
}

export async function inspect0034State(client, sourceMigrations) {
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

  const functions = (
    await client.query(
      `select p.proname,
              p.prosecdef,
              pg_get_userbyid(p.proowner) as owner,
              pg_get_function_identity_arguments(p.oid) as args,
              pg_get_functiondef(p.oid) as def,
              (
                select split_part(cfg, '=', 2)
                  from unnest(coalesce(p.proconfig, array[]::text[])) cfg
                 where cfg like 'search_path=%'
                 limit 1
              ) as search_path,
              has_function_privilege('aether_app', p.oid, 'EXECUTE') as app_exec,
              has_function_privilege('aether_runtime', p.oid, 'EXECUTE') as runtime_exec,
              (
                p.proacl is null
                or exists (
                  select 1
                    from aclexplode(p.proacl) a
                   where a.grantee = 0
                     and a.privilege_type = 'EXECUTE'
                )
              ) as public_exec
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = any($1::text[])
        order by p.proname, p.oid`,
      [Object.values(FUNCTIONS).map((spec) => spec.name)],
    )
  ).rows;
  const byName = new Map();
  for (const row of functions) {
    const list = byName.get(row.proname) ?? [];
    list.push(row);
    byName.set(row.proname, list);
  }
  function describe(spec) {
    const rows = byName.get(spec.name) ?? [];
    const one = rows.length === 1 ? rows[0] : null;
    if (!one) return blankFunction();
    return {
      present: true,
      securityDefiner: one.prosecdef === true,
      args: String(one.args ?? ""),
      searchPath: String(one.search_path ?? ""),
      owner: String(one.owner ?? ""),
      appExecute: one.app_exec === true,
      runtimeExecute: one.runtime_exec === true,
      publicExecute: one.public_exec === true,
      def: String(one.def ?? ""),
    };
  }
  const target = describe(FUNCTIONS.target);
  const classify = describe(FUNCTIONS.classify);
  const accept = describe(FUNCTIONS.accept);
  const read = describe(FUNCTIONS.read);
  const classifyBody = classify.def.replace(/--.*$/gm, "");
  const acceptBody = accept.def.replace(/--.*$/gm, "");
  const readBody = read.def.replace(/--.*$/gm, "");
  const allBody = `${classifyBody}\n${acceptBody}\n${readBody}\n${target.def}`;

  const acceptance = (
    await client.query(
      `select
         has_table_privilege('aether_app', 'public.sbg_organisation_acceptances', 'SELECT') as app_select,
         has_table_privilege('aether_app', 'public.sbg_organisation_acceptances', 'INSERT') as app_insert,
         has_table_privilege('aether_app', 'public.sbg_organisation_acceptances', 'UPDATE') as app_update,
         has_table_privilege('aether_app', 'public.sbg_organisation_acceptances', 'DELETE') as app_delete,
         exists (
           select 1 from pg_trigger
            where tgname = 'sbg_organisation_acceptances_immutable'
              and tgenabled = 'O'
              and not tgisinternal
         ) as immutable_trigger,
         exists (
           select 1 from pg_trigger
            where tgname = 'sbg_organisation_acceptances_no_truncate'
              and tgenabled = 'O'
              and not tgisinternal
         ) as truncate_trigger`,
    )
  ).rows[0];
  const orgUpdate = (
    await client.query(
      "select has_table_privilege('aether_app', 'public.sbg_organisations', 'UPDATE') as app_org_update",
    )
  ).rows[0];

  const organisations = (await client.query("select count(*)::int as n from sbg_organisations")).rows[0];
  const members = (await client.query("select count(*)::int as n from sbg_organisation_members")).rows[0];
  const classified = (
    await client.query("select count(*)::int as n from sbg_organisations where organisation_type is not null")
  ).rows[0];
  const acceptanceCount = (await client.query("select count(*)::int as n from sbg_organisation_acceptances")).rows[0];
  const licensed = (
    await client.query("select coalesce(sum(licensed_quantity), 0)::int as n from sbg_organisation_billing")
  ).rows[0];
  const allocations = (await client.query("select count(*)::int as n from sbg_property_licence_allocations")).rows[0];
  const bookings = (await client.query("select count(*)::int as n from bookings")).rows[0];
  const payments = (await client.query("select count(*)::int as n from sbg_booking_payments")).rows[0];
  const hotels = (
    await client.query("select code, status, organisation_id::text as organisation_id from hotels order by code")
  ).rows.map((row) => ({
    code: row.code,
    status: row.status,
    organisationId: row.organisation_id,
  }));
  const commerce = (
    await client.query(
      "select live_mapping_enabled, live_checkout_enabled from sbg_saas_commerce_locks where id = 1",
    )
  ).rows[0];

  return {
    database: identity?.database,
    currentUser: identity?.current_user,
    sessionUser: identity?.session_user,
    ledger,
    ledgerReadable,
    sourceMigrations,
    organisationCount: Number(organisations?.n ?? 0),
    memberCount: Number(members?.n ?? 0),
    classifiedCount: Number(classified?.n ?? 0),
    acceptanceCount: Number(acceptanceCount?.n ?? 0),
    licensedQuantity: Number(licensed?.n ?? 0),
    allocationCount: Number(allocations?.n ?? 0),
    bookingCount: Number(bookings?.n ?? 0),
    paymentCount: Number(payments?.n ?? 0),
    hotels,
    commerce: {
      present: Boolean(commerce),
      liveMapping: bool(commerce?.live_mapping_enabled),
      liveCheckout: bool(commerce?.live_checkout_enabled),
    },
    acceptance: {
      immutableTrigger: acceptance?.immutable_trigger === true,
      truncateTrigger: acceptance?.truncate_trigger === true,
      appSelect: acceptance?.app_select === true,
      appInsert: acceptance?.app_insert === true,
      appUpdate: acceptance?.app_update === true,
      appDelete: acceptance?.app_delete === true,
    },
    onboarding: {
      target,
      classify,
      accept,
      read,
      appOrgUpdate: orgUpdate?.app_org_update === true,
      classifyForUpdate: /for update/i.test(classifyBody),
      acceptTermsToken: /'terms-v1'/.test(acceptBody),
      acceptConflict: /on conflict \(organisation_id, accepted_by_user_id, agreement_version\) do nothing/i.test(acceptBody),
      classifyWritesAcceptance: /insert\s+into\s+(public\.)?sbg_organisation_acceptances/i.test(classifyBody),
      readWrites: /insert\s+into|update\s+public|delete\s+from/i.test(readBody),
      bodyHotel: /insert\s+into\s+(public\.)?hotels/i.test(allBody),
      bodyBillingWrite: /insert\s+into\s+(public\.)?sbg_organisation_billing/i.test(allBody),
      bodyStripe: /stripe/i.test(allBody),
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
  const pool = new pg.Pool({
    connectionString: ownerUrl,
    max: 1,
    application_name: "sbg-0034-apply",
    statement_timeout: 30000,
  });
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
      return await inspect0034State(client, sourceMigrations);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

async function apply0034OnOwner(ownerUrl, sql, sourceMigrations, before) {
  return withOwner(ownerUrl, (client) =>
    apply0034Transaction({
      sql,
      before,
      query: (text, params) => client.query(text, params),
      inspect: () => inspect0034State(client, sourceMigrations),
    }),
  );
}

async function main() {
  const ownerUrl = ownerUrlFromEnv(process.env);
  const confirmation = process.env.CP3005E2D2C1_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  say("note: classification functions only — no organisation insert, no acceptance row, no hotel, no Stripe");

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
  say(`0034 digest: ${file.digest}`);
  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUse0034({
    env: process.env,
    confirmation,
    file,
    sourceChecksums,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    mutate: ({ sql, before }) => apply0034OnOwner(ownerUrl, sql, sourceMigrations, before),
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
