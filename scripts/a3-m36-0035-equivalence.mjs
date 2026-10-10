/**
 * Deterministic 0035 equivalence for the isolated branch.
 *
 * scripts/migrate.mjs and src/lib/db.ts both insert public._migrations in the
 * same transaction as the SQL file. PostgreSQL rolls the objects back with
 * that insert. Neither applier can commit 0035's objects while omitting
 * 0035_cp3005e2d2d_founding_property.sql. No controller in this repository
 * applies 0035. The read-only preflight does not write. Objects without a
 * ledger row were therefore executed outside those appliers.
 *
 * Presence is not equivalence. Callers compare pg_proc.prosrc, comments,
 * constraints, and privileges with the reviewed 0035 and 0033 files. A miss
 * blocks 0036. This module does not connect, does not insert a ledger row,
 * and does not replay 0035.
 */
import { createHash } from "node:crypto";
import { ACCEPTED_LEDGER } from "./production-db-preflight.mjs";

export const MIGRATION_33 = "0033_cp3005e2d2b_founding_organisation.sql";
export const MIGRATION_35 = "0035_cp3005e2d2d_founding_property.sql";
export const MIGRATION_36 = "0036_cp3005e2d2d_founding_integrity.sql";
export const DIGEST_33 = "8880dbf93aa416e393af621957e3170da6390a6e3aef792d68fe97b709c22875";
export const DIGEST_35 = "80d1d3ec68eebfba0bcfbe07ac3c3dd1ade11d7d0466be9264cf0f28d27def67";
export const DIGEST_36 = "fb300bb17c8e9758700cf2fd09aa355b0293b5cd84c692e2913835876ece18fc";
export const EXPECTED_ENDPOINT = "ep-damp-dust-b1rdfp34";

const CREATE = "sbg_create_organisation_for_user";
const PROPERTY = "sbg_create_founding_property_for_user";
const ENSURE = "sbg_ensure_founding_organisation";

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function dollarBody(sql, tag) {
  const marker = `$${tag}$`;
  const start = String(sql ?? "").indexOf(marker);
  if (start < 0) return "";
  const from = start + marker.length;
  const end = String(sql).indexOf(marker, from);
  if (end < 0) return "";
  return String(sql).slice(from, end);
}

export function quotedComment(sql, needle) {
  const at = String(sql ?? "").toLowerCase().indexOf(String(needle).toLowerCase());
  if (at < 0) return "";
  const tail = String(sql).slice(at + needle.length);
  const match = tail.match(/^\s+'((?:''|[^'])*)'/);
  return match ? match[1].replace(/''/g, "'") : "";
}

