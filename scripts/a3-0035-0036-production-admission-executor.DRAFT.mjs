#!/usr/bin/env node
/**
 * A3 0035/0036 production admission executor — INERT DRAFT, review only.
 * Not wired to any workflow; never execute before independent review and authorisation.
 */
import pg from "pg";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCEPTED_LEDGER } from "./production-db-preflight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TARGET = Object.freeze({
  project: "quiet-sound-53513710",
  branch: "br-green-darkness-b1k7wkue",
  endpoint: "ep-withered-haze-b1fd9hse",
  database: "neondb",
  role: "neondb_owner",
});
const migrations = [
  ["0035_cp3005e2d2d_founding_property.sql", "80d1d3ec68eebfba0bcfbe07ac3c3dd1ade11d7d0466be9264cf0f28d27def67"],
  ["0036_cp3005e2d2d_founding_integrity.sql", "fb300bb17c8e9758700cf2fd09aa355b0293b5cd84c692e2913835876ece18fc"],
];
const indexIntegrityQuery = "SELECT indexrelid::regclass::text AS index_name, indisunique, indisvalid, indisready FROM pg_index WHERE indexrelid IN ('public.sbg_organisations_one_founding_creator_uidx'::regclass, 'public.sbg_approved_property_agreement_versions_one_effective_uidx'::regclass)";
const effectiveColumnQuery = "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='sbg_approved_property_agreement_versions' AND column_name='effective'";
function validIntegrity(indexRows, columnRows) {
  const names = new Set(["sbg_organisations_one_founding_creator_uidx", "sbg_approved_property_agreement_versions_one_effective_uidx"]);
  return indexRows.length === 2 && indexRows.every(row => names.has(row.index_name) && row.indisunique === true && row.indisvalid === true && row.indisready === true)
    && columnRows.length === 1 && columnRows[0].data_type === "boolean" && columnRows[0].is_nullable === "NO" && columnRows[0].column_default === "false";
}
const digest = b => createHash("sha256").update(b).digest("hex");

export function validateEnvironment(env) {
  const failures = [];
  if (env.A3_PRODUCTION_APPLY_CONFIRMATION !== "APPLY-0035-0036-PRODUCTION-EXPLICIT-AUTHORISATION") failures.push("confirmation");
  if (env.DATABASE_URL || env.AETHER_DATABASE_OWNER_URL || env.A3_REHEARSAL_OWNER_URL || env.A3_COMMIT_REHEARSAL_OWNER_URL || env.NEON_API_KEY) failures.push("ambient-credentials");
  let url;
  try { url = new URL(env.A3_PRODUCTION_APPLY_OWNER_URL); }
  catch { return [...failures, "owner-url"]; }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) failures.push("protocol");
  if (decodeURIComponent(url.username) !== TARGET.role) failures.push("role");
  if (!url.password) failures.push("password");
  if (env.A3_PRODUCTION_APPROVAL_RECORD !== "APPROVED-0035-0036-PRODUCTION") failures.push("approval-record");
  // DRAFT hard-stop: cannot connect, transact or apply under any supplied credentials.
  failures.push("executor-not-certified-or-authorised");
  if (decodeURIComponent(url.pathname.slice(1)) !== TARGET.database) failures.push("database");
  if (url.hostname !== TARGET.endpoint + ".c-5.eu-central-1.aws.neon.tech") failures.push("endpoint");
  if (env.SBG_ADMISSION_PROJECT_ID !== TARGET.project || env.SBG_ADMISSION_BRANCH_ID !== TARGET.branch || env.SBG_ADMISSION_ENDPOINT_ID !== TARGET.endpoint) failures.push("target-pin");
  if (url.searchParams.get("sslmode") !== "require" || [...url.searchParams.keys()].some(k => k !== "sslmode")) failures.push("connection-options");
  return failures;
}

