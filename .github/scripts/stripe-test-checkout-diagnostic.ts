/**
 * Closed Stripe TEST Checkout structure diagnostic.
 * It cannot run unless a separate diagnostic permit matches the exact commit.
 * It does not enter card details or submit payment.
 */
import { pathToFileURL } from "node:url";
import {
  observeCheckoutStructure,
  readPlaywrightStructure,
  type CheckoutStructureReport,
  type StructureBrowserPage,
  type StructureClock,
} from "./stripe-test-checkout-structure.ts";

export const CHECKOUT_DIAGNOSTIC_EXECUTION_GATE = "closed" as const;
export const DIAGNOSTIC_CONNECTED_ACCOUNT = "acct_1UKEFuFHnHoOWAJE";
export const DIAGNOSTIC_AMOUNT_MINOR = 4500;
export const DIAGNOSTIC_CURRENCY = "eur";
const REPOSITORY = "bizznessfone-cloud/birch-hazel-stone-cloud";
const REQUIRED_REF = "refs/heads/test/stripe-gate2-runner";
const DIAGNOSTIC_WORKFLOW = "SBG Stripe TEST checkout diagnostic";
const DIAGNOSTIC_WORKFLOW_REF =
  `${REPOSITORY}/.github/workflows/sbg-stripe-test-checkout-diagnostic.yml@${REQUIRED_REF}`;
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^\d{1,20}$/;
const SESSION_ID = /^cs_test_[A-Za-z0-9]+$/;

export type DiagnosticStatus = "closed" | "completed" | "blocked";
export type DiagnosticCleanup = "not_started" | "verified" | "failed" | "ambiguous";

export type DiagnosticReport = {
  diagnostic: "checkout_structure";
  status: DiagnosticStatus;
  cleanup: DiagnosticCleanup;
  failure: string | null;
  githubRunId: string | null;
  commitSha: string | null;
  structure: CheckoutStructureReport | null;
};

type Env = { [key: string]: string | undefined };

export type DiagnosticSession = {
  id: string;
  url: string;
  livemode: boolean;
  paymentStatus: string;
  status: string;
};

export type DiagnosticStripe = {
  create(input: { idempotencyKey: string }): Promise<DiagnosticSession>;
  retrieve(id: string): Promise<DiagnosticSession>;
  expire(id: string): Promise<DiagnosticSession>;
};

export type DiagnosticPage = StructureBrowserPage & {
  goto(url: string): Promise<void>;
  close(): Promise<void>;
};

export type DiagnosticBrowser = {
  newPage(): Promise<DiagnosticPage>;
  close(): Promise<void>;
};

export type DiagnosticInput = {
  env: Env;
  sourceGate?: string;
  stripe?: DiagnosticStripe;
  launch?: () => Promise<DiagnosticBrowser>;
  clock?: StructureClock;
  budgetMs?: number;
};

function value(env: Env, name: string): string {
  const found = env[name];
  return typeof found === "string" ? found : "";
}

export function diagnosticAuthorisationFailure(env: Env, sourceGate: string = CHECKOUT_DIAGNOSTIC_EXECUTION_GATE): string | null {
  if (sourceGate !== "closed") return "diagnostic_closed";
  const permit = value(env, "SBG_AUTHORISED_DIAGNOSTIC_SHA");
  const sha = value(env, "GITHUB_SHA");
  if (!SHA.test(permit) || !SHA.test(sha) || permit !== sha) {
    return permit ? "commit_rejected" : "authorisation_missing";
  }
  if (value(env, "GITHUB_REF") !== REQUIRED_REF) return "branch_rejected";
  if (value(env, "GITHUB_EVENT_NAME") !== "workflow_dispatch") return "workflow_rejected";
  if (value(env, "GITHUB_WORKFLOW") !== DIAGNOSTIC_WORKFLOW) return "workflow_rejected";
  if (value(env, "GITHUB_WORKFLOW_REF") !== DIAGNOSTIC_WORKFLOW_REF) return "workflow_rejected";
  if (value(env, "GITHUB_REPOSITORY") !== REPOSITORY) return "workflow_rejected";
  if (value(env, "GITHUB_ACTIONS") !== "true") return "workflow_rejected";
  return null;
}

