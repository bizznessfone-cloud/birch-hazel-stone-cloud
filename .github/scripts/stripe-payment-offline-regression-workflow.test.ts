import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CREATE_EXPIRE_EXECUTION_GATE } from "./stripe-test-create-expire.ts";

test("offline payment regression cannot reach Stripe or the payment harness", () => {
  const workflow = readFileSync(
    new URL("../workflows/sbg-stripe-payment-offline-regression.yml", import.meta.url),
    "utf8",
  );
  const harness = readFileSync(new URL("./stripe-test-harness.ts", import.meta.url), "utf8");
  assert.equal(CREATE_EXPIRE_EXECUTION_GATE, "closed");
  assert.match(harness, /const STRIPE_TEST_EXECUTION_GATE = "closed"/);
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /\n {2}(push|pull_request|schedule|workflow_run):/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/test\/stripe-gate2-runner'/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: "22"/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(
    workflow,
    /node --experimental-strip-types --test \\\n\s+\.github\/scripts\/stripe-test-harness-recovery\.test\.ts \\\n\s+\.github\/scripts\/stripe-test-payment-workflow\.test\.ts/,
  );
  assert.doesNotMatch(workflow, /secrets\.|environment:|STRIPE_|postgres|playwright|stripe listen|stripe-test-preflight|execute-test-payment|bootstrap-disposable-postgres/);
  assert.doesNotMatch(workflow, /stripe-test-harness\.ts/);
});
