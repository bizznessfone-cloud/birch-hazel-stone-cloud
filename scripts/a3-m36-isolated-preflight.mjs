#!/usr/bin/env node
/**
 * A3-M36 read-only preflight for one isolated Neon branch.
 *
 * Identity comes from the Neon compute settings neon.project_id,
 * neon.branch_id, and neon.endpoint_id after a direct connection.
 * The expected ids below are the acceptance criteria, not the proof.
 * A comment, a workflow input, or an environment name is not proof.
 *
 * Does not apply SQL. Does not insert fixtures. Does not open
 * DATABASE_URL, AETHER_DATABASE_OWNER_URL, or NEON_API_KEY.
 * Never prints a connection string, password, or token.
 *
 * Later install and concurrency stages are not implemented.
 * Enabling one requires a separate reviewed change to ENABLED_STAGE
 * and to the workflow choice list.
 */
import pg from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./production-db-preflight.mjs";

export const ISOLATED_OWNER_ENV = "AETHER_0036_ISOLATED_OWNER_URL";
export const CONFIRMATION_ENV = "A3M36_CONFIRMATION";
export const STAGE_ENV = "A3M36_STAGE";
export const CONFIRMATION = "PREFLIGHT-0036-ISOLATED";
export const ENABLED_STAGE = "preflight";
export const EXPECTED_PROJECT = "quiet-sound-53513710";
export const EXPECTED_BRANCH = "br-dawn-hat-b1b4uqhn";
export const EXPECTED_DATABASE = "neondb";
export const EXPECTED_ROLE = "neondb_owner";
export const FORBIDDEN_BRANCH = "br-green-darkness-b1k7wkue";
export const FORBIDDEN_ENDPOINT = "ep-withered-haze-b1fd9hse";
export const FORBIDDEN_ENV = ["DATABASE_URL", "AETHER_DATABASE_OWNER_URL", "NEON_API_KEY"];

const IDENTITY_SQL = `select current_database() as database,
       current_user,
       session_user,
       current_setting('neon.project_id', true) as project_id,
       current_setting('neon.branch_id', true) as branch_id,
       current_setting('neon.endpoint_id', true) as endpoint_id`;

const OBJECT_SQL = `select
       to_regclass('public._migrations') is not null as ledger,
       to_regclass('public.sbg_organisations') is not null as organisations,
       to_regclass('public.hotels') is not null as hotels,
       to_regclass('public.sbg_approved_property_agreement_versions') is not null as approval_table,
       to_regprocedure('public.sbg_create_founding_property_for_user(text,text,text,text,text,text)') is not null as property_function,
       exists (
         select 1 from pg_constraint
          where conname = 'sbg_approved_property_agreement_versions_not_provisional'
       ) as terms_v1_rejected,
       exists (
         select 1 from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname = 'sbg_organisations_one_founding_creator_uidx'
       ) as creator_index,
       exists (
         select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'sbg_approved_property_agreement_versions'
            and column_name = 'effective'
       ) as effective_column,
       exists (
         select 1 from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname = 'sbg_approved_property_agreement_versions_one_effective_uidx'
       ) as effective_index`;

const FUNCTION_SQL = `select p.proname,
       position('founding organisation already exists' in p.prosrc) > 0 as rejects_second,
       position('v.effective' in p.prosrc) > 0 as requires_effective
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('sbg_create_organisation_for_user', 'sbg_create_founding_property_for_user', 'sbg_ensure_founding_organisation')`;

