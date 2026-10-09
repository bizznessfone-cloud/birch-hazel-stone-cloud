#!/usr/bin/env node
/**
 * CP30.05E-2D-2C.1 — classification and acceptance proof on an isolated Neon branch.
 *
 * Production is read-only here. No Terms row, classification, or user is written
 * to Production. terms-v1 stays provisional. The branch is deleted afterwards.
 * If NEON_API_KEY is absent, this exits before any database write.
 * Never uses DATABASE_URL. Never prints a connection string.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { redact } from "./production-db-preflight.mjs";
import {
  REQUIRED_CONFIRMATION,
  TARGET_MIGRATION,
  apply0034Transaction,
  inspect0034State,
  runSingleUse0034,
  sha256,
} from "./cp3005e2d2c1-0034-production-migrate.mjs";

export const MARKER = "e2d2c1";
export const NAME_PREFIX = "E2D2C1 ";
const DELETE_TRIGGERS = [
  ["sbg_organisations", "sbg_organisations_no_delete"],
  ["sbg_organisation_members", "sbg_organisation_members_no_delete"],
  ["sbg_organisation_acceptances", "sbg_organisation_acceptances_immutable"],
  ["sbg_organisation_acceptances", "sbg_organisation_acceptances_no_truncate"],
];

export function directOwnerUrl(value) {
  return String(value ?? "").replace(/-pooler\./g, ".");
}

export function databaseHost(value) {
  try {
    return new URL(directOwnerUrl(value)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function sameDatabaseHost(left, right) {
  const a = databaseHost(left);
  const b = databaseHost(right);
  return a !== "" && a === b;
}

function say(line) {
  console.log(redact(line).replace(/[A-Za-z0-9.-]+\.neon\.tech/g, "neon-host"));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function client(ownerUrl) {
  return new pg.Client({
    connectionString: directOwnerUrl(ownerUrl),
    application_name: "e2d2c1-branch-proof",
    statement_timeout: 30000,
    query_timeout: 30000,
  });
}

export function projectIdFromScopedKeyError(value) {
  const chunks = [];
  if (typeof value === "string") chunks.push(value);
  else if (value && typeof value === "object") {
    if (typeof value.message === "string") chunks.push(value.message);
    const details = value.details;
    if (details && typeof details === "object") {
      const named = details.subject_project_id ?? details.subjectProjectId;
      if (typeof named === "string") chunks.push(`subject_project_id:${named}`);
    }
    try {
      chunks.push(JSON.stringify(value));
    } catch {
      // ignore a non-serialisable error body
    }
  }
  const text = chunks.join("\n");
  if (!/subject_project_id/i.test(text)) return "";
  const matches = [
    ...text.matchAll(/subject_project_id["']?\s*[:=]\s*["']?([a-z0-9][a-z0-9-]{2,80})/gi),
  ].map((match) => match[1]);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : "";
}

async function neonApi(apiKey, path, options = {}) {
  const response = await fetch(`https://console.neon.tech/api/v2${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 180) };
    }
    const message = String(body.message ?? "").slice(0, 180);
    const error = new Error(`BLOCKED — NEON API ${response.status} ${message}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

async function resolveProjectId(apiKey, explicit) {
  if (explicit) {
    say("neon_project_source: explicit");
    return explicit;
  }
  const orgOverride = String(process.env.NEON_ORG_ID ?? "").trim();
  let orgId = orgOverride;
  if (!orgId) {
    const listed = await neonApi(apiKey, "/users/me/organizations");
    const orgs = listed.organizations ?? [];
    say(`neon_orgs: ${orgs.length}`);
    if (orgs.length !== 1) throw new Error("BLOCKED — AMBIGUOUS NEON ORGANIZATION");
    orgId = String(orgs[0].id ?? "");
  }
  if (!orgId) throw new Error("BLOCKED — NEON ORGANIZATION UNKNOWN");
  say(`neon_org: ${orgId}`);
  try {
    const listed = await neonApi(apiKey, `/projects?org_id=${encodeURIComponent(orgId)}&limit=100`);
    const projects = listed.projects ?? [];
    say(`neon_projects: ${projects.length}`);
    if (projects.length !== 1) throw new Error("BLOCKED — AMBIGUOUS NEON PROJECT");
    say("neon_project_source: list");
    return projects[0].id;
  } catch (err) {
    const scoped = projectIdFromScopedKeyError(err.body) || projectIdFromScopedKeyError(err.message);
    if (!scoped) throw err;
    say("neon_project_source: scoped-key");
    const confirmed = await neonApi(apiKey, `/projects/${encodeURIComponent(scoped)}`);
    const id = String(confirmed.project?.id ?? "");
    if (id !== scoped) throw new Error("BLOCKED — SCOPED NEON PROJECT DID NOT MATCH");
    say(`neon_project_name: ${String(confirmed.project?.name ?? "")}`);
    return id;
  }
}

async function createVerifyBranch(apiKey, projectId) {
  const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const created = await neonApi(apiKey, `/projects/${projectId}/branches`, {
    method: "POST",
    body: {
      branch: { name: `sbg-verify-0034-${Date.now()}`, expires_at: expires },
      endpoints: [{ type: "read_write" }],
    },
  });
  const branchId = created.branch?.id;
  if (!branchId) throw new Error("BLOCKED — NEON BRANCH WAS NOT CREATED");
  let uri = "";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const connection = await neonApi(
        apiKey,
        `/projects/${projectId}/connection_uri?branch_id=${encodeURIComponent(branchId)}&database_name=neondb&role_name=neondb_owner`,
      );
      uri = String(connection.uri ?? "");
      if (uri) break;
    } catch {
      // endpoint may still be starting
    }
    await delay(2000);
  }
  if (!uri) throw new Error("BLOCKED — NEON BRANCH URI UNAVAILABLE");
  return { branchId, uri };
}

async function deleteVerifyBranch(apiKey, projectId, branchId) {
  await neonApi(apiKey, `/projects/${projectId}/branches/${branchId}`, { method: "DELETE" });
}

async function triggerState(db) {
  const names = DELETE_TRIGGERS.map(([, trigger]) => trigger);
  const rows = (
    await db.query(
      `select tgname, tgenabled
         from pg_trigger
        where not tgisinternal
          and tgname = any($1::text[])
        order by tgname`,
      [names],
    )
  ).rows;
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

async function snapshot(db) {
  const counts = (
    await db.query(
      `select
         (select count(*)::int from sbg_organisations) as organisations,
         (select count(*)::int from sbg_organisation_members) as members,
         (select count(*)::int from "user") as users,
         (select count(*)::int from sbg_organisations where organisation_type is not null) as classified,
         (select count(*)::int from sbg_organisation_acceptances) as acceptances,
         (select coalesce(sum(licensed_quantity), 0)::int from sbg_organisation_billing) as licensed,
         (select count(*)::int from sbg_property_licence_allocations) as allocations,
         (select count(*)::int from hotels) as hotels,
         (select count(*)::int from bookings) as bookings,
         (select count(*)::int from sbg_booking_payments) as payments`,
    )
  ).rows[0];
  return {
    organisations: Number(counts.organisations),
    members: Number(counts.members),
    users: Number(counts.users),
    classified: Number(counts.classified),
    acceptances: Number(counts.acceptances),
    licensed: Number(counts.licensed),
    allocations: Number(counts.allocations),
    hotels: Number(counts.hotels),
    bookings: Number(counts.bookings),
    payments: Number(counts.payments),
  };
}

async function insertUser(db, id, label) {
  await db.query(
    `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, false, now(), now())`,
    [id, `${NAME_PREFIX}${label}`, `${MARKER}-proof-${id}@invalid.scanbookgo.test`],
  );
}

async function foundOrg(db, userId, name) {
  const rows = (
    await db.query(
      `select organisation_id::text as organisation_id, organisation_type
         from sbg_ensure_founding_organisation($1, $2)`,
      [userId, name],
    )
  ).rows;
  return rows[0];
}

async function waitForLock(observer, pid) {
  const started = Date.now();
  let sawPid = false;
  while (Date.now() - started < 10000) {
    const row = (
      await observer.query("select wait_event_type from pg_stat_activity where pid = $1", [pid])
    ).rows[0];
    if (row) {
      sawPid = true;
      if (row.wait_event_type === "Lock") return { observed: true, sawPid: true };
    }
    await delay(40);
  }
  return { observed: false, sawPid };
}

async function lockedCall({ holder, waiter, observer, orgId, holderSql, holderParams, waiterSql, waiterParams, waiterPid }) {
  await holder.query("BEGIN");
  let waiterPromise;
  try {
    await holder.query("select id from public.sbg_organisations where id = $1::uuid for update", [orgId]);
    waiterPromise = waiter.query(waiterSql, waiterParams);
    const blocked = await waitForLock(observer, waiterPid);
    if (!blocked.observed) {
      throw new Error("BLOCKED — WAITER DID NOT BLOCK ON THE ORGANISATION LOCK");
    }
    const held = await holder.query(holderSql, holderParams);
    await holder.query("COMMIT");
    let waited = null;
    let waiterError = "";
    try {
      waited = await waiterPromise;
    } catch (err) {
      waiterError = String(err?.message ?? err);
    }
    return { lockWaitObserved: true, held: held.rows[0] ?? null, waited: waited?.rows?.[0] ?? null, waiterError };
  } catch (err) {
    try {
      await holder.query("ROLLBACK");
    } catch {
      // keep the original error
    }
    if (waiterPromise) {
      try {
        await waiterPromise;
      } catch {
        // waiter may fail after rollback
      }
    }
    throw err;
  }
}

async function cleanup(db, userIds) {
  const orgs = (
    await db.query(
      `select id::text as id, name
         from sbg_organisations
        where created_by_user_id = any($1::text[])`,
      [userIds],
    )
  ).rows;
  if (orgs.some((row) => !String(row.name).startsWith(NAME_PREFIX))) {
    return { ok: false, verdict: "BLOCKED — DISPOSABLE USER CREATED A NON-MARKER ORGANISATION" };
  }
  const orgIds = orgs.map((row) => row.id);
  const empty = ["00000000-0000-0000-0000-000000000000"];
  await db.query("BEGIN");
  try {
    await setDeleteTriggers(db, false);
    await db.query(
      "delete from sbg_organisation_acceptances where organisation_id = any($1::uuid[]) or accepted_by_user_id = any($2::text[])",
      [orgIds.length ? orgIds : empty, userIds],
    );
    await db.query(
      "delete from sbg_organisation_members where user_id = any($1::text[]) or organisation_id = any($2::uuid[])",
      [userIds, orgIds.length ? orgIds : empty],
    );
    await db.query(
      "delete from sbg_organisations where created_by_user_id = any($1::text[]) and name like $2",
      [userIds, `${NAME_PREFIX}%`],
    );
    await db.query(`delete from public."user" where id = any($1::text[])`, [userIds]);
    await setDeleteTriggers(db, true);
    const enabled = await triggerState(db);
    if (enabled.some((row) => !row.present || !row.enabled)) {
      await db.query("ROLLBACK");
      return { ok: false, verdict: "BLOCKED — CLEANUP WOULD LEAVE A TRIGGER DISABLED" };
    }
    await db.query("COMMIT");
    return { ok: true };
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // keep the original error
    }
    return { ok: false, verdict: "BLOCKED — CLEANUP FAILED", error: redact(err?.message || err) };
  }
}

async function connectReady(ownerUrl) {
  let last = "";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const db = client(ownerUrl);
    try {
      await db.connect();
      await db.query("select 1");
      return db;
    } catch (err) {
      last = redact(err?.message || err);
      try {
        await db.end();
      } catch {
        // retry
      }
      await delay(2000);
    }
  }
  throw new Error(`BLOCKED — VERIFY BRANCH NOT READY ${last}`);
}

async function readOnlySnapshot(ownerUrl) {
  const db = client(ownerUrl);
  await db.connect();
  try {
    await db.query("BEGIN READ ONLY");
    const identity = (
      await db.query("select current_database() as database, current_user, session_user")
    ).rows[0];
    const ledger = (await db.query("select name from _migrations order by name")).rows.map((row) => row.name);
    const counts = await snapshot(db);
    const hotels = (
      await db.query("select code, status, organisation_id::text as organisation_id from hotels order by code")
    ).rows;
    await db.query("ROLLBACK");
    return { identity, ledger, counts, hotels };
  } finally {
    await db.end();
  }
}

async function main() {
  const confirmation = process.env.CP3005E2D2C1_CONFIRMATION;
  const productionUrl = String(process.env.AETHER_DATABASE_OWNER_URL ?? "").trim();
  const apiKey = String(process.env.NEON_API_KEY ?? "").trim();
  const explicitProject = String(process.env.NEON_PROJECT_ID ?? "").trim();
  say(`AETHER_DATABASE_OWNER_URL: ${productionUrl ? "PRESENT" : "ABSENT"}`);
  say(`NEON_API_KEY: ${apiKey ? "PRESENT" : "ABSENT"}`);
  say(`confirmation: ${confirmation === REQUIRED_CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  if (confirmation !== REQUIRED_CONFIRMATION) {
    say("BLOCKED — CONFIRMATION PHRASE INVALID");
    process.exitCode = 1;
    return;
  }
  if (!productionUrl) {
    say("BLOCKED — AETHER_DATABASE_OWNER_URL is not configured");
    process.exitCode = 1;
    return;
  }
  if (!apiKey) {
    say("BLOCKED — ISOLATED VERIFICATION UNAVAILABLE");
    say("reason: NEON_API_KEY is absent. No Production test data was written.");
    process.exitCode = 1;
    return;
  }

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const bytes = await readFile(join(rootDir, "migrations", TARGET_MIGRATION));
  const file = { name: TARGET_MIGRATION, bytes, digest: sha256(bytes), sql: bytes.toString("utf8") };
  let projectId = "";
  let branchId = "";
  let branchUrl = "";
  try {
    projectId = await resolveProjectId(apiKey, explicitProject);
    say(`neon_project: ${projectId}`);
    const productionBefore = await readOnlySnapshot(productionUrl);
    say(`production_database: ${productionBefore.identity.database}`);
    say(`production_user: ${productionBefore.identity.current_user}`);
    if (productionBefore.identity.database !== "neondb" || productionBefore.identity.current_user !== "neondb_owner") {
      throw new Error("BLOCKED — PRODUCTION IDENTITY MISMATCH");
    }
    if (!productionBefore.ledger.includes("0033_cp3005e2d2b_founding_organisation.sql")) {
      throw new Error("BLOCKED — PRODUCTION 0033 IS NOT INSTALLED");
    }
    const created = await createVerifyBranch(apiKey, projectId);
    branchId = created.branchId;
    branchUrl = created.uri;
    say(`verify_branch: ${branchId}`);
    if (sameDatabaseHost(branchUrl, productionUrl)) {
      throw new Error("BLOCKED — VERIFY BRANCH HOST MATCHES PRODUCTION");
    }
    say("verify_host_differs: true");
    const branchBefore = await readOnlySnapshot(branchUrl);
    if (JSON.stringify(branchBefore.counts) !== JSON.stringify(productionBefore.counts)) {
      throw new Error("BLOCKED — BRANCH SNAPSHOT DOES NOT MATCH PRODUCTION");
    }
    if (JSON.stringify(branchBefore.hotels) !== JSON.stringify(productionBefore.hotels)) {
      throw new Error("BLOCKED — BRANCH HOTELS DO NOT MATCH PRODUCTION");
    }
    if (branchBefore.ledger.includes(TARGET_MIGRATION)) {
      throw new Error("BLOCKED — BRANCH ALREADY HAS 0034");
    }
    say("branch_matches_production: true");

    const sourceMigrations = (await readdir(join(rootDir, "migrations"))).filter((name) => name.endsWith(".sql"));
    const applied = await runSingleUse0034({
      env: { AETHER_DATABASE_OWNER_URL: directOwnerUrl(branchUrl) },
      confirmation,
      file,
      loadFacts: async () => {
        const db = await connectReady(branchUrl);
        try {
          await db.query("BEGIN READ ONLY");
          const facts = await inspect0034State(db, sourceMigrations);
          await db.query("ROLLBACK");
          return facts;
        } finally {
          await db.end();
        }
      },
      mutate: async ({ sql, before }) => {
        const db = await connectReady(branchUrl);
        try {
          return await apply0034Transaction({
            sql,
            before,
            query: (text, params) => db.query(text, params),
            inspect: () => inspect0034State(db, sourceMigrations),
          });
        } finally {
          await db.end();
        }
      },
    });
    say(applied.verdict);
    if (!applied.ok) throw new Error(applied.verdict || "BLOCKED — BRANCH APPLY FAILED");

    const holder = client(branchUrl);
    const waiter = client(branchUrl);
    const observer = client(branchUrl);
    const userIds = [];
    await Promise.all([holder.connect(), waiter.connect(), observer.connect()]);
    try {
      const pids = await Promise.all([
        holder.query("select pg_backend_pid() as pid"),
        waiter.query("select pg_backend_pid() as pid"),
        observer.query("select pg_backend_pid() as pid"),
      ]);
      const pidA = Number(pids[0].rows[0].pid);
      const pidB = Number(pids[1].rows[0].pid);
      const pidC = Number(pids[2].rows[0].pid);
      say(`backend_pids: ${pidA} ${pidB} ${pidC}`);
      if (new Set([pidA, pidB, pidC]).size !== 3) throw new Error("BLOCKED — CONNECTIONS ARE NOT INDEPENDENT");
      const installed = (await observer.query("select count(*)::int as n from _migrations where name = $1", [TARGET_MIGRATION])).rows[0];
      if (Number(installed.n) !== 1) throw new Error("BLOCKED — 0034 IS NOT INSTALLED ONCE ON THE BRANCH");
      const before = await snapshot(observer);

      const sameUser = `${MARKER}-${randomUUID()}`;
      const conflictUser = `${MARKER}-${randomUUID()}`;
      const acceptUser = `${MARKER}-${randomUUID()}`;
      const stranger = `${MARKER}-${randomUUID()}`;
      userIds.push(sameUser, conflictUser, acceptUser, stranger);
      await observer.query("BEGIN");
      await insertUser(observer, sameUser, "same");
      await insertUser(observer, conflictUser, "conflict");
      await insertUser(observer, acceptUser, "accept");
      await insertUser(observer, stranger, "stranger");
      await observer.query("COMMIT");

      const sameOrg = await foundOrg(observer, sameUser, `${NAME_PREFIX}Same Type`);
      const sameRace = await lockedCall({
        holder,
        waiter,
        observer,
        orgId: sameOrg.organisation_id,
        holderSql: "select organisation_type from sbg_classify_founding_organisation($1, $2)",
        holderParams: [sameUser, "hotel"],
        waiterSql: "select organisation_type from sbg_classify_founding_organisation($1, $2)",
        waiterParams: [sameUser, "hotel"],
        waiterPid: pidB,
      });
      const sameStored = (
        await observer.query("select organisation_type from sbg_organisations where id = $1::uuid", [sameOrg.organisation_id])
      ).rows[0];
      say(`test1_lock: ${sameRace.lockWaitObserved}`);
      say(`test1_type: ${sameStored?.organisation_type ?? ""}`);
      if (sameRace.waiterError || sameStored?.organisation_type !== "hotel" || sameRace.held?.organisation_type !== "hotel") {
        throw new Error("BLOCKED — SAME-TYPE CONCURRENCY FAILED");
      }

      const conflictOrg = await foundOrg(observer, conflictUser, `${NAME_PREFIX}Conflict`);
      const conflictRace = await lockedCall({
        holder,
        waiter,
        observer,
        orgId: conflictOrg.organisation_id,
        holderSql: "select organisation_type from sbg_classify_founding_organisation($1, $2)",
        holderParams: [conflictUser, "hotel"],
        waiterSql: "select organisation_type from sbg_classify_founding_organisation($1, $2)",
        waiterParams: [conflictUser, "transfer_operator"],
        waiterPid: pidB,
      });
      const retry = await observer.query("select organisation_type from sbg_classify_founding_organisation($1, 'hotel')", [conflictUser]);
      let retryRejected = false;
      try {
        await observer.query("select organisation_type from sbg_classify_founding_organisation($1, 'transfer_operator')", [conflictUser]);
      } catch (err) {
        retryRejected = /already set/i.test(String(err?.message ?? err));
      }
      const conflictStored = (
        await observer.query("select organisation_type from sbg_organisations where id = $1::uuid", [conflictOrg.organisation_id])
      ).rows[0];
      say(`test2_lock: ${conflictRace.lockWaitObserved}`);
      say(`test2_waiter_rejected: ${/already set/i.test(conflictRace.waiterError)}`);
      say(`test3_retry_same: ${retry.rows[0]?.organisation_type === "hotel"}`);
      say(`test3_retry_rejected: ${retryRejected}`);
      if (
        !/already set/i.test(conflictRace.waiterError) ||
        conflictStored?.organisation_type !== "hotel" ||
        !retryRejected
      ) {
        throw new Error("BLOCKED — CONFLICTING CLASSIFICATION OVERWROTE");
      }

      const acceptOrg = await foundOrg(observer, acceptUser, `${NAME_PREFIX}Accept`);
      let earlyRejected = false;
      try {
        await observer.query("select agreement_version from sbg_record_founding_terms_acceptance($1)", [acceptUser]);
      } catch (err) {
        earlyRejected = /unclassified/i.test(String(err?.message ?? err));
      }
      const earlyCount = (
        await observer.query(
          "select count(*)::int as n from sbg_organisation_acceptances where organisation_id = $1::uuid",
          [acceptOrg.organisation_id],
        )
      ).rows[0];
      say(`test4_rejected: ${earlyRejected}`);
      say(`test4_rows: ${earlyCount.n}`);
      if (!earlyRejected || Number(earlyCount.n) !== 0) throw new Error("BLOCKED — ACCEPTANCE BEFORE CLASSIFICATION");
      await observer.query("select organisation_type from sbg_classify_founding_organisation($1, 'transfer_operator')", [acceptUser]);
      const acceptRace = await lockedCall({
        holder,
        waiter,
        observer,
        orgId: acceptOrg.organisation_id,
        holderSql: "select agreement_version, already_accepted from sbg_record_founding_terms_acceptance($1)",
        holderParams: [acceptUser],
        waiterSql: "select agreement_version, already_accepted from sbg_record_founding_terms_acceptance($1)",
        waiterParams: [acceptUser],
        waiterPid: pidB,
      });
      const acceptedRows = (
        await observer.query(
          `select agreement_version, accepted_at::text as accepted_at, count(*)::int as n
             from sbg_organisation_acceptances
            where organisation_id = $1::uuid
            group by agreement_version, accepted_at`,
          [acceptOrg.organisation_id],
        )
      ).rows;
      const again = (
        await observer.query(
          "select already_accepted from sbg_record_founding_terms_acceptance($1)",
          [acceptUser],
        )
      ).rows[0];
      const still = (
        await observer.query(
          "select count(*)::int as n, min(accepted_at)::text as accepted_at from sbg_organisation_acceptances where organisation_id = $1::uuid",
          [acceptOrg.organisation_id],
        )
      ).rows[0];
      say(`test5_lock: ${acceptRace.lockWaitObserved}`);
      say(`test5_rows: ${acceptedRows.length === 1 ? acceptedRows[0].n : acceptedRows.length}`);
      say(`test5_version: ${acceptedRows[0]?.agreement_version ?? ""}`);
      say(`test6_already: ${again?.already_accepted === true}`);
      say(`test6_timestamp_unchanged: ${still.accepted_at === acceptedRows[0]?.accepted_at && Number(still.n) === 1}`);
      if (
        acceptedRows.length !== 1 ||
        Number(acceptedRows[0].n) !== 1 ||
        acceptedRows[0].agreement_version !== "terms-v1" ||
        again?.already_accepted !== true ||
        still.accepted_at !== acceptedRows[0].accepted_at
      ) {
        throw new Error("BLOCKED — ACCEPTANCE IDEMPOTENCY FAILED");
      }

      await observer.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'member', false)", [
        acceptUser,
        acceptOrg.organisation_id,
        stranger,
      ]);
      let strangerClassified = false;
      try {
        await observer.query("select organisation_type from sbg_classify_founding_organisation($1, 'hotel')", [stranger]);
        strangerClassified = true;
      } catch (err) {
        strangerClassified = false;
        say(`test7_classify_error: ${/missing|ambiguous/i.test(String(err?.message ?? err))}`);
      }
      let strangerAccepted = false;
      try {
        await observer.query("select agreement_version from sbg_record_founding_terms_acceptance($1)", [stranger]);
        strangerAccepted = true;
      } catch {
        strangerAccepted = false;
      }
      const strangerRows = (
        await observer.query(
          "select accepted_by_user_id from sbg_organisation_acceptances where organisation_id = $1::uuid",
          [acceptOrg.organisation_id],
        )
      ).rows;
      const typeStill = (
        await observer.query("select organisation_type from sbg_organisations where id = $1::uuid", [acceptOrg.organisation_id])
      ).rows[0];
      say(`test7_stranger_classified: ${strangerClassified}`);
      say(`test7_stranger_accepted: ${strangerAccepted}`);
      say(`test7_type: ${typeStill?.organisation_type ?? ""}`);
      if (
        strangerClassified ||
        strangerAccepted ||
        typeStill?.organisation_type !== "transfer_operator" ||
        strangerRows.map((row) => row.accepted_by_user_id).join(",") !== acceptUser
      ) {
        throw new Error("BLOCKED — UNAUTHORISED MEMBER MUTATED THE ORGANISATION");
      }

      const beforeRead = await snapshot(observer);
      const state = (
        await observer.query(
          "select state, terms_accepted from sbg_read_founding_onboarding_state($1)",
          [acceptUser],
        )
      ).rows[0];
      const afterRead = await snapshot(observer);
      say(`test8_state: ${state?.state ?? ""}`);
      say(`test8_terms: ${state?.terms_accepted === true}`);
      say(`test8_unchanged: ${JSON.stringify(beforeRead) === JSON.stringify(afterRead)}`);
      if (state?.state !== "ready" || state?.terms_accepted !== true || JSON.stringify(beforeRead) !== JSON.stringify(afterRead)) {
        throw new Error("BLOCKED — READ MUTATED DATA");
      }

      const privileges = (
        await observer.query(
          `select
             has_table_privilege('aether_app', 'public.sbg_organisation_acceptances', 'INSERT') as insert,
             has_table_privilege('aether_app', 'public.sbg_organisation_acceptances', 'UPDATE') as update,
             has_table_privilege('aether_app', 'public.sbg_organisation_acceptances', 'DELETE') as delete,
             has_table_privilege('aether_app', 'public.sbg_organisation_acceptances', 'SELECT') as select,
             has_function_privilege('aether_runtime', 'sbg_record_founding_terms_acceptance(text)', 'EXECUTE') as runtime_exec,
             exists (
               select 1
                 from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname = 'sbg_record_founding_terms_acceptance'
                  and (
                    p.proacl is null
                    or exists (
                      select 1 from aclexplode(p.proacl) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE'
                    )
                  )
             ) as public_exec`,
        )
      ).rows[0];
      say(`test9_app_insert: ${privileges.insert === true}`);
      say(`test9_app_update: ${privileges.update === true}`);
      say(`test9_app_delete: ${privileges.delete === true}`);
      say(`test9_app_select: ${privileges.select === true}`);
      say(`test9_runtime_execute: ${privileges.runtime_exec === true}`);
      say(`test9_public_execute: ${privileges.public_exec === true}`);
      if (
        privileges.insert === true ||
        privileges.update === true ||
        privileges.delete === true ||
        privileges.select === true ||
        privileges.runtime_exec === true ||
        privileges.public_exec === true
      ) {
        throw new Error("BLOCKED — RUNTIME CAN REACH THE ACCEPTANCE TABLE");
      }
      await observer.query("BEGIN");
      try {
        await observer.query("SET LOCAL ROLE aether_app");
        let denied = false;
        try {
          await observer.query(
            `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
             values ($1::uuid, $2, 'terms-v1')`,
            [acceptOrg.organisation_id, stranger],
          );
        } catch (err) {
          denied = /permission denied/i.test(String(err?.message ?? err));
        }
        say(`test9_set_role_insert_denied: ${denied}`);
        if (!denied) throw new Error("BLOCKED — RUNTIME INSERT WAS NOT DENIED");
      } finally {
        await observer.query("ROLLBACK");
      }

      const removed = await cleanup(observer, userIds);
      say(`cleanup: ${removed.ok ? "PASS" : removed.verdict}`);
      if (!removed.ok) throw new Error(removed.verdict);
      const after = await snapshot(observer);
      say(`cleanup_matches_preinsert: ${JSON.stringify(after) === JSON.stringify(before)}`);
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("BLOCKED — BRANCH SNAPSHOT CHANGED");
      const triggers = await triggerState(observer);
      if (triggers.some((row) => !row.present || !row.enabled)) throw new Error("BLOCKED — TRIGGER LEFT DISABLED");
      say("branch_concurrency: PASS");
    } finally {
      await Promise.all([holder.end(), waiter.end(), observer.end()]);
    }

    const productionAfter = await readOnlySnapshot(productionUrl);
    say(`production_unchanged: ${JSON.stringify(productionAfter.counts) === JSON.stringify(productionBefore.counts) && JSON.stringify(productionAfter.hotels) === JSON.stringify(productionBefore.hotels) && JSON.stringify(productionAfter.ledger) === JSON.stringify(productionBefore.ledger)}`);
    if (
      JSON.stringify(productionAfter.counts) !== JSON.stringify(productionBefore.counts) ||
      JSON.stringify(productionAfter.hotels) !== JSON.stringify(productionBefore.hotels) ||
      JSON.stringify(productionAfter.ledger) !== JSON.stringify(productionBefore.ledger)
    ) {
      throw new Error("BLOCKED — PRODUCTION CHANGED DURING BRANCH PROOF");
    }
  } catch (err) {
    say(redact(err?.message || err));
    process.exitCode = 1;
  } finally {
    if (apiKey && projectId && branchId) {
      try {
        await deleteVerifyBranch(apiKey, projectId, branchId);
        say(`verify_branch_deleted: ${branchId}`);
      } catch (err) {
        say(`verify_branch_delete_failed: ${branchId}`);
        say(redact(err?.message || err));
        process.exitCode = 1;
      }
    }
  }
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    say(redact(err?.message || err));
    process.exit(1);
  });
}
