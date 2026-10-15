import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateEnvironment, runProductionAdmission, TARGET } from "./a3-0035-0036-production-admission.STAGED.mjs";

test("isolated activation preparation rejects absent production approval before connection", async () => {
  assert.equal(TARGET.database, "neondb");
  assert.ok(validateEnvironment({}).length > 0);
  let connected = false;
  const result = await runProductionAdmission({
    env: {},
    connect: async () => { connected = true; throw Error("unexpected connection"); },
  });
  assert.equal(result.verdict, "BLOCKED");
  assert.equal(connected, false);
});

test("isolated preparation does not install an active production workflow", async () => {
  const entry = await readFile(new URL("./a3-0035-0036-production-admission-entry.STAGED.mjs", import.meta.url), "utf8");
  assert.ok(entry.includes("runProductionAdmission"));
  assert.ok(entry.includes("process.exitCode = 2"));
});