const PRIVILEGE_SQL = `select
       case
         when to_regprocedure('public.sbg_create_founding_property_for_user(text,text,text,text,text,text)') is null then null
         else has_function_privilege('aether_app', 'public.sbg_create_founding_property_for_user(text,text,text,text,text,text)', 'execute')
       end as app_property,
       case
         when to_regprocedure('public.sbg_create_founding_property_for_user(text,text,text,text,text,text)') is null then null
         else has_function_privilege('aether_runtime', 'public.sbg_create_founding_property_for_user(text,text,text,text,text,text)', 'execute')
       end as runtime_property,
       case
         when to_regprocedure('public.sbg_create_founding_property_for_user(text,text,text,text,text,text)') is null then null
         else has_function_privilege('public', 'public.sbg_create_founding_property_for_user(text,text,text,text,text,text)', 'execute')
       end as public_property,
       case
         when to_regprocedure('public.sbg_create_organisation_for_user(text,text)') is null then null
         else has_function_privilege('aether_app', 'public.sbg_create_organisation_for_user(text,text)', 'execute')
       end as app_creator,
       case
         when to_regprocedure('public.sbg_create_organisation_for_user(text,text)') is null then null
         else has_function_privilege('aether_runtime', 'public.sbg_create_organisation_for_user(text,text)', 'execute')
       end as runtime_creator,
       case
         when to_regprocedure('public.sbg_ensure_founding_organisation(text,text)') is null then null
         else has_function_privilege('aether_app', 'public.sbg_ensure_founding_organisation(text,text)', 'execute')
       end as app_ensure,
       case
         when to_regprocedure('public.sbg_ensure_founding_organisation(text,text)') is null then null
         else has_function_privilege('aether_runtime', 'public.sbg_ensure_founding_organisation(text,text)', 'execute')
       end as runtime_ensure,
       case
         when to_regclass('public.sbg_approved_property_agreement_versions') is null then null
         else has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'select')
       end as app_select,
       case
         when to_regclass('public.sbg_approved_property_agreement_versions') is null then null
         else has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'insert')
       end as app_insert,
       case
         when to_regclass('public.sbg_approved_property_agreement_versions') is null then null
         else has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'update')
       end as app_update,
       case
         when to_regclass('public.sbg_approved_property_agreement_versions') is null then null
         else has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'delete')
       end as app_delete`;

const DUPLICATE_SQL = `select created_by_user_id,
       count(*)::int as n,
       string_agg(id::text, ',' order by created_at, id) as ids
  from public.sbg_organisations
 group by created_by_user_id
having count(*) > 1
 order by created_by_user_id`;

const COUNT_SQL = `select
       (select count(*)::int from public.sbg_organisations) as organisations,
       (select count(*)::int from public.hotels) as hotels,
       (select count(*)::int from public.hotels where organisation_id is not null) as attached_hotels`;

export function directOwnerUrl(value) {
  const raw = String(value ?? "").trim().replace(/-pooler\./g, ".");
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
    return url.toString();
  } catch {
    return raw;
  }
}

export function hostSafetyFailures(value) {
  let url;
  try {
    url = new URL(directOwnerUrl(value));
  } catch {
    return ["url"];
  }
  const failures = [];
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") failures.push("protocol");
  const host = url.hostname.toLowerCase();
  const label = host.split(".")[0] ?? "";
  if (!host || !label.startsWith("ep-")) failures.push("endpoint-label");
  if (label === FORBIDDEN_ENDPOINT || host.includes(FORBIDDEN_ENDPOINT) || String(value).includes(FORBIDDEN_ENDPOINT)) {
    failures.push("production-endpoint");
  }
  if (String(value).includes(FORBIDDEN_BRANCH)) failures.push("production-branch-in-url");
  if (url.pathname !== `/${EXPECTED_DATABASE}`) failures.push("url-database");
  if ((url.searchParams.get("sslmode") ?? "").toLowerCase() === "disable") failures.push("ssl");
  let user = "";
  try {
    user = decodeURIComponent(url.username);
  } catch {
    user = "";
  }
  if (user !== EXPECTED_ROLE) failures.push("url-role");
  return failures;
}

export function identityFailures(identity, hostname) {
  const projectId = String(identity?.projectId ?? "").trim();
  const branchId = String(identity?.branchId ?? "").trim();
  const endpointId = String(identity?.endpointId ?? "").trim();
  const database = String(identity?.database ?? "").trim();
  const currentUser = String(identity?.currentUser ?? "").trim();
  const sessionUser = String(identity?.sessionUser ?? "").trim();
  const label = String(hostname ?? "").toLowerCase().split(".")[0] ?? "";
  const failures = [];
  if (!projectId) failures.push("project-unproven");
  else if (projectId !== EXPECTED_PROJECT) failures.push("project");
  if (!branchId) failures.push("branch-unproven");
  else if (branchId !== EXPECTED_BRANCH) failures.push("branch");
  if (branchId === FORBIDDEN_BRANCH) failures.push("production-branch");
  if (!endpointId) failures.push("endpoint-unproven");
  else if (endpointId === FORBIDDEN_ENDPOINT) failures.push("production-endpoint");
  if (database !== EXPECTED_DATABASE) failures.push("database");
  if (currentUser !== EXPECTED_ROLE || sessionUser !== EXPECTED_ROLE) failures.push("role");
  if (!endpointId || label !== endpointId) failures.push("endpoint-host-mismatch");
  return failures;
}

