#!/usr/bin/env node
/**
 * A3-M36 read-only foreign-key and fixture-not-legal diagnostic.
 * Does not delete, update, or install SQL. Does not run recovery.
 * The recovery branch is rejected. Personal names and emails are not selected.
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
import {
  EXPECTED_EDGES,
  cleanupForeignKeyDriverRows,
  mapCleanupCatalog,
} from "./a3-m36-isolated-cleanup.mjs";
import { EXPECTED_DELETE, NOT_LEGAL, foreignKeyStatus } from "./a3-m36-isolated-recovery-preflight.mjs";

export const DIAGNOSTIC_CONFIRMATION = "DIAGNOSE-0036-FOREIGN-KEYS";
export const CONFIRMATION_ENV = "A3M36_FK_CONFIRMATION";
export const RECOVERY_BRANCH = "br-proud-field-b1tymqgc";
export const VERDICT_MAPPING = "FK DIAGNOSTIC — MAPPING";
export const VERDICT_MISSING = "FK DIAGNOSTIC — GENUINE MISSING";
export const VERDICT_NAMING = "FK DIAGNOSTIC — NAMING";
export const VERDICT_QUERY = "FK DIAGNOSTIC — QUERY";
export const VERDICT_ACTION = "FK DIAGNOSTIC — ACTION";
export const VERDICT_UNVALIDATED = "FK DIAGNOSTIC — UNVALIDATED";
export const VERDICT_DUPLICATE = "FK DIAGNOSTIC — DUPLICATE";
export const VERDICT_MATCH = "FK DIAGNOSTIC — MATCH";

const DELETE_LABEL = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };
const CAUSE_PRIORITY = ["genuine-missing", "naming", "duplicate", "action", "unvalidated", "mapping", "query", "match"];
const VERDICT_FOR = {
  "genuine-missing": VERDICT_MISSING,
  naming: VERDICT_NAMING,
  duplicate: VERDICT_DUPLICATE,
  action: VERDICT_ACTION,
  unvalidated: VERDICT_UNVALIDATED,
  mapping: VERDICT_MAPPING,
  query: VERDICT_QUERY,
  match: VERDICT_MATCH,
};

const IDENTITY_SQL = `select current_database() as database,
       current_user,
       session_user,
       current_setting('neon.project_id', true) as project_id,
       current_setting('neon.branch_id', true) as branch_id,
       current_setting('neon.endpoint_id', true) as endpoint_id`;

const COLUMN_SQL = `-- a3m36-fk-columns
select con.conname as constraint_name,
       con.convalidated as validated,
       child_ns.nspname as child_schema,
       child.relname as child_table,
       parent_ns.nspname as parent_schema,
       parent.relname as parent_table,
       con.confdeltype as delete_action,
       child_att.attname::text as child_column,
       parent_att.attname::text as parent_column
  from pg_constraint con
  join pg_class child on child.oid = con.conrelid
  join pg_class parent on parent.oid = con.confrelid
  join pg_namespace child_ns on child_ns.oid = child.relnamespace
  join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
  join lateral unnest(con.conkey) with ordinality as child_ord(attnum, ord) on true
  join pg_attribute child_att on child_att.attrelid = con.conrelid and child_att.attnum = child_ord.attnum
  join lateral unnest(con.confkey) with ordinality as parent_ord(attnum, ord) on parent_ord.ord = child_ord.ord
  join pg_attribute parent_att on parent_att.attrelid = con.confrelid and parent_att.attnum = parent_ord.attnum
 where con.contype = 'f'
   and child_ns.nspname = 'public'
   and parent_ns.nspname = 'public'
   and (parent.relname = any($1::text[]) or child.relname = any($2::text[]))
 order by child.relname, con.conname, child_ord.ord`;

const APPROVAL_SQL = `-- a3m36-not-legal-approval
select agreement_version, effective
  from public.sbg_approved_property_agreement_versions
 where agreement_version = $1`;

const ACCEPTANCE_SQL = `-- a3m36-not-legal-acceptances
select a.id::text as acceptance_id,
       a.organisation_id::text as organisation_id,
       a.accepted_by_user_id as user_id,
       (u.id is not null) as user_present,
       (o.id is not null) as organisation_present,
       coalesce(u.id like 'a3m36-%'
         and u.email like 'a3m36-proof-%@invalid.scanbookgo.test'
         and u.name like 'A3M36 %', false) as marker_user,
       coalesce(o.name like 'A3M36 %', false) as marker_organisation,
       (select count(*)::int from public.sbg_organisation_acceptances x where x.organisation_id = a.organisation_id) as org_acceptances,
       (select count(*)::int from public.sbg_organisation_members x where x.organisation_id = a.organisation_id) as org_members,
       (select count(*)::int from public.hotels x where x.organisation_id = a.organisation_id) as org_hotels,
       (select count(*)::int from public.sbg_organisations x where x.created_by_user_id = a.accepted_by_user_id) as user_organisations,
       (select count(*)::int from public.app_hotel_accounts x where x.user_id = a.accepted_by_user_id) as user_accounts,
       (select count(*)::int from public.sbg_organisation_members x where x.user_id = a.accepted_by_user_id) as user_memberships,
       (select count(*)::int from public.sbg_organisation_acceptances x where x.accepted_by_user_id = a.accepted_by_user_id) as user_acceptances
  from public.sbg_organisation_acceptances a
  left join public.sbg_organisations o on o.id = a.organisation_id
  left join public."user" u on u.id = a.accepted_by_user_id
 where a.agreement_version = $1
 order by a.id`;

function sayLine(say, line) {
  const safe = redact(String(line)).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host");
  say(safe);
  return safe;
}

function client(connectionString) {
  return new pg.Client({
    connectionString: directOwnerUrl(connectionString),
    application_name: "a3m36-fk-diagnostic",
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

function readOnlyStatement(sql) {
  const text = String(sql ?? "").replace(/^\s*(--[^\n]*\n\s*)*/, "").trim();
  return /^(begin\s+read\s+only|rollback|select)\b/i.test(text);
}

