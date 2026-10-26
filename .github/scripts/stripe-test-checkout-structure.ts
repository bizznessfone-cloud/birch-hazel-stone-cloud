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
  limit<T>(operation: () => Promise<T>, ms: number): Promise<T>;
};

export type StructureSignals = {
  iframeCount: number;
  titleCounts: { card: number; expiry: number; cvc: number };
  controls: { card: boolean; expiry: boolean; cvc: boolean; link: boolean; wallet: boolean; challenge: boolean };
};

export type StructureReadContext = {
  deadline: number;
  clock: StructureClock;
};

export type StructureSource = {
  read(context: StructureReadContext): Promise<StructureSignals>;
};

type Countable = { count(): Promise<number> };

export type StructureFrame = {
  getByRole(role: "button" | "textbox", options: { name: RegExp }): Countable;
  isDetached(): boolean;
  identity(): string;
};

export type StructureBrowserPage = {
  locator(selector: string): Countable;
  mainFrame(): StructureFrame;
  childFrames(): StructureFrame[];
};

class DeadlineExceeded extends Error {
  constructor() {
    super("structure_observation_timeout");
    this.name = "DeadlineExceeded";
  }
}

function isDeadline(err: unknown): boolean {
  return err instanceof DeadlineExceeded || (err instanceof Error && err.name === "DeadlineExceeded");
}

class StructureFrameLost extends Error {
  constructor() {
    super("structure_frame_lost");
    this.name = "StructureFrameLost";
  }
}

export const realStructureClock: StructureClock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  async limit(operation, ms) {
    if (ms <= 0) throw new DeadlineExceeded();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = operation().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DeadlineExceeded()), ms);
        }),
      ]);
      if (!result.ok) throw result.error;
      return result.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
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

async function bounded<T>(operation: () => Promise<T>, deadline: number, clock: StructureClock): Promise<T> {
  const remaining = deadline - clock.now();
  if (remaining <= 0) throw new DeadlineExceeded();
  return clock.limit(operation, remaining);
}

async function rolePresent(frame: StructureFrame, role: "button" | "textbox", name: RegExp, deadline: number, clock: StructureClock): Promise<boolean> {
  const before = frame.identity();
  if (frame.isDetached()) throw new StructureFrameLost();
  const count = await bounded(() => frame.getByRole(role, { name }).count(), deadline, clock);
  if (frame.isDetached() || frame.identity() !== before) throw new StructureFrameLost();
  return count > 0;
}

async function controlsIn(frame: StructureFrame, deadline: number, clock: StructureClock): Promise<StructureSignals["controls"]> {
  return {
    card: await rolePresent(frame, "textbox", CARD_NAME, deadline, clock),
    expiry: await rolePresent(frame, "textbox", EXPIRY_NAME, deadline, clock),
    cvc: await rolePresent(frame, "textbox", CVC_NAME, deadline, clock),
    link: await rolePresent(frame, "button", LINK_NAME, deadline, clock),
    wallet: await rolePresent(frame, "button", WALLET_NAME, deadline, clock),
    challenge: false,
  };
}

function mergeControls(frames: StructureSignals["controls"][]): StructureSignals["controls"] {
  return {
    card: frames.some((frame) => frame.card),
    expiry: frames.some((frame) => frame.expiry),
    cvc: frames.some((frame) => frame.cvc),
    link: frames.some((frame) => frame.link),
    wallet: frames.some((frame) => frame.wallet),
    challenge: false,
  };
}

export async function readPlaywrightStructure(
  page: StructureBrowserPage,
  deadline: number,
  clock: StructureClock,
): Promise<StructureSignals> {
  const iframeCount = await bounded(() => page.locator(STRUCTURE_SELECTORS.iframe).count(), deadline, clock);
  const card = await bounded(() => page.locator(STRUCTURE_SELECTORS.cardTitle).count(), deadline, clock);
  const expiry = await bounded(() => page.locator(STRUCTURE_SELECTORS.expiryTitle).count(), deadline, clock);
  const cvc = await bounded(() => page.locator(STRUCTURE_SELECTORS.cvcTitle).count(), deadline, clock);
  const challenge = await bounded(() => page.locator(STRUCTURE_SELECTORS.challenge).count(), deadline, clock);
  const children = page.childFrames();
  if (children.length !== iframeCount) throw new StructureFrameLost();
  const frames = [page.mainFrame(), ...children];
  const seen = new Set<string>();
  const collected: StructureSignals["controls"][] = [];
  for (const frame of frames) {
    const identity = frame.identity();
    if (seen.has(identity)) throw new StructureFrameLost();
    seen.add(identity);
    collected.push(await controlsIn(frame, deadline, clock));
  }
  const controls = mergeControls(collected);
  controls.challenge = challenge > 0;
  return { iframeCount, titleCounts: { card, expiry, cvc }, controls };
}

export async function observeCheckoutStructure(
  source: StructureSource,
  clock: StructureClock = realStructureClock,
  budgetMs = STRUCTURE_OBSERVATION_BUDGET_MS,
): Promise<CheckoutStructureReport> {
  const deadline = clock.now() + budgetMs;
  let last: StructureSignals | null = null;
  while (clock.now() <= deadline) {
    try {
      const signals = await source.read({ deadline, clock });
      last = signals;
      if (signals.controls.challenge) return reportFrom(signals, "challenge");
      if (titleAmbiguous(signals)) return reportFrom(signals, "ambiguous");
      if (formReady(signals)) return reportFrom(signals, "ready");
    } catch (err) {
      if (isDeadline(err)) return reportFrom(last, "timeout");
      return reportFrom(null, "unexpected");
    }
    if (clock.now() >= deadline) return reportFrom(last, "timeout");
    const slice = Math.min(50, deadline - clock.now());
    if (slice <= 0) return reportFrom(last, "timeout");
    await clock.wait(slice);
  }
  return reportFrom(last, "timeout");
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
