#!/usr/bin/env node
/**
 * A3-M36 read-only constraint diagnostic for one isolated Neon branch.
 *
 * The 0036 installer blocked with 0035_equivalence_failures: constraint-count.
 * assess0035Equivalence requires exactly three pg_constraint rows. Migration
 * 0035 declares a primary key and two checks. PostgreSQL 18 also records the
 * primary-key column's NOT NULL as contype n. This command prints every live
 * constraint and says whether that extra row is the generated not-null
 * constraint. It does not change the equivalence verifier.
 *
 * Manual. One credential: AETHER_0036_ISOLATED_OWNER_URL. Identity is proven
 * from neon.project_id, neon.branch_id, and neon.endpoint_id before the
 * catalogue is read. No SQL is applied. No ledger row is inserted. Production
 * is not a fallback.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import { DIGEST_35, EXPECTED_ENDPOINT, MIGRATION_35, normSpace, sha256 } from "./a3-m36-0035-equivalence.mjs";
import { endpointPinFailures } from "./a3-m36-isolated-install.mjs";

export const DIAGNOSTIC_CONFIRMATION = "DIAGNOSE-0036-CONSTRAINTS";
export const CONFIRMATION_ENV = "A3M36_CONSTRAINT_CONFIRMATION";
export const VERDICT_AUTOMATIC = "CONSTRAINT DIAGNOSTIC — AUTOMATIC NOT NULL ONLY";
export const VERDICT_THREE = "CONSTRAINT DIAGNOSTIC — THREE MANDATORY ONLY";
export const VERDICT_UNEXPECTED = "CONSTRAINT DIAGNOSTIC — UNEXPECTED CONSTRAINT";
export const VERDICT_MISSING = "CONSTRAINT DIAGNOSTIC — MANDATORY CONSTRAINT MISSING";
export const AUTOMATIC_NOT_NULL_NAME = "sbg_approved_property_agreement_vers_agreement_version_not_null";
export const AUTOMATIC_NOT_NULL_DEFINITION = "NOT NULL agreement_version";
export const RECOMMENDATION_AUTOMATIC = "The only extra constraint is the validated PostgreSQL 18 not-null catalog row on agreement_version. A later verifier change may exclude that single contype n row from the count. Keep the primary-key, token, and terms-v1 checks required by name and definition. Do not replace the count check with a minimum of three. This diagnostic does not change the verifier.";

const TOKEN = "^[a-z0-9][a-z0-9._/-]{0,120}$";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const IDENTITY_SQL = `select current_database() as database,
       current_user,
       session_user,
       current_setting('neon.project_id', true) as project_id,
       current_setting('neon.branch_id', true) as branch_id,
       current_setting('neon.endpoint_id', true) as endpoint_id`;

const VERSION_SQL = `select current_setting('server_version') as server_version,
       current_setting('server_version_num') as server_version_num`;

const TABLE_SQL = `select to_regclass('public.sbg_approved_property_agreement_versions') is not null as present`;

const COLUMN_SQL = `select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'sbg_approved_property_agreement_versions'
 order by ordinal_position`;

export const CONSTRAINT_SQL = `select c.conname as name,
       c.contype as type,
       c.convalidated as validated,
       c.conislocal as is_local,
       c.coninhcount as inherit_count,
       (
         select string_agg(att.attname, ',' order by u.ord)
           from unnest(c.conkey) with ordinality as u(attnum, ord)
           join pg_attribute att
             on att.attrelid = c.conrelid
            and att.attnum = u.attnum
       ) as columns,
       pg_catalog.pg_get_constraintdef(c.oid, true) as definition
  from pg_constraint c
  join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
 where n.nspname = 'public'
   and r.relname = 'sbg_approved_property_agreement_versions'
 order by c.conname`;

const TYPE_LABEL = {
  c: "check",
  f: "foreign-key",
  n: "not-null",
  p: "primary-key",
  u: "unique",
  t: "constraint-trigger",
  x: "exclusion",
};

function sayLine(say, line) {
  const safe = redact(String(line)).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host");
  say(safe);
  return safe;
}

function client(connectionString) {
  return new pg.Client({
    connectionString: directOwnerUrl(connectionString),
    application_name: "a3m36-constraint-diagnostic",
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

function assertReadOnly(sql) {
  const text = String(sql ?? "").trim();
  if (!/^(set\s+default_transaction_read_only\s*=\s*on|begin\s+read\s+only|rollback|select)\b/i.test(text)) {
    throw new Error("BLOCKED — NON READ ONLY STATEMENT");
  }
}

async function query(db, sql) {
  assertReadOnly(sql);
  return db.query(sql);
}

export function expectedConstraintsFrom0035(sql) {
  const text = String(sql ?? "");
  if (!text.includes("agreement_version text primary key")) return null;
  if (!text.includes("constraint sbg_approved_property_agreement_versions_token")) return null;
  if (!text.includes(`agreement_version ~ '${TOKEN}'`)) return null;
  if (!text.includes("constraint sbg_approved_property_agreement_versions_not_provisional")) return null;
  if (!text.includes("agreement_version <> 'terms-v1'")) return null;
  return {
    primaryKey: {
      key: "primary-key",
      name: "sbg_approved_property_agreement_versions_pkey",
      matches: (def) => String(def ?? "").includes("PRIMARY KEY") && String(def ?? "").includes("agreement_version"),
    },
    token: {
      key: "token",
      name: "sbg_approved_property_agreement_versions_token",
      matches: (def) => String(def ?? "").includes(TOKEN),
    },
    provisional: {
      key: "provisional",
      name: "sbg_approved_property_agreement_versions_not_provisional",
      matches: (def) => String(def ?? "").includes("terms-v1"),
    },
  };
}

function originFor(rowClass) {
  if (rowClass === "automatic-not-null") return "automatically-generated-postgresql-constraint";
  if (String(rowClass).startsWith("mandatory-")) return "migration-0035";
  return "unexpected-database-modification";
}

export function classifyApprovalConstraints(rows, options = {}) {
  const expected = options.expected;
  const version = Number(options.serverVersionNum);
  const mandatorySpec = expected ? [expected.primaryKey, expected.token, expected.provisional] : [];
  const list = Array.isArray(rows) ? rows : [];
  const classified = list.map((row) => {
    const name = String(row?.name ?? "");
    const type = String(row?.type ?? "").trim();
    const definition = normSpace(row?.definition);
    const columns = String(row?.columns ?? "");
    const validated = row?.validated === true;
    const spec = mandatorySpec.find((item) => item?.name === name);
    let rowClass = "unexpected";
    let definitionOk = false;
    if (spec) {
      rowClass = `mandatory-${spec.key}`;
      definitionOk = spec.matches(definition);
    } else if (type === "n" && validated && columns === "agreement_version" && definition === AUTOMATIC_NOT_NULL_DEFINITION) {
      if (Number.isFinite(version) && version >= 180000 && name === AUTOMATIC_NOT_NULL_NAME) {
        rowClass = "automatic-not-null";
        definitionOk = true;
      } else if (Number.isFinite(version) && version >= 180000) {
        rowClass = "not-null-name-differs";
      } else {
        rowClass = "unexpected-not-null";
      }
    }
    return {
      name,
      type,
      typeLabel: TYPE_LABEL[type] ?? "unknown",
      definition,
      columns,
      validated,
      isLocal: row?.is_local === true,
      inheritCount: row?.inherit_count ?? "",
      class: rowClass,
      definitionOk,
      origin: originFor(rowClass),
    };
  });
  const names = classified.map((row) => row.name);
  const duplicateNames = names.filter((name, index) => name && names.indexOf(name) !== index);
  const mandatory = mandatorySpec.map((spec) => {
    const found = classified.filter((row) => row.name === spec.name);
    const row = found[0];
    return {
      key: spec.key,
      name: spec.name,
      present: found.length === 1,
      definitionOk: found.length === 1 && row.definitionOk === true,
      validated: found.length === 1 && row.validated === true,
    };
  });
  const extras = classified.filter((row) => !row.class.startsWith("mandatory-"));
  const mandatoryOk = mandatory.length === 3 && mandatory.every((item) => item.present && item.definitionOk && item.validated) && duplicateNames.length === 0;
  const onlyAutomatic = mandatoryOk && extras.length === 1 && extras[0].class === "automatic-not-null";
  let verdict = VERDICT_UNEXPECTED;
  let reason = "An extra constraint is not the single PostgreSQL 18 not-null catalog row for agreement_version. Do not change the verifier. Treat the extra row as an unexpected database modification or a later schema object.";
  if (!expected) {
    verdict = VERDICT_MISSING;
    reason = "Migration 0035 did not yield the three mandatory constraint markers. Do not change the verifier.";
  } else if (!mandatoryOk) {
    verdict = VERDICT_MISSING;
    reason = "A mandatory 0035 constraint is missing, duplicated, unvalidated, or its definition does not match. Do not change the count check.";
  } else if (extras.length === 0) {
    verdict = VERDICT_THREE;
    reason = "The live catalogue has exactly the three constraints declared by migration 0035. Do not change the verifier. constraint-count is not explained by an extra row.";
  } else if (onlyAutomatic) {
    verdict = VERDICT_AUTOMATIC;
    reason = RECOMMENDATION_AUTOMATIC;
  }
  return {
    rows: classified,
    mandatory,
    extras,
    mandatoryOk,
    count: classified.length,
    wouldFailConstraintCount: classified.length !== 3,
    recommendVerifierChange: verdict === VERDICT_AUTOMATIC,
    verdict,
    reason,
  };
}

async function defaultRead35() {
  return readFile(join(root, "migrations", MIGRATION_35), "utf8");
}

export async function runDiagnostic({ env, connect = client, say = () => {}, readSql = defaultRead35 }) {
  const lines = [];
  const log = (line) => lines.push(sayLine(say, line));
  const finish = (exitCode) => ({ exitCode, lines });
  const confirmation = String(env?.[CONFIRMATION_ENV] ?? "");
  const isolated = String(env?.[ISOLATED_OWNER_ENV] ?? "").trim();
  log(`confirmation: ${confirmation === DIAGNOSTIC_CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  log(`${ISOLATED_OWNER_ENV}: ${isolated ? "PRESENT" : "ABSENT"}`);
  log("install_stage: not-invoked");
  log("concurrency_stage: not-invoked");
  log("recovery_stage: not-invoked");
  log("ledger_insert: refused");
  log("verifier_changed: false");
  log("writes: none");
  if (confirmation !== DIAGNOSTIC_CONFIRMATION) {
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

  let sql35 = "";
  try {
    sql35 = String(await readSql());
  } catch (err) {
    log(`BLOCKED — MIGRATION SOURCE UNREADABLE ${redact(err?.message || err).slice(0, 180)}`);
    return finish(1);
  }
  const digestOk = sha256(sql35) === DIGEST_35;
  log(`digest_0035: ${digestOk ? "match" : "mismatch"}`);
  log(`compared_with: migrations/${MIGRATION_35}`);
  const expected = digestOk ? expectedConstraintsFrom0035(sql35) : null;
  if (!digestOk || !expected) {
    log("BLOCKED — 0035 SOURCE DOES NOT MATCH THE REVIEWED CONSTRAINTS");
    return finish(1);
  }

  let db;
  try {
    db = await connect(isolated);
    if (typeof db.connect === "function") await db.connect();
  } catch (err) {
    log(`BLOCKED — CONNECT FAILED ${redact(err?.message || err).split("\n")[0].slice(0, 180)}`);
    return finish(1);
  }
  try {
    await query(db, "set default_transaction_read_only = on");
    await query(db, "begin read only");
    const identity = mapIdentity((await query(db, IDENTITY_SQL)).rows[0]);
    const hostname = new URL(directOwnerUrl(isolated)).hostname.toLowerCase();
    const failures = identityFailures(identity, hostname);
    if (identity.endpointId !== EXPECTED_ENDPOINT) failures.push("endpoint-pin");
    log(`neon_project: ${identity.projectId || "unproven"}`);
    log(`neon_branch: ${identity.branchId || "unproven"}`);
    log(`neon_endpoint: ${identity.endpointId || "unproven"}`);
    log(`database: ${identity.database || "unproven"}`);
    log(`role: ${identity.currentUser || "unproven"}`);
    if (failures.length || identity.projectId !== EXPECTED_PROJECT || identity.branchId !== EXPECTED_BRANCH || identity.database !== EXPECTED_DATABASE || identity.currentUser !== EXPECTED_ROLE) {
      await query(db, "rollback");
      log(`BLOCKED — ISOLATED IDENTITY ${[...new Set(failures)].join(",") || "mismatch"}`);
      return finish(1);
    }
    log("isolated_identity: PASS");
    log("production_branch_rejected: true");
    log("production_endpoint_rejected: true");

    const version = (await query(db, VERSION_SQL)).rows[0] ?? {};
    log(`server_version: ${version.server_version || "unproven"}`);
    log(`server_version_num: ${version.server_version_num || "unproven"}`);
    const present = (await query(db, TABLE_SQL)).rows[0]?.present === true;
    log(`approval_table: ${present ? "present" : "absent"}`);
    if (!present) {
      await query(db, "rollback");
      log("BLOCKED — APPROVAL TABLE ABSENT");
      return finish(1);
    }
    const columns = (await query(db, COLUMN_SQL)).rows;
    for (const column of columns) {
      log(`column: ${column.column_name} ${column.data_type} nullable=${column.is_nullable === "YES" ? "true" : "false"}`);
    }
    const constraints = (await query(db, CONSTRAINT_SQL)).rows;
    await query(db, "rollback");
    log("transaction: read-only-rolled-back");

    const classified = classifyApprovalConstraints(constraints, {
      serverVersionNum: version.server_version_num,
      expected,
    });
    log(`constraint_count: ${classified.count}`);
    log(`0035_declared_constraints: 3`);
    for (const row of classified.rows) {
      log(`constraint: name=${row.name} type=${row.type} (${row.typeLabel}) validated=${row.validated ? "true" : "false"} columns=${row.columns || "none"} definition=${row.definition} class=${row.class} origin=${row.origin}`);
    }
    for (const item of classified.mandatory) {
      log(`0035_${item.key}: ${item.present && item.definitionOk && item.validated ? "pass" : "fail"}`);
    }
    log(`extra_constraints: ${classified.extras.length}`);
    log(`constraint_count_would_fail: ${classified.wouldFailConstraintCount ? "true" : "false"}`);
    log(`verifier_change_recommended: ${classified.recommendVerifierChange ? "true" : "false"}`);
    log(`recommendation: ${classified.reason}`);
    log(classified.verdict);
    return finish(classified.verdict === VERDICT_AUTOMATIC || classified.verdict === VERDICT_THREE ? 0 : 1);
  } catch (err) {
    try { await query(db, "rollback"); } catch { /* no open read */ }
    log(`BLOCKED — DIAGNOSTIC FAILED ${redact(err?.message || err).split("\n")[0].slice(0, 180)}`);
    return finish(1);
  } finally {
    try { await db.end?.(); } catch { /* closing must not hide the verdict */ }
  }
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runDiagnostic({ env: process.env, say: (line) => console.log(line) })
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((err) => {
      console.log(redact(err?.message || err).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host"));
      process.exitCode = 1;
    });
}