function readOnlyClient(db) {
  return {
    query(text, params) {
      if (!readOnlyStatement(text)) throw new Error("BLOCKED — NON READ ONLY STATEMENT");
      return db.query(text, params);
    },
    end: () => db.end?.(),
  };
}

export function groupFkColumns(rows) {
  const grouped = new Map();
  for (const row of rows ?? []) {
    const name = String(row.constraint_name ?? "");
    const current = grouped.get(name) ?? {
      name,
      validated: row.validated === true,
      childSchema: String(row.child_schema ?? ""),
      childTable: String(row.child_table ?? ""),
      parentSchema: String(row.parent_schema ?? ""),
      parentTable: String(row.parent_table ?? ""),
      deleteAction: String(row.delete_action ?? ""),
      childColumns: [],
      parentColumns: [],
    };
    current.childColumns.push(String(row.child_column ?? ""));
    current.parentColumns.push(String(row.parent_column ?? ""));
    grouped.set(name, current);
  }
  return [...grouped.values()];
}

export function driverColumnShape(value) {
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (value == null) return "absent";
  return typeof value;
}

function edgeKey(edge) {
  return `${edge.child}→${edge.parent}`;
}

export function classifyFkDiscrepancy({ edges = EXPECTED_EDGES, expectedDelete = EXPECTED_DELETE, scalar = [], driverMapped = [] } = {}) {
  const findings = [];
  for (const edge of edges) {
    const key = edgeKey(edge);
    const matches = scalar.filter((row) => row.childSchema === "public"
      && row.parentSchema === "public"
      && row.childTable === edge.child
      && row.parentTable === edge.parent
      && row.childColumns.length === 1
      && row.parentColumns.length === 1
      && row.childColumns[0] === edge.column
      && row.parentColumns[0] === "id");
    if (matches.length > 1) {
      findings.push({ key, column: edge.column, cause: "duplicate", constraints: matches.map((row) => row.name) });
      continue;
    }
    if (matches.length === 1) {
      const actual = matches[0];
      const mapped = driverMapped.filter((row) => row.childTable === edge.child && row.parentTable === edge.parent);
      const mappedHit = mapped.find((row) => row.childSchema === "public"
        && row.childColumns?.[0] === edge.column
        && row.parentColumns?.[0] === "id");
      let cause = "match";
      if (!mappedHit) cause = mapped.length ? "mapping" : "query";
      else if (actual.deleteAction !== expectedDelete[key]) cause = "action";
      else if (actual.validated !== true) cause = "unvalidated";
      findings.push({
        key,
        column: edge.column,
        cause,
        constraint: actual.name,
        action: actual.deleteAction,
        expectedAction: expectedDelete[key],
        validated: actual.validated,
      });
      continue;
    }
    const related = scalar.filter((row) => row.childTable === edge.child && row.parentTable === edge.parent);
    findings.push({
      key,
      column: edge.column,
      cause: related.length ? "naming" : "genuine-missing",
      constraints: related.map((row) => `${row.name}:${row.childColumns.join("+")}`),
    });
  }
  const present = new Set(findings.map((item) => item.cause));
  const cause = CAUSE_PRIORITY.find((item) => present.has(item)) ?? "match";
  return { findings, cause, verdict: VERDICT_FOR[cause] };
}

export function acceptanceShared(row) {
  if (!row?.markerUser || !row?.markerOrganisation) return true;
  return row.orgHotels > 0
    || row.userAccounts > 0
    || row.userOrganisations > 1
    || row.orgAcceptances > 1
    || row.userAcceptances > 1;
}

