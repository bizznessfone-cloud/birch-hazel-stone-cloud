#!/usr/bin/env node
/**
 * CP30.05E-2D-2C.1 — classification and acceptance proof on the existing
 * isolated Neon branch br-late-paper-b15gkfj3 only.
 *
 * Does not create or delete a Neon branch. Does not call the Neon API.
 * Does not open AETHER_DATABASE_OWNER_URL. Does not write Production.
 * terms-v1 stays provisional. Never uses DATABASE_URL. Never prints a connection string.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { redact } from "./production-db-preflight.mjs";
import {
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  TARGET_MIGRATION,
  apply0034Transaction,
  inspect0034State,
  runSingleUse0034,
  sha256,
} from "./cp3005e2d2c1-0034-production-migrate.mjs";

export const MARKER = "e2d2c1";
export const NAME_PREFIX = "E2D2C1 ";
export const ISOLATED_OWNER_ENV = "AETHER_0034_ISOLATED_OWNER_URL";
export const ISOLATED_CONFIRMATION = "VERIFY-0034-ISOLATED";
export const EXPECTED_PROJECT = "quiet-sound-53513710";
export const EXPECTED_BRANCH = "br-late-paper-b15gkfj3";
export const FORBIDDEN_BRANCH = "br-green-darkness-b1k7wkue";
export const FORBIDDEN_ENDPOINT = "ep-withered-haze-b1fd9hse";
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

export function hostIsProductionEndpoint(value) {
  const host = databaseHost(value);
  if (!host) return false;
  const label = host.split(".")[0] ?? "";
  return label === FORBIDDEN_ENDPOINT || host.startsWith(`${FORBIDDEN_ENDPOINT}.`) || host.startsWith(`${FORBIDDEN_ENDPOINT}-`);
}

export function isolatedLedgerMode(ledger) {
  const names = Array.isArray(ledger) ? ledger.map(String) : [];
  const applied = names.filter((name) => name === TARGET_MIGRATION);
  const historical = names.filter((name) => name !== TARGET_MIGRATION);
  if (applied.length > 1 || historical.join("\n") !== REQUIRED_LEDGER.join("\n")) return "rejected";
  if (applied.length === 1) {
    if (names.join("\n") !== [...REQUIRED_LEDGER, TARGET_MIGRATION].join("\n")) return "rejected";
    return "verify-installed";
  }
  return names.join("\n") === REQUIRED_LEDGER.join("\n") ? "apply" : "rejected";
}

export function isolatedGateFailures({ identity, ledger, schema }) {
  const failures = [];
  if (identity?.projectId !== EXPECTED_PROJECT) failures.push("project");
  if (identity?.branchId !== EXPECTED_BRANCH) failures.push("branch");
  if (identity?.branchId === FORBIDDEN_BRANCH) failures.push("production-branch");
  if (!identity?.endpointId || identity.endpointId === FORBIDDEN_ENDPOINT) failures.push("endpoint");
  if (identity?.database !== "neondb") failures.push("database");
  if (identity?.currentUser !== "neondb_owner" || identity?.sessionUser !== "neondb_owner") failures.push("role");
  if (isolatedLedgerMode(ledger) === "rejected") failures.push("ledger");
  if (
    schema?.organisationType !== true ||
    schema?.acceptances !== true ||
    schema?.hotels !== true ||
    schema?.founding !== true ||
    schema?.immutableTrigger !== true
  ) {
    failures.push("schema");
  }
  return failures;
}

export function captureQuery(queryPromise) {
  return queryPromise.then(
    (value) => ({ result: value ?? null, error: "" }),
    (err) => ({ result: null, error: String(err?.message ?? err) }),
  );
}

export function isDisposableMarkerUser(row) {
  const id = String(row?.id ?? "");
  const email = String(row?.email ?? "");
  const name = String(row?.name ?? "");
  return (
    id.startsWith(`${MARKER}-`) &&
    email.startsWith(`${MARKER}-proof-`) &&
    email.endsWith("@invalid.scanbookgo.test") &&
    name.startsWith(NAME_PREFIX)
  );
}

export function disposableMarkerOrgProblem(org, userIds) {
  const name = String(org?.name ?? "");
  const creator = String(org?.createdBy ?? "");
  const owners = Array.isArray(userIds) ? userIds.map(String) : [];
  if (!name.startsWith(NAME_PREFIX)) return "org-not-marker";
  if (!owners.includes(creator)) return "org-creator-not-marker";
  return "";
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
  let captured = null;
  try {
    await holder.query("select id from public.sbg_organisations where id = $1::uuid for update", [orgId]);
    // The rejection handler must be attached before the holder commits.
    // pg rethrows query errors, and Node 22 exits if that rejection is still unhandled.
    captured = captureQuery(waiter.query(waiterSql, waiterParams));
    const blocked = await waitForLock(observer, waiterPid);
    if (!blocked.observed) {
      throw new Error("BLOCKED — WAITER DID NOT BLOCK ON THE ORGANISATION LOCK");
    }
    const held = await holder.query(holderSql, holderParams);
    await holder.query("COMMIT");
    const waited = await captured;
    return {
      lockWaitObserved: true,
      held: held.rows[0] ?? null,
      waited: waited.result?.rows?.[0] ?? null,
      waiterError: waited.error,
    };
  } catch (err) {
    try {
      await holder.query("ROLLBACK");
    } catch {
      // keep the original error
    }
    if (captured) await captured;
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

async function removePriorMarkers(db) {
  const users = (
    await db.query(
      `select id, email, name
         from public."user"
        where id like $1
          and email like $2
          and name like $3
        order by id`,
      [`${MARKER}-%`, `${MARKER}-proof-%@invalid.scanbookgo.test`, `${NAME_PREFIX}%`],
    )
  ).rows.filter((row) => isDisposableMarkerUser(row));
  const userIds = users.map((row) => String(row.id));
  const orgs = (
    await db.query(
      `select name, created_by_user_id
         from sbg_organisations
        where name like $1
           or created_by_user_id = any($2::text[])
        order by name`,
      [`${NAME_PREFIX}%`, userIds.length ? userIds : ["__sbg_no_marker_user__"]],
    )
  ).rows;
  for (const org of orgs) {
    const problem = disposableMarkerOrgProblem({ name: org.name, createdBy: org.created_by_user_id }, userIds);
    if (problem) {
      return {
        ok: false,
        users: users.length,
        orgs: orgs.length,
        verdict: `BLOCKED — MARKER FIXTURE NOT POSITIVELY IDENTIFIED ${problem}`,
      };
    }
  }
  if (!userIds.length) {
    return { ok: true, users: 0, orgs: 0, removed: false };
  }
  const removed = await cleanup(db, userIds);
  return { ...removed, users: userIds.length, orgs: orgs.length, removed: removed.ok === true };
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

async function readIsolatedGate(ownerUrl) {
  const db = client(ownerUrl);
  await db.connect();
  try {
    await db.query("BEGIN READ ONLY");
    const row = (
      await db.query(
        `select current_database() as database,
                current_user,
                session_user,
                current_setting('neon.project_id', true) as project_id,
                current_setting('neon.branch_id', true) as branch_id,
                current_setting('neon.endpoint_id', true) as endpoint_id`,
      )
    ).rows[0];
    const ledger = (await db.query("select name from _migrations order by name")).rows.map((item) => item.name);
    const schema = (
      await db.query(
        `select
           exists (
             select 1 from information_schema.columns
              where table_schema = 'public'
                and table_name = 'sbg_organisations'
                and column_name = 'organisation_type'
           ) as organisation_type,
           to_regclass('public.sbg_organisation_acceptances') is not null as acceptances,
           to_regclass('public.hotels') is not null as hotels,
           exists (
             select 1
               from pg_proc p
               join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname = 'sbg_ensure_founding_organisation'
           ) as founding,
           exists (
             select 1 from pg_trigger
              where not tgisinternal
                and tgname = 'sbg_organisation_acceptances_immutable'
           ) as immutable_trigger`,
      )
    ).rows[0];
    await db.query("ROLLBACK");
    return {
      identity: {
        projectId: String(row.project_id ?? "").trim(),
        branchId: String(row.branch_id ?? "").trim(),
        endpointId: String(row.endpoint_id ?? "").trim(),
        database: String(row.database ?? ""),
        currentUser: String(row.current_user ?? ""),
        sessionUser: String(row.session_user ?? ""),
      },
      ledger,
      schema: {
        organisationType: schema.organisation_type === true,
        acceptances: schema.acceptances === true,
        hotels: schema.hotels === true,
        founding: schema.founding === true,
        immutableTrigger: schema.immutable_trigger === true,
      },
    };
  } finally {
    await db.end();
  }
}

async function main() {
  const confirmation = process.env.CP3005E2D2C1_CONFIRMATION;
  const isolatedUrl = String(process.env[ISOLATED_OWNER_ENV] ?? "").trim();
  const productionOwner = String(process.env.AETHER_DATABASE_OWNER_URL ?? "").trim();
  say(`${ISOLATED_OWNER_ENV}: ${isolatedUrl ? "PRESENT" : "ABSENT"}`);
  say(`confirmation: ${confirmation === ISOLATED_CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  if (confirmation !== ISOLATED_CONFIRMATION) {
    say("BLOCKED — CONFIRMATION PHRASE INVALID");
    process.exitCode = 1;
    return;
  }
  if (!isolatedUrl) {
    say("BLOCKED — ISOLATED VERIFICATION UNAVAILABLE");
    say(`reason: ${ISOLATED_OWNER_ENV} is absent. No database was opened.`);
    process.exitCode = 1;
    return;
  }
  if (hostIsProductionEndpoint(isolatedUrl)) {
    say("BLOCKED — ISOLATED URL IS THE PRODUCTION ENDPOINT");
    process.exitCode = 1;
    return;
  }
  if (productionOwner && sameDatabaseHost(productionOwner, isolatedUrl)) {
    say("BLOCKED — ISOLATED URL MATCHES THE PRODUCTION OWNER HOST");
    process.exitCode = 1;
    return;
  }

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const bytes = await readFile(join(rootDir, "migrations", TARGET_MIGRATION));
  const file = { name: TARGET_MIGRATION, bytes, digest: sha256(bytes), sql: bytes.toString("utf8") };
  const branchUrl = directOwnerUrl(isolatedUrl);
  try {
    const gate = await readIsolatedGate(branchUrl);
    const failures = isolatedGateFailures(gate);
    say(`neon_project: ${gate.identity.projectId}`);
    say(`neon_branch: ${gate.identity.branchId}`);
    say(`neon_endpoint: ${gate.identity.endpointId}`);
    say(`database: ${gate.identity.database}`);
    say(`role: ${gate.identity.currentUser}`);
    say(`ledger_last: ${gate.ledger.at(-1) ?? ""}`);
    say(`ledger_count: ${gate.ledger.length}`);
    say(`ledger_mode: ${isolatedLedgerMode(gate.ledger)}`);
    if (failures.length) {
      say(`BLOCKED — ISOLATED IDENTITY ${failures.join(",")}`);
      process.exitCode = 1;
      return;
    }
    say("isolated_identity: PASS");
    say("production_branch_rejected: true");
    say("production_endpoint_rejected: true");

    const sourceMigrations = (await readdir(join(rootDir, "migrations"))).filter((name) => name.endsWith(".sql"));
    let applyInvoked = false;
    const applied = await runSingleUse0034({
      // Argument name required by the existing applier. This does not read or set the Production secret.
      env: { AETHER_DATABASE_OWNER_URL: branchUrl },
      confirmation: REQUIRED_CONFIRMATION,
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
        applyInvoked = true;
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
    say(`isolated_0034_apply_invoked: ${applyInvoked}`);
    if (!applied.ok) throw new Error(applied.verdict || "BLOCKED — BRANCH APPLY FAILED");
    if (applied.alreadyApplied === true) {
      if (applyInvoked) throw new Error("BLOCKED — INSTALLED 0034 WAS APPLIED AGAIN");
    } else if (applied.migrated !== true) {
      throw new Error("BLOCKED — 0034 WAS NEITHER APPLIED NOR VERIFIED");
    }

    const holder = client(branchUrl);
    const waiter = client(branchUrl);
    const observer = client(branchUrl);
    const userIds = [];
    let fixturesSettled = false;
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
      const prior = await removePriorMarkers(observer);
      say(`prior_marker_users: ${prior.users}`);
      say(`prior_marker_organisations: ${prior.orgs}`);
      if (!prior.ok) throw new Error(prior.verdict);
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
      fixturesSettled = true;
      const after = await snapshot(observer);
      say(`cleanup_matches_preinsert: ${JSON.stringify(after) === JSON.stringify(before)}`);
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("BLOCKED — BRANCH SNAPSHOT CHANGED");
      const triggers = await triggerState(observer);
      if (triggers.some((row) => !row.present || !row.enabled)) throw new Error("BLOCKED — TRIGGER LEFT DISABLED");
      say("branch_concurrency: PASS");
      say("isolated_branch_retained: true");
    } finally {
      if (!fixturesSettled && userIds.length) {
        try {
          const removed = await cleanup(observer, userIds);
          say(`cleanup_after_failure: ${removed.ok ? "PASS" : removed.verdict}`);
          const triggers = await triggerState(observer);
          if (!removed.ok || triggers.some((row) => !row.present || !row.enabled)) {
            say("BLOCKED — FAILURE CLEANUP DID NOT RESTORE TRIGGERS");
          }
        } catch (err) {
          say(redact(err?.message || err));
        }
      }
      await Promise.all([holder.end(), waiter.end(), observer.end()]);
    }
  } catch (err) {
    say(redact(err?.message || err));
    process.exitCode = 1;
  }
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    say(redact(err?.message || err));
    process.exit(1);
  });
}
