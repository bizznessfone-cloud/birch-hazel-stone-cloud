#!/usr/bin/env node
/**
 * CP30.05E-2D-2B.1 — real multi-connection Neon proof of founding atomicity.
 *
 * Uses AETHER_DATABASE_OWNER_URL only. Never DATABASE_URL. Never prints secrets.
 * Does not call Stripe. Does not touch hotels, billing, allocation, or acceptance.
 *
 * Disposable Better Auth users are inserted only after a rolled-back probe proves
 * the owner can disable and re-enable the commercial-history DELETE triggers.
 * Cleanup deletes only those marker rows, inside one transaction that disables
 * sbg_organisations_no_delete and sbg_organisation_members_no_delete, then
 * re-enables both before commit. The schema forbids ordinary DELETE.
 * If the probe fails, this script exits before inserting any user.
 */
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { redact } from "./production-db-preflight.mjs";
import { REQUIRED_CONFIRMATION, TARGET_MIGRATION } from "./cp3005e2d2b1-0033-production-migrate.mjs";

export const MARKER = "e2d2b1";
export const NAME_PREFIX = "E2D2B1 ";
const DELETE_TRIGGERS = [
  ["sbg_organisations", "sbg_organisations_no_delete"],
  ["sbg_organisation_members", "sbg_organisation_members_no_delete"],
];
const FOUNDING_SQL = `select organisation_id::text as organisation_id, name, organisation_type
  from sbg_ensure_founding_organisation($1, $2)`;

export function assertConfirmation(value) {
  return String(value ?? "") === REQUIRED_CONFIRMATION;
}

export function directOwnerUrl(value) {
  // A Neon pooler can serialize every client onto one backend. The race needs
  // three sessions, so a "-pooler" host is rewritten to the direct endpoint.
  return String(value ?? "").replace(/-pooler\./g, ".");
}