export function normSpace(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function normPath(value) {
  return normSpace(String(value ?? "").replace(/\s*,\s*/g, ", "));
}

export function expectedFromSources(sql35, sql33) {
  return {
    digest35: sha256(String(sql35 ?? "")),
    digest33: sha256(String(sql33 ?? "")),
    createBody: dollarBody(sql35, "m35lock"),
    propertyBody: dollarBody(sql35, "m35"),
    ensureBody: dollarBody(sql33, "e2d2b"),
    createComment: quotedComment(sql35, "comment on function sbg_create_organisation_for_user(text, text) is"),
    propertyComment: quotedComment(sql35, "comment on function sbg_create_founding_property_for_user(text, text, text, text, text, text) is"),
    ensureComment: quotedComment(sql33, "comment on function sbg_ensure_founding_organisation(text, text) is"),
    tableComment: quotedComment(sql35, "comment on table sbg_approved_property_agreement_versions is"),
  };
}

function signatureFailure(fn, expected) {
  if (!fn) return true;
  return normSpace(fn.args) !== expected.args
    || normSpace(fn.result) !== expected.result
    || String(fn.language ?? "") !== "plpgsql"
    || fn.securityDefiner !== true
    || normPath(fn.searchPath) !== expected.searchPath
    || String(fn.prosrc ?? "") !== expected.prosrc
    || String(fn.comment ?? "") !== expected.comment;
}

const PRIVILEGE_EXPECTATION = {
  app_property: true,
  runtime_property: false,
  public_property: false,
  app_creator: true,
  runtime_creator: false,
  app_ensure: true,
  runtime_ensure: false,
  app_select: false,
  app_insert: false,
  app_update: false,
  app_delete: false,
};

export function assess0035Equivalence(sql35, sql33, catalog) {
  const expected = expectedFromSources(sql35, sql33);
  const failures = [];
  if (expected.digest35 !== DIGEST_35) failures.push("digest-0035");
  if (expected.digest33 !== DIGEST_33) failures.push("digest-0033");
  if (!expected.createBody || !expected.propertyBody || !expected.ensureBody) failures.push("source-body");
  const functions = catalog?.functions ?? {};
  const create = functions[CREATE];
  const property = functions[PROPERTY];
  const ensure = functions[ENSURE];
  if (signatureFailure(create, {
    args: "p_user_id text, p_name text",
    result: "uuid",
    searchPath: "public, pg_temp",
    prosrc: expected.createBody,
    comment: expected.createComment,
  })) failures.push("function-create");
  if (signatureFailure(property, {
    args: "p_user_id text, p_code text, p_name text, p_locality text, p_iana_timezone text, p_currency text",
    result: "TABLE(hotel_id uuid, provider_id uuid)",
    searchPath: "pg_catalog, public",
    prosrc: expected.propertyBody,
    comment: expected.propertyComment,
  })) failures.push("function-property");
  if (signatureFailure(ensure, {
    args: "p_user_id text, p_name text",
    result: "TABLE(organisation_id uuid, name text, organisation_type text)",
    searchPath: "pg_catalog, public",
    prosrc: expected.ensureBody,
    comment: expected.ensureComment,
  })) failures.push("function-ensure");
  if (String(ensure?.prosrc ?? "").includes("sbg_organisations_one_founding_creator_uidx")) {
    failures.push("ensure-already-0036");
  }
  const columns = Array.isArray(catalog?.columns) ? catalog.columns : [];
  if (columns.length !== 1 || columns[0]?.name !== "agreement_version" || columns[0]?.dataType !== "text" || columns[0]?.nullable !== false) {
    failures.push("columns");
  }
  const constraints = Array.isArray(catalog?.constraints) ? catalog.constraints : [];
  const byName = new Map(constraints.map((row) => [String(row.name), String(row.def ?? "")]));
  if (constraints.length !== 3) failures.push("constraint-count");
  if (!String(byName.get("sbg_approved_property_agreement_versions_pkey") ?? "").includes("PRIMARY KEY")
    || !String(byName.get("sbg_approved_property_agreement_versions_pkey") ?? "").includes("agreement_version")) {
    failures.push("constraint-primary-key");
  }
  if (!String(byName.get("sbg_approved_property_agreement_versions_token") ?? "").includes("^[a-z0-9][a-z0-9._/-]{0,120}$")) {
    failures.push("constraint-token");
  }
  if (!String(byName.get("sbg_approved_property_agreement_versions_not_provisional") ?? "").includes("terms-v1")) {
    failures.push("constraint-provisional");
  }
  if (String(catalog?.tableComment ?? "") !== expected.tableComment || !expected.tableComment) failures.push("comment-table");
  const privileges = catalog?.privileges ?? {};
  if (Object.entries(PRIVILEGE_EXPECTATION).some(([key, value]) => privileges[key] !== value)) failures.push("privilege");
  if (catalog?.creatorIndex !== false) failures.push("creator-index");
  if (catalog?.effectiveColumn !== false) failures.push("effective-column");
  if (catalog?.effectiveIndex !== false) failures.push("effective-index");
  return { ok: failures.length === 0, failures, expected };
}

export function presenceLevel(parts) {
  const flags = parts.map((part) => part === true);
  if (flags.every(Boolean)) return "present";
  if (flags.some(Boolean)) return "partial";
  return "absent";
}

export function ledgerDisposition(names) {
  const ledger = [...(names ?? [])].map(String);
  const unique = new Set(ledger);
  const base = { insert0035: false, insert0036: false, has35: unique.has(MIGRATION_35), has36: unique.has(MIGRATION_36) };
  if (unique.size !== ledger.length) return { ...base, ok: false, reason: "duplicate-ledger-names" };
  const allowed = new Set([...ACCEPTED_LEDGER, MIGRATION_35, MIGRATION_36]);
  if ([...unique].some((name) => !allowed.has(name))) return { ...base, ok: false, reason: "unexpected-ledger" };
  if (ACCEPTED_LEDGER.some((name) => !unique.has(name))) return { ...base, ok: false, reason: "missing-accepted-ledger" };
  if (base.has36) return { ...base, ok: false, reason: "0036-already-ledgered" };
  return {
    ...base,
    ok: true,
    reason: base.has35 ? "0035-ledgered" : "0035-unledgered",
    insert0036: true,
    genericMigratorSafe: base.has35,
  };
}

export function installDecision({ equivalenceOk, ledger, duplicateCreators, schema36, functions36 }) {
  const schema = schema36 ?? "absent";
  const functions = functions36 ?? "absent";
  if (schema === "partial" || functions === "partial" || (schema === "present") !== (functions === "present")) {
    return { action: "block", verdict: "BLOCKED — 0036 PARTIAL", insert0035: false };
  }
  if (schema === "present" && functions === "present") {
    if (ledger?.has36) return { action: "noop", verdict: "0036 ALREADY APPLIED — NO MUTATION", insert0035: false };
    return { action: "block", verdict: "BLOCKED — 0036 OBJECTS WITHOUT LEDGER", insert0035: false };
  }
  if (Number(duplicateCreators) > 0) return { action: "block", verdict: "BLOCKED — DUPLICATE FOUNDING CREATORS", insert0035: false };
  if (!ledger?.ok) return { action: "block", verdict: `BLOCKED — LEDGER ${ledger?.reason ?? "unproven"}`, insert0035: false };
  if (!equivalenceOk) return { action: "block", verdict: "BLOCKED — 0035 EQUIVALENCE FAILED", insert0035: false };
  return { action: "apply", verdict: "0036 INSTALL AUTHORISED", insert0035: false, genericMigratorSafe: ledger.genericMigratorSafe === true };
}