export function recommendFkRecovery({ verdict, approvalPresent, acceptances }) {
  const lines = [];
  const shared = (acceptances ?? []).some((row) => acceptanceShared(row));
  if (verdict === VERDICT_MAPPING) {
    lines.push("recommendation: the missing-foreign-key preflight result is a catalogue mapping discrepancy, not absent constraints");
    lines.push("recommendation: parse PostgreSQL name[] before spreading it; do not add or drop foreign keys from this result");
  } else if (verdict === VERDICT_MISSING) {
    lines.push("recommendation: at least one expected foreign key is absent from the scalar catalogue; do not run recovery");
  } else if (verdict !== VERDICT_MATCH) {
    lines.push(`recommendation: foreign-key comparison is ${verdict}; do not run recovery until the catalogue is reviewed`);
  }
  if (!approvalPresent) {
    lines.push("recommendation: fixture-not-legal is not in the approval catalogue");
  } else if ((acceptances ?? []).length !== 1) {
    lines.push(`recommendation: fixture-not-legal has ${acceptances?.length ?? 0} acceptances, not one; do not remove it`);
  } else if (shared) {
    lines.push("recommendation: do not delete the acceptance, organisation, or user; they are not an isolated marker fixture");
    lines.push("recommendation: existing recovery will not remove fixture-not-legal because it is outside the fixture version list");
    lines.push("recommendation: a later reviewed change may remove only that approval row, leaving the acceptance in place");
  } else {
    lines.push("recommendation: the acceptance is marker-scoped, but its delete trigger stays enabled; do not disable triggers");
    lines.push("recommendation: existing recovery still will not remove fixture-not-legal");
  }
  lines.push("recommendation: this diagnostic does not delete or modify rows");
  return lines;
}

function deleteLabel(action) {
  return DELETE_LABEL[action] ?? action ?? "unknown";
}

function mapAcceptance(row) {
  return {
    acceptanceId: String(row.acceptance_id ?? ""),
    organisationId: String(row.organisation_id ?? ""),
    userId: String(row.user_id ?? ""),
    userPresent: row.user_present === true,
    organisationPresent: row.organisation_present === true,
    markerUser: row.marker_user === true,
    markerOrganisation: row.marker_organisation === true,
    orgAcceptances: Number(row.org_acceptances ?? 0),
    orgMembers: Number(row.org_members ?? 0),
    orgHotels: Number(row.org_hotels ?? 0),
    userOrganisations: Number(row.user_organisations ?? 0),
    userAccounts: Number(row.user_accounts ?? 0),
    userMemberships: Number(row.user_memberships ?? 0),
    userAcceptances: Number(row.user_acceptances ?? 0),
  };
}

