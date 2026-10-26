import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CHECKOUT_DIAGNOSTIC_EXECUTION_GATE,
  DIAGNOSTIC_AMOUNT_MINOR,
  DIAGNOSTIC_CONNECTED_ACCOUNT,
  adaptFrames,
  diagnosticCheckoutBody,
  runCheckoutDiagnostic,
  type DiagnosticBrowser,
  type DiagnosticInput,
  type DiagnosticPage,
  type DiagnosticSession,
  type DiagnosticStripe,
} from "./stripe-test-checkout-diagnostic.ts";
import { STRUCTURE_SELECTORS, type StructureClock, type StructureFrame } from "./stripe-test-checkout-structure.ts";

const SHA = "3acc7c209856679302174ae872399360cf3c20f9";
const SECRET = "https://checkout.stripe.com/c/pay/secret rk_test_secret 4242424242424242";

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    GITHUB_SHA: SHA,
    GITHUB_REF: "refs/heads/test/stripe-gate2-runner",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW: "SBG Stripe TEST checkout diagnostic",
    GITHUB_WORKFLOW_REF: "bizznessfone-cloud/birch-hazel-stone-cloud/.github/workflows/sbg-stripe-test-checkout-diagnostic.yml@refs/heads/test/stripe-gate2-runner",
    GITHUB_REPOSITORY: "bizznessfone-cloud/birch-hazel-stone-cloud",
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: "40170003536",
    STRIPE_SECRET_KEY: "rk_test_diagnostickeyvalue0001",
    SBG_AUTHORISED_DIAGNOSTIC_SHA: SHA,
    SBG_DOMAIN_B_LIVE_CHECKOUT: "false",
    SBG_SAAS_COMMERCE: "off",
    ...overrides,
  };
}

function clock(): StructureClock {
  let time = 0;
  return {
    now: () => time,
    async wait(ms: number) {
      time += ms;
    },
    async limit(operation) {
      return operation();
    },
  };
}

function frame(controls: Partial<Record<"card" | "expiry" | "cvc", number>> = {}): StructureFrame {
  const values = { card: 0, expiry: 0, cvc: 0, ...controls };
  return {
    getByRole(_role, options) {
      return {
        async count() {
          if (options.name.source === "card number") return values.card;
          if (options.name.source === "expir") return values.expiry;
          if (options.name.source === "cvc|security code") return values.cvc;
          return 0;
        },
      };
    },
    isDetached: () => false,
  };
}

function page(input: { challenge?: number; frames?: StructureFrame[]; clicks?: { count: number } } = {}): DiagnosticPage {
  const frames = input.frames ?? [frame(), frame({ card: 1, expiry: 1, cvc: 1 })];
  return {
    async goto() {},
    async close() {},
    frames: () => frames,
    locator(selector: string) {
      return {
        async count() {
          if (selector === STRUCTURE_SELECTORS.challenge) return input.challenge ?? 0;
          if (selector === STRUCTURE_SELECTORS.iframe) return 1;
          if (selector === STRUCTURE_SELECTORS.cardTitle) return 0;
          return 0;
        },
      };
    },
  };
}

function browser(input: { fail?: "launch" | "goto"; challenge?: number; frames?: StructureFrame[] } = {}): DiagnosticBrowser & { closed: boolean } {
  let closed = false;
  return {
    async newPage() {
      if (input.fail === "launch") throw new Error(SECRET);
      const current = page(input);
      return {
        ...current,
        async goto() {
          if (input.fail === "goto") throw new Error(SECRET);
        },
        async close() {
          closed = true;
        },
      };
    },
    async close() {
      closed = true;
    },
    get closed() { return closed; },
  };
}

function session(overrides: Partial<DiagnosticSession> = {}): DiagnosticSession {
  return {
    id: "cs_test_structureprobe0001",
    url: "https://checkout.stripe.com/c/pay/structure-probe",
    livemode: false,
    paymentStatus: "unpaid",
    status: "open",
    ...overrides,
  };
}

function stripe(state: DiagnosticSession = session()): DiagnosticStripe & { creates: number; expires: number } {
  let creates = 0;
  let expires = 0;
  let current = { ...state };
  return {
    async create(input) {
      creates += 1;
      assert.equal(input.idempotencyKey, `sbgdiag_${SHA}`);
      return current;
    },
    async retrieve() {
      return current;
    },
    async expire() {
      expires += 1;
      current = { ...current, status: "expired", paymentStatus: "unpaid", livemode: false };
      return current;
    },
    get creates() { return creates; },
    get expires() { return expires; },
  };
}

function assertRedacted(value: unknown): void {
  const text = JSON.stringify(value);
  assert.equal(text.includes("checkout.stripe.com"), false);
  assert.equal(text.includes("4242"), false);
  assert.equal(text.includes("rk_test_"), false);
  assert.equal(text.includes(SECRET), false);
}

