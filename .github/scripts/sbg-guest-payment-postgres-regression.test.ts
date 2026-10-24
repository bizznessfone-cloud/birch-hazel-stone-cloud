import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CREATE_EXPIRE_EXECUTION_GATE } from "./stripe-test-create-expire.ts";

test("guest-payment regression workflow is manual and credential-free", () => {
  const workflow = readFileSync(new URL("../workflows/sbg-guest-payment-postgres-regression.yml", import.meta.url), "utf8");
  const existing = readFileSync(new URL("../workflows/sbg-disposable-postgres-regressions.yml", import.meta.url), "utf8");
  const harness = readFileSync(new URL("./stripe-test-harness.ts", import.meta.url), "utf8");
  assert.equal(CREATE_EXPIRE_EXECUTION_GATE, "closed");
  assert.match(harness, /const STRIPE_TEST_EXECUTION_GATE = "closed"/);
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /\n {2}(push|pull_request|schedule|workflow_run|workflow_call):/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/test\/stripe-gate2-runner'/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /environment:|secrets\./);
  assert.match(workflow, /bootstrap-disposable-postgres\.sh/);
  assert.match(workflow, /bootstrap-disposable-postgres\.sh identify/);
  assert.match(workflow, /PostgreSQL\) 18\\\./);
  assert.match(workflow, /STAGE_G2S5_PG_URL: postgresql:\/\/postgres@127\.0\.0\.1:54329\/postgres/);
  assert.match(workflow, /node --experimental-strip-types --test --test-concurrency=1 --test-force-exit src\/lib\/aether\/guest-payment-test\.test\.ts/);
  assert.match(workflow, /Neon endpoint rejected/);
  assert.doesNotMatch(workflow, /stripe-test-harness|stripe-test-preflight|playwright install|stripe listen/);
  assert.match(existing, /bootstrap-disposable-postgres\.sh/);
  assert.doesNotMatch(existing, /sbg-guest-payment-postgres-regression/);
});
