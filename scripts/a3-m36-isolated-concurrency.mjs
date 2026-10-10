#!/usr/bin/env node
/**
 * A3-M36 isolated concurrency gate. Manual. Does not install SQL.
 *
 * Requires 0036 already present on br-dawn-hat-b1b4uqhn. Uses only
 * AETHER_0036_ISOLATED_OWNER_URL. An optional AETHER_0036_ISOLATED_APP_URL
 * must be a distinct aether_app login on that same endpoint. There is no
 * Production fallback and no terms-v1 approval. Fixtures are synthetic and
 * removed in one cleanup transaction. A pass requires observed lock waits.
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
  FORBIDDEN_ENDPOINT,
  FORBIDDEN_ENV,
  ISOLATED_OWNER_ENV,
  directOwnerUrl,
  identityFailures,
} from "./a3-m36-isolated-preflight.mjs";
import {
  EXPECTED_ENDPOINT,
  MIGRATION_35,
  MIGRATION_36,
} from "./a3-m36-0035-equivalence.mjs";
import { endpointPinFailures } from "./a3-m36-isolated-install.mjs";

export const CONCURRENCY_CONFIRMATION = "CONCURRENCY-0036-ISOLATED";
export const CONFIRMATION_ENV = "A3M36_CONCURRENCY_CONFIRMATION";
export const APP_ENV = "AETHER_0036_ISOLATED_APP_URL";
export const MARKER = "a3m36";
export const NAME_PREFIX = "A3M36 ";
export const FIXTURE_EFFECTIVE = "a3m36-fixture-effective";
export const FIXTURE_SUPERSEDED = "a3m36-fixture-superseded";
export const FIXTURE_UNAPPROVED = "a3m36-fixture-unapproved";
export const FIXTURE_APP_DENIED = "a3m36-fixture-app-denied";
export const FIXTURE_VERSIONS = [FIXTURE_EFFECTIVE, FIXTURE_SUPERSEDED, FIXTURE_APP_DENIED];
export const PASS_VERDICT = "GATE PASS — 0036 ISOLATED CONCURRENCY VERIFIED";

const DELETE_TRIGGERS = [
  ["sbg_organisations", "sbg_organisations_no_delete"],
  ["sbg_organisation_members", "sbg_organisation_members_no_delete"],
  ["sbg_organisation_acceptances", "sbg_organisation_acceptances_immutable"],
  ["sbg_organisation_acceptances", "sbg_organisation_acceptances_no_truncate"],
];

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
  if (appConnection === "absent") return "";
  if (!live?.sameIdentity || live.role !== "aether_app") return "BLOCKED — APP CONNECTION IDENTITY";
  if (live.selectAllowed !== false || live.insertAllowed !== false || live.updateAllowed !== false) {
    return "BLOCKED — APP CONNECTION READ OR WROTE APPROVALS";
  }
  if (live.executeCreate !== true) return "BLOCKED — APP CONNECTION CANNOT EXECUTE CREATE";
  if (live.runtimeExecute !== false || live.publicExecute !== false) return "BLOCKED — RUNTIME ROLE CAN EXECUTE";
  return "";
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

export function appUrlFailures(value, ownerValue) {
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
  if (label !== EXPECTED_ENDPOINT) failures.push("endpoint-pin");
  if (label === FORBIDDEN_ENDPOINT || raw.includes(FORBIDDEN_ENDPOINT)) failures.push("production-endpoint");
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

export function isMarkerUser(row) {
  const id = String(row?.id ?? "");
  const email = String(row?.email ?? "");
  const name = String(row?.name ?? "");
  return id.startsWith(`${MARKER}-`)
    && email.startsWith(`${MARKER}-proof-`)
    && email.endsWith("@invalid.scanbookgo.test")
    && name.startsWith(NAME_PREFIX);
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

async function triggerState(db) {
  const names = DELETE_TRIGGERS.map(([, trigger]) => trigger);
  const rows = (await db.query(
    `select tgname, tgenabled from pg_trigger where not tgisinternal and tgname = any($1::text[])`,
    [names],
  )).rows;
  return names.map((name) => {
    const row = rows.find((item) => item.tgname === name);
    return { name, enabled: row?.tgenabled === "O", present: Boolean(row) };
  });
}

async function setDeleteTriggers(db, enabled) {
  const verb = enabled ? "ENABLE" : "DISABLE";
  for (const [table, trigger] of DELETE_TRIGGERS) {
    await db.query(`alter table public.${table} ${verb} trigger ${trigger}`);
  }
}

async function probeTriggerControl(db) {
  const before = await triggerState(db);
  if (before.some((row) => !row.present || !row.enabled)) return { ok: false, verdict: "BLOCKED — DELETE TRIGGERS NOT ENABLED" };
  await db.query("begin");
  try {
    await setDeleteTriggers(db, false);
    await setDeleteTriggers(db, true);
    const inside = await triggerState(db);
    await db.query("rollback");
    if (inside.some((row) => !row.enabled)) return { ok: false, verdict: "BLOCKED — TRIGGER RE-ENABLE FAILED" };
    return { ok: true };
  } catch (err) {
    try { await db.query("rollback"); } catch { /* keep the original error */ }
    return { ok: false, verdict: "BLOCKED — TRIGGER PROBE FAILED", error: redact(err?.message || err) };
  }
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

