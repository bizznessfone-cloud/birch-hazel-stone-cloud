import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_FIELD_DISCOVERY_BUDGET_MS,
  PAYMENT_AMOUNT_MINOR,
  STRIPE_TEST_EXECUTION_GATE,
  adaptPlaywrightCheckoutPage,
  classifyChallengeFrames,
  inspectPlaywrightChallenges,
  paymentExecutionAuthorised,
  readIframeMeasurement,
  runHostedCheckout,
  runPaymentHarnessBoundary,
  type ChallengeInspection,
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
  assert.equal(PAYMENT_AMOUNT_MINOR, 4500);
});

const CLEAR_CHALLENGE: ChallengeInspection = {
  visibleHcaptcha: 0,
  visibleThreeDs: 0,
  visibleCaptcha: 0,
  backgroundThreeDs: 0,
  ambiguous: 0,
};

function roleFrame(input: {
  card?: number;
  expiry?: number;
  cvc?: number;
  detached?: boolean;
  appearAt?: number;
  clock?: CheckoutClock;
  missing?: boolean;
  stall?: boolean;
  onFill?: (value: string) => void;
}) {
  return {
    isDetached: () => input.detached === true,
    getByRole(_role: "textbox", options: { name: RegExp }) {
      const key = options.name.test("card number") ? "card" : options.name.test("expir") ? "expiry" : "cvc";
      return {
        async count(options?: { timeout?: number }) {
          if (input.stall) {
            await input.clock?.wait(options?.timeout ?? 0);
            return input[key] ?? 1;
          }
          if (input.missing) {
            const error = new Error("missing");
            error.name = "FieldMissing";
            throw error;
          }
          if (input.appearAt != null && (input.clock?.now() ?? 0) < input.appearAt) return 0;
          return input[key] ?? 0;
        },
        async fill(value: string) {
          input.onFill?.(value);
        },
      };
    },
  };
}

function framed(input: {
  titles?: [number, number, number];
  frames: ReturnType<typeof roleFrame>[];
  challenges?: (options?: { timeout?: number }) => Promise<ChallengeInspection>;
  clock?: CheckoutClock;
  onTitleFill?: (value: string) => void;
  click?: () => Promise<void>;
}): HostedCheckoutBrowser {
  const titles = input.titles ?? [0, 0, 0];
  return {
    async newPage() {
      return {
        async goto() { return undefined; },
        locator() { return { async count() { return 0; } }; },
        frameLocator() {
          const count = titles.shift() ?? 0;
          return {
            locator() {
              return {
                async count() { return count; },
                async fill(value: string) { input.onTitleFill?.(value); },
              };
            },
          };
        },
        frames: () => input.frames,
        inspectChallenges: input.challenges ?? (async () => CLEAR_CHALLENGE),
        getByRole() { return { async click() { if (input.click) await input.click(); } }; },
        async waitForURL() { return undefined; },
      };
    },
    async close() { return undefined; },
  };
}

test("legacy titled iframes are used when frames are also attached", async () => {
  const clock = virtualClock();
  const filled: string[] = [];
  const err = await fail(framed({
    clock,
    titles: [1, 1, 1],
    onTitleFill: (value) => filled.push(value),
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1, onFill: () => filled.push("role") })],
  }), clock);
  assert.equal(err, null);
  assert.deepEqual(filled, ["4242424242424242", "1234", "123"]);
  assert.equal(clock.elapsed(), 0);
});

test("accessible controls in separate nested frames are used when titles are absent", async () => {
  const clock = virtualClock();
  const filled: string[] = [];
  const err = await fail(framed({
    clock,
    frames: [
      roleFrame({}),
      roleFrame({ card: 1, onFill: (value) => filled.push(`card:${value}`) }),
      roleFrame({ expiry: 1, onFill: (value) => filled.push(`expiry:${value}`) }),
      roleFrame({ cvc: 1, onFill: (value) => filled.push(`cvc:${value}`) }),
    ],
  }), clock);
  assert.equal(err, null);
  assert.deepEqual(filled, ["card:4242424242424242", "expiry:1234", "cvc:123"]);
  assert.equal(clock.elapsed(), 0);
});