function say(line) {
  console.log(redact(line).replace(/[A-Za-z0-9.-]+\.neon\.tech/g, "neon-host"));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function client(ownerUrl) {
  return new pg.Client({
    connectionString: ownerUrl,
    application_name: "e2d2b1-founding-proof",
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

export async function probeTriggerControl(db) {
  const before = await triggerState(db);
  if (before.some((row) => !row.present || !row.enabled)) {
    return { ok: false, verdict: "BLOCKED — DELETE TRIGGERS NOT ENABLED", before };
  }
  await db.query("BEGIN");
  try {
    await setDeleteTriggers(db, false);
    await setDeleteTriggers(db, true);
    const inside = await triggerState(db);
    if (inside.some((row) => !row.enabled)) {
      await db.query("ROLLBACK");
      return { ok: false, verdict: "BLOCKED — TRIGGER RE-ENABLE FAILED", before };
    }
    await db.query("ROLLBACK");
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // keep the original error
    }
    return { ok: false, verdict: "BLOCKED — TRIGGER PROBE FAILED", error: redact(err?.message || err) };
  }
  const after = await triggerState(db);
  if (after.some((row) => !row.enabled)) {
    return { ok: false, verdict: "BLOCKED — TRIGGER PROBE LEFT A TRIGGER DISABLED", after };
  }
  return { ok: true, before, after };
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
         (select count(*)::int from hotels) as hotels`,
    )
  ).rows[0];
  const hotels = (
    await db.query(
      "select code, status, organisation_id::text as organisation_id from hotels order by code",
    )
  ).rows;
  const commerce = (
    await db.query(
      "select live_mapping_enabled, live_checkout_enabled from sbg_saas_commerce_locks where id = 1",
    )
  ).rows[0];
  return {
    counts: {
      organisations: Number(counts.organisations),
      members: Number(counts.members),
      users: Number(counts.users),
      classified: Number(counts.classified),
      acceptances: Number(counts.acceptances),
      licensed: Number(counts.licensed),
      allocations: Number(counts.allocations),
      hotels: Number(counts.hotels),
    },
    hotels,
    commerce: {
      liveMapping: commerce?.live_mapping_enabled === true,
      liveCheckout: commerce?.live_checkout_enabled === true,
    },
  };
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function insertUser(db, id, label) {
  const email = `${MARKER}-proof-${id}@invalid.scanbookgo.test`;
  await db.query(
    `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, false, now(), now())`,
    [id, `${NAME_PREFIX}${label}`, email],
  );
  return { id, email };
}

async function waitForLock(observer, pid) {
  const started = Date.now();
  let sawPid = false;
  while (Date.now() - started < 10000) {
    const row = (
      await observer.query(
        `select wait_event_type, state
           from pg_stat_activity
          where pid = $1`,
        [pid],
      )
    ).rows[0];
    if (row) {
      sawPid = true;
      if (row.wait_event_type === "Lock") return { observed: true, sawPid: true };
    }
    await delay(40);
  }
  return { observed: false, sawPid };
}

async function heldRace({ holder, waiter, observer, userId, holderName, waiterName, waiterPid }) {
  await holder.query("BEGIN");
  let waiterPromise;
  try {
    await holder.query(`select id from public."user" where id = $1 for update`, [userId]);
    waiterPromise = waiter.query(FOUNDING_SQL, [userId, waiterName]);
    const blocked = await waitForLock(observer, waiterPid);
    if (blocked.sawPid && !blocked.observed) {
      throw new Error("BLOCKED — WAITER DID NOT BLOCK ON THE USER LOCK");
    }
    const created = await holder.query(FOUNDING_SQL, [userId, holderName]);
    await holder.query("COMMIT");
    const waited = await waiterPromise;
    return {
      lockWaitObserved: blocked.observed === true,
      activityVisible: blocked.sawPid === true,
      holder: created.rows[0],
      waiter: waited.rows[0],
    };
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
        // the waiter may fail after rollback; the caller records the holder error
      }
    }
    throw err;
  }
}

async function membership(db, organisationId, userId) {
  const rows = (
    await db.query(
      `select role, billing_authority, removed_at
         from sbg_organisation_members
        where organisation_id = $1
          and user_id = $2
          and removed_at is null`,
      [organisationId, userId],
    )
  ).rows;
  const orgs = (
    await db.query(
      `select id::text as id, name, organisation_type
         from sbg_organisations
        where created_by_user_id = $1
        order by id`,
      [userId],
    )
  ).rows;
  return { rows, orgs };
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
  const foreign = orgs.filter((row) => !String(row.name).startsWith(NAME_PREFIX));
  if (foreign.length) {
    return { ok: false, verdict: "BLOCKED — DISPOSABLE USER CREATED A NON-MARKER ORGANISATION" };
  }
  const orgIds = orgs.map((row) => row.id);
  const refs = (
    await db.query(
      `select
         (select count(*)::int from hotels where organisation_id = any($1::uuid[])) as hotels,
         (select count(*)::int from sbg_organisation_billing where organisation_id = any($1::uuid[])) as billing,
         (select count(*)::int from sbg_property_licence_allocations where organisation_id = any($1::uuid[])) as allocations,
         (select count(*)::int from sbg_organisation_acceptances where organisation_id = any($1::uuid[])) as acceptances,
         (select count(*)::int from sbg_domain_a_checkout_claims where organisation_id = any($1::uuid[])) as claims`,
      [orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]],
    )
  ).rows[0];
  if (["hotels", "billing", "allocations", "acceptances", "claims"].some((key) => Number(refs[key]) > 0)) {
    return { ok: false, verdict: "BLOCKED — MARKER ORGANISATION HAS REAL COMMERCIAL REFERENCES", refs };
  }
  await db.query("BEGIN");
  try {
    await setDeleteTriggers(db, false);
    await db.query(
      `delete from sbg_organisation_members
        where user_id = any($1::text[])
           or organisation_id = any($2::uuid[])`,
      [userIds, orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]],
    );
    await db.query(
      `delete from sbg_organisations
        where created_by_user_id = any($1::text[])
          and name like $2`,
      [userIds, `${NAME_PREFIX}%`],
    );
    await db.query(`delete from public."user" where id = any($1::text[])`, [userIds]);
    await setDeleteTriggers(db, true);
    const enabled = await triggerState(db);
    if (enabled.some((row) => !row.enabled)) {
      await db.query("ROLLBACK");
      return { ok: false, verdict: "BLOCKED — CLEANUP WOULD LEAVE A TRIGGER DISABLED" };
    }
    const leftOrgs = (
      await db.query(
        "select count(*)::int as n from sbg_organisations where created_by_user_id = any($1::text[])",
        [userIds],
      )
    ).rows[0];
    const leftUsers = (
      await db.query(`select count(*)::int as n from public."user" where id = any($1::text[])`, [userIds])
    ).rows[0];
    const leftMembers = (
      await db.query(
        "select count(*)::int as n from sbg_organisation_members where user_id = any($1::text[])",
        [userIds],
      )
    ).rows[0];
    if (Number(leftOrgs.n) || Number(leftUsers.n) || Number(leftMembers.n)) {
      await db.query("ROLLBACK");
      return { ok: false, verdict: "BLOCKED — CLEANUP DID NOT REMOVE MARKER ROWS" };
    }
    await db.query("COMMIT");
    return { ok: true, removedOrganisations: orgIds.length, removedUsers: userIds.length };
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // keep the original error
    }
    return { ok: false, verdict: "BLOCKED — CLEANUP FAILED", error: redact(err?.message || err) };
  }
}

function rowOf(row) {
  return {
    organisationId: row?.organisation_id ?? "",
    name: row?.name ?? "",
    organisationType: row?.organisation_type ?? null,
  };
}

async function main() {
  const configured = String(process.env.AETHER_DATABASE_OWNER_URL ?? "").trim();
  const ownerUrl = directOwnerUrl(configured);
  const confirmation = process.env.CP3005E2D2B1_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${configured ? "PRESENT" : "ABSENT"}`);
  say(`connection_mode: ${ownerUrl === configured ? "as-configured" : "direct-endpoint"}`);
  if (!assertConfirmation(confirmation)) {
    say("BLOCKED — CONFIRMATION PHRASE INVALID");
    process.exitCode = 1;
    return;
  }
  if (!ownerUrl) {
    say("BLOCKED — AETHER_DATABASE_OWNER_URL is not configured");
    process.exitCode = 1;
    return;
  }

  const holder = client(ownerUrl);
  const waiter = client(ownerUrl);
  const observer = client(ownerUrl);
  const userIds = [];
  let opened = false;
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
    say(`backend_pids: ${pidA} ${pidB} ${pidC}`);
    if (new Set([pidA, pidB, pidC]).size !== 3) {
      say("BLOCKED — CONNECTIONS ARE NOT INDEPENDENT");
      process.exitCode = 1;
      return;
    }
    const ledger = (
      await observer.query("select name from _migrations where name = $1", [TARGET_MIGRATION])
    ).rows;
    if (ledger.length !== 1) {
      say("BLOCKED — 0033 IS NOT INSTALLED");
      process.exitCode = 1;
      return;
    }
    const probe = await probeTriggerControl(observer);
    say(`trigger_probe: ${probe.ok ? "PASS" : probe.verdict}`);
    if (!probe.ok) {
      if (probe.error) say(probe.error);
      process.exitCode = 1;
      return;
    }

    const before = await snapshot(observer);
    const sameUser = `${MARKER}-${randomUUID()}`;
    const diffUser = `${MARKER}-${randomUUID()}`;
    const otherA = `${MARKER}-${randomUUID()}`;
    const otherB = `${MARKER}-${randomUUID()}`;
    userIds.push(sameUser, diffUser, otherA, otherB);
    await observer.query("BEGIN");
    await insertUser(observer, sameUser, "same");
    await insertUser(observer, diffUser, "diff");
    await insertUser(observer, otherA, "other-a");
    await insertUser(observer, otherB, "other-b");
    await observer.query("COMMIT");

    const sameName = `${NAME_PREFIX}Same Name Proof`;
    const same = await heldRace({
      holder,
      waiter,
      observer,
      userId: sameUser,
      holderName: sameName,
      waiterName: sameName,
      waiterPid: pidB,
    });
    const sameMembership = await membership(observer, same.holder.organisation_id, sameUser);
    say(`test1_lock_wait_observed: ${same.lockWaitObserved}`);
    say(`test1_activity_visible: ${same.activityVisible}`);
    say(`test1_same_id: ${same.holder.organisation_id === same.waiter.organisation_id}`);
    say(`test1_org_id: ${same.holder.organisation_id}`);
    say(`test1_org_count: ${sameMembership.orgs.length}`);
    say(`test1_member_count: ${sameMembership.rows.length}`);
    say(`test1_role: ${sameMembership.rows[0]?.role ?? ""}`);
    say(`test1_billing: ${sameMembership.rows[0]?.billing_authority === true}`);
    say(`test1_type_null: ${same.holder.organisation_type == null && same.waiter.organisation_type == null}`);
    if (
      same.holder.organisation_id !== same.waiter.organisation_id ||
      sameMembership.orgs.length !== 1 ||
      sameMembership.rows.length !== 1 ||
      sameMembership.rows[0]?.role !== "member" ||
      sameMembership.rows[0]?.billing_authority !== true ||
      same.holder.organisation_type != null
    ) {
      throw new Error("BLOCKED — SAME-NAME CONCURRENCY FAILED");
    }

    const alpha = `${NAME_PREFIX}Alpha Name`;
    const beta = `${NAME_PREFIX}Beta Name`;
    const diff = await heldRace({
      holder,
      waiter,
      observer,
      userId: diffUser,
      holderName: alpha,
      waiterName: beta,
      waiterPid: pidB,
    });
    const diffMembership = await membership(observer, diff.holder.organisation_id, diffUser);
    say(`test2_lock_wait_observed: ${diff.lockWaitObserved}`);
    say(`test2_activity_visible: ${diff.activityVisible}`);
    say(`test2_same_id: ${diff.holder.organisation_id === diff.waiter.organisation_id}`);
    say(`test2_stored_name: ${diff.holder.name}`);
    say(`test2_org_count: ${diffMembership.orgs.length}`);
    say(`test2_member_count: ${diffMembership.rows.length}`);
    if (
      diff.holder.organisation_id !== diff.waiter.organisation_id ||
      diff.holder.name !== alpha ||
      diff.waiter.name !== alpha ||
      diffMembership.orgs.length !== 1 ||
      diffMembership.rows.length !== 1
    ) {
      throw new Error("BLOCKED — DIFFERENT-NAME CONCURRENCY FAILED");
    }

    const renamed = `${NAME_PREFIX}Retry Other Name`;
    const retry = (await observer.query(FOUNDING_SQL, [diffUser, renamed])).rows[0];
    const retryMembership = await membership(observer, retry.organisation_id, diffUser);
    say(`test3_same_id: ${retry.organisation_id === diff.holder.organisation_id}`);
    say(`test3_stored_name: ${retry.name}`);
    say(`test3_org_count: ${retryMembership.orgs.length}`);
    say(`test3_member_count: ${retryMembership.rows.length}`);
    if (
      retry.organisation_id !== diff.holder.organisation_id ||
      retry.name !== alpha ||
      retryMembership.orgs.length !== 1 ||
      retryMembership.rows.length !== 1
    ) {
      throw new Error("BLOCKED — RETRY RENAMED OR DUPLICATED THE ORGANISATION");
    }

    const [left, right] = await Promise.all([
      holder.query(FOUNDING_SQL, [otherA, `${NAME_PREFIX}Other A`]),
      waiter.query(FOUNDING_SQL, [otherB, `${NAME_PREFIX}Other B`]),
    ]);
    const leftRow = rowOf(left.rows[0]);
    const rightRow = rowOf(right.rows[0]);
    say(`test4_distinct_ids: ${leftRow.organisationId !== rightRow.organisationId}`);
    say(`test4_left_type_null: ${leftRow.organisationType == null}`);
    say(`test4_right_type_null: ${rightRow.organisationType == null}`);
    if (!leftRow.organisationId || !rightRow.organisationId || leftRow.organisationId === rightRow.organisationId) {
      throw new Error("BLOCKED — DIFFERENT USERS DID NOT FOUND SEPARATE ORGANISATIONS");
    }

    const removed = await cleanup(observer, userIds);
    say(`cleanup: ${removed.ok ? "PASS" : removed.verdict}`);
    if (removed.error) say(removed.error);
    if (!removed.ok) {
      process.exitCode = 1;
      return;
    }
    userIds.length = 0;
    const after = await snapshot(observer);
    const triggers = await triggerState(observer);
    say(`counts_match: ${sameSnapshot(before, after)}`);
    say(`triggers_enabled: ${triggers.every((row) => row.enabled)}`);
    say(`removed_organisations: ${removed.removedOrganisations}`);
    say(`removed_users: ${removed.removedUsers}`);
    if (!sameSnapshot(before, after) || triggers.some((row) => !row.enabled)) {
      say("BLOCKED — PRODUCTION SNAPSHOT OR TRIGGERS CHANGED");
      process.exitCode = 1;
      return;
    }
    say("GATE PASS — NEON FOUNDING CONCURRENCY VERIFIED");
  } catch (err) {
    say(redact(err?.message || err));
    process.exitCode = 1;
  } finally {
    if (opened && userIds.length) {
      try {
        const removed = await cleanup(observer, userIds);
        say(`cleanup_after_failure: ${removed.ok ? "PASS" : removed.verdict}`);
        if (!removed.ok) process.exitCode = 1;
      } catch (err) {
        say(redact(err?.message || err));
        process.exitCode = 1;
      }
    }
    await Promise.allSettled([holder.end(), waiter.end(), observer.end()]);
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main();
}
