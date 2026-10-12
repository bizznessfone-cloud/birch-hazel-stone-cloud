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
  role: "neondb_owner",
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
  if (!env.AETHER_DATABASE_OWNER_URL) return [...failures, "missing-owner-url"];
  try {
    const u = new URL(env.AETHER_DATABASE_OWNER_URL);
    if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") failures.push("protocol");
    if (u.username !== EXPECTED.role) failures.push("role");
    if (decodeURIComponent(u.pathname.slice(1)) !== EXPECTED.database) failures.push("database");
    if (u.hostname.toLowerCase() !== EXPECTED.endpoint + ".c-5.eu-central-1.aws.neon.tech") failures.push("direct-endpoint-host");
    if (u.hostname.includes("-pooler")) failures.push("pooled-endpoint");
    if (u.searchParams.get("sslmode") !== "require") failures.push("ssl-required");
  } catch { failures.push("invalid-owner-url"); }
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

export function validateState(state) {
  const errors = [];
  if (state.current_database !== EXPECTED.database) errors.push("database-identity");
  if (state.current_user !== EXPECTED.role || state.session_user !== EXPECTED.role) errors.push("owner-identity");
  if (Number(state.duplicate_creator_groups) !== 0) errors.push("duplicate-creators");
  if (Number(state.approved_table_exists) !== 0) errors.push("approved-table-preexists");
  if (Number(state.creator_index_exists) !== 0) errors.push("creator-index-preexists");
  if (Number(state.effective_index_exists) !== 0) errors.push("effective-index-preexists");
  if (Number(state.effective_column_exists) !== 0) errors.push("effective-column-preexists");
  if (Number(state.property_function_exists) !== 0) errors.push("property-function-preexists");
  return errors;
}

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
  const client = connect ? await connect(env.AETHER_DATABASE_OWNER_URL) : new pg.Client({
    connectionString: env.AETHER_DATABASE_OWNER_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 10000,
    ssl: {rejectUnauthorized:true},
  });
  try {
    if (!connect) await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const state = (await client.query(`SELECT current_database() AS current_database, current_user AS current_user,
      session_user AS session_user,
      (SELECT count(*) FROM (SELECT created_by_user_id FROM public.sbg_organisations GROUP BY created_by_user_id HAVING count(*) > 1) d) AS duplicate_creator_groups,
      (to_regclass('public.sbg_approved_property_agreement_versions') IS NOT NULL)::int AS approved_table_exists,
      (to_regclass('public.sbg_organisations_one_founding_creator_uidx') IS NOT NULL)::int AS creator_index_exists,
      (to_regclass('public.sbg_approved_property_agreement_versions_one_effective_uidx') IS NOT NULL)::int AS effective_index_exists,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sbg_approved_property_agreement_versions' AND column_name = 'effective')::int AS effective_column_exists,
      (to_regprocedure('public.sbg_create_founding_property_for_user(text,text,text,text,text,text)') IS NOT NULL)::int AS property_function_exists`)).rows[0];
    const ledger = (await client.query("SELECT name FROM public._migrations ORDER BY name")).rows.map(r=>r.name);
    const issues = [...validateState(state), ...validateLedger(ledger)];
    await client.query("ROLLBACK");
    return {verdict:issues.length ? "BLOCKED" : "PREFLIGHT PASS — APPLY NOT AUTHORISED", failures:issues, ledgerCount:ledger.length};
  } finally {
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