test("zero title matches with three accessible controls complete discovery", async () => {
  const err = await fail(framed({
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1 })],
  }));
  assert.equal(err, null);
});

test("missing accessible controls fail closed", async () => {
  const err = await fail(framed({
    frames: [roleFrame({ missing: true })],
  }));
  assert.equal((err as { browserStage: string }).browserStage, "card_field_discovery");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_field_missing");
  assertSafe(err);
});

test("duplicate accessible controls are ambiguous", async () => {
  const duplicateFrame = await fail(framed({
    frames: [roleFrame({ card: 2, expiry: 1, cvc: 1 })],
  }));
  assert.equal((duplicateFrame as { browserFailure: string }).browserFailure, "checkout_field_ambiguous");
  const duplicateAcrossFrames = await fail(framed({
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1 }), roleFrame({ card: 1 })],
  }));
  assert.equal((duplicateAcrossFrames as { browserFailure: string }).browserFailure, "checkout_field_ambiguous");
  const repeated = roleFrame({ card: 1, expiry: 1, cvc: 1 });
  const duplicateReference = await fail(framed({ frames: [repeated, repeated] }));
  assert.equal((duplicateReference as { browserFailure: string }).browserFailure, "checkout_field_ambiguous");
  assertSafe(duplicateReference);
});

test("a detached frame cannot be used for payment", async () => {
  const err = await fail(framed({
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1, detached: true })],
  }));
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_field_missing");
  assertSafe(err);
});

test("accessible discovery shares one 20 second budget", async () => {
  const clock = virtualClock();
  const err = await fail(framed({
    clock,
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1, appearAt: 20_000, clock })],
  }), clock);
  assert.equal(err, null);
  assert.equal(clock.elapsed(), CARD_FIELD_DISCOVERY_BUDGET_MS);
  const timeout = await fail(framed({
    clock: virtualClock(),
    frames: [roleFrame({ clock: virtualClock() })],
  }));
  assert.equal((timeout as { browserFailure: string }).browserFailure, "checkout_field_timeout");
});

test("visible hCaptcha and 3-D Secure challenges block payment", async () => {
  const captcha = await fail(framed({
    challenges: async () => ({ ...CLEAR_CHALLENGE, visibleHcaptcha: 1 }),
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1 })],
  }));
  assert.equal((captcha as { browserStage: string }).browserStage, "challenge_detection");
  assert.equal((captcha as { browserFailure: string }).browserFailure, "checkout_challenge");
  const threeDs = await fail(framed({
    challenges: async () => ({ ...CLEAR_CHALLENGE, visibleThreeDs: 1 }),
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1 })],
  }));
  assert.equal((threeDs as { browserFailure: string }).browserFailure, "checkout_challenge");
  assertSafe(captcha);
});

test("a background 3ds frame does not override valid card controls", async () => {
  const err = await fail(framed({
    challenges: async () => ({ ...CLEAR_CHALLENGE, backgroundThreeDs: 1 }),
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1 })],
  }));
  assert.equal(err, null);
});

test("an ambiguous challenge fails closed", async () => {
  const err = await fail(framed({
    challenges: async () => ({ ...CLEAR_CHALLENGE, ambiguous: 1 }),
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1 })],
  }));
  assert.equal((err as { browserStage: string }).browserStage, "challenge_detection");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_challenge");
  assertSafe(err);
});

test("challenge state is checked again after discovery and before submission", async () => {
  let calls = 0;
  let clicked = false;
  const err = await fail(framed({
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1 })],
    challenges: async () => {
      calls += 1;
      return calls < 4 ? CLEAR_CHALLENGE : { ...CLEAR_CHALLENGE, visibleCaptcha: 1 };
    },
    click: async () => { clicked = true; },
  }));
  assert.equal((err as { browserStage: string }).browserStage, "challenge_detection");
  assert.equal(clicked, false);
  assert.ok(calls >= 4);
});