export function diagnosticCheckoutBody(idempotencyKey: string): URLSearchParams {
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": DIAGNOSTIC_CURRENCY,
    "line_items[0][price_data][product_data][name]": "SBG structure diagnostic",
    "line_items[0][price_data][unit_amount]": String(DIAGNOSTIC_AMOUNT_MINOR),
    "line_items[0][quantity]": "1",
    success_url: "http://127.0.0.1:9/sbg-structure-diagnostic/return",
    cancel_url: "http://127.0.0.1:9/sbg-structure-diagnostic/return",
    "metadata[sbg_diagnostic]": "checkout_structure",
    "metadata[sbg_connected_account]": DIAGNOSTIC_CONNECTED_ACCOUNT,
    "metadata[sbg_idempotency_key]": idempotencyKey,
  });
  const encoded = body.toString();
  if (encoded.includes("application_fee") || encoded.includes("transfer_data")) {
    throw new Error("diagnostic_failed");
  }
  return body;
}

function credentialFailure(env: Env): string | null {
  const secret = value(env, "STRIPE_SECRET_KEY");
  if (!secret) return "credential_absent";
  if (/^(sk|rk)_live_/.test(secret)) return "live_credential_rejected";
  if (!/^rk_test_[A-Za-z0-9]+$/.test(secret) || secret.length < 20) return "credential_malformed";
  if (value(env, "SBG_DOMAIN_B_LIVE_CHECKOUT") === "true" || value(env, "SBG_SAAS_COMMERCE") === "live") {
    return "live_payment_flag";
  }
  return null;
}

function report(input: {
  status: DiagnosticStatus;
  cleanup: DiagnosticCleanup;
  failure: string | null;
  githubRunId: string | null;
  commitSha: string | null;
  structure: CheckoutStructureReport | null;
}): DiagnosticReport {
  return { diagnostic: "checkout_structure", ...input };
}

function safeRunId(env: Env): string | null {
  const runId = value(env, "GITHUB_RUN_ID");
  return RUN_ID.test(runId) ? runId : null;
}

class DiagnosticStop extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "DiagnosticStop";
    this.code = code;
  }
}

function unpaidExpired(session: DiagnosticSession, id: string): boolean {
  return session.id === id && session.livemode === false && session.paymentStatus === "unpaid" && session.status === "expired";
}

async function closeBrowser(page: DiagnosticPage | null, browser: DiagnosticBrowser | null): Promise<string | null> {
  try {
    await page?.close();
    await browser?.close();
    return null;
  } catch {
    return "browser_close_failed";
  }
}

async function cleanupSession(stripe: DiagnosticStripe, id: string): Promise<{ cleanup: DiagnosticCleanup; failure: string | null }> {
  let current: DiagnosticSession;
  try {
    current = await stripe.retrieve(id);
  } catch {
    return { cleanup: "ambiguous", failure: "expire_unverified" };
  }
  if (current.livemode !== false || current.paymentStatus === "paid") {
    return { cleanup: "ambiguous", failure: "paid_session_preserved" };
  }
  if (!(current.paymentStatus === "unpaid" && (current.status === "open" || current.status === "expired"))) {
    return { cleanup: "ambiguous", failure: "expire_unverified" };
  }
  if (current.status !== "expired") {
    try {
      await stripe.expire(id);
    } catch {
      return { cleanup: "failed", failure: "expire_failed" };
    }
  }
  try {
    const finalSession = await stripe.retrieve(id);
    if (unpaidExpired(finalSession, id)) return { cleanup: "verified", failure: null };
  } catch {
    return { cleanup: "ambiguous", failure: "expire_unverified" };
  }
  return { cleanup: "ambiguous", failure: "expire_unverified" };
}

