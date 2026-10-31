#!/usr/bin/env node
/**
 * 0035/0036 production admission — REVIEW-ONLY preflight.
 * This script NEVER executes migrations or SQL writes. No fallback DATABASE_URL.
 * A separate reviewed, explicitly authorised single-use executor is required.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ACCEPTED_LEDGER } from "./production-db-preflight.mjs";

export const EXPECTED = Object.freeze({
  project: "quiet-sound-53513710",
  branch: "br-green-darkness-b1k7wkue",
  endpoint: "ep-withered-haze-b1fd9hse",
  database: "neondb",
  role: "sbg_a3_preflight_ro",
  migration35: "0035_cp3005e2d2d_founding_property.sql",
  migration36: "0036_cp3005e2d2d_founding_integrity.sql",
  digest35: "80d1d3ec68eebfba0bcfbe07ac3c3dd1ade11d7d0466be9264cf0f28d27def67",
  digest36: "fb300bb17c8e9758700cf2fd09aa355b0293b5cd84c692e2913835876ece18fc",
});
const here = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateTarget(env) {
  const failures = [];
  if (env.SBG_ADMISSION_PROJECT_ID !== EXPECTED.project) failures.push("project");
  if (env.SBG_ADMISSION_BRANCH_ID !== EXPECTED.branch) failures.push("branch");
  if (env.SBG_ADMISSION_ENDPOINT_ID !== EXPECTED.endpoint) failures.push("endpoint");
  if (!env.A3_PREFLIGHT_READONLY_URL) return [...failures, "missing-readonly-url"];
  if (env.DATABASE_URL || env.NEON_API_KEY) failures.push("forbidden-ambient-database-credentials");
  try {
    const u = new URL(env.A3_PREFLIGHT_READONLY_URL);
    if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") failures.push("protocol");
    if (decodeURIComponent(u.username) !== EXPECTED.role) failures.push("role");
    if (u.password.length === 0) failures.push("missing-readonly-password");
    if (decodeURIComponent(u.pathname.slice(1)) !== EXPECTED.database) failures.push("database");
    if (u.hostname.toLowerCase() !== EXPECTED.endpoint + ".c-5.eu-central-1.aws.neon.tech") failures.push("direct-endpoint-host");
    if (u.hostname.includes("-pooler")) failures.push("pooled-endpoint");
    if (u.searchParams.get("sslmode") !== "require") failures.push("ssl-required");
    if (u.searchParams.has("options") || u.searchParams.has("service")) failures.push("unexpected-connection-options");
  } catch { failures.push("invalid-readonly-url"); }
  return failures;
}

export function validateLedger(names) {
  const ledger = [...names].sort();
  const expected = [...ACCEPTED_LEDGER].sort();
  if (ledger.length !== expected.length || new Set(ledger).size !== expected.length) return ["ledger-cardinality"];
  const failures = expected.flatMap((name,i)=>ledger[i] === name ? [] : ["ledger-mismatch-"+String(i+1).padStart(4,"0")]);
  if (ledger.some(n=>n.startsWith("0035_") || n.startsWith("0036_"))) failures.push("already-applied");
  return failures;
}

const isZero = value => value === 0 || value === "0";

export function validateState(state) {
  const errors = [];
  if (state.current_database !== EXPECTED.database) errors.push("database-identity");
  if (state.neon_project_id !== EXPECTED.project) errors.push("live-project-identity");
  if (state.neon_branch_id !== EXPECTED.branch) errors.push("live-branch-identity");
  if (state.neon_endpoint_id !== EXPECTED.endpoint) errors.push("live-endpoint-identity");
  if (state.current_user !== EXPECTED.role || state.session_user !== EXPECTED.role) errors.push("readonly-role-identity");
  if (!isZero(state.duplicate_creator_groups)) errors.push("duplicate-creators");
  if (!isZero(state.agreement_acceptance_count)) errors.push("unexpected-acceptances");
  if (!isZero(state.approved_table_exists)) errors.push("approved-table-preexists");
  if (!isZero(state.creator_index_exists)) errors.push("creator-index-preexists");
  if (!isZero(state.effective_index_exists)) errors.push("effective-index-preexists");
  if (!isZero(state.effective_column_exists)) errors.push("effective-column-preexists");
  if (!isZero(state.property_function_exists)) errors.push("property-function-preexists");
  return errors;
}


export function validatePrivileges(p) {
  const failures = [];
  const falseOnly = ["rolsuper", "rolcreatedb", "rolcreaterole", "rolbypassrls", "database_create", "schema_create", "ledger_write", "organisations_write", "acceptances_write", "security_definer_execute"];
  for (const field of falseOnly) if (p?.[field] !== false) failures.push("privilege-" + field);
  if (p?.rolcanlogin !== true) failures.push("privilege-login");
  if (p?.rolinherit !== false) failures.push("privilege-inherit");
  if (!isZero(p?.membership_count)) failures.push("privilege-memberships");
  if (p?.database_connect !== true || p?.schema_usage !== true || p?.ledger_read !== true || p?.organisations_read !== true || p?.acceptances_read !== true) failures.push("privilege-required-read");
  return failures;
}

const privilegeQuery = `SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
  r.rolcanlogin, r.rolinherit,
  (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS membership_count,
  has_database_privilege(current_user, current_database(), 'CONNECT') AS database_connect,
  has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
  has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
  has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
  has_table_privilege(current_user, 'public._migrations', 'SELECT') AS ledger_read,
  has_table_privilege(current_user, 'public.sbg_organisations', 'SELECT') AS organisations_read,
  has_table_privilege(current_user, 'public.sbg_organisation_acceptances', 'SELECT') AS acceptances_read,
  has_table_privilege(current_user, 'public._migrations', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ledger_write,
  has_table_privilege(current_user, 'public.sbg_organisations', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS organisations_write,
  has_table_privilege(current_user, 'public.sbg_organisation_acceptances', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS acceptances_write,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege(current_user, p.oid, 'EXECUTE')) AS security_definer_execute
FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

export async function checkSource(read = readFile) {
  const files = [
    [EXPECTED.migration35, EXPECTED.digest35],
    [EXPECTED.migration36, EXPECTED.digest36],
  ];
  const failures = [];
  for (const [name, digest] of files) {
    const bytes = await read(resolve(here, "migrations", name));
    if (hash(bytes) !== digest) failures.push("digest-"+name);
  }
  return failures;
}

export async function runPreflight({env=process.env, connect}={}) {
  const failures = [...validateTarget(env), ...await checkSource()];
  if (failures.length) return {verdict:"BLOCKED", failures};
  const client = connect ? await connect(env.A3_PREFLIGHT_READONLY_URL) : new pg.Client({
    connectionString: env.A3_PREFLIGHT_READONLY_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 10000,
    ssl: {rejectUnauthorized:true},
  });
  let transactionOpen = false;
  try {
    if (!connect) await client.connect();
    await client.query("BEGIN READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    const state = (await client.query(`SELECT current_database() AS current_database, current_user AS current_user,
      session_user AS session_user,
      current_setting('neon.project_id', true) AS neon_project_id,
      current_setting('neon.branch_id', true) AS neon_branch_id,
      current_setting('neon.endpoint_id', true) AS neon_endpoint_id,
      (SELECT count(*) FROM (SELECT created_by_user_id FROM public.sbg_organisations GROUP BY created_by_user_id HAVING count(*) > 1) d) AS duplicate_creator_groups,
      (SELECT count(*) FROM public.sbg_organisation_acceptances)::int AS agreement_acceptance_count,
      (to_regclass('public.sbg_approved_property_agreement_versions') IS NOT NULL)::int AS approved_table_exists,
      (to_regclass('public.sbg_organisations_one_founding_creator_uidx') IS NOT NULL)::int AS creator_index_exists,
      (to_regclass('public.sbg_approved_property_agreement_versions_one_effective_uidx') IS NOT NULL)::int AS effective_index_exists,
      (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sbg_approved_property_agreement_versions' AND column_name = 'effective'))::int AS effective_column_exists,
      (EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'sbg_create_founding_property_for_user'))::int AS property_function_exists`)).rows[0];
    const ledger = (await client.query("SELECT name FROM public._migrations ORDER BY name")).rows.map(r=>r.name);
    const privilegeRows = (await client.query(privilegeQuery)).rows;
    const issues = [...validateState(state), ...validateLedger(ledger), ...validatePrivileges(privilegeRows.length === 1 ? privilegeRows[0] : null)];
    await client.query("ROLLBACK");
    transactionOpen = false;
    return {verdict:issues.length ? "BLOCKED" : "PREFLIGHT PASS — APPLY NOT AUTHORISED", failures:issues, ledgerCount:ledger.length};
  } finally {
    if (transactionOpen) { try { await client.query("ROLLBACK"); } catch { /* read-only rollback best effort */ } }
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPreflight().then(r=>{
    console.log(JSON.stringify(r));
    if (r.verdict === "BLOCKED") process.exitCode = 2;
  }).catch(()=>{
    console.error("BLOCKED — READ-ONLY PREFLIGHT ERROR (credentials and database errors redacted)");
    process.exitCode = 2;
  });
}