test("challenge inspection errors do not leak sensitive output", async () => {
  const err = await fail(framed({
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1 })],
    challenges: async () => { throw named("Error"); },
  }));
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_challenge");
  assertSafe(err);
});

test("challenge classification separates background infrastructure from an active challenge", () => {
  const hidden = readIframeMeasurement({
    getAttribute: (name) => name === "src" ? "https://js.stripe.com/v3/3ds2-method.html" : null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "none", visibility: "hidden" }) } },
  });
  assert.equal(hidden.visible, false);
  assert.equal(classifyChallengeFrames([hidden]).backgroundThreeDs, 1);
  const ariaHiddenBackground = readIframeMeasurement({
    getAttribute: (name) => name === "src" ? "https://js.stripe.com/v3/3ds2-method.html" : name === "aria-hidden" ? "true" : null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "none", visibility: "hidden" }) } },
  });
  assert.equal(ariaHiddenBackground.visible, false);
  assert.equal(classifyChallengeFrames([ariaHiddenBackground]).backgroundThreeDs, 1);
  assert.equal(classifyChallengeFrames([ariaHiddenBackground]).ambiguous, 0);
  const conflicting = readIframeMeasurement({
    getAttribute: (name) => name === "src" ? "https://js.stripe.com/v3/3ds2-challenge.html" : name === "aria-hidden" ? "true" : null,
    getBoundingClientRect: () => ({ width: 400, height: 600 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) } },
  });
  assert.equal(conflicting.visible, null);
  assert.equal(classifyChallengeFrames([conflicting]).ambiguous, 1);
  assert.equal(classifyChallengeFrames([conflicting]).backgroundThreeDs, 0);
  assert.equal(classifyChallengeFrames([conflicting]).visibleThreeDs, 0);
  const cssHiddenBox = readIframeMeasurement({
    getAttribute: (name) => name === "src" ? "https://js.stripe.com/v3/3ds2-method.html" : name === "aria-hidden" ? "true" : null,
    getBoundingClientRect: () => ({ width: 1, height: 1 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "block", visibility: "hidden" }) } },
  });
  assert.equal(cssHiddenBox.visible, false);
  assert.equal(classifyChallengeFrames([cssHiddenBox]).backgroundThreeDs, 1);
  assert.equal(classifyChallengeFrames([cssHiddenBox]).ambiguous, 0);
  const visible = readIframeMeasurement({
    title: "3D Secure",
    getAttribute: () => "https://hooks.stripe.com/3d-secure",
    getBoundingClientRect: () => ({ width: 400, height: 600 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) } },
  });
  assert.equal(classifyChallengeFrames([visible]).visibleThreeDs, 1);
  const hiddenCaptcha = readIframeMeasurement({
    getAttribute: (name) => name === "src" ? "https://hcaptcha.com/widget" : null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "none", visibility: "hidden" }) } },
  });
  assert.equal(classifyChallengeFrames([hiddenCaptcha]).ambiguous, 1);
  const unknown = readIframeMeasurement({
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
  });
  assert.equal(unknown.visible, null);
  assert.equal(classifyChallengeFrames([unknown]).ambiguous, 0);
});

