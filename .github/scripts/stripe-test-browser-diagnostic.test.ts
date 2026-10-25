import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_FIELD_DISCOVERY_BUDGET_MS,
  PAYMENT_AMOUNT_MINOR,
  STRIPE_TEST_EXECUTION_GATE,
  paymentExecutionAuthorised,
  runHostedCheckout,
  runPaymentHarnessBoundary,
  type CheckoutClock,
  type HostedCheckoutBrowser,
} from "./stripe-test-harness.ts";

const SECRET_TEXT = "https://checkout.stripe.com/c/pay/cs_test_secret rk_test_secret whsec_secret 4242424242424242 1234";
const SESSION = "cs_test_diagnostic00000000000001";
const BOOKING = "2d3edd20-2337-48db-a2d4-471b5d59338c";
const PAYMENT = "7d6fb5be-ad92-4532-8a8e-c578e5e6cfcd";

function named(name: string): Error {
  const error = new Error(SECRET_TEXT);
  error.name = name;
  return error;
}

function virtualClock(): CheckoutClock & { elapsed(): number } {
  let time = 0;
  return {
    now: () => time,
    async wait(ms: number) {
      time += ms;
    },
    elapsed: () => time,
  };
}

type FieldSpec = { count?: number; appearAt?: number; missing?: boolean; wait?: boolean };

function page(input: {
  goto?: () => Promise<void>;
  challengeCount?: number;
  fieldCounts?: number[];
  fields?: FieldSpec[];
  clock?: CheckoutClock;
  fill?: (value: string) => Promise<void>;
  click?: () => Promise<void>;
  redirect?: () => Promise<void>;
} = {}): HostedCheckoutBrowser {
  const clock = input.clock ?? { now: () => 0, async wait() { return undefined; } };
  const fields: FieldSpec[] = input.fields ?? (input.fieldCounts ?? [1, 1, 1]).map((count) => ({ count }));
  let fieldIndex = 0;
  return {
    async newPage() {
      return {
        async goto() {
          if (input.goto) await input.goto();
        },
        locator() {
          return { async count() { return input.challengeCount ?? 0; } };
        },
        frameLocator() {
          const spec = fields[fieldIndex] ?? { count: 1 };
          fieldIndex += 1;
          return {
            locator() {
              const field: {
                count: () => Promise<number>;
                fill: (value: string) => Promise<void>;
                waitFor?: (options: { timeout: number }) => Promise<void>;
              } = {
                async count() {
                  if (spec.missing) throw named("FieldMissing");
                  if (spec.appearAt != null) return clock.now() >= spec.appearAt ? 1 : 0;
                  return spec.count ?? 1;
                },
                async fill(value: string) {
                  if (input.fill) await input.fill(value);
                },
              };
              if (spec.appearAt != null && spec.wait !== false) {
                field.waitFor = async (options: { timeout: number }) => {
                  const now = clock.now();
                  if (spec.appearAt != null && now >= spec.appearAt) return;
                  const need = (spec.appearAt ?? now) - now;
                  if (need > options.timeout) {
                    await clock.wait(options.timeout);
                    throw named("TimeoutError");
                  }
                  await clock.wait(need);
                };
              }
              return field;
            },
          };
        },
        getByRole() {
          return { async click() { if (input.click) await input.click(); } };
        },
        async waitForURL() {
          if (input.redirect) await input.redirect();
        },
      };
    },
    async close() { return undefined; },
  };
}

async function fail(browser: HostedCheckoutBrowser, clock?: CheckoutClock): Promise<unknown> {
  try {
    await runHostedCheckout("https://checkout.stripe.com/c/pay/secret-url?card=4242424242424242", async () => browser, clock ?? virtualClock());
    return null;
  } catch (err) {
    return err;
  }
}

function assertSafe(err: unknown): void {
  assert.equal(err instanceof Error, true);
  const error = err as Error & { browserStage?: string; browserFailure?: string };
  const text = JSON.stringify({ message: error.message, stage: error.browserStage, failure: error.browserFailure, stack: error.stack });
  assert.equal(text.includes("checkout.stripe.com"), false);
  assert.equal(text.includes("4242"), false);
  assert.equal(text.includes("rk_test_"), false);
  assert.equal(text.includes("whsec_"), false);
  assert.equal(text.includes("secret-url"), false);
}

test("browser launch failure remains distinguishable", async () => {
  const err = await fail({
    async newPage() { throw named("Error"); },
    async close() { return undefined; },
  });
  assert.equal((err as Error).message, "checkout_browser_failed");
  assert.equal((err as { browserStage: string }).browserStage, "chromium_launch");
  assert.equal((err as { browserFailure: string }).browserFailure, "browser_launch_failed");
  assertSafe(err);
});

test("navigation failure is classified without the raw error", async () => {
  const err = await fail(page({ goto: async () => { throw named("Error"); } }));
  assert.equal((err as { browserStage: string }).browserStage, "checkout_navigation");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_navigation_failed");
  assertSafe(err);
});

test("card fields available immediately complete checkout", async () => {
  const clock = virtualClock();
  const err = await fail(page({ clock, fields: [{ count: 1 }, { count: 1 }, { count: 1 }] }), clock);
  assert.equal(err, null);
  assert.equal(clock.elapsed(), 0);
});