export async function runCheckoutDiagnostic(input: DiagnosticInput): Promise<DiagnosticReport> {
  const gate = input.sourceGate ?? CHECKOUT_DIAGNOSTIC_EXECUTION_GATE;
  const authFailure = diagnosticAuthorisationFailure(input.env, gate);
  const runId = safeRunId(input.env);
  if (authFailure) {
    return report({
      status: "closed",
      cleanup: "not_started",
      failure: authFailure,
      githubRunId: runId,
      commitSha: null,
      structure: null,
    });
  }
  const credential = credentialFailure(input.env);
  if (credential) {
    return report({
      status: "blocked",
      cleanup: "not_started",
      failure: credential,
      githubRunId: runId,
      commitSha: value(input.env, "GITHUB_SHA"),
      structure: null,
    });
  }
  const stripe = input.stripe;
  const launch = input.launch;
  if (!stripe || !launch) {
    return report({
      status: "blocked",
      cleanup: "not_started",
      failure: "diagnostic_failed",
      githubRunId: runId,
      commitSha: value(input.env, "GITHUB_SHA"),
      structure: null,
    });
  }
  const idempotencyKey = `sbgdiag_${value(input.env, "GITHUB_SHA")}`;
  let session: DiagnosticSession | null = null;
  let browser: DiagnosticBrowser | null = null;
  let page: DiagnosticPage | null = null;
  let structure: CheckoutStructureReport | null = null;
  let failure: string | null = null;
  try {
    session = await stripe.create({ idempotencyKey });
    if (!SESSION_ID.test(session.id)) {
      session = null;
      throw new DiagnosticStop("orphaned_session_possible");
    }
    if (session.livemode !== false || session.paymentStatus === "paid") {
      throw new DiagnosticStop("paid_session_preserved");
    }
    if (!session.url.startsWith("https://")) throw new DiagnosticStop("browser_failed");
    browser = await launch();
    page = await browser.newPage();
    const checkoutUrl = session.url;
    await page.goto(checkoutUrl);
    structure = await observeCheckoutStructure({
      read: (context) => readPlaywrightStructure(page as DiagnosticPage, context.deadline, context.clock),
    }, input.clock, input.budgetMs);
  } catch (err) {
    failure = err instanceof DiagnosticStop
      ? err.code
      : (session ? "browser_failed" : "orphaned_session_possible");
  } finally {
    const closeFailure = await closeBrowser(page, browser);
    if (closeFailure && !failure) failure = closeFailure;
  }
  if (!session) {
    return report({
      status: "blocked",
      cleanup: "ambiguous",
      failure: "orphaned_session_possible",
      githubRunId: runId,
      commitSha: value(input.env, "GITHUB_SHA"),
      structure: null,
    });
  }
  const cleaned = await cleanupSession(stripe, session.id);
  return report({
    status: cleaned.cleanup === "verified" && failure == null ? "completed" : "blocked",
    cleanup: cleaned.cleanup,
    failure: cleaned.failure ?? failure,
    githubRunId: runId,
    commitSha: value(input.env, "GITHUB_SHA"),
    structure,
  });
}

const CHECKOUT_COLLECTION = "https://api.stripe.com/v1/checkout/sessions";

async function stripeSession(secret: string, method: "GET" | "POST", url: string, idempotencyKey?: string, body?: URLSearchParams): Promise<DiagnosticSession> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    Accept: "application/json",
    "Stripe-Account": DIAGNOSTIC_CONNECTED_ACCOUNT,
  };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body?.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new DiagnosticStop("orphaned_session_possible");
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) as unknown : null;
  } catch {
    throw new DiagnosticStop("orphaned_session_possible");
  }
  if (!response.ok || !parsed || typeof parsed !== "object") throw new DiagnosticStop("orphaned_session_possible");
  const record = parsed as { id?: unknown; url?: unknown; livemode?: unknown; payment_status?: unknown; status?: unknown };
  return {
    id: typeof record.id === "string" ? record.id : "",
    url: typeof record.url === "string" ? record.url : "",
    livemode: record.livemode === true,
    paymentStatus: typeof record.payment_status === "string" ? record.payment_status : "",
    status: typeof record.status === "string" ? record.status : "",
  };
}

function realStripe(secret: string): DiagnosticStripe {
  return {
    create(input) {
      return stripeSession(secret, "POST", CHECKOUT_COLLECTION, input.idempotencyKey, diagnosticCheckoutBody(input.idempotencyKey));
    },
    retrieve(id) {
      return stripeSession(secret, "GET", `${CHECKOUT_COLLECTION}/${encodeURIComponent(id)}`);
    },
    expire(id) {
      return stripeSession(secret, "POST", `${CHECKOUT_COLLECTION}/${encodeURIComponent(id)}/expire`);
    },
  };
}

async function launchPlaywright(): Promise<DiagnosticBrowser> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  return {
    async newPage() {
      const page = await browser.newPage();
      return {
        goto: async (url: string) => {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        },
        close: () => page.close(),
        locator: (selector: string) => page.locator(selector),
        frames: () => page.frames().map((frame) => ({
          getByRole: (role: "button" | "textbox", options: { name: RegExp }) => frame.getByRole(role, options),
          isDetached: () => frame.isDetached(),
        })),
      };
    },
    close: () => browser.close(),
  };
}

async function main(): Promise<void> {
  const secret = process.env.STRIPE_SECRET_KEY ?? "";
  const result = await runCheckoutDiagnostic({
    env: process.env,
    stripe: secret ? realStripe(secret) : undefined,
    launch: launchPlaywright,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "completed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(report({
      status: "blocked",
      cleanup: "ambiguous",
      failure: "diagnostic_failed",
      githubRunId: null,
      commitSha: null,
      structure: null,
    }))}\n`);
    process.exitCode = 1;
  });
}
