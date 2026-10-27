import assert from "node:assert/strict";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { test } from "node:test";
import {
  HUMAN_CONFIRMATION_FILE,
  HUMAN_SERVE_STEPS,
  assertHumanTestConfig,
  humanConfirmationUrl,
  operatorStatusLines,
  publishConfirmationUrl,
  redactHumanSecrets,
  requireIdentifiedCluster,
  resolveStripeCli,
} from "./stripe-test-human-booking.ts";

const runner = readFileSync(new URL("./stripe-test-human-booking.ts", import.meta.url), "utf8");
const harness = readFileSync(new URL("./stripe-test-harness.ts", import.meta.url), "utf8");

test("human booking config accepts only a TEST key and rejects live commerce", () => {
  const env = { SBG_GUEST_PAYMENT_TEST: "true", STRIPE_SECRET_KEY: "rk_test_local_only" };
  assert.doesNotThrow(() => assertHumanTestConfig(env));
  assert.throws(() => assertHumanTestConfig({ ...env, SBG_GUEST_PAYMENT_TEST: "false" }), /test_mode_required/);
  assert.throws(() => assertHumanTestConfig({ ...env, STRIPE_SECRET_KEY: "sk_live_secret" }), /test_credentials_required/);
  assert.throws(() => assertHumanTestConfig({ ...env, SBG_DOMAIN_B_LIVE_CHECKOUT: "true" }), /live_payment_flag/);
  assert.throws(() => assertHumanTestConfig({ ...env, SBG_SAAS_COMMERCE: "live" }), /live_payment_flag/);
  assert.throws(
    () => assertHumanTestConfig({ ...env, DATABASE_URL: "postgresql://user@ep-example.neon.tech/neondb" }),
    /database_not_authorised/,
  );
});

test("confirmation URL stays on loopback and the token file is private", async () => {
  const token = "human_booking_token_example";
  assert.equal(humanConfirmationUrl(token), "http://127.0.0.1:8080/confirmed/human_booking_token_example");
  assert.throws(() => humanConfirmationUrl("short"), /booking_token_invalid/);
  assert.equal(HUMAN_CONFIRMATION_FILE.startsWith("/tmp/"), true);
  const path = await publishConfirmationUrl(token);
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8").includes(token), true);
  } finally {
    unlinkSync(path);
  }
});

test("diagnostics redact the booking token and Stripe secrets", () => {
  const text = redactHumanSecrets(
    "token human_booking_token_example sk_test_abc rk_test_abc whsec_abc sk_live_abc",
    "human_booking_token_example",
  );
  assert.equal(text.includes("human_booking_token_example"), false);
  assert.equal(text.includes("sk_test_"), false);
  assert.equal(text.includes("whsec_"), false);
  assert.equal(text.includes("sk_live_"), false);
});

test("a failed identify stops without bootstrapping a cluster", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    () => requireIdentifiedCluster(async (args) => {
      calls.push(args);
      throw new Error("identify_failed");
    }),
    /database_not_authorised/,
  );
  assert.deepEqual(calls, [["identify"]]);
  assert.equal(runner.includes("runScript([])"), false);
  assert.equal(runner.includes("rm -rf /tmp/s1pg"), false);
});

test("stdout names only the private handoff file", () => {
  const token = "human_booking_token_example";
  const lines = operatorStatusLines().join("\n");
  assert.equal(lines.includes(HUMAN_CONFIRMATION_FILE), true);
  assert.equal(lines.includes(token), false);
  assert.equal(lines.includes("http://"), false);
  assert.equal(lines.includes("/confirmed/"), false);
  assert.equal(lines.includes("whsec_"), false);
  assert.equal(runner.includes("Confirmation page:"), false);
  assert.equal(runner.includes("process.stdout.write(`${line}"), true);
  assert.equal(runner.includes("removeConfirmationFile"), true);
});

test("the runner waits for a human and does not submit a card", () => {
  assert.deepEqual(HUMAN_SERVE_STEPS.at(-1), "wait_for_human");
  assert.equal(runner.includes("prepareDisposableGuestFixture"), true);
  assert.equal(runner.includes("forward-connect-to") || runner.includes("forwardConnectEvents"), true);
  assert.equal(runner.includes("/api/stripe/webhook"), false);
  assert.equal(runner.includes("127.0.0.1"), true);
  assert.equal(runner.includes(".fill("), false);
  assert.equal(runner.includes("playwright"), false);
  assert.equal(runner.includes("checkout/sessions"), false);
  assert.equal(resolveStripeCli({}), "/tmp/stripe-cli/stripe");
  assert.throws(() => resolveStripeCli({ STRIPE_CLI: "relative/stripe" }), /stripe_cli_missing/);
  const identify = runner.indexOf('runScript(["identify"])');
  const cleanup = runner.lastIndexOf('runScript(["cleanup"])');
  assert.ok(identify > 0 && cleanup > identify);
  const fixture = harness.slice(harness.indexOf("async function prepareDisposableGuestFixture"));
  assert.match(fixture, /acct_1UKEFuFHnHoOWAJE|CONNECTED_ACCOUNT/);
  assert.match(fixture, /awaiting_payment/);
  assert.match(fixture, /fixture_not_payable/);
  assert.match(fixture, /sbg_booking_payments/);
});
