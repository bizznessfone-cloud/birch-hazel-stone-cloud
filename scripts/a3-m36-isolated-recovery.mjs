#!/usr/bin/env node
/**
 * A3-M36 isolated fixture recovery. Manual. Does not install SQL.
 *
 * Removes only marker fixtures left by an interrupted concurrency run on
 * br-dawn-hat-b1b4uqhn. Uses AETHER_0036_ISOLATED_OWNER_URL. There is no
 * Production fallback. Triggers and foreign keys stay enabled. The cleanup
 * is one transaction. A refusal rolls it back and preserves the rows.
 * terms-v1 is never deleted.
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
  FORBIDDEN_ENV,
  ISOLATED_OWNER_ENV,
  directOwnerUrl,
  identityFailures,
} from "./a3-m36-isolated-preflight.mjs";
import { EXPECTED_ENDPOINT } from "./a3-m36-0035-equivalence.mjs";
import { endpointPinFailures } from "./a3-m36-isolated-install.mjs";
import { cleanupFixtures } from "./a3-m36-isolated-cleanup.mjs";

export const RECOVERY_CONFIRMATION = "RECOVER-0036-ISOLATED";
export const CONFIRMATION_ENV = "A3M36_RECOVERY_CONFIRMATION";
export const RECOVERY_REMOVED = "RECOVERY PASS — FIXTURE ROWS REMOVED";
export const RECOVERY_CLEAN = "RECOVERY CLEAN — NO FIXTURE ROWS";

const IDENTITY_SQL = `select current_database() as database,
       current_user,
       session_user,
       current_setting('neon.project_id', true) as project_id,
       current_setting('neon.branch_id', true) as branch_id,
       current_setting('neon.endpoint_id', true) as endpoint_id`;

function sayLine(say, line) {
  const safe = redact(String(line)).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host");
  say(safe);
  return safe;
}

function client(connectionString) {
  return new pg.Client({
    connectionString: directOwnerUrl(connectionString),
    application_name: "a3m36-isolated-recovery",
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

export async function runRecovery({ env, connect = client, say = () => {} }) {
  const lines = [];
  const log = (line) => lines.push(sayLine(say, line));
  const finish = (exitCode) => ({ exitCode, lines });
  const confirmation = String(env?.[CONFIRMATION_ENV] ?? "");
  const isolated = String(env?.[ISOLATED_OWNER_ENV] ?? "").trim();
  log(`confirmation: ${confirmation === RECOVERY_CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  log(`${ISOLATED_OWNER_ENV}: ${isolated ? "PRESENT" : "ABSENT"}`);
  log("install_stage: not-invoked");
  log("concurrency_stage: not-invoked");
  log("terms_v1_approval: refused");
  if (confirmation !== RECOVERY_CONFIRMATION) {
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
  try {
    await db.query("begin read only");
    const identity = mapIdentity((await db.query(IDENTITY_SQL)).rows[0]);
    const hostname = new URL(directOwnerUrl(isolated)).hostname.toLowerCase();
    const failures = identityFailures(identity, hostname);
    if (identity.endpointId !== EXPECTED_ENDPOINT) failures.push("endpoint-pin");
    log(`neon_project: ${identity.projectId || "unproven"}`);
    log(`neon_branch: ${identity.branchId || "unproven"}`);
    log(`neon_endpoint: ${identity.endpointId || "unproven"}`);
    log(`database: ${identity.database || "unproven"}`);
    log(`role: ${identity.currentUser || "unproven"}`);
    if (failures.length || identity.projectId !== EXPECTED_PROJECT || identity.branchId !== EXPECTED_BRANCH || identity.database !== EXPECTED_DATABASE || identity.currentUser !== EXPECTED_ROLE) {
      await db.query("rollback");
      log(`BLOCKED — ISOLATED IDENTITY ${failures.join(",") || "mismatch"}`);
      return finish(1);
    }
    await db.query("rollback");
    log("isolated_identity: PASS");
    const removed = await cleanupFixtures(db, { discover: true, approvals: true });
    log(`cleanup_transaction: ${removed.transaction}`);
    log(`data_preserved: ${removed.preserved}`);
    for (const [table, count] of Object.entries(removed.identified)) log(`identified ${table}: ${count}`);
    for (const [table, count] of Object.entries(removed.removed)) log(`removed ${table}: ${count}`);
    for (const ref of removed.references ?? []) {
      log(`unexpected_reference: ${ref.childTable}.${ref.childColumns?.[0]} -> ${ref.parentTable} rows=${ref.count}`);
    }
    if (!removed.ok) {
      log(removed.verdict);
      return finish(1);
    }
    const verdict = removed.transaction === "committed" ? RECOVERY_REMOVED : RECOVERY_CLEAN;
    log(verdict);
    return finish(0);
  } catch (err) {
    try { await db.query("rollback"); } catch { /* no open read */ }
    log(`BLOCKED — RECOVERY FAILED ${String(err?.message ?? err).split("\n")[0].slice(0, 180)}`);
    return finish(1);
  } finally {
    try { await db.end?.(); } catch { /* closing must not hide the verdict */ }
  }
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runRecovery({ env: process.env, say: (line) => console.log(line) })
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((err) => {
      console.log(redact(err?.message || err).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host"));
      process.exitCode = 1;
    });
}