export async function runFkDiagnostic({ env, connect = client, say = () => {} }) {
  const lines = [];
  const log = (line) => lines.push(sayLine(say, line));
  const finish = (exitCode) => ({ exitCode, lines });
  const confirmation = String(env?.[CONFIRMATION_ENV] ?? "");
  const isolated = String(env?.[ISOLATED_OWNER_ENV] ?? "").trim();
  log(`confirmation: ${confirmation === DIAGNOSTIC_CONFIRMATION ? "ACCEPTED" : "INVALID"}`);
  log(`${ISOLATED_OWNER_ENV}: ${isolated ? "PRESENT" : "ABSENT"}`);
  log("writes: none");
  log("install_stage: not-invoked");
  log("recovery_stage: not-invoked");
  log("concurrency_stage: not-invoked");
  log("recovery_branch_target: refused");
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

  let db;
  try {
    db = await connect(isolated);
    if (typeof db.connect === "function") await db.connect();
  } catch (err) {
    log(`BLOCKED — CONNECT FAILED ${redact(err?.message || err).split("\n")[0].slice(0, 180)}`);
    return finish(1);
  }
  const rollback = async () => {
    try { await db.query("rollback"); } catch { /* no open read */ }
  };
  try {
    db = readOnlyClient(db);
    await db.query("begin read only");
    const identity = mapIdentity((await db.query(IDENTITY_SQL)).rows[0]);
    const hostname = new URL(directOwnerUrl(isolated)).hostname.toLowerCase();
    const failures = identityFailures(identity, hostname);
    if (identity.endpointId !== EXPECTED_ENDPOINT) failures.push("endpoint-pin");
    if (identity.branchId === RECOVERY_BRANCH) failures.push("recovery-branch");
    log(`neon_project: ${identity.projectId || "unproven"}`);
    log(`neon_branch: ${identity.branchId || "unproven"}`);
    log(`neon_endpoint: ${identity.endpointId || "unproven"}`);
    log(`database: ${identity.database || "unproven"}`);
    log(`role: ${identity.currentUser || "unproven"}`);
    if (failures.length || identity.projectId !== EXPECTED_PROJECT || identity.branchId !== EXPECTED_BRANCH || identity.database !== EXPECTED_DATABASE || identity.currentUser !== EXPECTED_ROLE || identity.sessionUser !== EXPECTED_ROLE) {
      await rollback();
      log(`BLOCKED — ISOLATED IDENTITY ${[...new Set(failures)].join(",") || "mismatch"}`);
      return finish(1);
    }
    log("isolated_identity: PASS");

    const parents = [...new Set(EXPECTED_EDGES.map((edge) => edge.parent))];
    const children = [...new Set(EXPECTED_EDGES.map((edge) => edge.child))];
    const driverRows = await cleanupForeignKeyDriverRows(db);
    const scalar = groupFkColumns((await db.query(COLUMN_SQL, [parents, children])).rows);
    const approvalRows = (await db.query(APPROVAL_SQL, [NOT_LEGAL])).rows;
    const acceptances = (await db.query(ACCEPTANCE_SQL, [NOT_LEGAL])).rows.map(mapAcceptance);
    await rollback();

    const mapped = mapCleanupCatalog(driverRows);
    const preflight = foreignKeyStatus(mapped);
    const classified = classifyFkDiscrepancy({ scalar, driverMapped: mapped });
    log(`driver_rows: ${driverRows.length}`);
    log(`scalar_constraints: ${scalar.length}`);
    log(`preflight_foreign_keys: ${preflight.ok ? "pass" : "fail"}`);
    for (const failure of preflight.failures) log(`preflight_foreign_key_failure: ${failure}`);
    for (const row of driverRows) {
      const shape = driverColumnShape(row.child_columns);
      const preview = String(row.child_columns ?? "").slice(0, 80);
      const mappedRow = mapped.find((item) => item.constraint === String(row.constraint_name ?? ""));
      log(`driver_foreign_key ${row.constraint_name} shape=${shape} value=${preview} mapped_column=${mappedRow?.childColumns?.[0] ?? "absent"}`);
    }
    for (const row of scalar) {
      const expected = EXPECTED_EDGES.some((edge) => edge.child === row.childTable && edge.parent === row.parentTable && edge.column === row.childColumns[0]);
      log(`${expected ? "expected" : "additional"}_foreign_key ${row.name} child=${row.childSchema}.${row.childTable}.${row.childColumns.join("+")} parent=${row.parentSchema}.${row.parentTable}.${row.parentColumns.join("+")} action=${deleteLabel(row.deleteAction)} validated=${row.validated}`);
    }
    for (const finding of classified.findings) {
      log(`comparison ${finding.key}.${finding.column} cause=${finding.cause} constraint=${finding.constraint ?? finding.constraints?.join(",") ?? "absent"} action=${finding.action ?? "absent"} expected_action=${finding.expectedAction ?? EXPECTED_DELETE[finding.key] ?? "absent"} validated=${finding.validated ?? "absent"}`);
    }
    log(`fk_cause: ${classified.cause}`);
    const approval = approvalRows[0];
    log(`fixture_not_legal_approval: ${approval ? "present" : "absent"}`);
    if (approval) log(`fixture_not_legal_effective: ${approval.effective === true}`);
    if (!acceptances.length) log("fixture_not_legal_acceptance: absent");
    for (const row of acceptances) {
      log(`fixture_not_legal_acceptance: id=${row.acceptanceId} organisation=${row.organisationId} user=${row.userId} marker_user=${row.markerUser} marker_organisation=${row.markerOrganisation} user_present=${row.userPresent} organisation_present=${row.organisationPresent}`);
      log(`fixture_not_legal_dependencies: acceptance=${row.acceptanceId} org_acceptances=${row.orgAcceptances} org_members=${row.orgMembers} org_hotels=${row.orgHotels} user_organisations=${row.userOrganisations} user_accounts=${row.userAccounts} user_memberships=${row.userMemberships} user_acceptances=${row.userAcceptances}`);
      log(`shared_with_non_fixture: ${acceptanceShared(row)}`);
    }
    for (const line of recommendFkRecovery({ verdict: classified.verdict, approvalPresent: Boolean(approval), acceptances })) log(line);
    log(classified.verdict);
    return finish(0);
  } catch (err) {
    await rollback();
    log(`BLOCKED — DIAGNOSTIC FAILED ${redact(err?.message || err).split("\n")[0].slice(0, 180)}`);
    return finish(1);
  } finally {
    try { await db.end?.(); } catch { /* closing must not hide the verdict */ }
  }
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runFkDiagnostic({ env: process.env, say: (line) => console.log(line) })
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((err) => {
      console.log(redact(err?.message || err).replace(/[a-z0-9.-]+\.neon\.tech/gi, "neon-host"));
      process.exitCode = 1;
    });
}
