#!/usr/bin/env node
/**
 * A3-M36 read-only fixture-recovery preflight. Manual. Does not install SQL.
 *
 * Reports the approval catalogue, including fixture-not-legal, and the rows
 * the existing recovery procedure would delete, preserve, or refuse.
 * The session is begin read only. Triggers and foreign keys are not changed.
 * Recovery and concurrency are not started.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { redact } from "./production-db-preflight.mjs";
import {
  EXPECTED_BRANCH,
  EXPECTED_DATABASE,
  EXPECTED_PROJECT,
  EXPECTED_ROLE,
  FORBIDDEN_ENV,
  ISOLATED_OWNER_ENV,
  directOwnerUrl,
  identityFailures,
} from "./a3-m36-isolated-preflight.mjs";
import { EXPECTED_ENDPOINT, MIGRATION_36 } from "./a3-m36-0035-equivalence.mjs";
import { endpointPinFailures } from "./a3-m36-isolated-install.mjs";
import { concurrencyLedgerOk } from "./a3-m36-isolated-concurrency.mjs";
import {
  CLEANUP_ORDER,
  EXPECTED_EDGES,
  FIXTURE_VERSIONS,
  cleanupForeignKeys,
  dependencyViolations,
  planFixtureCleanup,
} from "./a3-m36-isolated-cleanup.mjs";

export const PREFLIGHT_CONFIRMATION = "PREFLIGHT-0036-RECOVERY";
export const CONFIRMATION_ENV = "A3M36_RECOVERY_PREFLIGHT_CONFIRMATION";
export const VERDICT_SAFE = "RECOVERY PREFLIGHT — SAFE FOR RECOVERY AND CONCURRENCY";
export const VERDICT_RECOVERY_ONLY = "RECOVERY PREFLIGHT — RECOVERY SAFE, CONCURRENCY NOT SAFE";
export const VERDICT_NOT_SAFE = "RECOVERY PREFLIGHT — NOT SAFE";
export const NOT_LEGAL = "fixture-not-legal";

export const EXPECTED_DELETE = {
  "hotel_provider_agreements→hotels": "r",
  "hotel_provider_agreements→providers": "r",
  "app_hotel_accounts→hotels": "c",
  "app_hotel_accounts→user": "c",
  "hotels→sbg_organisations": "r",
  "sbg_organisation_members→sbg_organisations": "r",
  "sbg_organisation_members→user": "r",
  "sbg_organisation_acceptances→sbg_organisations": "r",
  "sbg_organisation_acceptances→user": "r",
  "sbg_organisations→user": "r",
};

const IDENTITY_SQL = `select current_database() as database,
       current_user,
       session_user,
       current_setting('neon.project_id', true) as project_id,
       current_setting('neon.branch_id', true) as branch_id,
       current_setting('neon.endpoint_id', true) as endpoint_id`;

const CATALOGUE_SQL = `-- a3m36-approval-catalogue
select agreement_version, effective
  from public.sbg_approved_property_agreement_versions
 order by agreement_version`;

const ACCEPTANCE_SQL = `-- a3m36-acceptance-versions
select agreement_version, count(*)::int as n
  from public.sbg_organisation_acceptances
 group by agreement_version
 order by agreement_version`;

const OBJECT_SQL = `-- a3m36-0036-objects
select
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'sbg_organisations_one_founding_creator_uidx') as creator_index,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sbg_approved_property_agreement_versions' and column_name = 'effective') as effective_column,
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'sbg_approved_property_agreement_versions_one_effective_uidx') as effective_index,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'sbg_create_organisation_for_user' and position('founding organisation already exists' in p.prosrc) > 0) as rejects_second,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'sbg_create_founding_property_for_user' and position('and v.effective' in p.prosrc) > 0) as requires_effective`;

const LEDGER_SQL = `-- a3m36-ledger
select name from public._migrations order by name`;

const DUPLICATE_SQL = `-- a3m36-duplicate-creators
select count(*)::int as n
  from (select 1 from public.sbg_organisations group by created_by_user_id having count(*) > 1) d`;

function sayLine(say, line) {
  const safe = redact(String(line)).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host");
  say(safe);
  return safe;
}

function client(connectionString) {
  return new pg.Client({
    connectionString: directOwnerUrl(connectionString),
    application_name: "a3m36-recovery-preflight",
    statement_timeout: 30000,
    query_timeout: 35000,
  });
}

function mapIdentity(row) {
  return {
    projectId: String(row?.project_id ?? "").trim(),
    branchId: String(row?.branch_id ?? "").trim(),
    endpointId: String(row?.endpoint_id ?? "").trim(),
    database: String(row?.database ?? "").trim(),
    currentUser: String(row?.current_user ?? "").trim(),
    sessionUser: String(row?.session_user ?? "").trim(),
  };
}

function edgeKey(row) {
  return `${row.childTable}→${row.parentTable}`;
}

export function foreignKeyStatus(rows) {
  const failures = [];
  const seen = new Set();
  for (const row of rows ?? []) {
    if (row?.malformed) failures.push(`malformed ${row.constraint || row.childTable || "foreign-key"}`);
  }
  for (const edge of EXPECTED_EDGES) {
    const key = `${edge.child}→${edge.parent}`;
    const matches = (rows ?? []).filter((row) => row.childTable === edge.child
      && row.parentTable === edge.parent
      && row.childSchema === "public"
      && !row.malformed
      && row.childColumns?.length === 1
      && row.parentColumns?.length === 1
      && row.childColumns[0] === edge.column
      && row.parentColumns[0] === "id");
    if (matches.length === 0) {
      failures.push(`missing ${key}.${edge.column}`);
      continue;
    }
    if (matches.length > 1) {
      failures.push(`duplicate ${key}.${edge.column}`);
      continue;
    }
    seen.add(key);
    const action = String(matches[0].deleteAction ?? "");
    if (action !== EXPECTED_DELETE[key]) failures.push(`action ${key} ${action || "unknown"}`);
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)], seen: [...seen] };
}

function refusesFixture(plan) {
  return (plan?.failures ?? []).some((item) => /REFUSING|CROSSES|NON-FIXTURE|NON-MARKER/.test(item));
}

export function rowDisposition(table, plan) {
  if ((plan?.identified?.[table] ?? 0) < 1) return "untouched";
  if (plan.prediction === "would-commit" && (plan.targeted?.[table] ?? 0) > 0) return "would-delete";
  if (refusesFixture(plan)) return "refused";
  return "preserve";
}

export function approvalDisposition(version, plan) {
  if (version === "terms-v1") return "refused";
  if (!FIXTURE_VERSIONS.includes(version)) return "untouched";
  return rowDisposition("sbg_approved_property_agreement_versions", plan);
}

function removedByRecovery(version, plan) {
  return plan?.prediction === "would-commit" && FIXTURE_VERSIONS.includes(version);
}

function readOnlyStatement(sql) {
  const text = String(sql ?? "").replace(/^\s*(--[^\n]*\n\s*)*/, "").trim();
  return /^(begin\s+read\s+only|rollback|select)\b/i.test(text);
}

