#!/usr/bin/env node
/**
 * A3-M36 concurrency gate for one disposable Neon branch.
 * Manual. Does not install SQL. Does not delete immutable organisation,
 * membership, or acceptance rows. Does not open the parent isolated branch,
 * the recovery branch, or Production.
 *
 * Uses AETHER_0036_DISPOSABLE_OWNER_URL. An optional
 * AETHER_0036_DISPOSABLE_APP_URL must be a distinct aether_app login on
 * that same disposable endpoint. There is no parent or Production fallback.
 * A missing app login is NOT TESTED, not a pass.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ACCEPTED_LEDGER, redact } from "./production-db-preflight.mjs";
import {
  EXPECTED_BRANCH,
  EXPECTED_DATABASE,
  EXPECTED_PROJECT,
  EXPECTED_ROLE,
  FORBIDDEN_BRANCH,
  FORBIDDEN_ENDPOINT,
  FORBIDDEN_ENV,
  ISOLATED_OWNER_ENV,
  directOwnerUrl,
  hostSafetyFailures,
} from "./a3-m36-isolated-preflight.mjs";
import {
  EXPECTED_ENDPOINT,
  MIGRATION_35,
  MIGRATION_36,
} from "./a3-m36-0035-equivalence.mjs";
import { RECOVERY_BRANCH } from "./a3-m36-agreement-fixture-plan.mjs";
import {
  FIXTURE_APP_DENIED,
  FIXTURE_EFFECTIVE,
  FIXTURE_SUPERSEDED,
  FIXTURE_UNAPPROVED,
  FIXTURE_VERSIONS,
  MARKER,
  NAME_PREFIX,
  cleanupFailure,
  isMarkerUser,
  triggerGuard,
} from "./a3-m36-isolated-cleanup.mjs";

export {
  FIXTURE_APP_DENIED,
  FIXTURE_EFFECTIVE,
  FIXTURE_SUPERSEDED,
  FIXTURE_UNAPPROVED,
  FIXTURE_VERSIONS,
  MARKER,
  NAME_PREFIX,
  cleanupFailure,
  isMarkerUser,
};

export const CONCURRENCY_CONFIRMATION = "CONCURRENCY-0036-DISPOSABLE";
export const CONFIRMATION_ENV = "A3M36_CONCURRENCY_CONFIRMATION";
export const DISPOSABLE_OWNER_ENV = "AETHER_0036_DISPOSABLE_OWNER_URL";
export const DISPOSABLE_APP_ENV = "AETHER_0036_DISPOSABLE_APP_URL";
export const DISPOSABLE_BRANCH_ENV = "A3M36_DISPOSABLE_BRANCH";
export const DISPOSABLE_ENDPOINT_ENV = "A3M36_DISPOSABLE_ENDPOINT";
export const PASS_VERDICT = "GATE PASS — 0036 DISPOSABLE CONCURRENCY VERIFIED";
export const INCOMPLETE_VERDICT = "INCOMPLETE — RUNTIME ROLE SECURITY NOT TESTED";
export const RETAINED_CLEANUP = "RETAINED — IMMUTABLE FIXTURE NOT DELETED";
export const PROTECTED_BRANCHES = [EXPECTED_BRANCH, FORBIDDEN_BRANCH, RECOVERY_BRANCH];
export const PROTECTED_ENDPOINTS = [EXPECTED_ENDPOINT, FORBIDDEN_ENDPOINT];
const BLOCKED_ENV = [...FORBIDDEN_ENV, ISOLATED_OWNER_ENV, "AETHER_0036_ISOLATED_APP_URL"];

const IDENTITY_SQL = `select current_database() as database,
       current_user,
       session_user,
       current_setting('neon.project_id', true) as project_id,
       current_setting('neon.branch_id', true) as branch_id,
       current_setting('neon.endpoint_id', true) as endpoint_id`;

const CREATE_SQL = `select sbg_create_organisation_for_user($1, $2)::text as organisation_id`;
const ENSURE_SQL = `select organisation_id::text as organisation_id from sbg_ensure_founding_organisation($1, $2)`;
const PROPERTY_SQL = `select hotel_id::text as hotel_id, provider_id::text as provider_id
  from sbg_create_founding_property_for_user($1, $2, $3, $4, $5, $6)`;

export function overlapFailure({ distinctPids, lockWaitObserved, waiterSeen }) {
  if (distinctPids !== true) return "BLOCKED — CONNECTIONS ARE NOT INDEPENDENT";
  if (waiterSeen !== true || lockWaitObserved !== true) return "BLOCKED — TRANSACTIONS DID NOT OVERLAP";
  return "";
}

export function sameCreatorVerdict({ overlap, orgCount, memberCount, waiterError, holderId, ensureId }) {
  const overlapError = overlapFailure(overlap);
  if (overlapError) return overlapError;
  if (orgCount !== 1 || memberCount !== 1 || !holderId || ensureId !== holderId) return "BLOCKED — SAME-CREATOR ORGANISATION OUTCOME";
  if (!/founding organisation already exists/i.test(String(waiterError ?? ""))) return "BLOCKED — SECOND CREATE WAS NOT REJECTED";
  return "";
}

export function propertyPairVerdict({ overlap, orgCount, hotelIds, organisationIds }) {
  const overlapError = overlapFailure(overlap);
  if (overlapError) return overlapError;
  const hotels = [...(hotelIds ?? [])];
  const orgs = [...(organisationIds ?? [])];
  if (orgCount !== 1 || hotels.length !== 2 || new Set(hotels).size !== 2 || new Set(orgs).size !== 1) {
    return "BLOCKED — SIMULTANEOUS PROPERTY OUTCOME";
  }
  return "";
}

export function duplicateCodeVerdict({ overlap, hotelDelta, providerDelta, waiterError }) {
  const overlapError = overlapFailure(overlap);
  if (overlapError) return overlapError;
  if (hotelDelta !== 1 || providerDelta !== 1) return "BLOCKED — DUPLICATE CODE LEFT EXTRA ROWS";
  if (!/hotel code already exists/i.test(String(waiterError ?? ""))) return "BLOCKED — DUPLICATE CODE WAS NOT REJECTED";
  return "";
}

export function rollbackVerdict({ error, before, after }) {
  if (!/terms are not approved for property creation/i.test(String(error ?? ""))) return "BLOCKED — FAILED CREATION DID NOT REJECT";
  if (JSON.stringify(before) !== JSON.stringify(after)) return "BLOCKED — FAILED CREATION PERSISTED";
  return "";
}

export function uncommittedVerdict({ before, after }) {
  if (JSON.stringify(before) !== JSON.stringify(after)) return "BLOCKED — ROLLED BACK CREATION PERSISTED";
  return "";
}

export function termsVerdict(results) {
  const failed = (error) => /terms are not approved for property creation/i.test(String(error ?? ""));
  if (!results?.effectiveHotel || !results?.bothHotel) return "BLOCKED — EFFECTIVE TERMS DID NOT AUTHORISE";
  if (!failed(results.supersededError) || !failed(results.provisionalError) || !failed(results.unapprovedError)) {
    return "BLOCKED — SUPERSEDED PROVISIONAL OR UNAPPROVED TERMS WERE ACCEPTED";
  }
  if (!/not_provisional|violates check constraint/i.test(String(results.termsV1InsertError ?? ""))) {
    return "BLOCKED — TERMS-V1 WAS INSERTED INTO THE APPROVAL TABLE";
  }
  if (Number(results.termsV1ApprovalRows) !== 0) return "BLOCKED — TERMS-V1 APPROVAL PERSISTED";
  return "";
}

export function isolationVerdict({ leftId, rightId, leftCount, rightCount, leftName, rightName, memberInserted }) {
  if (!leftId || !rightId || leftId === rightId) return "BLOCKED — CREATORS WERE NOT ISOLATED";
  if (leftCount !== 1 || rightCount !== 1 || !leftName || !rightName) return "BLOCKED — CREATOR CARDINALITY CHANGED";
  if (!String(leftName).startsWith(NAME_PREFIX) || !String(rightName).startsWith(NAME_PREFIX)) return "BLOCKED — CREATOR CARDINALITY CHANGED";
  if (memberInserted !== true) return "BLOCKED — CROSS-MEMBERSHIP WAS NOT RECORDED";
  return "";
}

export function runtimeRoleVerdict({ catalogMatch, appConnection, live }) {
  if (catalogMatch !== true) return "BLOCKED — RUNTIME PRIVILEGE CATALOG";
  if (appConnection === "absent") return "NOT TESTED";
  if (!live?.sameIdentity || live.role !== "aether_app") return "BLOCKED — APP CONNECTION IDENTITY";
  if (live.selectAllowed !== false || live.insertAllowed !== false || live.updateAllowed !== false) {
    return "BLOCKED — APP CONNECTION READ OR WROTE APPROVALS";
  }
  if (live.executeCreate !== true) return "BLOCKED — APP CONNECTION CANNOT EXECUTE CREATE";
  if (live.runtimeExecute !== false || live.publicExecute !== false) return "BLOCKED — RUNTIME ROLE CAN EXECUTE";
  return "";
}

export function overallVerdict({ concurrency, terms, runtime, cleanup }) {
  const blocked = [concurrency, terms, runtime, cleanup].find((item) => String(item ?? "").startsWith("BLOCKED"));
  if (blocked) return { exitCode: 1, full: false, verdict: blocked };
  if (concurrency !== "PASS" || terms !== "PASS" || cleanup !== RETAINED_CLEANUP) {
    return { exitCode: 1, full: false, verdict: "BLOCKED — CONCURRENCY SECTIONS DID NOT COMPLETE" };
  }
  if (runtime === "NOT TESTED") return { exitCode: 2, full: false, verdict: INCOMPLETE_VERDICT };
  if (runtime !== "PASS") return { exitCode: 1, full: false, verdict: "BLOCKED — RUNTIME ROLE SECURITY INCOMPLETE" };
  return { exitCode: 0, full: true, verdict: PASS_VERDICT };
}

export function concurrencyLedgerOk(names) {
  const ledger = [...(names ?? [])].map(String);
  const unique = new Set(ledger);
  if (unique.size !== ledger.length) return false;
  const allowed = new Set([...ACCEPTED_LEDGER, MIGRATION_35, MIGRATION_36]);
  if ([...unique].some((name) => !allowed.has(name))) return false;
  if (ACCEPTED_LEDGER.some((name) => !unique.has(name))) return false;
  return unique.has(MIGRATION_36);
}

export function disposablePinFailures({ branch, endpoint }) {
  const branchId = String(branch ?? "").trim();
  const endpointId = String(endpoint ?? "").trim();
  const failures = [];
  if (!/^br-[a-z0-9-]{8,}$/.test(branchId)) failures.push("branch-shape");
  if (!/^ep-[a-z0-9-]{8,}$/.test(endpointId)) failures.push("endpoint-shape");
  if (PROTECTED_BRANCHES.includes(branchId)) failures.push("protected-branch");
  if (PROTECTED_ENDPOINTS.includes(endpointId)) failures.push("protected-endpoint");
  return failures;
}

export function disposableUrlFailures(value, endpointId) {
  const failures = hostSafetyFailures(value);
  let label = "";
  try {
    label = new URL(directOwnerUrl(value)).hostname.toLowerCase().split(".")[0] ?? "";
  } catch {
    label = "";
  }
  if (label !== String(endpointId ?? "").trim()) failures.push("endpoint-pin");
  if (PROTECTED_ENDPOINTS.includes(label)) failures.push("protected-endpoint");
  if (PROTECTED_BRANCHES.some((id) => String(value ?? "").includes(id))) failures.push("protected-branch-in-url");
  return [...new Set(failures)];
}

export function disposableIdentityFailures(identity, hostname, expected) {
  const branchId = String(identity?.branchId ?? "").trim();
  const endpointId = String(identity?.endpointId ?? "").trim();
  const label = String(hostname ?? "").toLowerCase().split(".")[0] ?? "";
  const failures = [];
  if (identity?.projectId !== EXPECTED_PROJECT) failures.push("project");
  if (!branchId) failures.push("branch-unproven");
  if (branchId !== expected?.branch) failures.push("branch");
  if (PROTECTED_BRANCHES.includes(branchId)) failures.push("protected-branch");
  if (!endpointId) failures.push("endpoint-unproven");
  if (endpointId !== expected?.endpoint) failures.push("endpoint");
  if (PROTECTED_ENDPOINTS.includes(endpointId)) failures.push("protected-endpoint");
  if (identity?.database !== EXPECTED_DATABASE) failures.push("database");
  if (identity?.currentUser !== EXPECTED_ROLE || identity?.sessionUser !== EXPECTED_ROLE) failures.push("role");
  if (!endpointId || label !== endpointId) failures.push("endpoint-host-mismatch");
  return [...new Set(failures)];
}

export function appUrlFailures(value, ownerValue, endpointId) {
  const raw = String(value ?? "").trim();
  if (!raw) return ["absent"];
  let url;
  try {
    url = new URL(directOwnerUrl(raw));
  } catch {
    return ["url"];
  }
  const failures = [];
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") failures.push("protocol");
  const label = url.hostname.toLowerCase().split(".")[0] ?? "";
  if (label !== String(endpointId ?? "").trim()) failures.push("endpoint-pin");
  if (PROTECTED_ENDPOINTS.includes(label) || raw.includes(FORBIDDEN_ENDPOINT) || raw.includes(EXPECTED_ENDPOINT)) failures.push("protected-endpoint");
  if (url.pathname !== `/${EXPECTED_DATABASE}`) failures.push("database");
  let user = "";
  try {
    user = decodeURIComponent(url.username);
  } catch {
    user = "";
  }
  if (user !== "aether_app") failures.push("role");
  let owner;
  try {
    owner = new URL(directOwnerUrl(ownerValue));
  } catch {
    owner = null;
  }
  if (owner && owner.hostname === url.hostname && owner.pathname === url.pathname && owner.username === url.username) {
    failures.push("same-as-owner");
  }
  return failures;
}

function sayLine(say, line) {
  const safe = redact(String(line)).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host");
  say(safe);
  return safe;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function captureQuery(promise) {
  return promise.then(
    (result) => ({ result, error: "" }),
    (err) => ({ result: null, error: String(err?.message ?? err) }),
  );
}

function client(connectionString, name) {
  return new pg.Client({
    connectionString: directOwnerUrl(connectionString),
    application_name: name,
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

async function waitForLock(observer, pid) {
  const started = Date.now();
  let sawPid = false;
  while (Date.now() - started < 8000) {
    const row = (await observer.query(
      `select wait_event_type from pg_stat_activity where pid = $1`,
      [pid],
    )).rows[0];
    if (row) {
      sawPid = true;
      if (row.wait_event_type === "Lock") return { observed: true, sawPid: true };
    }
    await delay(40);
  }
  return { observed: false, sawPid };
}

async function snapshot(db) {
  const counts = (await db.query(
    `select
       (select count(*)::int from public.sbg_organisations) as organisations,
       (select count(*)::int from public.hotels) as hotels,
       (select count(*)::int from public.providers) as providers,
       (select count(*)::int from public."user") as users,
       (select count(*)::int from public.sbg_organisation_members) as members,
       (select count(*)::int from public.sbg_organisation_acceptances) as acceptances,
       (select count(*)::int from public.sbg_approved_property_agreement_versions) as approvals,
       (select count(*)::int from public.bookings) as bookings`,
  )).rows[0];
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)]));
}

async function insertUser(db, id, label) {
  const email = `${MARKER}-proof-${id}@invalid.scanbookgo.test`;
  const name = `${NAME_PREFIX}${label}`;
  await db.query(
    `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, false, now(), now())`,
    [id, name, email],
  );
}

async function accept(db, orgId, userId, version) {
  await db.query(
    `insert into public.sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
     values ($1::uuid, $2, $3)`,
    [orgId, userId, version],
  );
}

async function foundProperty(db, userId, code) {
  return db.query(PROPERTY_SQL, [userId, code, `${NAME_PREFIX}Property`, "Athens", "Europe/Athens", "EUR"]);
}

function code(label) {
  return `${MARKER}-${label}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

async function held(holder, waiter, observer, userLock, waiterCall, holderCall, waiterPid) {
  await holder.query("begin");
  let waiterPromise;
  try {
    await holder.query(`select id from public."user" where id = $1 for update`, [userLock]);
    waiterPromise = captureQuery(waiterCall());
    const blocked = await waitForLock(observer, waiterPid);
    const created = await holderCall();
    await holder.query("commit");
    const waited = await waiterPromise;
    return { blocked, created, waited };
  } catch (err) {
    try { await holder.query("rollback"); } catch { /* keep the original error */ }
    if (waiterPromise) await waiterPromise;
    throw err;
  }
}

