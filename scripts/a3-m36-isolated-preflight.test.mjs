/**
 * A3-M36 isolated preflight source checks. No database is opened.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  CONFIRMATION,
  ENABLED_STAGE,
  EXPECTED_BRANCH,
  EXPECTED_DATABASE,
  EXPECTED_PROJECT,
  EXPECTED_ROLE,
  FORBIDDEN_BRANCH,
  FORBIDDEN_ENDPOINT,
  ISOLATED_OWNER_ENV,
  directOwnerUrl,
  hostSafetyFailures,
  identityFailures,
  runPreflight,
} from "./a3-m36-isolated-preflight.mjs";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(root, "scripts/a3-m36-isolated-preflight.mjs");
const workflowPath = join(root, ".github/workflows/a3-m36-isolated-verification.yml");
const src = readFileSync(scriptPath, "utf8");
const workflow = readFileSync(workflowPath, "utf8");

const ENDPOINT = "ep-dawn-isolated-example";
const HOST = `${ENDPOINT}.eu-central-1.aws.neon.tech`;
const OWNER_URL = `postgres://${EXPECTED_ROLE}:secret@${HOST}/${EXPECTED_DATABASE}?sslmode=require`;

function env(overrides = {}) {
  return {
    A3M36_CONFIRMATION: CONFIRMATION,
    A3M36_STAGE: ENABLED_STAGE,
    [ISOLATED_OWNER_ENV]: OWNER_URL,
    ...overrides,
  };
}

function db(rowsFor) {
  const queries = [];
  return {
    queries,
    async query(text) {
      queries.push(String(text));
      return { rows: rowsFor(String(text)) };
    },
    async end() {
      this.ended = true;
    },
  };
}

function readyRows(text) {
  if (text.includes("neon.project_id")) {
    return [{
      database: EXPECTED_DATABASE,
      current_user: EXPECTED_ROLE,
      session_user: EXPECTED_ROLE,
      project_id: EXPECTED_PROJECT,
      branch_id: EXPECTED_BRANCH,
      endpoint_id: ENDPOINT,
    }];
  }
  if (text.includes("sbg_approved_property_agreement_versions_not_provisional")) {
    return [{
      ledger: true,
      organisations: true,
      hotels: true,
      approval_table: true,
      property_function: true,
      terms_v1_rejected: true,
      creator_index: false,
      effective_column: false,
      effective_index: false,
    }];
  }
  if (text.includes("from pg_proc")) {
    return [
      { proname: "sbg_create_organisation_for_user", rejects_second: false, requires_effective: false },
      { proname: "sbg_create_founding_property_for_user", rejects_second: false, requires_effective: false },
      { proname: "sbg_ensure_founding_organisation", rejects_second: false, requires_effective: false },
    ];
  }
  if (text.includes("from public._migrations")) {
    return [{ name: "0034_cp3005e2d2c_founding_classification_acceptance.sql" }, { name: "0035_cp3005e2d2d_founding_property.sql" }];
  }
  if (text.includes("having count(*) > 1")) return [];
  if (text.includes("attached_hotels")) return [{ organisations: 2, hotels: 4, attached_hotels: 3 }];
  if (text.includes("has_function_privilege")) {
    return [{
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
    }];
  }
  return [];
}

test("source stays read-only and does not use a production or API fallback", () => {
  assert.equal(ENABLED_STAGE, "preflight");
  assert.equal(EXPECTED_PROJECT, "quiet-sound-53513710");
  assert.equal(EXPECTED_BRANCH, "br-dawn-hat-b1b4uqhn");
  assert.equal(FORBIDDEN_BRANCH, "br-green-darkness-b1k7wkue");
  assert.equal(FORBIDDEN_ENDPOINT, "ep-withered-haze-b1fd9hse");
  assert.match(src, /current_setting\('neon\.project_id'/);
  assert.match(src, /current_setting\('neon\.branch_id'/);
  assert.match(src, /current_setting\('neon\.endpoint_id'/);
  assert.match(src, /begin read only/);
  assert.match(src, /set default_transaction_read_only = on/);
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /process\.env\.AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(src, /process\.env\.NEON_API_KEY/);
  assert.doesNotMatch(src, /console\.neon\.tech|NEON_API_KEY\s*=/);
  assert.doesNotMatch(src, /\b(insert into|update\s+|delete from|alter table|create table|drop table|commit)\b/i);
  assert.doesNotMatch(src, /migrations\/0036_/);
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /AETHER_0036_ISOLATED_OWNER_URL/);
  assert.match(workflow, /PREFLIGHT-0036-ISOLATED/);
  assert.match(workflow, /node scripts\/a3-m36-isolated-preflight\.mjs/);
  assert.doesNotMatch(workflow, /DATABASE_URL|AETHER_DATABASE_OWNER_URL|NEON_API_KEY/);
  assert.doesNotMatch(workflow, /echo "\$AETHER_0036_ISOLATED_OWNER_URL"|set -x/);
  assert.match(workflow, /secrets\.AETHER_0036_ISOLATED_OWNER_URL/);
  assert.equal(workflow.includes("0026"), false);
});

test("a missing secret, a rejected stage, and a production host do not connect", async () => {
  let connects = 0;
  const connect = async () => {
    connects += 1;
    throw new Error("connect should not be called");
  };
  const missing = await runPreflight({ env: env({ [ISOLATED_OWNER_ENV]: "" }), connect });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.lines.join("\n"), /No database was opened/);
  const stage = await runPreflight({ env: env({ A3M36_STAGE: "install-0036" }), connect });
  assert.equal(stage.exitCode, 1);
  assert.match(stage.lines.join("\n"), /STAGE NOT ENABLED/);
  const phrase = await runPreflight({ env: env({ A3M36_CONFIRMATION: "APPLY-0036" }), connect });
  assert.equal(phrase.exitCode, 1);
  assert.match(phrase.lines.join("\n"), /CONFIRMATION PHRASE INVALID/);
  const production = `postgres://${EXPECTED_ROLE}:secret@${FORBIDDEN_ENDPOINT}.eu-central-1.aws.neon.tech/${EXPECTED_DATABASE}`;
  const blocked = await runPreflight({ env: env({ [ISOLATED_OWNER_ENV]: production }), connect });
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.lines.join("\n"), /production-endpoint/);
  assert.doesNotMatch(blocked.lines.join("\n"), /secret/);
  const fallback = await runPreflight({ env: env({ DATABASE_URL: production }), connect });
  assert.equal(fallback.exitCode, 1);
  assert.match(fallback.lines.join("\n"), /DATABASE_URL must not be set/);
  assert.equal(connects, 0);
});

test("direct connection is required and identity must match Neon metadata", async () => {
  assert.equal(hostSafetyFailures("not a url")[0], "url");
  assert.equal(directOwnerUrl(`postgres://${EXPECTED_ROLE}@ep-a-pooler.eu.neon.tech/neondb`).includes("-pooler."), false);
  const seen = [];
  const fake = db((text) => {
    if (text.includes("neon.project_id")) {
      return [{
        database: EXPECTED_DATABASE,
        current_user: EXPECTED_ROLE,
        session_user: EXPECTED_ROLE,
        project_id: EXPECTED_PROJECT,
        branch_id: FORBIDDEN_BRANCH,
        endpoint_id: ENDPOINT,
      }];
    }
    return readyRows(text);
  });
  const result = await runPreflight({
    env: env({ [ISOLATED_OWNER_ENV]: `postgres://${EXPECTED_ROLE}:secret@${ENDPOINT}-pooler.eu-central-1.aws.neon.tech/${EXPECTED_DATABASE}` }),
    connect: async (value) => {
      seen.push(value);
      return fake;
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join("\n"), /ISOLATED IDENTITY/);
  assert.match(result.lines.join("\n"), /production-branch/);
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0]).hostname, HOST);
  assert.equal(fake.queries.some((text) => text.includes("having count")), false);
  assert.doesNotMatch(result.lines.join("\n"), /secret/);
  assert.deepEqual(identityFailures({
    projectId: "",
    branchId: EXPECTED_BRANCH,
    endpointId: ENDPOINT,
    database: EXPECTED_DATABASE,
    currentUser: EXPECTED_ROLE,
    sessionUser: EXPECTED_ROLE,
  }, HOST), ["project-unproven"]);
});

test("a proven isolated branch is reported without a write", async () => {
  const fake = db(readyRows);
  const result = await runPreflight({ env: env(), connect: async () => fake });
  assert.equal(result.exitCode, 0);
  const text = result.lines.join("\n");
  assert.match(text, /isolated_identity: PASS/);
  assert.match(text, new RegExp(`neon_project: ${EXPECTED_PROJECT}`));
  assert.match(text, new RegExp(`neon_branch: ${EXPECTED_BRANCH}`));
  assert.match(text, new RegExp(`neon_endpoint: ${ENDPOINT}`));
  assert.match(text, /database: neondb/);
  assert.match(text, /role: neondb_owner/);
  assert.match(text, /0035_objects: present/);
  assert.match(text, /0036_objects: absent/);
  assert.match(text, /ledger_0035: present/);
  assert.match(text, /ledger_0036: absent/);
  assert.match(text, /duplicate_creators: 0/);
  assert.match(text, /privileges_match_0036: not-applicable/);
  assert.match(text, /privilege_runtime_property_execute: false/);
  assert.match(text, /writes: none/);
  assert.match(text, /verdict: PREFLIGHT REPORTED/);
  assert.match(text, /install_stage: NOT ENABLED/);
  assert.equal(fake.queries[0], "set default_transaction_read_only = on");
  assert.equal(fake.queries[1], "begin read only");
  assert.equal(fake.queries.at(-1), "rollback");
  assert.equal(fake.queries.every((sql) => /^(set|begin|rollback|select)\b/i.test(sql.trim())), true);
  assert.equal(fake.ended, true);
});

test("an endpoint that disagrees with the session is not accepted", async () => {
  const fake = db((text) => {
    if (text.includes("neon.project_id")) {
      return [{
        database: EXPECTED_DATABASE,
        current_user: EXPECTED_ROLE,
        session_user: EXPECTED_ROLE,
        project_id: EXPECTED_PROJECT,
        branch_id: EXPECTED_BRANCH,
        endpoint_id: "ep-other-compute",
      }];
    }
    return [];
  });
  const result = await runPreflight({ env: env(), connect: async () => fake });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join("\n"), /endpoint-host-mismatch/);
  assert.equal(fake.queries.some((text) => text.includes("having count")), false);
});

test("the command fails closed when the secret is absent and prints no credential", async () => {
  const ran = await execFileAsync("node", [scriptPath], {
    env: {
      PATH: process.env.PATH,
      A3M36_CONFIRMATION: CONFIRMATION,
      A3M36_STAGE: ENABLED_STAGE,
    },
  }).catch((err) => err);
  const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  assert.notEqual(ran.code ?? ran.exitCode, 0);
  assert.match(output, /ABSENT/);
  assert.match(output, /No database was opened/);
  assert.doesNotMatch(output, /postgres:\/\//);
});
