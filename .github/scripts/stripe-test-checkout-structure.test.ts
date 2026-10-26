import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHECKOUT_STRUCTURE_PROBE_GATE,
  STRUCTURE_OBSERVATION_BUDGET_MS,
  STRUCTURE_SELECTORS,
  observeCheckoutStructure,
  readPlaywrightStructure,
  runCheckoutStructureProbe,
  type StructureBrowserPage,
  type StructureClock,
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
    elapsed: () => time,
  };
}

function page(input: {
  iframes?: number;
  titles?: Partial<Record<"card" | "expiry" | "cvc", number>>;
  controls?: Partial<Record<"card" | "expiry" | "cvc" | "link" | "wallet", number>>;
  challenge?: number;
  fail?: boolean;
} = {}): StructureBrowserPage & { forbidden(): number } {
  let forbidden = 0;
  const titles = { card: 0, expiry: 0, cvc: 0, ...input.titles };
  const controls = { card: 0, expiry: 0, cvc: 0, link: 0, wallet: 0, ...input.controls };
  const countFor = (selector: string) => {
    if (input.fail) throw new Error(SECRET);
    if (selector === STRUCTURE_SELECTORS.iframe) return input.iframes ?? 0;
    if (selector === STRUCTURE_SELECTORS.cardTitle) return titles.card;
    if (selector === STRUCTURE_SELECTORS.expiryTitle) return titles.expiry;
    if (selector === STRUCTURE_SELECTORS.cvcTitle) return titles.cvc;
    if (selector === STRUCTURE_SELECTORS.challenge) return input.challenge ?? 0;
    forbidden += 1;
    throw new Error(SECRET);
  };
  const roleCount = (name: RegExp) => {
    if (CARD_NAME.test("card number") && name.source === CARD_NAME.source) return controls.card;
    if (name.source === EXPIRY_NAME.source) return controls.expiry;
    if (name.source === CVC_NAME.source) return controls.cvc;
    if (name.source === LINK_NAME.source) return controls.link;
    if (name.source === WALLET_NAME.source) return controls.wallet;
    return 0;
  };
  return {
    locator(selector: string) {
      return { async count() { return countFor(selector); } };
    },
    getByRole(_role, options) {
      return { async count() { return roleCount(options.name); } };
    },
    frameLocator(selector: string) {
      if (selector !== STRUCTURE_SELECTORS.iframe) {
        forbidden += 1;
        throw new Error(SECRET);
      }
      return {
        getByRole(_role, options) {
          return { async count() { return roleCount(options.name); } };
        },
      };
    },
    forbidden: () => forbidden,
  };
}

const CARD_NAME = /card number/i;
const EXPIRY_NAME = /expir/i;
const CVC_NAME = /cvc|security code/i;
const LINK_NAME = /^link$/i;
const WALLET_NAME = /google pay|apple pay|paypal/i;

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
    report: await observeCheckoutStructure({ read: () => readPlaywrightStructure(source) }, time),
    time,
  };
}

test("no iframe matches time out without payment controls", async () => {
  const { report, time } = await observe(page());
  assert.equal(report.observation, "timeout");
  assert.equal(report.formDetected, false);
  assert.equal(report.iframeCount, 0);
  assert.equal(report.cardNumberTitle, false);
  assert.equal(time.elapsed(), STRUCTURE_OBSERVATION_BUDGET_MS);
  assertRedacted(report);
});

test("three known iframe titles are detected", async () => {
  const { report, time } = await observe(page({
    iframes: 3,
    titles: { card: 1, expiry: 1, cvc: 1 },
  }));
  assert.equal(report.observation, "ready");
  assert.equal(report.formDetected, true);
  assert.equal(report.cardNumberTitleCount, 1);
  assert.equal(report.expiryTitleCount, 1);
  assert.equal(report.cvcTitleCount, 1);
  assert.equal(time.elapsed(), 0);
});

test("one unified payment iframe is detected from accessible controls", async () => {
  const { report } = await observe(page({
    iframes: 1,
    controls: { card: 1, expiry: 1, cvc: 1 },
  }));
  assert.equal(report.observation, "ready");
  assert.equal(report.cardNumberTitle, false);
  assert.equal(report.cardNumberControl, true);
  assert.equal(report.expiryControl, true);
  assert.equal(report.cvcControl, true);
  assert.equal(report.formDetected, true);
});

test("delayed card structure stays within one observation budget", async () => {
  const time = clock();
  let reads = 0;
  const report = await observeCheckoutStructure({
    async read(): Promise<StructureSignals> {
      reads += 1;
      const visible = time.now() >= 100;
      return {
        iframeCount: visible ? 3 : 0,
        titleCounts: { card: visible ? 1 : 0, expiry: visible ? 1 : 0, cvc: visible ? 1 : 0 },
        controls: { card: false, expiry: false, cvc: false, link: false, wallet: false, challenge: false },
      };
    },
  }, time);
  assert.equal(report.observation, "ready");
  assert.equal(report.formDetected, true);
  assert.equal(time.elapsed(), 100);
  assert.ok(reads > 1);
});

test("Link and wallet controls are reported and not activated", async () => {
  const fake = page({
    iframes: 3,
    titles: { card: 1, expiry: 1, cvc: 1 },
    controls: { link: 1, wallet: 1 },
  });
  const { report } = await observe(fake);
  assert.equal(report.linkControl, true);
  assert.equal(report.walletControl, true);
  assert.equal(report.observation, "ready");
  assert.equal(fake.forbidden(), 0);
});

test("a challenge stops observation", async () => {
  const { report, time } = await observe(page({ challenge: 1, iframes: 2 }));
  assert.equal(report.observation, "challenge");
  assert.equal(report.challenge, true);
  assert.equal(time.elapsed(), 0);
});

test("multiple title matches are ambiguous and capped", async () => {
  const { report } = await observe(page({
    iframes: 12,
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
});
