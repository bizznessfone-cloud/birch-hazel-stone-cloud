import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHECKOUT_STRUCTURE_PROBE_GATE,
  STRUCTURE_OBSERVATION_BUDGET_MS,
  STRUCTURE_SELECTORS,
  observeCheckoutStructure,
  readPlaywrightStructure,
  realStructureClock,
  runCheckoutStructureProbe,
  type StructureBrowserPage,
  type StructureClock,
  type StructureFrame,
  type StructureSignals,
} from "./stripe-test-checkout-structure.ts";

const SECRET = "https://checkout.stripe.com/c/pay/secret rk_test_secret 4242424242424242 raw-title";

function clock(): StructureClock & { elapsed(): number } {
  let time = 0;
  return {
    now: () => time,
    async wait(ms: number) {
      time += ms;
    },
    async limit(operation, ms) {
      if (ms <= 0) throw Object.assign(new Error("structure_observation_timeout"), { name: "DeadlineExceeded" });
      try {
        return await operation();
      } catch (err) {
        if (err instanceof Error && err.name === "StallError") {
          time += ms;
          throw Object.assign(new Error("structure_observation_timeout"), { name: "DeadlineExceeded" });
        }
        throw err;
      }
    },
    elapsed: () => time,
  };
}

const CARD_NAME = /card number/i;
const EXPIRY_NAME = /expir/i;
const CVC_NAME = /cvc|security code/i;
const LINK_NAME = /^link$/i;
const WALLET_NAME = /google pay|apple pay|paypal/i;

function frame(input: {
  controls?: Partial<Record<"card" | "expiry" | "cvc" | "link" | "wallet", number>>;
  detached?: boolean;
  detachOnRead?: boolean;
} = {}): StructureFrame & { inspected: number } {
  let detached = input.detached === true;
  let inspected = 0;
  const controls = { card: 0, expiry: 0, cvc: 0, link: 0, wallet: 0, ...input.controls };
  const countFor = (name: RegExp) => {
    inspected += 1;
    if (input.detachOnRead) detached = true;
    if (name.source === CARD_NAME.source) return controls.card;
    if (name.source === EXPIRY_NAME.source) return controls.expiry;
    if (name.source === CVC_NAME.source) return controls.cvc;
    if (name.source === LINK_NAME.source) return controls.link;
    if (name.source === WALLET_NAME.source) return controls.wallet;
    return 0;
  };
  return {
    getByRole(_role, options) {
      return { async count() { return countFor(options.name); } };
    },
    isDetached: () => detached,
    get inspected() { return inspected; },
  };
}

function page(input: {
  titles?: Partial<Record<"card" | "expiry" | "cvc", number>>;
  challenge?: number;
  frames?: StructureFrame[];
  domIframes?: number;
  stallAt?: number;
  slowFirst?: number;
  clock?: StructureClock;
  fail?: boolean;
} = {}): StructureBrowserPage & { forbidden: number } {
  const titles = { card: 0, expiry: 0, cvc: 0, ...input.titles };
  const frames = input.frames ?? [frame()];
  const domIframes = input.domIframes ?? Math.max(0, frames.length - 1);
  let calls = 0;
  let forbidden = 0;
  const countFor = async (selector: string) => {
    calls += 1;
    if (input.fail) throw new Error(SECRET);
    if (input.slowFirst && calls === 1) await input.clock?.wait(input.slowFirst);
    if (input.stallAt === calls) throw Object.assign(new Error(SECRET), { name: "StallError" });
    if (selector === STRUCTURE_SELECTORS.iframe) return domIframes;
    if (selector === STRUCTURE_SELECTORS.cardTitle) return titles.card;
    if (selector === STRUCTURE_SELECTORS.expiryTitle) return titles.expiry;
    if (selector === STRUCTURE_SELECTORS.cvcTitle) return titles.cvc;
    if (selector === STRUCTURE_SELECTORS.challenge) return input.challenge ?? 0;
    forbidden += 1;
    throw new Error(SECRET);
  };
  return {
    locator(selector: string) {
      return { count: () => countFor(selector) };
    },
    frames: () => frames,
    get forbidden() { return forbidden; },
  };
}

