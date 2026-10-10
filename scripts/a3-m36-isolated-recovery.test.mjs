/**
 * A3-M36 isolated recovery. No database is opened.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { INSTALL_CONFIRMATION } from "./a3-m36-isolated-install.mjs";
import { CONCURRENCY_CONFIRMATION } from "./a3-m36-isolated-concurrency.mjs";
import { EXPECTED_DATABASE, EXPECTED_ROLE, FORBIDDEN_ENDPOINT } from "./a3-m36-isolated-preflight.mjs";
import { RECOVERY_CLEAN, RECOVERY_CONFIRMATION, runRecovery } from "./a3-m36-isolated-recovery.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "scripts/a3-m36-isolated-recovery.mjs"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/a3-m36-isolated-recovery.yml"), "utf8");
const ENDPOINT = "ep-damp-dust-b1rdfp34";
const OWNER_URL = `postgres://${EXPECTED_ROLE}:secret@${ENDPOINT}.eu-central-1.aws.neon.tech/${EXPECTED_DATABASE}`;

test("recovery is a distinct manual stage and does not disable safeguards", () => {
  assert.notEqual(RECOVERY_CONFIRMATION, INSTALL_CONFIRMATION);
  assert.notEqual(RECOVERY_CONFIRMATION, CONCURRENCY_CONFIRMATION);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /RECOVER-0036-ISOLATED/);
  assert.match(workflow, /node scripts\/a3-m36-isolated-recovery\.mjs/);
  assert.doesNotMatch(workflow, /DATABASE_URL|AETHER_DATABASE_OWNER_URL|NEON_API_KEY|0026/);
  assert.doesNotMatch(src, /disable trigger/i);
  assert.doesNotMatch(src, /enable trigger/i);
  assert.doesNotMatch(src, /alter table/i);
  assert.doesNotMatch(src, /runInstall\(/);
  assert.doesNotMatch(src, /runConcurrency\(/);
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.match(src, /discover: true/);
  assert.match(src, /data_preserved/);
});

test("a rejected confirmation or a production host does not connect", async () => {
  let connects = 0;
  const connect = () => {
    connects += 1;
    throw new Error("connect");
  };
  const phrase = await runRecovery({
    env: { A3M36_RECOVERY_CONFIRMATION: CONCURRENCY_CONFIRMATION, AETHER_0036_ISOLATED_OWNER_URL: OWNER_URL },
    connect,
  });
  assert.equal(phrase.exitCode, 1);
  assert.match(phrase.lines.join("\n"), /CONFIRMATION PHRASE INVALID/);
  const host = await runRecovery({
    env: {
      A3M36_RECOVERY_CONFIRMATION: RECOVERY_CONFIRMATION,
      AETHER_0036_ISOLATED_OWNER_URL: `postgres://${EXPECTED_ROLE}:secret@${FORBIDDEN_ENDPOINT}.eu.neon.tech/neondb`,
    },
    connect,
  });
  assert.match(host.lines.join("\n"), /production-endpoint/);
  const fallback = await runRecovery({
    env: { A3M36_RECOVERY_CONFIRMATION: RECOVERY_CONFIRMATION, AETHER_0036_ISOLATED_OWNER_URL: OWNER_URL, DATABASE_URL: OWNER_URL },
    connect,
  });
  assert.match(fallback.lines.join("\n"), /DATABASE_URL must not be set/);
  assert.equal(connects, 0);
  assert.equal(RECOVERY_CLEAN.startsWith("RECOVERY CLEAN"), true);
  assert.doesNotMatch(`${phrase.lines.join("\n")}\n${host.lines.join("\n")}`, /secret/);
});