test("card fields appearing after a zero count are not missing", async () => {
  const clock = virtualClock();
  const err = await fail(page({
    clock,
    fields: [{ appearAt: 100, wait: false }, { appearAt: 150, wait: false }, { appearAt: 200, wait: false }],
  }), clock);
  assert.equal(err, null);
  assert.equal(clock.elapsed(), 200);
});

test("card fields that never appear time out on the shared budget", async () => {
  const clock = virtualClock();
  const err = await fail(page({
    clock,
    fields: [{ count: 1 }, { appearAt: 5_000 }, { appearAt: Number.POSITIVE_INFINITY }],
  }), clock);
  assert.equal((err as { browserStage: string }).browserStage, "card_field_discovery");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_field_timeout");
  assert.equal(clock.elapsed(), CARD_FIELD_DISCOVERY_BUDGET_MS);
  assertSafe(err);
});

test("a demonstrably absent card field is not a timeout", async () => {
  const clock = virtualClock();
  const err = await fail(page({ clock, fields: [{ missing: true }, { count: 1 }, { count: 1 }] }), clock);
  assert.equal((err as { browserStage: string }).browserStage, "card_field_discovery");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_field_missing");
  assert.equal(clock.elapsed(), 0);
  assertSafe(err);
});

test("ambiguous card field matches are distinct", async () => {
  const clock = virtualClock();
  const err = await fail(page({ clock, fields: [{ count: 2 }, { count: 1 }, { count: 1 }] }), clock);
  assert.equal((err as { browserStage: string }).browserStage, "card_field_discovery");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_field_ambiguous");
  assert.equal(clock.elapsed(), 0);
  assertSafe(err);
});

test("card entry timeout remains distinct from discovery", async () => {
  const timeout = await fail(page({ fill: async () => { throw named("TimeoutError"); } }));
  assert.equal((timeout as { browserStage: string }).browserStage, "card_number_entry");
  assert.equal((timeout as { browserFailure: string }).browserFailure, "checkout_field_timeout");
  assertSafe(timeout);
});

test("card entry failure is classified separately", async () => {
  const err = await fail(page({ fill: async () => { throw named("Error"); } }));
  assert.equal((err as { browserStage: string }).browserStage, "card_number_entry");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_card_entry_failed");
  assertSafe(err);
});

test("submission failure is classified correctly", async () => {
  const err = await fail(page({ click: async () => { throw named("TimeoutError"); } }));
  assert.equal((err as { browserStage: string }).browserStage, "payment_submission");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_submission_failed");
  assertSafe(err);
});

test("redirect failure is classified correctly", async () => {
  const err = await fail(page({ redirect: async () => { throw named("TimeoutError"); } }));
  assert.equal((err as { browserStage: string }).browserStage, "completion_redirect");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_redirect_failed");
  assertSafe(err);
});

test("challenge detection remains distinct", async () => {
  const err = await fail(page({ challengeCount: 1 }));
  assert.equal((err as Error).message, "checkout_challenge");
  assert.equal((err as { browserStage: string }).browserStage, "challenge_detection");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_challenge");
  assertSafe(err);
});

test("browser diagnostics do not change unpaid recovery", async () => {
  let gets = 0;
  const record = await runPaymentHarnessBoundary({
    secret: "rk_test_harnessfixturekey01",
    githubRunId: "40211631759",
    githubRunAttempt: "1",
    fetchImpl: async (_url, init) => {
      const status = (init?.method ?? "GET") === "POST" || gets++ > 0 ? "expired" : "open";
      return new Response(JSON.stringify({
        id: SESSION,
        livemode: false,
        mode: "payment",
        amount_total: PAYMENT_AMOUNT_MINOR,
        currency: "eur",
        payment_status: "unpaid",
        status,
      }), { status: 200 });
    },
    steps: {
      prepareFixture: async () => ({ bookingId: BOOKING }),
      installCli: async () => undefined,
      startProxy: async () => undefined,
      awaitCli: async () => undefined,
      startListener: async () => undefined,
      createCheckout: async () => ({ attempted: true, ambiguous: false, sessionId: SESSION, paymentId: PAYMENT, checkoutAttempt: 1, failure: null }),
      retrieveCheckout: async () => undefined,
      completeBrowser: async () => {
        const clock = virtualClock();
        await runHostedCheckout(
          "https://checkout.stripe.com/c/pay/secret-url",
          async () => page({ clock, fields: [{ missing: true }, { count: 1 }, { count: 1 }] }),
          clock,
        );
      },
      confirmWebhook: async () => undefined,
      replay: async () => undefined,
    },
    lookupPayment: async () => ({ state: "stored", paymentId: PAYMENT, sessionId: SESSION, checkoutAttempt: 1 }),
    readBooking: async () => null,
    cleanup: {
      listener: async () => undefined,
      proxy: async () => undefined,
      cli: async () => undefined,
      database: async () => undefined,
      temporaryDirectory: async () => undefined,
    },
  });
  assert.equal(record.outcome, "unpaid_expired");
  assert.equal(record.operationFailure, "checkout_browser_failed");
  assert.equal(record.browserStage, "card_field_discovery");
  assert.equal(record.browserFailure, "checkout_field_missing");
  assert.equal(record.recoveryFailure, null);
  const text = JSON.stringify(record);
  assert.equal(text.includes("checkout.stripe.com"), false);
  assert.equal(text.includes("4242"), false);
});

test("closed harness remains unauthorised without the permit", () => {
  assert.equal(STRIPE_TEST_EXECUTION_GATE, "closed");
  assert.equal(paymentExecutionAuthorised({}), false);
});