function assertReadOnly(sql) {
  const text = String(sql ?? "").trim();
  if (!/^(set\s+default_transaction_read_only\s*=\s*on|begin\s+read\s+only|rollback|select)\b/i.test(text)) {
    throw new Error("BLOCKED — NON READ ONLY STATEMENT");
  }
}

function flag(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "absent";
}

function present(value) {
  return value === true ? "present" : "absent";
}

async function query(db, sql) {
  assertReadOnly(sql);
  return db.query(sql);
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

export async function runPreflight({ env, connect, say = () => {} }) {
  const lines = [];
  const log = (line) => {
    const safe = redact(String(line)).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host");
    lines.push(safe);
    say(safe);
  };
  const finish = (exitCode) => ({ exitCode, lines });

  const stage = String(env?.[STAGE_ENV] ?? "");
  const confirmation = String(env?.[CONFIRMATION_ENV] ?? "");
  const isolated = String(env?.[ISOLATED_OWNER_ENV] ?? "").trim();
  log(`stage: ${stage === ENABLED_STAGE ? ENABLED_STAGE : "rejected"}`);
  log(`confirmation: ${confirmation === CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  log(`${ISOLATED_OWNER_ENV}: ${isolated ? "PRESENT" : "ABSENT"}`);
  log("enabled_stage: preflight");
  log("install_stage: NOT ENABLED");
  log("concurrency_stage: NOT ENABLED");

  if (stage !== ENABLED_STAGE) {
    log("BLOCKED — STAGE NOT ENABLED");
    return finish(1);
  }
  if (confirmation !== CONFIRMATION) {
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
  const hostFailures = hostSafetyFailures(isolated);
  if (hostFailures.length) {
    log(`BLOCKED — CONNECTION ${hostFailures.join(",")}`);
    return finish(1);
  }

  const direct = directOwnerUrl(isolated);
  let hostname = "";
  try {
    hostname = new URL(direct).hostname.toLowerCase();
  } catch {
    log("BLOCKED — CONNECTION url");
    return finish(1);
  }

  let db;
  try {
    db = await connect(direct);
  } catch (err) {
    log(`BLOCKED — CONNECT FAILED ${redact(err?.message || err)}`);
    return finish(1);
  }

  try {
    await query(db, "set default_transaction_read_only = on");
    await query(db, "begin read only");
    const identity = mapIdentity((await query(db, IDENTITY_SQL)).rows[0]);
    const failures = identityFailures(identity, hostname);
    log(`neon_project: ${identity.projectId || "unproven"}`);
    log(`neon_branch: ${identity.branchId || "unproven"}`);
    log(`neon_endpoint: ${identity.endpointId || "unproven"}`);
    log(`database: ${identity.database || "unproven"}`);
    log(`role: ${identity.currentUser || "unproven"}`);
    log(`session_role: ${identity.sessionUser || "unproven"}`);
    if (failures.length) {
      await query(db, "rollback");
      log(`BLOCKED — ISOLATED IDENTITY ${failures.join(",")}`);
      return finish(1);
    }
    log("isolated_identity: PASS");
    log("identity_proof: neon.project_id neon.branch_id neon.endpoint_id");
    log("production_branch_rejected: true");
    log("production_endpoint_rejected: true");

    const objects = (await query(db, OBJECT_SQL)).rows[0] ?? {};
    const migration0035 = objects.approval_table === true && objects.property_function === true && objects.terms_v1_rejected === true;
    const schema0036 = objects.creator_index === true && objects.effective_column === true && objects.effective_index === true;
    log(`0035_approval_table: ${present(objects.approval_table)}`);
    log(`0035_property_function: ${present(objects.property_function)}`);
    log(`0035_terms_v1_rejected: ${present(objects.terms_v1_rejected)}`);
    log(`0035_objects: ${migration0035 ? "present" : "absent"}`);
    log(`0036_creator_index: ${present(objects.creator_index)}`);
    log(`0036_effective_column: ${present(objects.effective_column)}`);
    log(`0036_effective_index: ${present(objects.effective_index)}`);

    const functions = (await query(db, FUNCTION_SQL)).rows;
    const creator = functions.find((row) => row.proname === "sbg_create_organisation_for_user");
    const property = functions.find((row) => row.proname === "sbg_create_founding_property_for_user");
    const ensure = functions.find((row) => row.proname === "sbg_ensure_founding_organisation");
    const functions0036 = creator?.rejects_second === true && property?.requires_effective === true;
    log(`0036_creator_rejects_second: ${flag(creator?.rejects_second)}`);
    log(`0036_property_requires_effective: ${flag(property?.requires_effective)}`);
    log(`0036_ensure_present: ${ensure ? "present" : "absent"}`);
    log(`0036_schema: ${schema0036 ? "present" : "absent"}`);
    log(`0036_functions: ${functions0036 ? "present" : "absent"}`);
    log(`0036_objects: ${schema0036 && functions0036 ? "present" : schema0036 || functions0036 ? "partial" : "absent"}`);

    if (objects.ledger === true) {
      const ledger = (await query(db, "select name from public._migrations order by name")).rows.map((row) => String(row.name));
      log("ledger_readable: true");
      log(`ledger_0035: ${ledger.includes("0035_cp3005e2d2d_founding_property.sql") ? "present" : "absent"}`);
      log(`ledger_0036: ${ledger.includes("0036_cp3005e2d2d_founding_integrity.sql") ? "present" : "absent"}`);
    } else {
      log("ledger_readable: false");
      log("ledger_0035: unproven");
      log("ledger_0036: unproven");
    }

    if (objects.organisations === true) {
      const duplicates = (await query(db, DUPLICATE_SQL)).rows;
      log(`duplicate_creators: ${duplicates.length}`);
      for (const row of duplicates.slice(0, 20)) {
        log(`duplicate_creator: ${row.created_by_user_id} count=${row.n} ids=${row.ids}`);
      }
      log(`install_later_blocked_by_duplicates: ${duplicates.length > 0 ? "true" : "false"}`);
    } else {
      log("duplicate_creators: unproven");
      log("install_later_blocked_by_duplicates: unproven");
    }

    if (objects.organisations === true && objects.hotels === true) {
      const counts = (await query(db, COUNT_SQL)).rows[0] ?? {};
      log(`organisations: ${counts.organisations}`);
      log(`hotels: ${counts.hotels}`);
      log(`attached_hotels: ${counts.attached_hotels}`);
    } else {
      log("organisations: unproven");
      log("hotels: unproven");
      log("attached_hotels: unproven");
    }

    const priv = (await query(db, PRIVILEGE_SQL)).rows[0] ?? {};
    log(`privilege_app_property_execute: ${flag(priv.app_property)}`);
    log(`privilege_runtime_property_execute: ${flag(priv.runtime_property)}`);
    log(`privilege_public_property_execute: ${flag(priv.public_property)}`);
    log(`privilege_app_creator_execute: ${flag(priv.app_creator)}`);
    log(`privilege_runtime_creator_execute: ${flag(priv.runtime_creator)}`);
    log(`privilege_app_ensure_execute: ${flag(priv.app_ensure)}`);
    log(`privilege_runtime_ensure_execute: ${flag(priv.runtime_ensure)}`);
    log(`privilege_app_approval_select: ${flag(priv.app_select)}`);
    log(`privilege_app_approval_insert: ${flag(priv.app_insert)}`);
    log(`privilege_app_approval_update: ${flag(priv.app_update)}`);
    log(`privilege_app_approval_delete: ${flag(priv.app_delete)}`);
    if (schema0036 && functions0036) {
      const match = priv.app_property === true
        && priv.runtime_property === false
        && priv.public_property === false
        && priv.app_creator === true
        && priv.runtime_creator === false
        && priv.app_ensure === true
        && priv.runtime_ensure === false
        && priv.app_select === false
        && priv.app_insert === false
        && priv.app_update === false
        && priv.app_delete === false;
      log(`privileges_match_0036: ${match ? "true" : "false"}`);
    } else {
      log("privileges_match_0036: not-applicable");
    }

    await query(db, "rollback");
    log("writes: none");
    log("verdict: PREFLIGHT REPORTED");
    return finish(0);
  } catch (err) {
    try {
      await query(db, "rollback");
    } catch {
      // The session may already be closed or aborted.
    }
    log(`BLOCKED — PREFLIGHT READ ${redact(err?.message || err)}`);
    return finish(1);
  } finally {
    try {
      await db.end();
    } catch {
      // Closing a failed session must not hide the blocked verdict.
    }
  }
}

async function defaultConnect(connectionString) {
  const client = new pg.Client({
    connectionString,
    application_name: "a3m36-isolated-preflight",
    statement_timeout: 20000,
    query_timeout: 20000,
  });
  await client.connect();
  return client;
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runPreflight({ env: process.env, connect: defaultConnect, say: (line) => console.log(line) })
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((err) => {
      console.log(`BLOCKED — PREFLIGHT READ ${redact(err?.message || err)}`.replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host"));
      process.exitCode = 1;
    });
}