async function cleanup(db, userIds) {
  const users = (await db.query(
    `select id, name, email from public."user" where id = any($1::text[])`,
    [userIds],
  )).rows;
  if (users.some((row) => !isMarkerUser(row))) return { ok: false, verdict: "BLOCKED — REFUSING TO DELETE A NON-MARKER USER" };
  const orgs = (await db.query(
    `select id::text as id, name from public.sbg_organisations where created_by_user_id = any($1::text[])`,
    [userIds],
  )).rows;
  if (orgs.some((row) => !String(row.name).startsWith(NAME_PREFIX))) return { ok: false, verdict: "BLOCKED — REFUSING TO DELETE A NON-MARKER ORGANISATION" };
  const hotels = (await db.query(
    `select h.id::text as id, h.name, h.code
       from public.hotels h
       join public.app_hotel_accounts a on a.hotel_id = h.id
      where a.user_id = any($1::text[])`,
    [userIds],
  )).rows;
  if (hotels.some((row) => !String(row.name).startsWith(NAME_PREFIX) || !String(row.code).startsWith(`${MARKER}-`))) {
    return { ok: false, verdict: "BLOCKED — REFUSING TO DELETE A NON-MARKER HOTEL" };
  }
  const hotelIds = hotels.map((row) => row.id);
  const orgIds = orgs.map((row) => row.id);
  const providers = hotelIds.length
    ? (await db.query(
      `select provider_id::text as id from public.hotel_provider_agreements where hotel_id = any($1::uuid[])`,
      [hotelIds],
    )).rows.map((row) => row.id)
    : [];
  await db.query("begin");
  try {
    await setDeleteTriggers(db, false);
    if (hotelIds.length) {
      await db.query(`delete from public.hotels where id = any($1::uuid[])`, [hotelIds]);
    }
    if (providers.length) {
      await db.query(`delete from public.providers where id = any($1::uuid[])`, [providers]);
    }
    await db.query(
      `delete from public.sbg_organisation_acceptances where organisation_id = any($1::uuid[]) or accepted_by_user_id = any($2::text[])`,
      [orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"], userIds],
    );
    await db.query(
      `delete from public.sbg_organisation_members where user_id = any($1::text[]) or organisation_id = any($2::uuid[])`,
      [userIds, orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]],
    );
    await db.query(
      `delete from public.sbg_organisations where created_by_user_id = any($1::text[]) and name like $2`,
      [userIds, `${NAME_PREFIX}%`],
    );
    await db.query(`delete from public."user" where id = any($1::text[])`, [userIds]);
    await db.query(
      `delete from public.sbg_approved_property_agreement_versions where agreement_version = any($1::text[])`,
      [FIXTURE_VERSIONS],
    );
    await setDeleteTriggers(db, true);
    const enabled = await triggerState(db);
    if (enabled.some((row) => !row.present || !row.enabled)) {
      await db.query("rollback");
      return { ok: false, verdict: "BLOCKED — CLEANUP WOULD LEAVE A TRIGGER DISABLED" };
    }
    const leftUsers = Number((await db.query(`select count(*)::int as n from public."user" where id = any($1::text[])`, [userIds])).rows[0].n);
    const leftApprovals = Number((await db.query(
      `select count(*)::int as n from public.sbg_approved_property_agreement_versions where agreement_version = any($1::text[])`,
      [FIXTURE_VERSIONS],
    )).rows[0].n);
    if (leftUsers || leftApprovals) {
      await db.query("rollback");
      return { ok: false, verdict: "BLOCKED — CLEANUP DID NOT REMOVE MARKER ROWS" };
    }
    await db.query("commit");
    return { ok: true };
  } catch (err) {
    try { await db.query("rollback"); } catch { /* keep the original error */ }
    return { ok: false, verdict: "BLOCKED — CLEANUP FAILED", error: redact(err?.message || err) };
  }
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
  const isolated = String(env?.[ISOLATED_OWNER_ENV] ?? "").trim();
  const appUrl = String(env?.[APP_ENV] ?? "").trim();
  log(`confirmation: ${confirmation === CONCURRENCY_CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  log(`${ISOLATED_OWNER_ENV}: ${isolated ? "PRESENT" : "ABSENT"}`);
  log(`${APP_ENV}: ${appUrl ? "PRESENT" : "ABSENT"}`);
  log("install_stage: not-invoked");
  log("terms_v1_approval: refused");
  if (confirmation !== CONCURRENCY_CONFIRMATION) {
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
  const appFailures = appUrlFailures(appUrl, isolated);
  if (appUrl && appFailures.length) {
    log(`BLOCKED — APP CONNECTION ${appFailures.join(",")}`);
    return finish(1);
  }

  const holder = connect(isolated, "a3m36-isolated-concurrency");
  const waiter = connect(isolated, "a3m36-isolated-concurrency-waiter");
  const observer = connect(isolated, "a3m36-isolated-concurrency-observer");
  const userIds = [];
  let opened = false;
  let app;
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
    const hostname = new URL(directOwnerUrl(isolated)).hostname.toLowerCase();
    const failures = identityFailures(identity, hostname);
    if (identity.endpointId !== EXPECTED_ENDPOINT) failures.push("endpoint-pin");
    log(`neon_project: ${identity.projectId || "unproven"}`);
    log(`neon_branch: ${identity.branchId || "unproven"}`);
    log(`neon_endpoint: ${identity.endpointId || "unproven"}`);
    if (failures.length || identity.projectId !== EXPECTED_PROJECT || identity.branchId !== EXPECTED_BRANCH) {
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
    log("isolated_identity: PASS");

    const probe = await probeTriggerControl(observer);
    log(`trigger_probe: ${probe.ok ? "PASS" : probe.verdict}`);
    if (!probe.ok) {
      if (probe.error) log(probe.error);
      return finish(1);
    }
    const before = await snapshot(observer);
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
    if (sameVerdict) throw new Error(sameVerdict);

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
    if (pairVerdict) throw new Error(pairVerdict);

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
    if (duplicateVerdict) throw new Error(duplicateVerdict);

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
    if (failedVerdict) throw new Error(failedVerdict);

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
    if (openVerdict) throw new Error(openVerdict);

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
    if (termsResult) throw new Error(termsResult);

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
    if (!/founding organisation already exists/i.test(second.error)) throw new Error("BLOCKED — SIBLING CREATE WAS NOT REJECTED");
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
    if (isolatedVerdict) throw new Error(isolatedVerdict);

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
        && appIdentity.branchId === EXPECTED_BRANCH
        && appIdentity.endpointId === EXPECTED_ENDPOINT
        && appIdentity.database === EXPECTED_DATABASE
        && appIdentity.currentUser === "aether_app"
        && appIdentity.sessionUser === "aether_app"
        && appLabel === EXPECTED_ENDPOINT;
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
    log(`test_runtime_role: ${runtimeVerdict || "PASS"}`);
    if (runtimeVerdict) throw new Error(runtimeVerdict);

    const removed = await cleanup(observer, userIds);
    log(`cleanup: ${removed.ok ? "PASS" : removed.verdict}`);
    if (removed.error) log(removed.error);
    if (!removed.ok) return finish(1);
    userIds.length = 0;
    const after = await snapshot(observer);
    const triggers = await triggerState(observer);
    log(`counts_match: ${JSON.stringify(before) === JSON.stringify(after)}`);
    log(`triggers_enabled: ${triggers.every((row) => row.present && row.enabled)}`);
    if (JSON.stringify(before) !== JSON.stringify(after) || triggers.some((row) => !row.present || !row.enabled)) {
      log("BLOCKED — BRANCH SNAPSHOT OR TRIGGERS CHANGED");
      return finish(1);
    }
    log(PASS_VERDICT);
    return finish(0);
  } catch (err) {
    log(redact(err?.message || err));
    if (opened) {
      try { await observer.query("rollback"); } catch { /* no open transaction */ }
    }
    if (opened && userIds.length) {
      try {
        const removed = await cleanup(observer, userIds);
        log(`cleanup_after_failure: ${removed.ok ? "PASS" : removed.verdict}`);
        if (!removed.ok) return finish(1);
      } catch (cleanupErr) {
        log(redact(cleanupErr?.message || cleanupErr));
      }
    }
    return finish(1);
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