async function run(
  overrides: Partial<DiagnosticInput> = {},
  envOverrides: Record<string, string> = {},
  sourceGate: string = CHECKOUT_DIAGNOSTIC_EXECUTION_GATE,
) {
  const payments = stripe();
  const chrome = browser();
  const result = await runCheckoutDiagnostic({
    env: env(envOverrides),
    stripe: payments,
    launch: async () => chrome,
    clock: clock(),
    budgetMs: 100,
    ...overrides,
    sourceGate,
  });
  return { result, payments, chrome };
}

test("a closed source gate rejects a valid SHA permit", async () => {
  assert.equal(CHECKOUT_DIAGNOSTIC_EXECUTION_GATE, "closed");
  const { result, payments } = await run();
  assert.equal(result.status, "closed");
  assert.equal(result.failure, "diagnostic_closed");
  assert.equal(payments.creates, 0);
});

test("an open gate without a permit is rejected", async () => {
  const { result, payments } = await run({}, { SBG_AUTHORISED_DIAGNOSTIC_SHA: "" }, "open");
  assert.equal(result.failure, "authorisation_missing");
  assert.equal(payments.creates, 0);
});

test("the wrong branch is rejected", async () => {
  const { result, payments } = await run({}, { GITHUB_REF: "refs/heads/main" }, "open");
  assert.equal(result.failure, "branch_rejected");
  assert.equal(payments.creates, 0);
});

test("the wrong commit is rejected", async () => {
  const { result, payments } = await run({}, { GITHUB_SHA: `${"a".repeat(40)}` }, "open");
  assert.equal(result.failure, "commit_rejected");
  assert.equal(payments.creates, 0);
});

test("a missing permit is rejected", async () => {
  const { result, payments } = await run({}, { SBG_AUTHORISED_DIAGNOSTIC_SHA: "" }, "open");
  assert.equal(result.failure, "authorisation_missing");
  assert.equal(payments.creates, 0);
});

test("the wrong workflow is rejected", async () => {
  const { result, payments } = await run({}, { GITHUB_WORKFLOW: "SBG Stripe TEST payment" }, "open");
  assert.equal(result.failure, "workflow_rejected");
  assert.equal(payments.creates, 0);
});

test("a live credential is rejected before Session creation", async () => {
  const { result, payments } = await run({}, { STRIPE_SECRET_KEY: "sk_live_notallowed000000" }, "open");
  assert.equal(result.failure, "live_credential_rejected");
  assert.equal(payments.creates, 0);
  assertRedacted(result);
});

test("one authorised run creates one Session and verifies expiry", async () => {
  const body = diagnosticCheckoutBody(`sbgdiag_${SHA}`);
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), String(DIAGNOSTIC_AMOUNT_MINOR));
  assert.equal(body.get("line_items[0][price_data][currency]"), "eur");
  assert.equal(body.get("metadata[sbg_connected_account]"), DIAGNOSTIC_CONNECTED_ACCOUNT);
  assert.equal(body.toString().includes("application_fee"), false);
  const { result, payments, chrome } = await run({}, {}, "open");
  assert.equal(result.status, "completed");
  assert.equal(result.cleanup, "verified");
  assert.equal(payments.creates, 1);
  assert.equal(payments.expires, 1);
  assert.equal(result.structure?.formDetected, true);
  assert.equal(chrome.closed, true);
  assert.equal(result.commitSha, SHA);
  assertRedacted(result);
});

test("ambiguous Session creation is not retried", async () => {
  let creates = 0;
  const { result } = await run({
    stripe: {
      async create() {
        creates += 1;
        throw new Error(SECRET);
      },
      async retrieve() { throw new Error("retrieve"); },
      async expire() { throw new Error("expire"); },
    },
  }, {}, "open");
  assert.equal(creates, 1);
  assert.equal(result.status, "blocked");
  assert.equal(result.cleanup, "ambiguous");
  assert.equal(result.failure, "orphaned_session_possible");
  assertRedacted(result);
});

test("browser launch failure still attempts cleanup", async () => {
  const payments = stripe();
  const { result } = await run({
    stripe: payments,
    launch: async () => browser({ fail: "launch" }),
  }, {}, "open");
  assert.equal(result.failure, "browser_failed");
  assert.equal(result.cleanup, "verified");
  assert.equal(payments.creates, 1);
  assert.equal(payments.expires, 1);
  assertRedacted(result);
});

test("observation timeout closes the browser and expires the Session", async () => {
  const payments = stripe();
  const chrome = browser({ frames: [frame()] });
  const { result } = await run({ stripe: payments, launch: async () => chrome }, {}, "open");
  assert.equal(result.structure?.observation, "timeout");
  assert.equal(result.cleanup, "verified");
  assert.equal(chrome.closed, true);
  assert.equal(payments.expires, 1);
});

test("nested frames are reported by the existing probe", async () => {
  const grandchild = frame({ card: 1, expiry: 1, cvc: 1 });
  const { result } = await run({
    launch: async () => browser({ frames: [frame(), frame(), grandchild] }),
  }, {}, "open");
  assert.equal(result.structure?.formDetected, true);
  assert.equal(result.structure?.iframeCount, 1);
});