export async function runProductionAdmissionDraft({ env = process.env, connect, read = readFile } = {}) {
  const failures = validateEnvironment(env);
  if (failures.length) return { verdict: "BLOCKED", failures };
  const sources = [];
  for (const [name, expected] of migrations) {
    const bytes = await read(join(root, "migrations", name));
    if (digest(bytes) !== expected) return { verdict: "BLOCKED", failures: ["migration-digest-" + name] };
    sources.push(String(bytes));
  }
  const db = connect ? await connect(env.A3_PRODUCTION_APPLY_OWNER_URL) : new pg.Client({
    connectionString: env.A3_PRODUCTION_APPLY_OWNER_URL,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  let open = false;
  let commitAttempted = false;
  try {
    if (!connect) await db.connect();
    await db.query("BEGIN"); open = true;
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '30s'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await db.query("SELECT pg_advisory_xact_lock(3005, 3536)");
    const id = (await db.query("SELECT current_database() AS database, current_user AS role, session_user AS session_role, current_setting('neon.project_id',true) AS project, current_setting('neon.branch_id',true) AS branch, current_setting('neon.endpoint_id',true) AS endpoint")).rows[0];
    if (!id || id.database !== TARGET.database || id.role !== TARGET.role || id.session_role !== TARGET.role || id.project !== TARGET.project || id.branch !== TARGET.branch || id.endpoint !== TARGET.endpoint) return { verdict: "BLOCKED", failures: ["live-identity"] };
    const names = (await db.query("SELECT name FROM public._migrations ORDER BY name")).rows.map(r => r.name);
    if (names.length !== ACCEPTED_LEDGER.length || new Set(names).size !== names.length || names.some(n => !ACCEPTED_LEDGER.includes(n))) return { verdict: "BLOCKED", failures: ["ledger-drift"] };
    const pre = (await db.query("SELECT (SELECT count(*) FROM (SELECT created_by_user_id FROM public.sbg_organisations GROUP BY created_by_user_id HAVING count(*) > 1) x)::int AS duplicates, (SELECT count(*) FROM public.sbg_organisation_acceptances)::int AS acceptances, (to_regclass('public.sbg_approved_property_agreement_versions') IS NOT NULL) AS approval_exists")).rows[0];
    if (!pre || pre.duplicates !== 0 || pre.acceptances !== 0 || pre.approval_exists !== false) return { verdict: "BLOCKED", failures: ["baseline-drift"] };
    for (let i = 0; i < migrations.length; i++) {
      await db.query(sources[i]);
      await db.query("INSERT INTO public._migrations(name) VALUES ($1)", [migrations[i][0]]);
    }
    if (!validIntegrity((await db.query(indexIntegrityQuery)).rows, (await db.query(effectiveColumnQuery)).rows)) return { verdict: "BLOCKED", failures: ["transaction-index-integrity"] };
    const migrationNames = (await db.query("SELECT name FROM public._migrations ORDER BY name")).rows.map(r => r.name);
    const expectedNames = [...ACCEPTED_LEDGER, ...migrations.map(([name]) => name)];
    if (migrationNames.length !== expectedNames.length || new Set(migrationNames).size !== expectedNames.length || migrationNames.some(n => !expectedNames.includes(n))) return { verdict: "BLOCKED", failures: ["transaction-ledger-names"] };
    const security = (await db.query(`SELECT
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('sbg_create_organisation_for_user','sbg_ensure_founding_organisation','sbg_create_founding_property_for_user') AND p.prosecdef) AS security_definer_count,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('sbg_create_organisation_for_user','sbg_ensure_founding_organisation','sbg_create_founding_property_for_user') AND has_function_privilege('aether_app',p.oid,'EXECUTE')) AS app_executable_count,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('sbg_create_organisation_for_user','sbg_ensure_founding_organisation','sbg_create_founding_property_for_user') AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')) AS public_executable_count,
      has_table_privilege('aether_app','public.sbg_approved_property_agreement_versions','INSERT,UPDATE,DELETE,TRUNCATE') AS app_agreement_write,
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('sbg_organisations','sbg_organisation_acceptances') AND NOT t.tgisinternal AND t.tgenabled='D') AS disabled_relevant_triggers`)).rows[0];
    if (!security || security.security_definer_count !== 3 || security.app_executable_count !== 3 || security.public_executable_count !== 0 || security.app_agreement_write !== false || security.disabled_relevant_triggers !== 0) return { verdict: "BLOCKED", failures: ["transaction-privileges-or-triggers"] };
    const post = (await db.query("SELECT (SELECT count(*) FROM public._migrations)::int AS ledger_count, (to_regclass('public.sbg_approved_property_agreement_versions') IS NOT NULL) AS approval_exists, (to_regclass('public.sbg_organisations_one_founding_creator_uidx') IS NOT NULL) AS creator_index_exists, (to_regclass('public.sbg_approved_property_agreement_versions_one_effective_uidx') IS NOT NULL) AS effective_index_exists, (SELECT count(*) FROM public.sbg_approved_property_agreement_versions)::int AS approved_versions")).rows[0];
    if (!post || post.ledger_count !== 36 || !post.approval_exists || !post.creator_index_exists || !post.effective_index_exists || post.approved_versions !== 0) return { verdict: "BLOCKED", failures: ["transaction-postcondition"] };
    commitAttempted = true;
    await db.query("COMMIT"); open = false;
    // COMMIT success is not sufficient: verify durable state via a fresh session.
    const check = connect ? await connect(env.A3_PRODUCTION_APPLY_OWNER_URL) : new pg.Client({
      connectionString: env.A3_PRODUCTION_APPLY_OWNER_URL, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 5000,
    });
    try {
      if (!connect) await check.connect();
      await check.query("BEGIN READ ONLY");
      const persistedIntegrityValid = validIntegrity((await check.query(indexIntegrityQuery)).rows, (await check.query(effectiveColumnQuery)).rows);
      const persistedNames = (await check.query("SELECT name FROM public._migrations ORDER BY name")).rows.map(r => r.name);
      const expectedPersistedNames = [...ACCEPTED_LEDGER, ...migrations.map(([name]) => name)];
      const persistedLedgerValid = persistedNames.length === expectedPersistedNames.length && new Set(persistedNames).size === expectedPersistedNames.length && persistedNames.every(n => expectedPersistedNames.includes(n));
      const persistedSecurity = (await check.query(`SELECT
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('sbg_create_organisation_for_user','sbg_ensure_founding_organisation','sbg_create_founding_property_for_user') AND p.prosecdef) AS security_definer_count,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('sbg_create_organisation_for_user','sbg_ensure_founding_organisation','sbg_create_founding_property_for_user') AND has_function_privilege('aether_app',p.oid,'EXECUTE')) AS app_executable_count,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('sbg_create_organisation_for_user','sbg_ensure_founding_organisation','sbg_create_founding_property_for_user') AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')) AS public_executable_count,
        has_table_privilege('aether_app','public.sbg_approved_property_agreement_versions','INSERT,UPDATE,DELETE,TRUNCATE') AS app_agreement_write,
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('sbg_organisations','sbg_organisation_acceptances') AND NOT t.tgisinternal AND t.tgenabled='D') AS disabled_relevant_triggers`)).rows[0];
      const persistedSecurityValid = persistedSecurity?.security_definer_count === 3 && persistedSecurity?.app_executable_count === 3 && persistedSecurity?.public_executable_count === 0 && persistedSecurity?.app_agreement_write === false && persistedSecurity?.disabled_relevant_triggers === 0;
      const identity = (await check.query("SELECT current_setting('neon.branch_id',true) AS branch, current_setting('neon.endpoint_id',true) AS endpoint")).rows[0];
      const verified = (await check.query("SELECT (SELECT count(*) FROM public._migrations)::int AS ledger_count, (SELECT count(*) FROM public.sbg_approved_property_agreement_versions)::int AS approved_versions, (to_regclass('public.sbg_organisations_one_founding_creator_uidx') IS NOT NULL) AS creator_index_exists, (to_regclass('public.sbg_approved_property_agreement_versions_one_effective_uidx') IS NOT NULL) AS effective_index_exists")).rows[0];
      await check.query("ROLLBACK");
      if (!persistedIntegrityValid || !persistedLedgerValid || !persistedSecurityValid || !identity || identity.branch !== TARGET.branch || identity.endpoint !== TARGET.endpoint || !verified || verified.ledger_count !== 36 || verified.approved_versions !== 0 || !verified.creator_index_exists || !verified.effective_index_exists) return { verdict: "ESCALATE", failures: ["persisted-state-verification"] };
      return { verdict: "PASS — PRODUCTION COMMIT VERIFIED", migrationCount: 36, productionModified: true };
    } finally { await check.end(); }
  } catch {
    return commitAttempted ? { verdict: "ESCALATE", failures: ["commit-or-verification-ambiguous"] } : { verdict: "BLOCKED", failures: ["transaction-error-redacted"] };
  } finally {
    if (open && !commitAttempted) { try { await db.query("ROLLBACK"); } catch {} }
    await db.end();
  }
}

// Intentionally no CLI entry point. NOT AUTHORISED FOR EXECUTION.