test("playwright frame identity stays stable and an unreadable frame fails closed", async () => {
  const child = {
    isDetached: () => false,
    parentFrame: () => ({}) as never,
    getByRole: () => ({ async count() { return 0; }, async fill() { return undefined; } }),
    async frameElement() {
      return { async evaluate(fn: typeof readIframeMeasurement) {
        return fn({
          getAttribute: (name) => name === "src" ? "https://js.stripe.com/v3/3ds2.html" : null,
          getBoundingClientRect: () => ({ width: 0, height: 0 }),
          ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "none", visibility: "hidden" }) } },
        });
      } };
    },
  };
  const main = {
    isDetached: () => false,
    parentFrame: () => null,
    getByRole: () => ({ async count() { return 0; }, async fill() { return undefined; } }),
    async frameElement() { throw new Error("Frame is not an iframe"); },
  };
  const raw = {
    async goto() { return undefined; },
    locator: () => ({ async count() { return 0; } }),
    frameLocator: () => ({ locator: () => ({ async count() { return 0; }, async fill() { return undefined; } }) }),
    getByRole: () => ({ async click() { return undefined; } }),
    async waitForURL() { return undefined; },
    frames: () => [main, child],
  };
  const adapted = adaptPlaywrightCheckoutPage(raw as never);
  const first = adapted.frames?.() ?? [];
  const second = adapted.frames?.() ?? [];
  assert.equal(first[1], second[1]);
  const inspection = await inspectPlaywrightChallenges(raw as never);
  assert.equal(inspection.backgroundThreeDs, 1);
  assert.equal(inspection.ambiguous, 0);
  child.frameElement = async () => { throw new Error(SECRET_TEXT); };
  const blocked = await inspectPlaywrightChallenges(raw as never);
  assert.equal(blocked.ambiguous, 1);
  assert.equal(JSON.stringify(blocked).includes("4242"), false);
  assert.equal(JSON.stringify(blocked).includes("secret"), false);
});

test("a visibly sized aria-hidden challenge iframe blocks payment", async () => {
  let filled = false;
  const err = await fail(framed({
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1, onFill: () => { filled = true; } })],
    challenges: async () => classifyChallengeFrames([readIframeMeasurement({
      getAttribute: (name) => name === "src" ? "https://js.stripe.com/v3/3ds2.html" : name === "aria-hidden" ? "true" : null,
      getBoundingClientRect: () => ({ width: 400, height: 600 }),
      ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) } },
    })]),
  }));
  assert.equal((err as { browserStage: string }).browserStage, "challenge_detection");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_challenge");
  assert.equal(filled, false);
  assertSafe(err);
});

test("a stalled locator cannot be used after the shared discovery deadline", async () => {
  const clock = virtualClock();
  let filled = false;
  let clicked = false;
  let seenTimeout = -1;
  let titles = 0;
  const err = await fail({
    async newPage() {
      return {
        async goto() { return undefined; },
        locator: () => ({ async count() { return 0; } }),
        frameLocator: () => ({
          locator: () => ({
            async count() {
              titles += 1;
              if (titles === 1) await clock.wait(15_000);
              return 0;
            },
            async fill() { filled = true; },
          }),
        }),
        frames: () => [{
          isDetached: () => false,
          getByRole: () => ({
            async count(options?: { timeout?: number }) {
              seenTimeout = options?.timeout ?? -1;
              await clock.wait(options?.timeout ?? 0);
              return 1;
            },
            async fill() { filled = true; },
          }),
        }],
        inspectChallenges: async () => CLEAR_CHALLENGE,
        getByRole: () => ({ async click() { clicked = true; } }),
        async waitForURL() { return undefined; },
      };
    },
    async close() { return undefined; },
  }, clock);
  assert.equal((err as { browserStage: string }).browserStage, "card_field_discovery");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_field_timeout");
  assert.equal(filled, false);
  assert.equal(clicked, false);
  assert.equal(seenTimeout, 5_000);
  assert.equal(clock.elapsed(), CARD_FIELD_DISCOVERY_BUDGET_MS);
  assertSafe(err);
});

test("a stalled challenge inspection cannot fall through to payment", async () => {
  const clock = virtualClock();
  let filled = false;
  const err = await fail(framed({
    clock,
    frames: [roleFrame({ card: 1, expiry: 1, cvc: 1, onFill: () => { filled = true; } })],
    challenges: async (options) => {
      if ((options?.timeout ?? 0) > 0) await clock.wait(options?.timeout ?? 0);
      return CLEAR_CHALLENGE;
    },
  }), clock);
  assert.equal((err as { browserStage: string }).browserStage, "card_field_discovery");
  assert.equal((err as { browserFailure: string }).browserFailure, "checkout_field_timeout");
  assert.equal(filled, false);
  assert.equal(clock.elapsed(), CARD_FIELD_DISCOVERY_BUDGET_MS);
  assertSafe(err);
});
