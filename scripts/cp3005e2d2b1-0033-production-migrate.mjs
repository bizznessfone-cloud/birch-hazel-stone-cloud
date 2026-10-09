#!/usr/bin/env node
/**
 * CP30.05E-2D-2B.1 — single-use production controller for 0033 only.
 *
 * Applies migrations/0033_cp3005e2d2b_founding_organisation.sql and nothing else.
 * Does not insert an organisation, a membership, a hotel, billing, allocation,
 * or an acceptance. Does not call Stripe. Does not change commerce.
 * Never uses DATABASE_URL. Never prints secrets.
 * Does not invoke the generic production migrator or any historical controller.
 *
 * REQUIRED_LEDGER is the frozen pre-apply pin (0001–0032). It must not follow
 * Gate B after 0033 is accepted. Re-running a valid installed contract must
 * return "0033 ALREADY APPLIED — NO MUTATION" and must not rewrite SQL.
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

export const TARGET_MIGRATION = "0033_cp3005e2d2b_founding_organisation.sql";
export const TARGET_DIGEST =
  "8880dbf93aa416e393af621957e3170da6390a6e3aef792d68fe97b709c22875";
export const REQUIRED_CONFIRMATION = "APPLY-0033";
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
];

export const REVIEWED_DIGESTS = {
  ...PRIOR_REVIEWED_DIGESTS,
  [TARGET_MIGRATION]: TARGET_DIGEST,
};

export const AUTHORISED = "GATE PASS — 0033 AUTHORISED";
export const ALREADY_APPLIED = "0033 ALREADY APPLIED — NO MUTATION";
export const APPLIED_VERIFIED = "GATE PASS — 0033 APPLIED AND VERIFIED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const DIGEST_BLOCKED = "BLOCKED — 0033 DIGEST MISMATCH";
export const REVIEWED_DIGEST_BLOCKED = "BLOCKED — REVIEWED MIGRATION DIGEST MISMATCH";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const APPLY_FAILED = "BLOCKED — 0033 APPLICATION FAILED";
export const UNAUTHORISED_MIGRATION = "BLOCKED — UNAUTHORISED MIGRATION";
export const PARTIAL_BLOCKED = "BLOCKED — 0033 PARTIAL / LEDGER SPLIT";
export const CONTRACT_BLOCKED = "BLOCKED — 0033 FOUNDING CONTRACT INVALID";
export const IDENTITY_BLOCKED = "BLOCKED — DATABASE IDENTITY MISMATCH";
export const OWNER_BLOCKED = "BLOCKED — OWNER IDENTITY MISMATCH";

const ALLOWED_LEDGER = new Set([...REQUIRED_LEDGER, TARGET_MIGRATION]);
const FUNCTION_ARGS = "p_user_id text, p_name text";
const SEARCH_PATH = "pg_catalog, public";

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

export function contractFailures(facts) {
  const founding = facts?.founding ?? {};
  const failures = [];
  if (founding.present !== true) failures.push("function-absent");
  if (founding.securityDefiner !== true) failures.push("security-definer");
  if (founding.args !== FUNCTION_ARGS) failures.push("signature");
  if (founding.searchPath !== SEARCH_PATH) failures.push("search-path");
  if (founding.owner !== EXPECTED_OWNER) failures.push("function-owner");
  if (founding.appExecute !== true) failures.push("app-execute");
  if (founding.runtimeExecute !== false) failures.push("runtime-execute");
  if (founding.publicExecute !== false) failures.push("public-execute");
  if (founding.appOrgSelect !== true) failures.push("app-org-select");
  if (founding.appOrgInsert !== false) failures.push("app-org-insert");
  if (founding.appOrgUpdate !== false) failures.push("app-org-update");
  if (founding.appOrgDelete !== false) failures.push("app-org-delete");
  if (founding.appMemberSelect !== true) failures.push("app-member-select");
  if (founding.appMemberInsert !== false) failures.push("app-member-insert");
  if (founding.appMemberUpdate !== false) failures.push("app-member-update");
  if (founding.appMemberDelete !== false) failures.push("app-member-delete");
  if (founding.createdByIndex !== true) failures.push("created-by-index");
  if (founding.createdByUnique !== false) failures.push("created-by-unique");
  if (founding.userIdUnique !== false) failures.push("user-id-unique");
  if (founding.bodyForUpdate !== true) failures.push("body-for-update");
  if (founding.bodyMember !== true) failures.push("body-member");
  if (founding.bodyBilling !== true) failures.push("body-billing");
  if (founding.bodyHotel !== false) failures.push("body-hotel");
  if (founding.bodyBillingWrite !== false) failures.push("body-billing-write");
  if (founding.bodyAcceptance !== false) failures.push("body-acceptance");
  if (founding.bodyStripe !== false) failures.push("body-stripe");
  if (founding.bodyTypeAssign !== false) failures.push("body-type-assign");
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
  if (Number(facts?.organisationCount ?? -1) !== Number(before?.organisationCount ?? -2)) {
    failures.push("organisation-count");
  }
  if (Number(facts?.memberCount ?? -1) !== Number(before?.memberCount ?? -2)) {
    failures.push("member-count");
  }
  if (Number(facts?.classifiedCount ?? -1) !== Number(before?.classifiedCount ?? -2)) {
    failures.push("classified-rows");
  }
  if (Number(facts?.acceptanceCount ?? -1) !== Number(before?.acceptanceCount ?? -2)) {
    failures.push("acceptance-rows");
  }
  if (Number(facts?.licensedQuantity ?? -1) !== Number(before?.licensedQuantity ?? -2)) {
    failures.push("licensed-quantity");
  }
  if (Number(facts?.allocationCount ?? -1) !== Number(before?.allocationCount ?? -2)) {
    failures.push("allocations");
  }
  if (JSON.stringify(facts?.hotels ?? null) !== JSON.stringify(before?.hotels ?? null)) {
    failures.push("hotels");
  }
  if (JSON.stringify(facts?.commerce ?? null) !== JSON.stringify(before?.commerce ?? null)) {
    failures.push("commerce");
  }
  return failures;
}

export function evaluate0033Baseline(facts, file) {
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

export function evaluate0033Aftermath(facts, before) {
  const failures = [];
  const { pending, appliedCount, unexpectedApplied, unexpectedPending } = ledgerState(facts);
  if (appliedCount !== 1) failures.push("0033-ledger");
  if (!sameList(facts?.ledger, [...REQUIRED_LEDGER, TARGET_MIGRATION])) failures.push("ledger-contents");
  if (unexpectedApplied.length || unexpectedPending.length) failures.push("unexpected-ledger");
  if (pending.length) failures.push("pending-remain");
  failures.push(...contractFailures(facts));
  failures.push(...platformFailures(facts));
  failures.push(...snapshotFailures(facts, before));
  if (failures.length) {
    return { ok: false, verdict: POST_BLOCKED, failures, pending, migrated: false, committed: false };
  }
  return { ok: true, verdict: APPLIED_VERIFIED, pending: [], migrated: true, committed: true };
}

export async function apply0033Transaction({ sql, before, query, inspect }) {
  if (typeof query !== "function" || typeof inspect !== "function") {
    throw new Error("BLOCKED — 0033 EXECUTOR MISSING");
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
    const aftermath = evaluate0033Aftermath(after, before);
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

export async function runSingleUse0033({ env, confirmation, file, sourceChecksums, loadFacts, mutate }) {
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
  const baseline = evaluate0033Baseline({ ...before, confirmation, env, ownerUrl }, file);
  if (!baseline.ok || baseline.alreadyApplied) {
    return { ...baseline, preflight: before, migrated: false };
  }
  if (typeof mutate !== "function") return blocked("BLOCKED — 0033 EXECUTOR MISSING");
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
  const founding = facts?.founding ?? {};
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
  say(`function_present: ${founding.present === true}`);
  say(`security_definer: ${founding.securityDefiner === true}`);
  say(`function_args: ${founding.args ?? ""}`);
  say(`search_path: ${founding.searchPath ?? ""}`);
  say(`function_owner: ${founding.owner ?? ""}`);
  say(`aether_app_execute: ${founding.appExecute === true}`);
  say(`aether_runtime_execute: ${founding.runtimeExecute === true}`);
  say(`public_execute: ${founding.publicExecute === true}`);
  say(`aether_app_org_insert: ${founding.appOrgInsert === true}`);
  say(`aether_app_member_insert: ${founding.appMemberInsert === true}`);
  say(`created_by_index: ${founding.createdByIndex === true}`);
  say(`created_by_unique: ${founding.createdByUnique === true}`);
  say(`user_id_unique: ${founding.userIdUnique === true}`);
  say("stripe: UNTOUCHED");
  say("commerce: UNTOUCHED");
}

function bool(value) {
  return value === true;
}

export async function inspect0033State(client, sourceMigrations) {
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

  const fn = (
    await client.query(
      `select p.oid,
              p.prosecdef,
              pg_get_userbyid(p.proowner) as owner,
              pg_get_function_identity_arguments(p.oid) as args,
              pg_get_functiondef(p.oid) as def,
              p.proacl::text as acl,
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
          and p.proname = 'sbg_ensure_founding_organisation'
        order by p.oid`,
    )
  ).rows;
  const one = fn.length === 1 ? fn[0] : null;
  const body = String(one?.def ?? "");
  const executable = body.replace(/--.*$/gm, "");
  const privileges = (
    await client.query(
      `select has_table_privilege('aether_app', 'public.sbg_organisations', 'SELECT') as org_select,
              has_table_privilege('aether_app', 'public.sbg_organisations', 'INSERT') as org_insert,
              has_table_privilege('aether_app', 'public.sbg_organisations', 'UPDATE') as org_update,
              has_table_privilege('aether_app', 'public.sbg_organisations', 'DELETE') as org_delete,
              has_table_privilege('aether_app', 'public.sbg_organisation_members', 'SELECT') as member_select,
              has_table_privilege('aether_app', 'public.sbg_organisation_members', 'INSERT') as member_insert,
              has_table_privilege('aether_app', 'public.sbg_organisation_members', 'UPDATE') as member_update,
              has_table_privilege('aether_app', 'public.sbg_organisation_members', 'DELETE') as member_delete`,
    )
  ).rows[0];
  const createdBy = (
    await client.query(
      `select i.indisunique
         from pg_class ic
         join pg_index i on i.indexrelid = ic.oid
         join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'sbg_organisations'
          and ic.relname = 'sbg_organisations_created_by_idx'`,
    )
  ).rows[0];
  const userUnique = (
    await client.query(
      `select exists (
         select 1
           from pg_index i
           join pg_class c on c.oid = i.indrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname = 'sbg_organisation_members'
            and i.indisunique
            and i.indpred is null
            and (
              select array_agg(a.attname::text order by a.attname)
                from unnest(i.indkey) k
                join pg_attribute a on a.attrelid = c.oid and a.attnum = k
               where k <> 0
            ) = array['user_id']::text[]
       ) as unique_user`,
    )
  ).rows[0];
  const organisations = (await client.query("select count(*)::int as n from sbg_organisations")).rows[0];
  const members = (await client.query("select count(*)::int as n from sbg_organisation_members")).rows[0];
  const classified = (
    await client.query("select count(*)::int as n from sbg_organisations where organisation_type is not null")
  ).rows[0];
  const acceptance = (
    await client.query("select count(*)::int as n from sbg_organisation_acceptances")
  ).rows[0];
  const licensed = (
    await client.query("select coalesce(sum(licensed_quantity), 0)::int as n from sbg_organisation_billing")
  ).rows[0];
  const allocations = (
    await client.query("select count(*)::int as n from sbg_property_licence_allocations")
  ).rows[0];
  const hotels = (
    await client.query(
      "select code, status, organisation_id::text as organisation_id from hotels order by code",
    )
  ).rows.map((row) => ({
    code: row.code,
    status: row.status,
    organisationId: row.organisation_id,
  }));
  const commerce = (
    await client.query(
      `select live_mapping_enabled, live_checkout_enabled
         from sbg_saas_commerce_locks
        where id = 1`,
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
    acceptanceCount: Number(acceptance?.n ?? 0),
    licensedQuantity: Number(licensed?.n ?? 0),
    allocationCount: Number(allocations?.n ?? 0),
    hotels,
    commerce: {
      present: Boolean(commerce),
      liveMapping: bool(commerce?.live_mapping_enabled),
      liveCheckout: bool(commerce?.live_checkout_enabled),
    },
    founding: {
      present: Boolean(one),
      securityDefiner: one?.prosecdef === true,
      args: one ? String(one.args ?? "") : "",
      searchPath: one ? String(one.search_path ?? "") : "",
      owner: one ? String(one.owner ?? "") : "",
      appExecute: one?.app_exec === true,
      runtimeExecute: one?.runtime_exec === true,
      publicExecute: one ? one.public_exec === true : false,
      appOrgSelect: privileges?.org_select === true,
      appOrgInsert: privileges?.org_insert === true,
      appOrgUpdate: privileges?.org_update === true,
      appOrgDelete: privileges?.org_delete === true,
      appMemberSelect: privileges?.member_select === true,
      appMemberInsert: privileges?.member_insert === true,
      appMemberUpdate: privileges?.member_update === true,
      appMemberDelete: privileges?.member_delete === true,
      createdByIndex: Boolean(createdBy),
      createdByUnique: createdBy ? createdBy.indisunique === true : false,
      userIdUnique: userUnique?.unique_user === true,
      bodyForUpdate: /for update/i.test(executable),
      bodyMember: /'member'/.test(executable),
      bodyBilling: /billing_authority/.test(executable),
      bodyHotel: /insert\s+into\s+(public\.)?hotels/i.test(executable),
      bodyBillingWrite: /insert\s+into\s+(public\.)?sbg_organisation_billing/i.test(executable),
      bodyAcceptance: /sbg_organisation_acceptances/i.test(executable),
      bodyStripe: /stripe/i.test(executable),
      bodyTypeAssign: /organisation_type\s*=/i.test(executable),
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
    application_name: "sbg-0033-apply",
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
      return await inspect0033State(client, sourceMigrations);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

async function apply0033OnOwner(ownerUrl, sql, sourceMigrations, before) {
  return withOwner(ownerUrl, (client) =>
    apply0033Transaction({
      sql,
      before,
      query: (text, params) => client.query(text, params),
      inspect: () => inspect0033State(client, sourceMigrations),
    }),
  );
}

async function main() {
  const ownerUrl = ownerUrlFromEnv(process.env);
  const confirmation = process.env.CP3005E2D2B1_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  say("note: founding function only — no organisation insert, no hotel, no Stripe, no commerce change");

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
  say(`0033 digest: ${file.digest}`);
  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUse0033({
    env: process.env,
    confirmation,
    file,
    sourceChecksums,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    mutate: ({ sql, before }) => apply0033OnOwner(ownerUrl, sql, sourceMigrations, before),
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
