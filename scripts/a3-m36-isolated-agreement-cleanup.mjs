#!/usr/bin/env node
/**
 * A3-M36 isolated agreement-catalogue cleanup. Manual. One transaction.
 *
 * Deletes only the inactive fixture-not-legal approval row on
 * br-dawn-hat-b1b4uqhn. The historical acceptance, organisation, user,
 * memberships, hotels, and accounts stay. Triggers stay enabled.
 * A second run, when the row is already gone, rolls back and changes nothing.
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
  FORBIDDEN_BRANCH,
  FORBIDDEN_ENV,
  ISOLATED_OWNER_ENV,
  directOwnerUrl,
  identityFailures,
} from "./a3-m36-isolated-preflight.mjs";
import { EXPECTED_ENDPOINT } from "./a3-m36-0035-equivalence.mjs";
import { endpointPinFailures } from "./a3-m36-isolated-install.mjs";
import { REQUIRED_TRIGGERS } from "./a3-m36-isolated-cleanup.mjs";
import {
  ACCEPTANCE_ID,
  NOT_LEGAL,
  ORGANISATION_ID,
  RECOVERY_BRANCH,
  USER_ID,
  VERIFIED_FACTS,
} from "./a3-m36-agreement-fixture-plan.mjs";

export const CLEANUP_CONFIRMATION = "CLEANUP-0036-AGREEMENT-ISOLATED";
export const CONFIRMATION_ENV = "A3M36_AGREEMENT_CLEANUP_CONFIRMATION";
export const VERDICT_PASS = "CLEANUP PASS — INACTIVE APPROVAL REMOVED";
export const VERDICT_ABSENT = "CLEANUP BLOCKED — APPROVAL ROW IS ALREADY ABSENT";

const IDENTITY_SQL = `select current_database() as database,
       current_user,
       session_user,
       current_setting('neon.project_id', true) as project_id,
       current_setting('neon.branch_id', true) as branch_id,
       current_setting('neon.endpoint_id', true) as endpoint_id`;

const SHAPE_SQL = `-- a3m36-agreement-shape
select
  exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'sbg_approved_property_agreement_versions'
       and column_name = 'effective'
       and is_nullable = 'NO'
  ) as effective_column,
  exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'sbg_approved_property_agreement_versions_one_effective_uidx'
  ) as effective_index,
  exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'sbg_create_founding_property_for_user'
       and position('and v.effective' in p.prosrc) > 0
  ) as requires_effective,
  exists (
    select 1 from pg_trigger
     where not tgisinternal
       and tgrelid = 'public.sbg_approved_property_agreement_versions'::regclass
       and (tgtype::integer & 8) <> 0
  ) as approval_delete_trigger`;

const FK_SQL = `-- a3m36-agreement-fk
select c.conname
  from pg_constraint c
  join pg_class parent on parent.oid = c.confrelid
  join pg_namespace pn on pn.oid = parent.relnamespace
 where c.contype = 'f'
   and pn.nspname = 'public'
   and parent.relname = 'sbg_approved_property_agreement_versions'`;

const TRIGGER_SQL = `-- a3m36-agreement-triggers
select tgname, tgenabled::text as tgenabled
  from pg_trigger
 where not tgisinternal
   and tgname = any($1::text[])`;

const LOCK_TABLE_SQL = `-- a3m36-agreement-lock-table
lock table public.sbg_approved_property_agreement_versions in share row exclusive mode`;

const LOCK_ROWS_SQL = `-- a3m36-agreement-lock-rows
select agreement_version
  from public.sbg_approved_property_agreement_versions
   for update`;

const LOCK_ACCEPTANCE_SQL = `-- a3m36-agreement-lock-acceptance
select id
  from public.sbg_organisation_acceptances
 where agreement_version = $1
   for update`;

const LOCK_ORGANISATION_SQL = `-- a3m36-agreement-lock-organisation
select id
  from public.sbg_organisations
 where id = $1::uuid
   for update`;

const LOCK_USER_SQL = `-- a3m36-agreement-lock-user
select id
  from public."user"
 where id = $1
   for update`;

const SNAPSHOT_SQL = `-- a3m36-agreement-snapshot
select
  (select count(*)::int from public.sbg_approved_property_agreement_versions) as approval_count,
  (select count(*)::int from public.sbg_approved_property_agreement_versions where effective) as effective_count,
  (select agreement_version from public.sbg_approved_property_agreement_versions limit 1) as approval_version,
  (select effective from public.sbg_approved_property_agreement_versions limit 1) as approval_effective,
  (select count(*)::int from public.sbg_organisation_acceptances where agreement_version = $1) as version_acceptances,
  (select id::text from public.sbg_organisation_acceptances where agreement_version = $1 limit 1) as acceptance_id,
  (select organisation_id::text from public.sbg_organisation_acceptances where agreement_version = $1 limit 1) as organisation_id,
  (select accepted_by_user_id from public.sbg_organisation_acceptances where agreement_version = $1 limit 1) as user_id,
  (select count(*)::int from public.sbg_organisations where id = $2::uuid) as organisations,
  (select count(*)::int from public."user" where id = $3) as users,
  (select count(*)::int from public.hotels where organisation_id = $2::uuid) as org_hotels,
  (select count(*)::int from public.app_hotel_accounts where user_id = $3) as user_accounts,
  (select count(*)::int from public.sbg_organisation_members where organisation_id = $2::uuid) as org_members,
  (select count(*)::int from public.sbg_organisation_acceptances where organisation_id = $2::uuid) as org_acceptances,
  (select count(*)::int from public.sbg_organisations where created_by_user_id = $3) as user_organisations,
  (select count(*)::int from public.sbg_organisation_members where user_id = $3) as user_memberships,
  (select count(*)::int from public.sbg_organisation_acceptances where accepted_by_user_id = $3) as user_acceptances`;

export const DELETE_SQL = `-- a3m36-agreement-delete
delete from public.sbg_approved_property_agreement_versions
 where agreement_version = $1
   and effective = false`;

function sayLine(say, line) {
  const safe = redact(String(line)).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host");
  say(safe);
  return safe;
}

function client(connectionString) {
  return new pg.Client({
    connectionString: directOwnerUrl(connectionString),
    application_name: "a3m36-agreement-cleanup",
    statement_timeout: 15000,
    query_timeout: 20000,
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

function number(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : NaN;
}

export function snapshotFailures(row) {
  const failures = [];
  const approvalCount = number(row?.approval_count);
  if (approvalCount !== 1) failures.push(approvalCount === 0 ? "approval-absent" : "approval-count");
  else {
    if (row?.approval_version !== NOT_LEGAL) failures.push("approval-version");
    if (row?.approval_effective !== false) failures.push("approval-effective");
  }
  if (number(row?.effective_count) !== 0) failures.push("effective-count");
  if (number(row?.version_acceptances) !== 1) failures.push("acceptance-count");
  if (String(row?.acceptance_id ?? "") !== ACCEPTANCE_ID) failures.push("acceptance-id");
  if (String(row?.organisation_id ?? "") !== ORGANISATION_ID) failures.push("organisation-id");
  if (String(row?.user_id ?? "") !== USER_ID) failures.push("user-id");
  if (number(row?.organisations) !== 1) failures.push("organisation-missing");
  if (number(row?.users) !== 1) failures.push("user-missing");
  if (number(row?.org_hotels) !== VERIFIED_FACTS.orgHotels) failures.push("org-hotels");
  if (number(row?.user_accounts) !== VERIFIED_FACTS.userAccounts) failures.push("user-accounts");
  if (number(row?.org_members) !== VERIFIED_FACTS.orgMembers) failures.push("org-members");
  if (number(row?.org_acceptances) !== VERIFIED_FACTS.orgAcceptances) failures.push("org-acceptances");
  if (number(row?.user_organisations) !== VERIFIED_FACTS.userOrganisations) failures.push("user-organisations");
  if (number(row?.user_memberships) !== VERIFIED_FACTS.userMemberships) failures.push("user-memberships");
  if (number(row?.user_acceptances) !== VERIFIED_FACTS.userAcceptances) failures.push("user-acceptances");
  return failures;
}

function preservedFailures(before, after) {
  const failures = [];
  if (number(after?.approval_count) !== 0) failures.push("catalogue-not-empty");
  if (number(after?.effective_count) !== 0) failures.push("effective-not-zero");
  if (String(after?.acceptance_id ?? "") !== ACCEPTANCE_ID) failures.push("acceptance-lost");
  if (String(after?.organisation_id ?? "") !== ORGANISATION_ID) failures.push("acceptance-org-lost");
  if (String(after?.user_id ?? "") !== USER_ID) failures.push("acceptance-user-lost");
  if (number(after?.version_acceptances) !== 1) failures.push("acceptance-count-changed");
  for (const key of ["organisations", "users", "org_hotels", "user_accounts", "org_members", "org_acceptances", "user_organisations", "user_memberships", "user_acceptances"]) {
    if (number(after?.[key]) !== number(before?.[key])) failures.push(`changed-${key}`);
  }
  return failures;
}

function lockConflict(err) {
  const code = String(err?.code ?? "");
  return code === "55P03" || code === "40P01" || code === "57014" || code === "40001";
}

async function rollback(db, log) {
  try {
    await db.query("rollback");
    log("transaction: rolled-back");
  } catch {
    log("transaction: rollback-failed");
  }
}

export async function runAgreementCleanup({ env, connect = client, say = () => {} }) {
  const lines = [];
  const log = (line) => lines.push(sayLine(say, line));
  const finish = (exitCode) => ({ exitCode, lines });
  const confirmation = String(env?.[CONFIRMATION_ENV] ?? "");
  const isolated = String(env?.[ISOLATED_OWNER_ENV] ?? "").trim();
  log(`commit: ${String(env?.GITHUB_SHA ?? "local")}`);
  log(`workflow_run: ${String(env?.GITHUB_RUN_ID ?? "not-dispatched")}`);
  log(`confirmation: ${confirmation === CLEANUP_CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  log(`${ISOLATED_OWNER_ENV}: ${isolated ? "PRESENT" : "ABSENT"}`);
  log("recovery_stage: not-invoked");
  log("concurrency_stage: not-invoked");
  if (confirmation !== CLEANUP_CONFIRMATION) {
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
    log(`BLOCKED — CONNECT FAILED ${String(err?.message ?? err).split("\n")[0].slice(0, 180)}`);
    return finish(1);
  }

  let writing = false;
  try {
    await db.query("begin read only");
    const identity = mapIdentity((await db.query(IDENTITY_SQL)).rows[0]);
    const hostname = new URL(directOwnerUrl(isolated)).hostname.toLowerCase();
    const failures = identityFailures(identity, hostname);
    if (identity.endpointId !== EXPECTED_ENDPOINT) failures.push("endpoint-pin");
    if (identity.branchId === RECOVERY_BRANCH) failures.push("recovery-branch");
    if (identity.branchId === FORBIDDEN_BRANCH) failures.push("production-branch");
    log(`neon_project: ${identity.projectId || "unproven"}`);
    log(`neon_branch: ${identity.branchId || "unproven"}`);
    log(`neon_endpoint: ${identity.endpointId || "unproven"}`);
    log(`database: ${identity.database || "unproven"}`);
    log(`role: ${identity.currentUser || "unproven"}`);
    if (failures.length) {
      await db.query("rollback");
      log(`BLOCKED — ISOLATED IDENTITY ${[...new Set(failures)].join(",")}`);
      return finish(1);
    }
    await db.query("rollback");

    await db.query("begin");
    writing = true;
    await db.query(LOCK_TABLE_SQL);
    await db.query(LOCK_ROWS_SQL);
    await db.query(LOCK_ACCEPTANCE_SQL, [NOT_LEGAL]);
    await db.query(LOCK_ORGANISATION_SQL, [ORGANISATION_ID]);
    await db.query(LOCK_USER_SQL, [USER_ID]);
    const shape = (await db.query(SHAPE_SQL)).rows[0] ?? {};
    const foreignKeys = (await db.query(FK_SQL)).rows;
    const triggers = (await db.query(TRIGGER_SQL, [REQUIRED_TRIGGERS])).rows;
    const before = (await db.query(SNAPSHOT_SQL, [NOT_LEGAL, ORGANISATION_ID, USER_ID])).rows[0] ?? {};
    const disabled = REQUIRED_TRIGGERS.filter((name) => !triggers.some((row) => row.tgname === name && row.tgenabled === "O"));
    const gates = [];
    if (shape.effective_column !== true || shape.effective_index !== true || shape.requires_effective !== true) gates.push("schema-drift");
    if (shape.approval_delete_trigger === true) gates.push("approval-delete-trigger");
    if (foreignKeys.length) gates.push("catalogue-foreign-key");
    if (disabled.length) gates.push("trigger-disabled");
    const shapeFailures = snapshotFailures(before);
    log(`precondition_approval_count: ${number(before.approval_count)}`);
    log(`precondition_effective_count: ${number(before.effective_count)}`);
    log(`precondition_failures: ${[...gates, ...shapeFailures].join(",") || "none"}`);
    if (shapeFailures.includes("approval-absent") && gates.length === 0 && shapeFailures.length === 1) {
      log("deleted_rows: 0 expected: 1");
      await rollback(db, log);
      writing = false;
      log(VERDICT_ABSENT);
      return finish(1);
    }
    if (gates.length || shapeFailures.length) {
      log("deleted_rows: 0 expected: 1");
      await rollback(db, log);
      writing = false;
      log(`BLOCKED — PRECONDITION ${[...gates, ...shapeFailures].join(",")}`);
      return finish(1);
    }

    const removed = await db.query(DELETE_SQL, [NOT_LEGAL]);
    const deleted = Number(removed?.rowCount ?? 0);
    log(`deleted_rows: ${deleted} expected: 1`);
    if (deleted !== 1) {
      await rollback(db, log);
      writing = false;
      log("BLOCKED — DELETE COUNT");
      return finish(1);
    }
    const after = (await db.query(SNAPSHOT_SQL, [NOT_LEGAL, ORGANISATION_ID, USER_ID])).rows[0] ?? {};
    const afterKeys = (await db.query(FK_SQL)).rows;
    const afterTriggers = (await db.query(TRIGGER_SQL, [REQUIRED_TRIGGERS])).rows;
    const afterDisabled = REQUIRED_TRIGGERS.filter((name) => !afterTriggers.some((row) => row.tgname === name && row.tgenabled === "O"));
    const post = preservedFailures(before, after);
    if (afterKeys.length) post.push("catalogue-foreign-key");
    if (afterDisabled.length) post.push("trigger-disabled");
    log(`acceptance_preserved: ${post.some((item) => item.startsWith("acceptance")) ? "false" : "true"}`);
    log(`organisation_preserved: ${number(after.organisations) === 1 ? "true" : "false"}`);
    log(`user_preserved: ${number(after.users) === 1 ? "true" : "false"}`);
    log(`org_hotels: ${number(after.org_hotels)}`);
    log(`user_accounts: ${number(after.user_accounts)}`);
    log(`org_members: ${number(after.org_members)}`);
    log(`org_acceptances: ${number(after.org_acceptances)}`);
    log(`user_organisations: ${number(after.user_organisations)}`);
    log(`user_memberships: ${number(after.user_memberships)}`);
    log(`user_acceptances: ${number(after.user_acceptances)}`);
    if (post.length) {
      await rollback(db, log);
      writing = false;
      log(`BLOCKED — POSTCONDITION ${post.join(",")}`);
      return finish(1);
    }
    await db.query("commit");
    writing = false;
    log("transaction: committed");
    log(`approval_rows: ${number(after.approval_count)}`);
    log(`effective_rows: ${number(after.effective_count)}`);
    log(VERDICT_PASS);
    return finish(0);
  } catch (err) {
    if (writing) await rollback(db, log);
    const reason = lockConflict(err) ? "LOCK CONFLICT" : "QUERY FAILED";
    log(`BLOCKED — ${reason} ${String(err?.message ?? err).split("\n")[0].slice(0, 180)}`);
    return finish(1);
  } finally {
    if (typeof db?.end === "function") await db.end();
  }
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const result = await runAgreementCleanup({ env: process.env, say: (line) => console.log(line) });
  process.exit(result.exitCode);
}
