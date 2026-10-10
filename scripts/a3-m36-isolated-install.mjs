#!/usr/bin/env node
/**
 * A3-M36 isolated installer for migration 0036 only.
 *
 * Manual. One Neon branch: quiet-sound-53513710 / br-dawn-hat-b1b4uqhn /
 * ep-damp-dust-b1rdfp34 / neondb / neondb_owner. The only credential is
 * AETHER_0036_ISOLATED_OWNER_URL. DATABASE_URL, AETHER_DATABASE_OWNER_URL,
 * and NEON_API_KEY are refused. Production authorisation is not changed.
 *
 * 0035 is not replayed and is not inserted into public._migrations.
 * Installation proceeds only when the live 0035 objects match the reviewed
 * file. The whole apply, including the single 0036 ledger insert, is one
 * transaction and rolls back on failure. There is no user-supplied SQL,
 * database URL, or migration filename.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { redact } from "./production-db-preflight.mjs";
import {
  CONFIRMATION as PREFLIGHT_CONFIRMATION,
  EXPECTED_BRANCH,
  EXPECTED_DATABASE,
  EXPECTED_PROJECT,
  EXPECTED_ROLE,
  FORBIDDEN_ENV,
  ISOLATED_OWNER_ENV,
  directOwnerUrl,
  hostSafetyFailures,
  identityFailures,
} from "./a3-m36-isolated-preflight.mjs";
import {
  DIGEST_36,
  EXPECTED_ENDPOINT,
  MIGRATION_33,
  MIGRATION_35,
  MIGRATION_36,
  assess0035Equivalence,
  installDecision,
  ledgerDisposition,
  presenceLevel,
  sha256,
} from "./a3-m36-0035-equivalence.mjs";

export const INSTALL_CONFIRMATION = "INSTALL-0036-ISOLATED";
export const CONFIRMATION_ENV = "A3M36_INSTALL_CONFIRMATION";
export const ALREADY_APPLIED = "0036 ALREADY APPLIED — NO MUTATION";
export const APPLIED = "GATE PASS — 0036 INSTALLED ON ISOLATED BRANCH";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const IDENTITY_SQL = `select current_database() as database,
       current_user,
       session_user,
       current_setting('neon.project_id', true) as project_id,
       current_setting('neon.branch_id', true) as branch_id,
       current_setting('neon.endpoint_id', true) as endpoint_id`;

const FUNCTION_SQL = `select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       pg_get_function_result(p.oid) as result,
       l.lanname as language,
       p.prosecdef as security_definer,
       p.prosrc,
       obj_description(p.oid, 'pg_proc') as comment,
       (
         select split_part(cfg, '=', 2)
           from unnest(coalesce(p.proconfig, array[]::text[])) as cfg
          where split_part(cfg, '=', 1) = 'search_path'
          limit 1
       ) as search_path
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
 where n.nspname = 'public'
   and p.proname in (
     'sbg_create_organisation_for_user',
     'sbg_create_founding_property_for_user',
     'sbg_ensure_founding_organisation'
   )`;

const CONSTRAINT_SQL = `select c.conname as name, pg_get_constraintdef(c.oid) as def
  from pg_constraint c
  join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
 where n.nspname = 'public'
   and r.relname = 'sbg_approved_property_agreement_versions'
 order by c.conname`;

const COLUMN_SQL = `select column_name as name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'sbg_approved_property_agreement_versions'
 order by ordinal_position`;

const COMMENT_SQL = `select obj_description('public.sbg_approved_property_agreement_versions'::regclass, 'pg_class') as comment`;

const OBJECT_SQL = `select
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

const PRIVILEGE_SQL = `select
       has_function_privilege('aether_app', 'public.sbg_create_founding_property_for_user(text,text,text,text,text,text)', 'execute') as app_property,
       has_function_privilege('aether_runtime', 'public.sbg_create_founding_property_for_user(text,text,text,text,text,text)', 'execute') as runtime_property,
       has_function_privilege('public', 'public.sbg_create_founding_property_for_user(text,text,text,text,text,text)', 'execute') as public_property,
       has_function_privilege('aether_app', 'public.sbg_create_organisation_for_user(text,text)', 'execute') as app_creator,
       has_function_privilege('aether_runtime', 'public.sbg_create_organisation_for_user(text,text)', 'execute') as runtime_creator,
       has_function_privilege('aether_app', 'public.sbg_ensure_founding_organisation(text,text)', 'execute') as app_ensure,
       has_function_privilege('aether_runtime', 'public.sbg_ensure_founding_organisation(text,text)', 'execute') as runtime_ensure,
       has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'select') as app_select,
       has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'insert') as app_insert,
       has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'update') as app_update,
       has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'delete') as app_delete`;

const DUPLICATE_SQL = `select count(*)::int as n
  from (
    select created_by_user_id
      from public.sbg_organisations
     group by created_by_user_id
    having count(*) > 1
  ) d`;

const COUNT_SQL = `select
       (select count(*)::int from public.sbg_organisations) as organisations,
       (select count(*)::int from public.hotels) as hotels`;

const LEDGER_SQL = `select name from public._migrations order by name`;
const MARKER_SQL = `select p.proname,
       position('founding organisation already exists' in p.prosrc) > 0 as rejects_second,
       position('and v.effective' in p.prosrc) > 0 as requires_effective
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('sbg_create_organisation_for_user', 'sbg_create_founding_property_for_user')`;

function safeError(err) {
  const message = String(err?.message ?? err);
  if (message.includes("founding organisation duplicates exist")) return "founding organisation duplicates exist";
  return redact(message).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host").slice(0, 300);
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

function mapCatalog(functions, constraints, columns, comment, privileges, objects) {
  const mapped = {};
  for (const row of functions ?? []) {
    mapped[row.proname] = {
      args: row.args,
      result: row.result,
      language: row.language,
      securityDefiner: row.security_definer === true,
      searchPath: row.search_path,
      prosrc: row.prosrc,
      comment: row.comment,
    };
  }
  return {
    functions: mapped,
    constraints: (constraints ?? []).map((row) => ({ name: row.name, def: row.def })),
    columns: (columns ?? []).map((row) => ({
      name: row.name,
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
    })),
    tableComment: comment ?? "",
    privileges: privileges ?? {},
    creatorIndex: objects?.creator_index === true,
    effectiveColumn: objects?.effective_column === true,
    effectiveIndex: objects?.effective_index === true,
  };
}

async function defaultReadSources() {
  const read = (name) => readFile(join(root, "migrations", name), "utf8");
  return { sql35: await read(MIGRATION_35), sql33: await read(MIGRATION_33), sql36: await read(MIGRATION_36) };
}

async function defaultConnect(connectionString) {
  const client = new pg.Client({
    connectionString,
    application_name: "a3m36-isolated-install",
    statement_timeout: 60000,
    query_timeout: 60000,
  });
  await client.connect();
  return client;
}

export function endpointPinFailures(value) {
  const failures = hostSafetyFailures(value);
  let label = "";
  try {
    label = new URL(directOwnerUrl(value)).hostname.toLowerCase().split(".")[0] ?? "";
  } catch {
    label = "";
  }
  if (label !== EXPECTED_ENDPOINT) failures.push("endpoint-pin");
  return [...new Set(failures)];
}

async function readState(db) {
  const functions = (await db.query(FUNCTION_SQL)).rows;
  const constraints = (await db.query(CONSTRAINT_SQL)).rows;
  const columns = (await db.query(COLUMN_SQL)).rows;
  const comment = (await db.query(COMMENT_SQL)).rows[0]?.comment ?? "";
  const privileges = (await db.query(PRIVILEGE_SQL)).rows[0] ?? {};
  const objects = (await db.query(OBJECT_SQL)).rows[0] ?? {};
  const duplicates = Number((await db.query(DUPLICATE_SQL)).rows[0]?.n ?? 0);
  const counts = (await db.query(COUNT_SQL)).rows[0] ?? {};
  const ledger = (await db.query(LEDGER_SQL)).rows.map((row) => String(row.name));
  const markers = (await db.query(MARKER_SQL)).rows;
  const creator = markers.find((row) => row.proname === "sbg_create_organisation_for_user");
  const property = markers.find((row) => row.proname === "sbg_create_founding_property_for_user");
  return {
    catalog: mapCatalog(functions, constraints, columns, comment, privileges, objects),
    duplicates,
    counts: { organisations: Number(counts.organisations ?? 0), hotels: Number(counts.hotels ?? 0) },
    ledger,
    schema36: presenceLevel([objects.creator_index === true, objects.effective_column === true, objects.effective_index === true]),
    functions36: presenceLevel([creator?.rejects_second === true, property?.requires_effective === true]),
  };
}

export async function runInstall({ env, connect, readSources = defaultReadSources, say = () => {} }) {
  const lines = [];
  const log = (line) => {
    const safe = redact(String(line)).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host");
    lines.push(safe);
    say(safe);
  };
  const finish = (exitCode) => ({ exitCode, lines });
  const confirmation = String(env?.[CONFIRMATION_ENV] ?? "");
  const isolated = String(env?.[ISOLATED_OWNER_ENV] ?? "").trim();
  log(`confirmation: ${confirmation === INSTALL_CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  log(`preflight_confirmation_rejected: ${confirmation === PREFLIGHT_CONFIRMATION ? "true" : "false"}`);
  log(`${ISOLATED_OWNER_ENV}: ${isolated ? "PRESENT" : "ABSENT"}`);
  log("production_credential_fallback: none");
  log("migration_0035_replay: refused");
  log("ledger_0035_insert: refused");

  if (confirmation !== INSTALL_CONFIRMATION) {
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

  let sources;
  try {
    sources = await readSources();
  } catch (err) {
    log(`BLOCKED — MIGRATION SOURCE UNREADABLE ${safeError(err)}`);
    return finish(1);
  }
  const digest36 = sha256(String(sources?.sql36 ?? ""));
  log(`digest_0036: ${digest36 === DIGEST_36 ? "match" : "mismatch"}`);
  log("migration_file: 0036_cp3005e2d2d_founding_integrity.sql");
  if (digest36 !== DIGEST_36 || !sources?.sql35 || !sources?.sql33 || !sources?.sql36) {
    log("BLOCKED — 0036 DIGEST MISMATCH");
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
    log(`BLOCKED — CONNECT FAILED ${safeError(err)}`);
    return finish(1);
  }

  const rollback = async () => {
    try {
      await db.query("rollback");
    } catch {
      // The transaction may already be closed.
    }
  };

  try {
    await db.query("begin read only");
    const identity = mapIdentity((await db.query(IDENTITY_SQL)).rows[0]);
    const failures = identityFailures(identity, hostname);
    if (identity.endpointId !== EXPECTED_ENDPOINT) failures.push("endpoint-pin");
    log(`neon_project: ${identity.projectId || "unproven"}`);
    log(`neon_branch: ${identity.branchId || "unproven"}`);
    log(`neon_endpoint: ${identity.endpointId || "unproven"}`);
    log(`database: ${identity.database || "unproven"}`);
    log(`role: ${identity.currentUser || "unproven"}`);
    if (failures.length || identity.projectId !== EXPECTED_PROJECT || identity.branchId !== EXPECTED_BRANCH || identity.database !== EXPECTED_DATABASE || identity.currentUser !== EXPECTED_ROLE) {
      await rollback();
      log(`BLOCKED — ISOLATED IDENTITY ${failures.join(",") || "mismatch"}`);
      return finish(1);
    }
    log("isolated_identity: PASS");

    const inspected = await readState(db);
    const equivalence = assess0035Equivalence(sources.sql35, sources.sql33, inspected.catalog);
    const ledger = ledgerDisposition(inspected.ledger);
    const decision = installDecision({
      equivalenceOk: equivalence.ok,
      ledger,
      duplicateCreators: inspected.duplicates,
      schema36: inspected.schema36,
      functions36: inspected.functions36,
    });
    log(`0035_equivalence: ${equivalence.ok ? "pass" : "fail"}`);
    if (!equivalence.ok) log(`0035_equivalence_failures: ${equivalence.failures.join(",")}`);
    log(`ledger_disposition: ${ledger.reason}`);
    log(`duplicate_creators: ${inspected.duplicates}`);
    log(`0036_schema: ${inspected.schema36}`);
    log(`0036_functions: ${inspected.functions36}`);
    log(`organisations_before: ${inspected.counts.organisations}`);
    log(`hotels_before: ${inspected.counts.hotels}`);
    log(`install_decision: ${decision.verdict}`);
    await rollback();

    if (decision.action === "noop") {
      log("writes: none");
      log(ALREADY_APPLIED);
      return finish(0);
    }
    if (decision.action !== "apply") {
      log("writes: none");
      log(decision.verdict);
      return finish(1);
    }

    await db.query("begin");
    await db.query("lock table public._migrations in share row exclusive mode");
    const locked = await readState(db);
    const lockedEquivalence = assess0035Equivalence(sources.sql35, sources.sql33, locked.catalog);
    const lockedLedger = ledgerDisposition(locked.ledger);
    const lockedDecision = installDecision({
      equivalenceOk: lockedEquivalence.ok,
      ledger: lockedLedger,
      duplicateCreators: locked.duplicates,
      schema36: locked.schema36,
      functions36: locked.functions36,
    });
    if (lockedDecision.action !== "apply" || locked.counts.organisations !== inspected.counts.organisations || locked.counts.hotels !== inspected.counts.hotels) {
      await rollback();
      log(`BLOCKED — LOCKED STATE ${lockedDecision.verdict}`);
      log("writes: rolled-back");
      return finish(1);
    }

    try {
      await db.query(sources.sql36);
    } catch (err) {
      await rollback();
      log(`BLOCKED — 0036 APPLICATION FAILED ${safeError(err)}`);
      log("writes: rolled-back");
      return finish(1);
    }
    await db.query("insert into public._migrations (name) values ($1)", [MIGRATION_36]);
    const applied = await readState(db);
    const appliedNames = applied.ledger.filter((name) => !locked.ledger.includes(name));
    const markersOk = applied.schema36 === "present" && applied.functions36 === "present";
    const privilegeOk = assess0035Equivalence(sources.sql35, sources.sql33, {
      ...locked.catalog,
      privileges: applied.catalog.privileges,
      creatorIndex: false,
      effectiveColumn: false,
      effectiveIndex: false,
    }).failures.includes("privilege") === false;
    if (!markersOk || !privilegeOk || appliedNames.length !== 1 || appliedNames[0] !== MIGRATION_36 || applied.ledger.includes(MIGRATION_35) !== locked.ledger.includes(MIGRATION_35) || applied.counts.organisations !== locked.counts.organisations || applied.counts.hotels !== locked.counts.hotels || applied.duplicates !== 0) {
      await rollback();
      log("BLOCKED — POST-MIGRATION VERIFICATION FAILED");
      log("writes: rolled-back");
      return finish(1);
    }
    await db.query("commit");
    log("transaction: committed");
    log("ledger_0035_insert: refused");
    log(`ledger_0036_insert: committed`);
    log(`generic_migrator_safe: ${lockedLedger.genericMigratorSafe ? "true" : "false"}`);
    log(`organisations_after: ${applied.counts.organisations}`);
    log(`hotels_after: ${applied.counts.hotels}`);
    log("production_authorisation: unchanged");
    log(APPLIED);
    return finish(0);
  } catch (err) {
    await rollback();
    log(`BLOCKED — INSTALL FAILED ${safeError(err)}`);
    log("writes: rolled-back");
    return finish(1);
  } finally {
    try {
      await db.end();
    } catch {
      // Closing a failed session must not hide the verdict.
    }
  }
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runInstall({ env: process.env, connect: defaultConnect, say: (line) => console.log(line) })
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((err) => {
      console.log(`BLOCKED — INSTALL FAILED ${safeError(err)}`);
      process.exitCode = 1;
    });
}