function readOnlyClient(db) {
  return {
    query(text, params) {
      if (!readOnlyStatement(text)) throw new Error("BLOCKED — NON READ ONLY STATEMENT");
      return db.query(text, params);
    },
    end: () => db.end?.(),
  };
}

export async function runRecoveryPreflight({ env, connect = client, say = () => {} }) {
  const lines = [];
  const log = (line) => lines.push(sayLine(say, line));
  const finish = (exitCode) => ({ exitCode, lines });
  const confirmation = String(env?.[CONFIRMATION_ENV] ?? "");
  const isolated = String(env?.[ISOLATED_OWNER_ENV] ?? "").trim();
  log(`confirmation: ${confirmation === PREFLIGHT_CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  log(`${ISOLATED_OWNER_ENV}: ${isolated ? "PRESENT" : "ABSENT"}`);
  log("writes: none");
  log("install_stage: not-invoked");
  log("recovery_stage: not-invoked");
  log("concurrency_stage: not-invoked");
  if (confirmation !== PREFLIGHT_CONFIRMATION) {
    log("BLOCKED — CONFIRMATION PHRASE INVALID");
    return finish(1);
  }
  for (const name of FORBIDDEN_ENV) {
    if (String(env?.[name] ?? "").trim()) {
      log(`BLOCKED — ${name} must not be set`);
      return finish(1);
    }
  }
  if (!isolated) {
    log("BLOCKED — AETHER_0036_ISOLATED_OWNER_URL is absent. No database was opened.");
    return finish(1);
  }
  const hostFailures = endpointPinFailures(isolated);
  if (hostFailures.length) {
    log(`BLOCKED — CONNECTION ${hostFailures.join(",")}`);
    return finish(1);
  }

  let db;
  try {
    db = await connect(isolated);
    if (typeof db.connect === "function") await db.connect();
  } catch (err) {
    log(`BLOCKED — CONNECT FAILED ${redact(err?.message || err).split("\n")[0].slice(0, 180)}`);
    return finish(1);
  }
  const rollback = async () => {
    try { await db.query("rollback"); } catch { /* no open read */ }
  };
  try {
    db = readOnlyClient(db);
    await db.query("begin read only");
    const identity = mapIdentity((await db.query(IDENTITY_SQL)).rows[0]);
    const hostname = new URL(directOwnerUrl(isolated)).hostname.toLowerCase();
    const failures = identityFailures(identity, hostname);
    if (identity.endpointId !== EXPECTED_ENDPOINT) failures.push("endpoint-pin");
    log(`neon_project: ${identity.projectId || "unproven"}`);
    log(`neon_branch: ${identity.branchId || "unproven"}`);
    log(`neon_endpoint: ${identity.endpointId || "unproven"}`);
    log(`database: ${identity.database || "unproven"}`);
    log(`role: ${identity.currentUser || "unproven"}`);
    if (failures.length || identity.projectId !== EXPECTED_PROJECT || identity.branchId !== EXPECTED_BRANCH || identity.database !== EXPECTED_DATABASE || identity.currentUser !== EXPECTED_ROLE || identity.sessionUser !== EXPECTED_ROLE) {
      await rollback();
      log(`BLOCKED — ISOLATED IDENTITY ${failures.join(",") || "mismatch"}`);
      return finish(1);
    }
    log("isolated_identity: PASS");

    const plan = await planFixtureCleanup(db);
    const keys = await cleanupForeignKeys(db);
    const fk = foreignKeyStatus(keys);
    const catalogue = (await db.query(CATALOGUE_SQL)).rows.map((row) => ({
      agreement_version: String(row.agreement_version),
      effective: row.effective === true,
    }));
    const acceptanceCounts = new Map((await db.query(ACCEPTANCE_SQL)).rows.map((row) => [String(row.agreement_version), Number(row.n)]));
    const objects = (await db.query(OBJECT_SQL)).rows[0] ?? {};
    const ledger = (await db.query(LEDGER_SQL)).rows.map((row) => String(row.name));
    const duplicates = Number((await db.query(DUPLICATE_SQL)).rows[0]?.n ?? 0);
    await rollback();

    const installed = concurrencyLedgerOk(ledger)
      && objects.creator_index === true
      && objects.effective_column === true
      && objects.effective_index === true
      && objects.rejects_second === true
      && objects.requires_effective === true;
    log(`0036_installed: ${installed}`);
    log(`ledger_0036: ${ledger.includes(MIGRATION_36) ? "present" : "absent"}`);
    log(`duplicate_creators: ${duplicates}`);
    log(`trigger_guard: ${plan.guards.ok ? "enabled" : plan.guards.verdict}`);
    log(`deletion_order: ${CLEANUP_ORDER.join(",")}`);
    log(`deletion_order_status: ${dependencyViolations().length === 0 && plan.orderViolations.length === 0 ? "pass" : "fail"}`);
    for (const violation of plan.orderViolations) log(`deletion_order_violation: ${violation}`);
    log(`foreign_keys: ${fk.ok ? "pass" : "fail"}`);
    for (const failure of fk.failures) log(`foreign_key_failure: ${failure}`);
    for (const edge of EXPECTED_EDGES) {
      const key = `${edge.child}→${edge.parent}`;
      log(`foreign_key ${edge.child}.${edge.column} -> ${edge.parent} expected=${EXPECTED_DELETE[key] === "c" ? "cascade" : "restrict"} status=${fk.seen.includes(key) ? "present" : "absent"}`);
    }
    log(`recovery_prediction: ${plan.prediction}`);
    for (const failure of plan.failures) log(`recovery_refusal: ${failure}`);
    for (const ref of plan.references) {
      log(`unexpected_reference: ${ref.childTable}.${ref.childColumns?.[0]} -> ${ref.parentTable} rows=${ref.count}`);
    }
    for (const table of CLEANUP_ORDER) {
      if (table === "sbg_approved_property_agreement_versions") continue;
      const rows = table === "user" ? plan.graph.users
        : table === "sbg_organisations" ? plan.graph.orgs
        : table === "sbg_organisation_members" ? plan.graph.members
        : table === "sbg_organisation_acceptances" ? plan.graph.acceptances
        : table === "hotels" ? plan.graph.hotels
        : table === "providers" ? plan.graph.providers
        : table === "hotel_provider_agreements" ? plan.graph.agreements
        : plan.graph.accounts;
      const disposition = rowDisposition(table, plan);
      for (const row of rows ?? []) log(`${disposition} ${table} ${row.id ?? `${row.user_id}:${row.hotel_id}`}`);
      if ((rows ?? []).length === 0) log(`${disposition} ${table} rows=0`);
    }
    const versions = new Set(catalogue.map((row) => row.agreement_version));
    for (const version of acceptanceCounts.keys()) versions.add(version);
    for (const version of [...versions].sort()) {
      const row = catalogue.find((item) => item.agreement_version === version);
      const acceptances = acceptanceCounts.get(version) ?? 0;
      const disposition = approvalDisposition(version, plan);
      log(`approval ${version} effective=${row ? row.effective : "absent"} acceptances=${acceptances} recovery=${disposition}`);
    }
    if (versions.size === 0) log("approval_catalogue: empty");
    log(`fixture_not_legal: ${versions.has(NOT_LEGAL) ? "present" : "absent"}`);
    const remaining = catalogue.filter((row) => !removedByRecovery(row.agreement_version, plan));
    const recoverySafe = fk.ok
      && plan.guards.ok
      && plan.orderViolations.length === 0
      && plan.failures.length === 0
      && (plan.prediction === "clean" || plan.prediction === "would-commit")
      && remaining.length === 0;
    const concurrencySafe = recoverySafe && plan.prediction === "clean" && installed && duplicates === 0 && catalogue.length === 0;
    log(`recovery_safe: ${recoverySafe}`);
    log(`concurrency_safe: ${concurrencySafe}`);
    log(`approval_rows_now: ${catalogue.length}`);
    log(`approval_rows_after_recovery: ${remaining.length}`);
    const verdict = recoverySafe && concurrencySafe ? VERDICT_SAFE : recoverySafe ? VERDICT_RECOVERY_ONLY : VERDICT_NOT_SAFE;
    log(verdict);
    return finish(0);
  } catch (err) {
    await rollback();
    log(`BLOCKED — PREFLIGHT FAILED ${redact(err?.message || err).split("\n")[0].slice(0, 180)}`);
    return finish(1);
  } finally {
    try { await db.end?.(); } catch { /* closing must not hide the verdict */ }
  }
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runRecoveryPreflight({ env: process.env, say: (line) => console.log(line) })
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((err) => {
      console.log(redact(err?.message || err).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host"));
      process.exitCode = 1;
    });
}
