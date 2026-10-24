import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CREATE_EXPIRE_EXECUTION_GATE } from "./stripe-test-create-expire.ts";

test("payment workflow stays manual and the paid gate stays closed", () => {
  const workflow = readFileSync(new URL("../workflows/sbg-stripe-test-payment.yml", import.meta.url), "utf8");
  const checkout = readFileSync(new URL("../workflows/sbg-stripe-test-checkout.yml", import.meta.url), "utf8");
  const harness = readFileSync(new URL("./stripe-test-harness.ts", import.meta.url), "utf8");
  assert.equal(CREATE_EXPIRE_EXECUTION_GATE, "closed");
  assert.match(harness, /const STRIPE_TEST_EXECUTION_GATE = "closed"/);
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /\n {2}(push|pull_request|schedule|workflow_run):/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/test\/stripe-gate2-runner'/);
  assert.match(workflow, /environment: sbg-stripe-test/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /SBG_DOMAIN_B_LIVE_CHECKOUT: "false"/);
  assert.match(workflow, /SBG_SAAS_COMMERCE: "off"/);
  assert.match(workflow, /npx --no-install playwright install --with-deps chromium/);
  assert.doesNotMatch(workflow, /playwright install firefox|playwright install webkit/);
  assert.match(workflow, /stripe-test-preflight\.sh execute-test-payment/);
  assert.equal(workflow.split("\n").filter((line) => line.includes("SBG_STRIPE_TEST_SECRET_KEY")).length, 1);
  assert.doesNotMatch(checkout, /execute-test-payment|playwright install/);
  assert.match(harness, /acct_1UKEFuFHnHoOWAJE/);
  assert.match(harness, /const AMOUNT_MINOR = 4500/);
  assert.doesNotMatch(harness, /application_fee|transfer_data/);
});

test("the closed payment harness exits before Stripe", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", ".github/scripts/stripe-test-harness.ts"],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      env: {
        ...process.env,
        STRIPE_SECRET_KEY: "rk_test_offline_not_used",
        SBG_GUEST_PAYMENT_TEST: "true",
        SBG_DOMAIN_B_LIVE_CHECKOUT: "false",
        SBG_SAAS_COMMERCE: "off",
      },
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /stripe_test_execution_closed/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /rk_test_|checkout\.stripe\.com|sk_live_|whsec_/);
});
