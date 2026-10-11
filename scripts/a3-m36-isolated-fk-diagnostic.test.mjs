/**
 * A3-M36 foreign-key diagnostic. No database is opened.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getTypeParser } from "pg-types";
import { INSTALL_CONFIRMATION } from "./a3-m36-isolated-install.mjs";
import { CONCURRENCY_CONFIRMATION } from "./a3-m36-isolated-concurrency.mjs";
import { RECOVERY_CONFIRMATION } from "./a3-m36-isolated-recovery.mjs";
import { CONFIRMATION as ISOLATED_PREFLIGHT, EXPECTED_BRANCH, EXPECTED_DATABASE, EXPECTED_PROJECT, EXPECTED_ROLE, FORBIDDEN_ENDPOINT } from "./a3-m36-isolated-preflight.mjs";
import { EXPECTED_EDGES, mapCleanupCatalog } from "./a3-m36-isolated-cleanup.mjs";
import { EXPECTED_DELETE, PREFLIGHT_CONFIRMATION, foreignKeyStatus } from "./a3-m36-isolated-recovery-preflight.mjs";
import { DIAGNOSTIC_CONFIRMATION as CONSTRAINT_CONFIRMATION } from "./a3-m36-isolated-constraint-diagnostic.mjs";
import {
  DIAGNOSTIC_CONFIRMATION,
  RECOVERY_BRANCH,
  VERDICT_MAPPING,
  VERDICT_MATCH,
  VERDICT_MISSING,
  VERDICT_NAMING,
  VERDICT_QUERY,
  acceptanceShared,
  classifyFkDiscrepancy,
  groupFkColumns,
  recommendFkRecovery,
  runFkDiagnostic,
} from "./a3-m36-isolated-fk-diagnostic.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "scripts/a3-m36-isolated-fk-diagnostic.mjs"), "utf8");
const cleanup = readFileSync(join(root, "scripts/a3-m36-isolated-cleanup.mjs"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/a3-m36-isolated-fk-diagnostic.yml"), "utf8");
const ENDPOINT = "ep-damp-dust-b1rdfp34";
const OWNER_URL = `postgres://${EXPECTED_ROLE}:secret@${ENDPOINT}.eu-central-1.aws.neon.tech/${EXPECTED_DATABASE}`;

function scalarRows(columnFor = (edge) => edge.column) {
  return EXPECTED_EDGES.map((edge) => ({
    constraint_name: `${edge.child}_${edge.column}_fkey`,
    validated: true,
    child_schema: "public",
    child_table: edge.child,
    parent_schema: "public",
    parent_table: edge.parent,
    delete_action: EXPECTED_DELETE[`${edge.child}→${edge.parent}`],
    child_column: columnFor(edge),
    parent_column: "id",
  }));
}

function driverRows(columns) {
  return EXPECTED_EDGES.map((edge) => ({
    child_schema: "public",
    child_table: edge.child,
    parent_table: edge.parent,
    constraint_name: `${edge.child}_${edge.column}_fkey`,
    delete_action: EXPECTED_DELETE[`${edge.child}→${edge.parent}`],
    child_columns: columns(edge),
    parent_columns: Array.isArray(columns(edge)) ? ["id"] : "{id}",
  }));
}

function grouped(rows) {
  return groupFkColumns(rows);
}

function fakeDb(state = {}) {
  const queries = [];
  return {
    queries,
    ended: false,
    async query(text) {
      const sql = String(text);
      queries.push(sql);
      if (/\b(insert into|update |delete from|alter table|commit|truncate)\b/i.test(sql)) throw new Error(`write ${sql.slice(0, 40)}`);
      if (sql === "begin read only" || sql === "rollback") return { rows: [] };
      if (sql.includes("neon.project_id")) {
        return { rows: [{
          database: EXPECTED_DATABASE,
          current_user: EXPECTED_ROLE,
          session_user: EXPECTED_ROLE,
          project_id: EXPECTED_PROJECT,
          branch_id: state.branchId ?? EXPECTED_BRANCH,
          endpoint_id: ENDPOINT,
        }] };
      }
      if (sql.includes("a3m36-foreign-keys")) return { rows: state.driver ?? driverRows((edge) => `{${edge.column}}`) };
      if (sql.includes("a3m36-fk-columns")) return { rows: state.scalar ?? scalarRows() };
      if (sql.includes("a3m36-not-legal-approval")) return { rows: state.approval ?? [{ agreement_version: "fixture-not-legal", effective: false }] };
      if (sql.includes("a3m36-not-legal-acceptances")) {
        return { rows: state.acceptances ?? [{
          acceptance_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          organisation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          user_id: "user-real-1",
          user_present: true,
          organisation_present: true,
          marker_user: false,
          marker_organisation: false,
          org_acceptances: 1,
          org_members: 1,
          org_hotels: 2,
          user_organisations: 1,
          user_accounts: 1,
          user_memberships: 1,
          user_acceptances: 1,
        }] };
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 160)}`);
    },
    async end() {
      this.ended = true;
    },
  };
}

function env(overrides = {}) {
  return {
    A3M36_FK_CONFIRMATION: DIAGNOSTIC_CONFIRMATION,
    AETHER_0036_ISOLATED_OWNER_URL: OWNER_URL,
    ...overrides,
  };
}

test("the foreign-key diagnostic is manual, read-only, and does not recover", () => {
  assert.notEqual(DIAGNOSTIC_CONFIRMATION, RECOVERY_CONFIRMATION);
  assert.notEqual(DIAGNOSTIC_CONFIRMATION, PREFLIGHT_CONFIRMATION);
  assert.notEqual(DIAGNOSTIC_CONFIRMATION, CONCURRENCY_CONFIRMATION);
  assert.notEqual(DIAGNOSTIC_CONFIRMATION, INSTALL_CONFIRMATION);
  assert.notEqual(DIAGNOSTIC_CONFIRMATION, ISOLATED_PREFLIGHT);
  assert.notEqual(DIAGNOSTIC_CONFIRMATION, CONSTRAINT_CONFIRMATION);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /DIAGNOSE-0036-FOREIGN-KEYS/);
  assert.match(workflow, /node scripts\/a3-m36-isolated-fk-diagnostic\.mjs/);
  assert.doesNotMatch(workflow, /DATABASE_URL|AETHER_DATABASE_OWNER_URL|NEON_API_KEY|0026|br-proud-field/);
  assert.match(src, /begin read only/);
  assert.match(src, new RegExp(RECOVERY_BRANCH));
  assert.doesNotMatch(src, /cleanupFixtures\(|runRecovery\(|runRecoveryPreflight\(|runConcurrency\(|runInstall\(/);
  assert.doesNotMatch(src, /\b(insert into|update |delete from|alter table|truncate )\b/i);
  assert.doesNotMatch(src, /as email\b|u\.email,|o\.name,/);
  assert.match(cleanup, /childColumns: \[\.\.\.\(row\.child_columns/);
});

test("node-pg leaves name[] unparsed and the cleanup mapper spreads that literal", () => {
  assert.equal(getTypeParser(1003)("{organisation_id}"), "{organisation_id}");
  assert.deepEqual(getTypeParser(1009)("{organisation_id}"), ["organisation_id"]);
  const mapped = mapCleanupCatalog([{
    child_schema: "public",
    child_table: "hotels",
    parent_table: "sbg_organisations",
    constraint_name: "hotels_organisation_id_fkey",
    delete_action: "r",
    child_columns: "{organisation_id}",
    parent_columns: "{id}",
  }]);
  assert.equal(mapped[0].childColumns[0], "{");
  assert.equal(mapped[0].parentColumns[0], "{");
  assert.equal(foreignKeyStatus(mapped).ok, false);
  assert.match(foreignKeyStatus(mapped).failures.join("\n"), /missing hotels→sbg_organisations\.organisation_id/);
  const parsed = mapCleanupCatalog([{
    child_schema: "public",
    child_table: "hotels",
    parent_table: "sbg_organisations",
    constraint_name: "hotels_organisation_id_fkey",
    delete_action: "r",
    child_columns: ["organisation_id"],
    parent_columns: ["id"],
  }]);
  assert.equal(parsed[0].childColumns[0], "organisation_id");
});

test("a name[] literal classifies as mapping when the scalar columns match", () => {
  const scalar = groupFkColumns(scalarRows());
  const mapped = mapCleanupCatalog(driverRows((edge) => `{${edge.column}}`));
  const result = classifyFkDiscrepancy({ scalar, driverMapped: mapped });
  assert.equal(result.verdict, VERDICT_MAPPING);
  assert.equal(result.findings.length, EXPECTED_EDGES.length);
  assert.equal(result.findings.every((item) => item.cause === "mapping"), true);
  assert.equal(foreignKeyStatus(mapped).failures.length, EXPECTED_EDGES.length);
  const arrays = mapCleanupCatalog(driverRows((edge) => [edge.column]));
  assert.equal(foreignKeyStatus(arrays).ok, true);
  assert.equal(classifyFkDiscrepancy({ scalar, driverMapped: arrays }).verdict, VERDICT_MATCH);
});

test("an empty or renamed catalogue is not called a mapping error", () => {
  const missing = classifyFkDiscrepancy({ scalar: [], driverMapped: [] });
  assert.equal(missing.verdict, VERDICT_MISSING);
  const renamed = classifyFkDiscrepancy({
    edges: [EXPECTED_EDGES.find((edge) => edge.child === "hotels")],
    scalar: grouped(scalarRows(() => "org_id")).filter((row) => row.childTable === "hotels"),
    driverMapped: [],
  });
  assert.equal(renamed.verdict, VERDICT_NAMING);
  const dropped = classifyFkDiscrepancy({
    scalar: grouped(scalarRows()),
    driverMapped: [],
  });
  assert.equal(dropped.verdict, VERDICT_QUERY);
});

test("a non-marker acceptance is shared and is not a deletion target", () => {
  const row = {
    markerUser: false,
    markerOrganisation: false,
    orgHotels: 2,
    userAccounts: 1,
    userOrganisations: 1,
    orgAcceptances: 1,
    userAcceptances: 1,
  };
  assert.equal(acceptanceShared(row), true);
  const lines = recommendFkRecovery({
    verdict: VERDICT_MAPPING,
    approvalPresent: true,
    acceptances: [row],
  });
  assert.match(lines.join("\n"), /catalogue mapping discrepancy/);
  assert.match(lines.join("\n"), /do not delete the acceptance, organisation, or user/);
  assert.doesNotMatch(lines.join("\n"), /delete from/i);
});

test("a rejected confirmation, production host, or recovery branch does not query the catalogue", async () => {
  let connects = 0;
  const connect = () => {
    connects += 1;
    throw new Error("connect");
  };
  const phrase = await runFkDiagnostic({ env: env({ A3M36_FK_CONFIRMATION: RECOVERY_CONFIRMATION }), connect });
  assert.match(phrase.lines.join("\n"), /CONFIRMATION PHRASE INVALID/);
  const host = await runFkDiagnostic({
    env: env({ AETHER_0036_ISOLATED_OWNER_URL: `postgres://${EXPECTED_ROLE}:secret@${FORBIDDEN_ENDPOINT}.eu.neon.tech/neondb` }),
    connect,
  });
  assert.match(host.lines.join("\n"), /production-endpoint/);
  const fallback = await runFkDiagnostic({ env: env({ DATABASE_URL: OWNER_URL }), connect });
  assert.match(fallback.lines.join("\n"), /DATABASE_URL must not be set/);
  assert.equal(connects, 0);
  const db = fakeDb({ branchId: RECOVERY_BRANCH });
  const recovery = await runFkDiagnostic({ env: env(), connect: async () => db });
  assert.match(recovery.lines.join("\n"), /recovery-branch/);
  assert.equal(db.queries.some((sql) => sql.includes("a3m36-fk-columns")), false);
});

test("the live-shaped name[] catalogue reports mapping and the fixture dependency", async () => {
  const extra = {
    constraint_name: "sbg_organisation_billing_organisation_id_fkey",
    validated: true,
    child_schema: "public",
    child_table: "sbg_organisation_billing",
    parent_schema: "public",
    parent_table: "sbg_organisations",
    delete_action: "r",
    child_column: "organisation_id",
    parent_column: "id",
  };
  const db = fakeDb({
    scalar: [...scalarRows(), extra],
    driver: [...driverRows((edge) => `{${edge.column}}`), {
      child_schema: "public",
      child_table: "sbg_organisation_billing",
      parent_table: "sbg_organisations",
      constraint_name: extra.constraint_name,
      delete_action: "r",
      child_columns: "{organisation_id}",
      parent_columns: "{id}",
    }],
  });
  const result = await runFkDiagnostic({ env: env(), connect: async () => db });
  const text = result.lines.join("\n");
  assert.equal(result.exitCode, 0, text);
  assert.match(text, /isolated_identity: PASS/);
  assert.match(text, /preflight_foreign_keys: fail/);
  assert.match(text, /preflight_foreign_key_failure: missing hotels→sbg_organisations\.organisation_id/);
  assert.match(text, /driver_foreign_key hotels_organisation_id_fkey shape=string value=\{organisation_id\} mapped_column=\{/);
  assert.match(text, /expected_foreign_key hotels_organisation_id_fkey child=public\.hotels\.organisation_id parent=public\.sbg_organisations\.id action=restrict validated=true/);
  assert.match(text, /additional_foreign_key sbg_organisation_billing_organisation_id_fkey/);
  assert.match(text, /comparison hotels→sbg_organisations\.organisation_id cause=mapping/);
  assert.match(text, /fk_cause: mapping/);
  assert.match(text, /fixture_not_legal_approval: present/);
  assert.match(text, /fixture_not_legal_effective: false/);
  assert.match(text, /fixture_not_legal_acceptance: id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa organisation=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb user=user-real-1 marker_user=false marker_organisation=false/);
  assert.match(text, /org_hotels=2/);
  assert.match(text, /user_accounts=1/);
  assert.match(text, /shared_with_non_fixture: true/);
  assert.match(text, /do not delete the acceptance, organisation, or user/);
  assert.match(text, new RegExp(VERDICT_MAPPING));
  assert.doesNotMatch(text, /@|secret|A3M36 /);
  assert.equal(db.queries.some((sql) => /\b(insert into|update |delete from|commit)\b/i.test(sql)), false);
  assert.equal(db.ended, true);
});