function assertRedacted(value: unknown): void {
  const text = JSON.stringify(value);
  assert.equal(text.includes("checkout.stripe.com"), false);
  assert.equal(text.includes("4242"), false);
  assert.equal(text.includes("rk_test_"), false);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("raw-title"), false);
}

async function observe(source: StructureBrowserPage, time = clock()) {
  return {
    report: await observeCheckoutStructure({
      read: (context) => readPlaywrightStructure(source, context.deadline, context.clock),
    }, time),
    time,
  };
}

test("main frame only times out without payment controls", async () => {
  const { report, time } = await observe(page({ domIframes: 0 }));
  assert.equal(report.observation, "timeout");
  assert.equal(report.formDetected, false);
  assert.equal(report.iframeCount, 0);
  assert.equal(time.elapsed(), STRUCTURE_OBSERVATION_BUDGET_MS);
  assertRedacted(report);
});

test("one child frame with card controls is detected", async () => {
  const child = frame({ controls: { card: 1, expiry: 1, cvc: 1 } });
  const { report } = await observe(page({ frames: [frame(), child] }));
  assert.equal(report.observation, "ready");
  assert.equal(report.iframeCount, 1);
  assert.equal(report.formDetected, true);
  assert.ok(child.inspected > 0);
});

test("multiple sibling frames are inspected separately", async () => {
  const first = frame();
  const second = frame();
  const third = frame();
  const { report } = await observe(page({
    frames: [frame(), first, second, third],
    titles: { card: 1, expiry: 1, cvc: 1 },
  }));
  assert.equal(report.observation, "ready");
  assert.equal(report.iframeCount, 3);
  assert.ok(first.inspected > 0);
  assert.ok(second.inspected > 0);
  assert.ok(third.inspected > 0);
});

test("nested grandchild frames are inspected", async () => {
  const grandchild = frame({ controls: { card: 1, expiry: 1, cvc: 1 } });
  const { report } = await observe(page({
    frames: [frame(), frame(), grandchild],
    domIframes: 1,
  }));
  assert.equal(report.observation, "ready");
  assert.equal(report.iframeCount, 1);
  assert.equal(report.formDetected, true);
  assert.ok(grandchild.inspected > 0);
});

test("controls inside nested frames are combined", async () => {
  const { report } = await observe(page({
    frames: [
      frame(),
      frame({ controls: { card: 1 } }),
      frame({ controls: { expiry: 1, cvc: 1 } }),
    ],
    domIframes: 1,
  }));
  assert.equal(report.observation, "ready");
  assert.equal(report.cardNumberControl, true);
  assert.equal(report.expiryControl, true);
  assert.equal(report.cvcControl, true);
  assert.equal(report.iframeCount, 1);
});

test("a DOM iframe count may differ from the attached frame count", async () => {
  const { report } = await observe(page({
    frames: [frame(), frame({ controls: { card: 1, expiry: 1, cvc: 1 } })],
    domIframes: 4,
  }));
  assert.equal(report.observation, "ready");
  assert.equal(report.iframeCount, 4);
  assert.equal(report.formDetected, true);
});

test("a detached frame stops as unexpected", async () => {
  const time = clock();
  const { report } = await observe(page({
    frames: [frame(), frame({ detachOnRead: true })],
  }), time);
  assert.equal(report.observation, "unexpected");
  assert.equal(report.formDetected, false);
  assert.equal(time.elapsed(), 0);
  assertRedacted(report);
});

test("duplicate frame references stop as unexpected", async () => {
  const child = frame({ controls: { card: 1, expiry: 1, cvc: 1 } });
  const time = clock();
  const { report } = await observe(page({ frames: [frame(), child, child] }), time);
  assert.equal(report.observation, "unexpected");
  assert.equal(time.elapsed(), 0);
});