test("a challenge is reported without payment submission", async () => {
  const { result, payments } = await run({
    launch: async () => browser({ challenge: 1, frames: [frame()] }),
  }, {}, "open");
  assert.equal(result.structure?.observation, "challenge");
  assert.equal(payments.expires, 1);
  assert.equal(result.status, "completed");
});

test("expiry failure stays blocked and is not retried", async () => {
  let creates = 0;
  let expires = 0;
  const { result } = await run({
    stripe: {
      async create() {
        creates += 1;
        return session();
      },
      async retrieve() {
        return session();
      },
      async expire() {
        expires += 1;
        throw new Error(SECRET);
      },
    },
  }, {}, "open");
  assert.equal(creates, 1);
  assert.equal(expires, 1);
  assert.equal(result.cleanup, "failed");
  assert.equal(result.failure, "expire_failed");
  assert.equal(result.status, "blocked");
  assertRedacted(result);
});

test("unverified expiry is blocked for manual investigation", async () => {
  const { result } = await run({
    stripe: {
      async create() { return session(); },
      async retrieve() { return session({ status: "open" }); },
      async expire() { return session({ status: "open" }); },
    },
  }, {}, "open");
  assert.equal(result.cleanup, "ambiguous");
  assert.equal(result.failure, "expire_unverified");
  assert.equal(result.status, "blocked");
});

test("frame adapters keep a stable identity", () => {
  const cache = new WeakMap<object, StructureFrame>();
  const parent = { getByRole: () => ({ async count() { return 0; } }), isDetached: () => false };
  const child = { getByRole: () => ({ async count() { return 0; } }), isDetached: () => false };
  const first = adaptFrames([parent, child], cache);
  const second = adaptFrames([parent, child], cache);
  assert.equal(first[0], second[0]);
  assert.equal(first[1], second[1]);
  assert.notEqual(first[0], first[1]);
});

test("a duplicated underlying frame is reported as unexpected", async () => {
  const cache = new WeakMap<object, StructureFrame>();
  const raw = { getByRole: () => ({ async count() { return 1; } }), isDetached: () => false };
  const payments = stripe();
  const { result } = await run({
    stripe: payments,
    launch: async () => ({
      async newPage() {
        return {
          async goto() {},
          async close() {},
          locator: () => ({ async count() { return 1; } }),
          frames: () => adaptFrames([raw, raw], cache),
        };
      },
      async close() {},
    }),
  }, {}, "open");
  assert.equal(result.structure?.observation, "unexpected");
  assert.equal(payments.creates, 1);
  assert.equal(payments.expires, 1);
});

test("page closure failure still closes the browser and expires the Session", async () => {
  let browserClosed = false;
  const payments = stripe();
  const { result } = await run({
    stripe: payments,
    launch: async () => ({
      async newPage() {
        return { ...page(), async close() { throw new Error(SECRET); } };
      },
      async close() { browserClosed = true; },
    }),
  }, {}, "open");
  assert.equal(browserClosed, true);
  assert.equal(result.failure, "browser_close_failed");
  assert.equal(result.status, "blocked");
  assert.equal(payments.expires, 1);
  assert.equal(payments.creates, 1);
  assertRedacted(result);
});

test("browser closure failure is reported and Session cleanup still runs", async () => {
  let pageClosed = false;
  const payments = stripe();
  const { result } = await run({
    stripe: payments,
    launch: async () => ({
      async newPage() {
        return { ...page(), async close() { pageClosed = true; } };
      },
      async close() { throw new Error(SECRET); },
    }),
  }, {}, "open");
  assert.equal(pageClosed, true);
  assert.equal(result.failure, "browser_close_failed");
  assert.equal(payments.creates, 1);
  assert.equal(payments.expires, 1);
  assertRedacted(result);
});

test("the diagnostic workflow is manual and separate from payment", () => {
  const workflow = readFileSync(".github/workflows/sbg-stripe-test-checkout-diagnostic.yml", "utf8");
  assert.equal(workflow.includes("workflow_dispatch"), true);
  assert.equal(workflow.includes("push:"), false);
  assert.equal(workflow.includes("schedule:"), false);
  assert.equal(workflow.includes("SBG_AUTHORISED_DIAGNOSTIC_SHA"), true);
  assert.equal(workflow.includes("SBG_AUTHORISED_PAYMENT_SHA"), false);
  assert.equal(workflow.includes("execute-test-payment"), false);
  const source = readFileSync(".github/scripts/stripe-test-checkout-diagnostic.ts", "utf8");
  assert.equal(source.includes(".fill("), false);
  assert.equal(source.includes(".click("), false);
  assert.equal(source.includes("refund"), false);
  assert.equal(source.includes('sourceGate: "open"'), false);
  assert.equal(source.includes('CHECKOUT_DIAGNOSTIC_EXECUTION_GATE = "closed"'), true);
});
