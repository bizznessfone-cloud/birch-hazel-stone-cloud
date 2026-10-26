/**
 * Disabled Stripe-hosted Checkout structure probe.
 * It records allowlisted layout facts only. It does not pay, click, or fill fields.
 * CHECKOUT_STRUCTURE_PROBE_GATE is independent of the payment execution gate.
 */
export const CHECKOUT_STRUCTURE_PROBE_GATE = "closed" as const;

export const STRUCTURE_OBSERVATION_BUDGET_MS = 20_000;

export const STRUCTURE_SELECTORS = {
  iframe: "iframe",
  cardTitle: 'iframe[title*="card number" i]',
  expiryTitle: 'iframe[title*="expir" i]',
  cvcTitle: 'iframe[title*="CVC" i]',
  challenge: 'iframe[src*="hcaptcha"], iframe[src*="3ds"], iframe[title*="3D Secure" i], iframe[title*="captcha" i]',
} as const;

const CARD_NAME = /card number/i;
const EXPIRY_NAME = /expir/i;
const CVC_NAME = /cvc|security code/i;
const LINK_NAME = /^link$/i;
const WALLET_NAME = /google pay|apple pay|paypal/i;

export type StructureObservation = "ready" | "timeout" | "ambiguous" | "challenge" | "unexpected";

export type CheckoutStructureReport = {
  probe: "checkout_structure";
  iframeCount: number;
  iframeCountCapped: boolean;
  cardNumberTitle: boolean;
  expiryTitle: boolean;
  cvcTitle: boolean;
  cardNumberTitleCount: number;
  expiryTitleCount: number;
  cvcTitleCount: number;
  cardNumberControl: boolean;
  expiryControl: boolean;
  cvcControl: boolean;
  linkControl: boolean;
  walletControl: boolean;
  challenge: boolean;
  formDetected: boolean;
  observation: StructureObservation;
};

export type StructureClock = {
  now(): number;
  wait(ms: number): Promise<void>;
};

export type StructureSignals = {
  iframeCount: number;
  titleCounts: { card: number; expiry: number; cvc: number };
  controls: { card: boolean; expiry: boolean; cvc: boolean; link: boolean; wallet: boolean; challenge: boolean };
};

export type StructureSource = {
  read(): Promise<StructureSignals>;
};

type Countable = { count(): Promise<number> };

export type StructureBrowserPage = {
  locator(selector: string): Countable;
  getByRole(role: "button" | "link" | "textbox", options: { name: RegExp }): Countable;
  frameLocator(selector: string): {
    getByRole(role: "button" | "link" | "textbox", options: { name: RegExp }): Countable;
  };
};

const realClock: StructureClock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function capSmall(count: number): number {
  if (!Number.isInteger(count) || count <= 0) return 0;
  return Math.min(count, 3);
}

function capIframes(count: number): { iframeCount: number; iframeCountCapped: boolean } {
  if (!Number.isInteger(count) || count <= 0) return { iframeCount: 0, iframeCountCapped: false };
  if (count > 9) return { iframeCount: 9, iframeCountCapped: true };
  return { iframeCount: count, iframeCountCapped: false };
}

function formReady(signals: StructureSignals): boolean {
  const titles = signals.titleCounts.card === 1 && signals.titleCounts.expiry === 1 && signals.titleCounts.cvc === 1;
  const controls = signals.controls.card && signals.controls.expiry && signals.controls.cvc;
  return titles || controls;
}

function titleAmbiguous(signals: StructureSignals): boolean {
  return signals.titleCounts.card > 1 || signals.titleCounts.expiry > 1 || signals.titleCounts.cvc > 1;
}

function reportFrom(signals: StructureSignals | null, observation: StructureObservation): CheckoutStructureReport {
  const titles = signals?.titleCounts ?? { card: 0, expiry: 0, cvc: 0 };
  const controls = signals?.controls ?? {
    card: false, expiry: false, cvc: false, link: false, wallet: false, challenge: false,
  };
  const iframes = capIframes(signals?.iframeCount ?? 0);
  const cardNumberTitleCount = capSmall(titles.card);
  const expiryTitleCount = capSmall(titles.expiry);
  const cvcTitleCount = capSmall(titles.cvc);
  return {
    probe: "checkout_structure",
    ...iframes,
    cardNumberTitle: cardNumberTitleCount > 0,
    expiryTitle: expiryTitleCount > 0,
    cvcTitle: cvcTitleCount > 0,
    cardNumberTitleCount,
    expiryTitleCount,
    cvcTitleCount,
    cardNumberControl: controls.card === true,
    expiryControl: controls.expiry === true,
    cvcControl: controls.cvc === true,
    linkControl: controls.link === true,
    walletControl: controls.wallet === true,
    challenge: controls.challenge === true,
    formDetected: signals != null && observation !== "unexpected" && formReady(signals),
    observation,
  };
}

async function rolePresent(
  page: StructureBrowserPage,
  role: "button" | "link" | "textbox",
  name: RegExp,
): Promise<boolean> {
  const direct = await page.getByRole(role, { name }).count();
  const framed = await page.frameLocator(STRUCTURE_SELECTORS.iframe).getByRole(role, { name }).count();
  return direct > 0 || framed > 0;
}

export async function readPlaywrightStructure(page: StructureBrowserPage): Promise<StructureSignals> {
  const [iframeCount, card, expiry, cvc, challenge] = await Promise.all([
    page.locator(STRUCTURE_SELECTORS.iframe).count(),
    page.locator(STRUCTURE_SELECTORS.cardTitle).count(),
    page.locator(STRUCTURE_SELECTORS.expiryTitle).count(),
    page.locator(STRUCTURE_SELECTORS.cvcTitle).count(),
    page.locator(STRUCTURE_SELECTORS.challenge).count(),
  ]);
  return {
    iframeCount,
    titleCounts: { card, expiry, cvc },
    controls: {
      card: await rolePresent(page, "textbox", CARD_NAME),
      expiry: await rolePresent(page, "textbox", EXPIRY_NAME),
      cvc: await rolePresent(page, "textbox", CVC_NAME),
      link: await rolePresent(page, "button", LINK_NAME),
      wallet: await rolePresent(page, "button", WALLET_NAME),
      challenge: challenge > 0,
    },
  };
}

export async function observeCheckoutStructure(
  source: StructureSource,
  clock: StructureClock = realClock,
): Promise<CheckoutStructureReport> {
  const deadline = clock.now() + STRUCTURE_OBSERVATION_BUDGET_MS;
  while (true) {
    let signals: StructureSignals;
    try {
      signals = await source.read();
    } catch {
      return reportFrom(null, "unexpected");
    }
    if (signals.controls.challenge) return reportFrom(signals, "challenge");
    if (titleAmbiguous(signals)) return reportFrom(signals, "ambiguous");
    if (formReady(signals)) return reportFrom(signals, "ready");
    if (clock.now() >= deadline) return reportFrom(signals, "timeout");
    const slice = Math.min(50, deadline - clock.now());
    if (slice <= 0) return reportFrom(signals, "timeout");
    await clock.wait(slice);
  }
}

/**
 * Future Stripe execution stays unreachable. Opening the gate constant is not
 * enough: this checkpoint has no Checkout or browser entrypoint.
 */
export async function runCheckoutStructureProbe(execute?: () => Promise<unknown>): Promise<never> {
  void execute;
  if (CHECKOUT_STRUCTURE_PROBE_GATE === "closed") throw new Error("checkout_structure_probe_closed");
  throw new Error("checkout_structure_probe_not_implemented");
}