test("a stalled browser read times out once on the shared deadline", async () => {
  const time = clock();
  let reads = 0;
  const report = await observeCheckoutStructure({
    async read(context) {
      reads += 1;
      return readPlaywrightStructure(page({ stallAt: 1, clock: time }), context.deadline, context.clock);
    },
  }, time);
  assert.equal(report.observation, "timeout");
  assert.equal(reads, 1);
  assert.equal(time.elapsed(), STRUCTURE_OBSERVATION_BUDGET_MS);
  assertRedacted(report);
});

test("later reads cannot restart the observation deadline", async () => {
  const time = clock();
  const report = await observeCheckoutStructure({
    read: (context) => readPlaywrightStructure(page({
      slowFirst: 15_000,
      stallAt: 2,
      clock: time,
    }), context.deadline, context.clock),
  }, time);
  assert.equal(report.observation, "timeout");
  assert.equal(time.elapsed(), STRUCTURE_OBSERVATION_BUDGET_MS);
});

test("delayed card structure stays within one observation budget", async () => {
  const time = clock();
  let reads = 0;
  const report = await observeCheckoutStructure({
    async read(): Promise<StructureSignals> {
      reads += 1;
      const visible = time.now() >= 100;
      return {
        iframeCount: visible ? 1 : 0,
        titleCounts: { card: visible ? 1 : 0, expiry: visible ? 1 : 0, cvc: visible ? 1 : 0 },
        controls: { card: false, expiry: false, cvc: false, link: false, wallet: false, challenge: false },
      };
    },
  }, time);
  assert.equal(report.observation, "ready");
  assert.equal(time.elapsed(), 100);
  assert.ok(reads > 1);
});

test("a challenge stops observation", async () => {
  const { report, time } = await observe(page({ challenge: 1 }));
  assert.equal(report.observation, "challenge");
  assert.equal(report.challenge, true);
  assert.equal(time.elapsed(), 0);
});

test("multiple title matches are ambiguous and capped", async () => {
  const frames = [frame(), ...Array.from({ length: 12 }, () => frame())];
  const { report } = await observe(page({
    frames,
    titles: { card: 4, expiry: 1, cvc: 1 },
  }));
  assert.equal(report.observation, "ambiguous");
  assert.equal(report.cardNumberTitleCount, 3);
  assert.equal(report.iframeCount, 9);
  assert.equal(report.iframeCountCapped, true);
});

test("unexpected browser errors expose no raw message", async () => {
  const report = await observeCheckoutStructure({
    async read() {
      throw new Error(SECRET);
    },
  }, clock());
  assert.equal(report.observation, "unexpected");
  assert.equal(report.formDetected, false);
  assertRedacted(report);
});

test("Link and wallet controls are reported and not activated", async () => {
  const fake = page({
    frames: [frame(), frame({ controls: { card: 1, expiry: 1, cvc: 1, link: 1, wallet: 1 } })],
  });
  const { report } = await observe(fake);
  assert.equal(report.linkControl, true);
  assert.equal(report.walletControl, true);
  assert.equal(fake.forbidden, 0);
});

test("a real stalled read is bounded and cannot reject later", async () => {
  const report = await observeCheckoutStructure({
    read: ({ deadline, clock: active }) => active.limit(
      () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error(SECRET)), 250);
      }),
      deadline - active.now(),
    ),
  }, realStructureClock, 40);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(report.observation, "timeout");
  assertRedacted(report);
});

test("the structure probe is disabled and has no payment entry", async () => {
  assert.equal(CHECKOUT_STRUCTURE_PROBE_GATE, "closed");
  let called = false;
  await assert.rejects(
    () => runCheckoutStructureProbe(async () => {
      called = true;
    }),
    /checkout_structure_probe_closed/,
  );
  assert.equal(called, false);
  const source = readPlaywrightStructure.toString();
  assert.equal(source.includes(".fill("), false);
  assert.equal(source.includes(".click("), false);
  assert.equal(source.includes("frameLocator("), false);
  assert.equal(source.includes(".url("), false);
  assert.equal(source.includes("checkout.sessions"), false);
  assert.equal(source.includes("!== iframeCount"), false);
});