export async function runConcurrency({ env, connect = client, say = () => {} }) {
  const lines = [];
  const log = (line) => lines.push(sayLine(say, line));
  const finish = (exitCode) => ({ exitCode, lines });
  const confirmation = String(env?.[CONFIRMATION_ENV] ?? "");
  const ownerUrl = String(env?.[DISPOSABLE_OWNER_ENV] ?? "").trim();
  const appUrl = String(env?.[DISPOSABLE_APP_ENV] ?? "").trim();
  const expected = {
    branch: String(env?.[DISPOSABLE_BRANCH_ENV] ?? "").trim(),
    endpoint: String(env?.[DISPOSABLE_ENDPOINT_ENV] ?? "").trim(),
  };
  log(`confirmation: ${confirmation === CONCURRENCY_CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  log(`${DISPOSABLE_OWNER_ENV}: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  log(`${DISPOSABLE_APP_ENV}: ${appUrl ? "PRESENT" : "ABSENT"}`);
  log(`disposable_branch: ${expected.branch || "ABSENT"}`);
  log(`disposable_endpoint: ${expected.endpoint || "ABSENT"}`);
  log("install_stage: not-invoked");
  log("terms_v1_approval: refused");
  log("immutable_delete: not-attempted");
  if (confirmation !== CONCURRENCY_CONFIRMATION) {
    log("BLOCKED — CONFIRMATION PHRASE INVALID");
    return finish(1);
  }
  for (const name of BLOCKED_ENV) {
    if (String(env?.[name] ?? "").trim()) {
      log(`BLOCKED — ${name} must not be set`);
      return finish(1);
    }
  }
  const pinFailures = disposablePinFailures(expected);
  if (pinFailures.length) {
    log(`BLOCKED — DISPOSABLE TARGET ${pinFailures.join(",")}`);
    return finish(1);
  }
  if (!ownerUrl) {
    log("BLOCKED — AETHER_0036_DISPOSABLE_OWNER_URL is absent. No database was opened.");
    return finish(1);
  }
  const hostFailures = disposableUrlFailures(ownerUrl, expected.endpoint);
  if (hostFailures.length) {
    log(`BLOCKED — CONNECTION ${hostFailures.join(",")}`);
    return finish(1);
  }
  const appFailures = appUrl ? appUrlFailures(appUrl, ownerUrl, expected.endpoint) : [];
  if (appUrl && appFailures.length) {
    log(`BLOCKED — APP CONNECTION ${appFailures.join(",")}`);
    return finish(1);
  }

  const holder = connect(ownerUrl, "a3m36-disposable-concurrency");
  const waiter = connect(ownerUrl, "a3m36-disposable-concurrency-waiter");
  const observer = connect(ownerUrl, "a3m36-disposable-concurrency-observer");
  const userIds = [];
  let opened = false;
  let app;
  let concluded = false;
  let before = null;
  const sections = { concurrency: "NOT RUN", terms: "NOT RUN", runtime: "NOT TESTED" };
  const stop = (section, verdict) => {
    sections[section] = verdict;
    const error = new Error(verdict);
    error.sectioned = true;
    throw error;
  };
  async function conclude() {
    if (concluded) return finish(1);
    concluded = true;
    let cleanupVerdict = "NOT RUN";
    if (opened) {
      try { await observer.query("rollback"); } catch { /* no open transaction */ }
      if (before) {
        cleanupVerdict = RETAINED_CLEANUP;
        log("fixture_residue: retained");
      }
      const guards = await triggerGuard(observer);
      log(`triggers_still_enabled: ${guards.ok}`);
      if (!guards.ok) cleanupVerdict = guards.verdict;
    }
    log(`cleanup: ${cleanupVerdict}`);
    log(`postgresql_concurrency: ${sections.concurrency}`);
    log(`agreement_version_enforcement: ${sections.terms}`);
    log(`runtime_role_security: ${sections.runtime}`);
    const overall = overallVerdict({
      concurrency: sections.concurrency,
      terms: sections.terms,
      runtime: sections.runtime,
      cleanup: cleanupVerdict,
    });
    log(`overall: ${overall.verdict}`);
    if (overall.full) log(PASS_VERDICT);
    return finish(overall.exitCode);
  }
  try {
    await Promise.all([holder.connect(), waiter.connect(), observer.connect()]);
    opened = true;
    const pids = await Promise.all([
      holder.query("select pg_backend_pid() as pid"),
      waiter.query("select pg_backend_pid() as pid"),
      observer.query("select pg_backend_pid() as pid"),
    ]);
    const pidA = Number(pids[0].rows[0].pid);
    const pidB = Number(pids[1].rows[0].pid);
    const pidC = Number(pids[2].rows[0].pid);
    const distinctPids = new Set([pidA, pidB, pidC]).size === 3;
    log(`backend_pids_distinct: ${distinctPids}`);
    if (!distinctPids) {
      log("BLOCKED — CONNECTIONS ARE NOT INDEPENDENT");
      return finish(1);
    }

    await observer.query("begin read only");
    const identity = mapIdentity((await observer.query(IDENTITY_SQL)).rows[0]);
    const hostname = new URL(directOwnerUrl(ownerUrl)).hostname.toLowerCase();
    const failures = disposableIdentityFailures(identity, hostname, expected);
    log(`neon_project: ${identity.projectId || "unproven"}`);
    log(`neon_branch: ${identity.branchId || "unproven"}`);
    log(`neon_endpoint: ${identity.endpointId || "unproven"}`);
    if (failures.length || identity.projectId !== EXPECTED_PROJECT || identity.branchId !== expected.branch || identity.endpointId !== expected.endpoint) {
      await observer.query("rollback");
      log(`BLOCKED — ISOLATED IDENTITY ${failures.join(",") || "mismatch"}`);
      return finish(1);
    }
    const ledger = (await observer.query("select name from public._migrations order by name")).rows.map((row) => String(row.name));
    const objects = (await observer.query(
      `select
         exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'sbg_organisations_one_founding_creator_uidx') as creator_index,
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sbg_approved_property_agreement_versions' and column_name = 'effective') as effective_column,
         exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'sbg_approved_property_agreement_versions_one_effective_uidx') as effective_index`,
    )).rows[0];
    const markers = (await observer.query(
      `select p.proname,
              position('founding organisation already exists' in p.prosrc) > 0 as rejects_second,
              position('and v.effective' in p.prosrc) > 0 as requires_effective
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('sbg_create_organisation_for_user', 'sbg_create_founding_property_for_user')`,
    )).rows;
    const duplicates = Number((await observer.query(
      `select count(*)::int as n from (select 1 from public.sbg_organisations group by created_by_user_id having count(*) > 1) d`,
    )).rows[0].n);
    const approvals = (await observer.query(
      `select count(*)::int as n, count(*) filter (where effective)::int as effective_n
         from public.sbg_approved_property_agreement_versions`,
    )).rows[0];
    await observer.query("rollback");
    const creator = markers.find((row) => row.proname === "sbg_create_organisation_for_user");
    const property = markers.find((row) => row.proname === "sbg_create_founding_property_for_user");
    const installed = concurrencyLedgerOk(ledger)
      && objects.creator_index === true
      && objects.effective_column === true
      && objects.effective_index === true
      && creator?.rejects_second === true
      && property?.requires_effective === true;
    log(`0036_installed: ${installed}`);
    log(`duplicate_creators: ${duplicates}`);
    log(`approval_rows: ${Number(approvals.n)}`);
    if (!installed) {
      log("BLOCKED — 0036 IS NOT INSTALLED");
      return finish(1);
    }
    if (duplicates > 0) {
      log("BLOCKED — DUPLICATE FOUNDING CREATORS");
      return finish(1);
    }
    if (Number(approvals.n) !== 0 || Number(approvals.effective_n) !== 0) {
      log("BLOCKED — APPROVAL TABLE IS NOT EMPTY");
      return finish(1);
    }
    log("disposable_identity: PASS");

    const guards = await triggerGuard(observer);
    log(`trigger_guard: ${guards.ok ? "enabled" : guards.verdict}`);
    if (!guards.ok) {
      sections.concurrency = guards.verdict;
      return conclude();
    }
    before = await snapshot(observer);
    await observer.query("begin");
    await observer.query(
      `insert into public.sbg_approved_property_agreement_versions (agreement_version, effective)
       values ($1, true), ($2, false)`,
      [FIXTURE_EFFECTIVE, FIXTURE_SUPERSEDED],
    );
    await observer.query("commit");

    const sameUser = `${MARKER}-${randomUUID()}`;
    userIds.push(sameUser);
    await insertUser(observer, sameUser, "Same");
    const sameRace = await held(
      holder,
      waiter,
      observer,
      sameUser,
      () => waiter.query(CREATE_SQL, [sameUser, `${NAME_PREFIX}Same Waiter`]),
      () => holder.query(CREATE_SQL, [sameUser, `${NAME_PREFIX}Same Holder`]),
      pidB,
    );
    const sameOrg = sameRace.created.rows[0].organisation_id;
    const ensured = (await observer.query(ENSURE_SQL, [sameUser, `${NAME_PREFIX}Same Retry`])).rows[0];
    const sameCount = Number((await observer.query(`select count(*)::int as n from public.sbg_organisations where created_by_user_id = $1`, [sameUser])).rows[0].n);
    const sameMembers = Number((await observer.query(`select count(*)::int as n from public.sbg_organisation_members where user_id = $1 and removed_at is null`, [sameUser])).rows[0].n);
    const sameVerdict = sameCreatorVerdict({
      overlap: { distinctPids, lockWaitObserved: sameRace.blocked.observed, waiterSeen: sameRace.blocked.sawPid },
      orgCount: sameCount,
      memberCount: sameMembers,
      waiterError: sameRace.waited.error,
      holderId: sameOrg,
      ensureId: ensured.organisation_id,
    });
    log(`test_same_creator: ${sameVerdict || "PASS"}`);
    log(`test_same_creator_overlap: ${sameRace.blocked.observed === true}`);
    if (sameVerdict) stop("concurrency", sameVerdict);

    const propertyUser = `${MARKER}-${randomUUID()}`;
    userIds.push(propertyUser);
    await insertUser(observer, propertyUser, "Property");
    const propertyOrg = (await observer.query(CREATE_SQL, [propertyUser, `${NAME_PREFIX}Property`])).rows[0].organisation_id;
    await observer.query(`select organisation_id::text from sbg_classify_founding_organisation($1, $2)`, [propertyUser, "hotel"]);
    await accept(observer, propertyOrg, propertyUser, FIXTURE_EFFECTIVE);
    const codeA = code("pair-a");
    const codeB = code("pair-b");
    const pair = await held(
      holder,
      waiter,
      observer,
      propertyUser,
      () => waiter.query(PROPERTY_SQL, [propertyUser, codeB, `${NAME_PREFIX}Property B`, "Athens", "Europe/Athens", "EUR"]),
      () => holder.query(PROPERTY_SQL, [propertyUser, codeA, `${NAME_PREFIX}Property A`, "Athens", "Europe/Athens", "EUR"]),
      pidB,
    );
    const pairHotels = [pair.created.rows[0]?.hotel_id, pair.waited.result?.rows?.[0]?.hotel_id].filter(Boolean);
    const pairOrgs = (await observer.query(`select organisation_id::text as id from public.hotels where id = any($1::uuid[])`, [pairHotels])).rows.map((row) => row.id);
    const pairOrgCount = Number((await observer.query(`select count(*)::int as n from public.sbg_organisations where created_by_user_id = $1`, [propertyUser])).rows[0].n);
    const pairVerdict = propertyPairVerdict({
      overlap: { distinctPids, lockWaitObserved: pair.blocked.observed, waiterSeen: pair.blocked.sawPid },
      orgCount: pairOrgCount,
      hotelIds: pairHotels,
      organisationIds: pairOrgs,
    });
    log(`test_property_pair: ${pairVerdict || "PASS"}`);
    log(`test_property_pair_overlap: ${pair.blocked.observed === true}`);
    if (pairVerdict) stop("concurrency", pairVerdict);

    const codeUser = `${MARKER}-${randomUUID()}`;
    userIds.push(codeUser);
    await insertUser(observer, codeUser, "Code");
    const codeOrg = (await observer.query(CREATE_SQL, [codeUser, `${NAME_PREFIX}Code`])).rows[0].organisation_id;
    await observer.query(`select organisation_id::text from sbg_classify_founding_organisation($1, $2)`, [codeUser, "hotel"]);
    await accept(observer, codeOrg, codeUser, FIXTURE_EFFECTIVE);
    const sharedCode = code("shared");
    const beforeCode = await snapshot(observer);
    const duplicate = await held(
      holder,
      waiter,
      observer,
      codeUser,
      () => waiter.query(PROPERTY_SQL, [codeUser, sharedCode, `${NAME_PREFIX}Code Waiter`, "Athens", "Europe/Athens", "EUR"]),
      () => holder.query(PROPERTY_SQL, [codeUser, sharedCode, `${NAME_PREFIX}Code Holder`, "Athens", "Europe/Athens", "EUR"]),
      pidB,
    );
    const afterCode = await snapshot(observer);
    const duplicateVerdict = duplicateCodeVerdict({
      overlap: { distinctPids, lockWaitObserved: duplicate.blocked.observed, waiterSeen: duplicate.blocked.sawPid },
      hotelDelta: afterCode.hotels - beforeCode.hotels,
      providerDelta: afterCode.providers - beforeCode.providers,
      waiterError: duplicate.waited.error,
    });
    log(`test_duplicate_code: ${duplicateVerdict || "PASS"}`);
    log(`test_duplicate_code_overlap: ${duplicate.blocked.observed === true}`);
    if (duplicateVerdict) stop("concurrency", duplicateVerdict);

    const failUser = `${MARKER}-${randomUUID()}`;
    userIds.push(failUser);
    await insertUser(observer, failUser, "Rollback");
    const failOrg = (await observer.query(CREATE_SQL, [failUser, `${NAME_PREFIX}Rollback`])).rows[0].organisation_id;
    await observer.query(`select organisation_id::text from sbg_classify_founding_organisation($1, $2)`, [failUser, "hotel"]);
    await accept(observer, failOrg, failUser, FIXTURE_SUPERSEDED);
    const beforeFail = await snapshot(observer);
    await observer.query("begin");
    const failed = await captureQuery(foundProperty(observer, failUser, code("rollback-fail")));
    await observer.query("rollback");
    const afterFail = await snapshot(observer);
    const failedVerdict = rollbackVerdict({ error: failed.error, before: beforeFail, after: afterFail });
    log(`test_failed_rollback: ${failedVerdict || "PASS"}`);
    if (failedVerdict) stop("concurrency", failedVerdict);

    const openUser = `${MARKER}-${randomUUID()}`;
    userIds.push(openUser);
    await insertUser(observer, openUser, "Uncommitted");
    const openOrg = (await observer.query(CREATE_SQL, [openUser, `${NAME_PREFIX}Uncommitted`])).rows[0].organisation_id;
    await observer.query(`select organisation_id::text from sbg_classify_founding_organisation($1, $2)`, [openUser, "hotel"]);
    await accept(observer, openOrg, openUser, FIXTURE_EFFECTIVE);
    const beforeOpen = await snapshot(observer);
    await observer.query("begin");
    await foundProperty(observer, openUser, code("uncommitted"));
    await observer.query("rollback");
    const afterOpen = await snapshot(observer);
    const openVerdict = uncommittedVerdict({ before: beforeOpen, after: afterOpen });
    log(`test_uncommitted_rollback: ${openVerdict || "PASS"}`);
    if (openVerdict) stop("concurrency", openVerdict);

    const leftUser = `${MARKER}-${randomUUID()}`;
    const rightUser = `${MARKER}-${randomUUID()}`;
    userIds.push(leftUser, rightUser);
    await insertUser(observer, leftUser, "Left");
    await insertUser(observer, rightUser, "Right");
    const [leftCreated, rightCreated] = await Promise.all([
      holder.query(CREATE_SQL, [leftUser, `${NAME_PREFIX}Left`]),
      waiter.query(CREATE_SQL, [rightUser, `${NAME_PREFIX}Right`]),
    ]);
    const leftId = leftCreated.rows[0].organisation_id;
    const rightId = rightCreated.rows[0].organisation_id;
    const second = await captureQuery(holder.query(CREATE_SQL, [leftUser, `${NAME_PREFIX}Left Again`]));
    if (!/founding organisation already exists/i.test(second.error)) stop("concurrency", "BLOCKED — SIBLING CREATE WAS NOT REJECTED");
    await observer.query(
      `insert into public.sbg_organisation_members (organisation_id, user_id, role, billing_authority)
       values ($1::uuid, $2, 'member', false)`,
      [leftId, rightUser],
    );
    const leftCount = Number((await observer.query(`select count(*)::int as n from public.sbg_organisations where created_by_user_id = $1`, [leftUser])).rows[0].n);
    const rightCount = Number((await observer.query(`select count(*)::int as n from public.sbg_organisations where created_by_user_id = $1`, [rightUser])).rows[0].n);
    const leftName = (await observer.query(`select name from public.sbg_organisations where id = $1::uuid`, [leftId])).rows[0].name;
    const rightName = (await observer.query(`select name from public.sbg_organisations where id = $1::uuid`, [rightId])).rows[0].name;
    const isolatedVerdict = isolationVerdict({
      leftId,
      rightId,
      leftCount,
      rightCount,
      leftName,
      rightName,
      memberInserted: true,
    });
    log(`test_isolation: ${isolatedVerdict || "PASS"}`);
    if (isolatedVerdict) stop("concurrency", isolatedVerdict);
    sections.concurrency = "PASS";

    const effectiveUser = `${MARKER}-${randomUUID()}`;
    const supersededUser = `${MARKER}-${randomUUID()}`;
    const provisionalUser = `${MARKER}-${randomUUID()}`;
    const unapprovedUser = `${MARKER}-${randomUUID()}`;
    const bothUser = `${MARKER}-${randomUUID()}`;
    userIds.push(effectiveUser, supersededUser, provisionalUser, unapprovedUser, bothUser);
    const termUsers = [
      [effectiveUser, "Effective", [FIXTURE_EFFECTIVE]],
      [supersededUser, "Superseded", [FIXTURE_SUPERSEDED]],
      [provisionalUser, "Provisional", ["terms-v1"]],
      [unapprovedUser, "Unapproved", [FIXTURE_UNAPPROVED]],
      [bothUser, "Both", [FIXTURE_SUPERSEDED, FIXTURE_EFFECTIVE]],
    ];
    const termOrgs = {};
    for (const [id, label, versions] of termUsers) {
      await insertUser(observer, id, label);
      termOrgs[id] = (await observer.query(CREATE_SQL, [id, `${NAME_PREFIX}${label}`])).rows[0].organisation_id;
      await observer.query(`select organisation_id::text from sbg_classify_founding_organisation($1, $2)`, [id, "hotel"]);
      for (const version of versions) await accept(observer, termOrgs[id], id, version);
    }
    const effective = await captureQuery(foundProperty(observer, effectiveUser, code("effective")));
    const superseded = await captureQuery(foundProperty(observer, supersededUser, code("superseded")));
    const provisional = await captureQuery(foundProperty(observer, provisionalUser, code("provisional")));
    const unapproved = await captureQuery(foundProperty(observer, unapprovedUser, code("unapproved")));
    const both = await captureQuery(foundProperty(observer, bothUser, code("both")));
    await observer.query("begin");
    const termsInsert = await captureQuery(observer.query(
      `insert into public.sbg_approved_property_agreement_versions (agreement_version, effective) values ($1, false)`,
      ["terms-v1"],
    ));
    await observer.query("rollback");
    const termsLeft = Number((await observer.query(
      `select count(*)::int as n from public.sbg_approved_property_agreement_versions where agreement_version = 'terms-v1'`,
    )).rows[0].n);
    const termsResult = termsVerdict({
      effectiveHotel: effective.result?.rows?.[0]?.hotel_id ?? "",
      bothHotel: both.result?.rows?.[0]?.hotel_id ?? "",
      supersededError: superseded.error,
      provisionalError: provisional.error,
      unapprovedError: unapproved.error,
      termsV1InsertError: termsInsert.error,
      termsV1ApprovalRows: termsLeft,
    });
    log(`test_terms: ${termsResult || "PASS"}`);
    if (termsResult) stop("terms", termsResult);
    sections.terms = "PASS";

    const privileges = (await observer.query(
      `select
         has_function_privilege('aether_app', 'public.sbg_create_organisation_for_user(text,text)', 'execute') as app_creator,
         has_function_privilege('aether_runtime', 'public.sbg_create_organisation_for_user(text,text)', 'execute') as runtime_creator,
         has_function_privilege('public', 'public.sbg_create_organisation_for_user(text,text)', 'execute') as public_creator,
         has_function_privilege('aether_app', 'public.sbg_create_founding_property_for_user(text,text,text,text,text,text)', 'execute') as app_property,
         has_function_privilege('aether_runtime', 'public.sbg_create_founding_property_for_user(text,text,text,text,text,text)', 'execute') as runtime_property,
         has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'select') as app_select,
         has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'insert') as app_insert,
         has_table_privilege('aether_app', 'public.sbg_approved_property_agreement_versions', 'update') as app_update`,
    )).rows[0];
    const catalogMatch = privileges.app_creator === true
      && privileges.runtime_creator === false
      && privileges.public_creator === false
      && privileges.app_property === true
      && privileges.runtime_property === false
      && privileges.app_select === false
      && privileges.app_insert === false
      && privileges.app_update === false;
    let live = null;
    if (!appUrl) {
      log("aether_app_connection: absent");
      log("runtime_role_live_session: skipped");
    } else {
      app = connect(appUrl, "a3m36-isolated-app");
      await app.connect();
      const appIdentity = mapIdentity((await app.query(IDENTITY_SQL)).rows[0]);
      const appLabel = new URL(directOwnerUrl(appUrl)).hostname.toLowerCase().split(".")[0] ?? "";
      const sameIdentity = appIdentity.projectId === EXPECTED_PROJECT
        && appIdentity.branchId === expected.branch
        && appIdentity.endpointId === expected.endpoint
        && appIdentity.database === EXPECTED_DATABASE
        && appIdentity.currentUser === "aether_app"
        && appIdentity.sessionUser === "aether_app"
        && appLabel === expected.endpoint;
      const appUser = `${MARKER}-${randomUUID()}`;
      userIds.push(appUser);
      await insertUser(observer, appUser, "App");
      const selectTry = await captureQuery(app.query("select count(*)::int as n from public.sbg_approved_property_agreement_versions"));
      const insertTry = await captureQuery(app.query(
        `insert into public.sbg_approved_property_agreement_versions (agreement_version, effective) values ($1, false)`,
        [FIXTURE_APP_DENIED],
      ));
      const updateTry = await captureQuery(app.query(
        `update public.sbg_approved_property_agreement_versions set effective = true where agreement_version = $1`,
        [FIXTURE_EFFECTIVE],
      ));
      const executeTry = await captureQuery(app.query(CREATE_SQL, [appUser, `${NAME_PREFIX}App`]));
      live = {
        sameIdentity,
        role: appIdentity.currentUser,
        selectAllowed: selectTry.error === "",
        insertAllowed: insertTry.error === "",
        updateAllowed: updateTry.error === "",
        executeCreate: Boolean(executeTry.result?.rows?.[0]?.organisation_id),
        runtimeExecute: privileges.runtime_creator === true,
        publicExecute: privileges.public_creator === true,
      };
      log(`aether_app_connection: present`);
      log(`runtime_role_live_session: ${sameIdentity ? "proven" : "rejected"}`);
    }
    const runtimeVerdict = runtimeRoleVerdict({ catalogMatch, appConnection: appUrl ? "present" : "absent", live });
    sections.runtime = runtimeVerdict || "PASS";
    if (runtimeVerdict.startsWith("BLOCKED")) stop("runtime", runtimeVerdict);
    return conclude();
  } catch (err) {
    if (!err?.sectioned) {
      const message = `BLOCKED — ${redact(err?.message || err)}`.slice(0, 300);
      log(message);
      if (sections.concurrency !== "PASS") {
        if (!String(sections.concurrency).startsWith("BLOCKED")) sections.concurrency = message;
      } else if (sections.terms !== "PASS") {
        if (!String(sections.terms).startsWith("BLOCKED")) sections.terms = message;
      } else if (!String(sections.runtime).startsWith("BLOCKED") && sections.runtime !== "PASS") {
        sections.runtime = message;
      }
    }
    return conclude();
  } finally {
    await Promise.allSettled([holder.end(), waiter.end(), observer.end(), app?.end?.()].filter(Boolean));
  }
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runConcurrency({ env: process.env, say: (line) => console.log(line) })
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((err) => {
      console.log(redact(err?.message || err).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host"));
      process.exitCode = 1;
    });
}
