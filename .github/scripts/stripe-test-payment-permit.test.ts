import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentExecutionAuthorised } from "./stripe-test-harness.ts";

const SHA = "6ffb9e73f322ad2d409410f5e649617ce27504a2";
const OTHER_SHA = "91a8a427d9ce6b120319017735559638e813355f";

function authorisedEnv(overrides: { [key: string]: string | undefined } = {}): { [key: string]: string | undefined } {
  return {
    SBG_AUTHORISED_PAYMENT_SHA: SHA,
    GITHUB_SHA: SHA,
    GITHUB_REF: "refs/heads/test/stripe-gate2-runner",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW: "SBG Stripe TEST payment",
    GITHUB_WORKFLOW_REF: "bizznessfone-cloud/birch-hazel-stone-cloud/.github/workflows/sbg-stripe-test-payment.yml@refs/heads/test/stripe-gate2-runner",
    GITHUB_REPOSITORY: "bizznessfone-cloud/birch-hazel-stone-cloud",
    GITHUB_ACTIONS: "true",
    ...overrides,
  };
}

test("missing permit is rejected", () => {
  const env = authorisedEnv();
  delete env.SBG_AUTHORISED_PAYMENT_SHA;
  assert.equal(paymentExecutionAuthorised(env), false);
});

test("empty permit is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv({ SBG_AUTHORISED_PAYMENT_SHA: "" })), false);
});

test("malformed permit is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv({ SBG_AUTHORISED_PAYMENT_SHA: `${SHA}g` })), false);
  assert.equal(paymentExecutionAuthorised(authorisedEnv({ SBG_AUTHORISED_PAYMENT_SHA: SHA.toUpperCase() })), false);
});

test("short permit is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv({ SBG_AUTHORISED_PAYMENT_SHA: SHA.slice(0, 7) })), false);
});

test("wrong permit SHA is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv({ SBG_AUTHORISED_PAYMENT_SHA: OTHER_SHA })), false);
});

test("missing GITHUB_SHA is rejected", () => {
  const env = authorisedEnv();
  delete env.GITHUB_SHA;
  assert.equal(paymentExecutionAuthorised(env), false);
});

test("wrong branch is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv({ GITHUB_REF: "refs/heads/main" })), false);
});

test("wrong event is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv({ GITHUB_EVENT_NAME: "push" })), false);
});

test("wrong workflow name is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv({ GITHUB_WORKFLOW: "SBG Stripe payment offline regression" })), false);
});

test("wrong workflow file is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv({
    GITHUB_WORKFLOW_REF: "bizznessfone-cloud/birch-hazel-stone-cloud/.github/workflows/sbg-stripe-test-checkout.yml@refs/heads/test/stripe-gate2-runner",
  })), false);
});

test("wrong workflow repository is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv({
    GITHUB_WORKFLOW_REF: "example/other/.github/workflows/sbg-stripe-test-payment.yml@refs/heads/test/stripe-gate2-runner",
  })), false);
});

test("wrong GITHUB_REPOSITORY is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv({ GITHUB_REPOSITORY: "example/other" })), false);
});

test("missing or false GITHUB_ACTIONS is rejected", () => {
  const missing = authorisedEnv();
  delete missing.GITHUB_ACTIONS;
  assert.equal(paymentExecutionAuthorised(missing), false);
  assert.equal(paymentExecutionAuthorised(authorisedEnv({ GITHUB_ACTIONS: "false" })), false);
});

test("source gate opened without a permit is rejected", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv(), "open"), false);
});

test("matching authorisation context is accepted without running the harness", () => {
  assert.equal(paymentExecutionAuthorised(authorisedEnv()), true);
});

test("repeated matching context stays authorised and is not single-use", () => {
  const env = authorisedEnv();
  assert.equal(paymentExecutionAuthorised(env), true);
  assert.equal(paymentExecutionAuthorised(env), true);
});
