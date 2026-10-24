/**
 * Closed Stripe TEST create-and-expire drill.
 * A dispatch cannot bypass CREATE_EXPIRE_EXECUTION_GATE.
 * This file does not call the paid payment harness.
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const CREATE_EXPIRE_EXECUTION_GATE: "closed" | "open" = "closed";
export const CONNECTED_ACCOUNT = "acct_1UKEFuFHnHoOWAJE";
export const AMOUNT_MINOR = 4500;
export const CURRENCY = "eur";
export const REQUIRED_REF = "refs/heads/test/stripe-gate2-runner";
export const REQUIRED_ENVIRONMENT = "sbg-stripe-test";
export const SUCCESS_URL = "http://127.0.0.1:9/sbg-create-expire/success";
export const CANCEL_URL = "http://127.0.0.1:9/sbg-create-expire/cancel";

const CHECKOUT_COLLECTION = "https://api.stripe.com/v1/checkout/sessions";
const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]+$/;
const RUN_ID = /^sbgce_[0-9a-f]{32}$/;
const GITHUB_ID = /^\d{1,20}$/;
const SAFE_CODES = new Set([
  "create_expire_execution_closed",
  "branch_rejected",
  "environment_rejected",
  "credential_absent",
  "credential_malformed",
  "live_credential_rejected",
  "live_payment_flag",
  "account_rejected",
  "amount_rejected",
  "currency_rejected",
  "run_id_rejected",
  "create_permission_denied",
  "create_rejected",
  "session_id_rejected",
  "session_livemode_rejected",
  "session_mode_rejected",
  "session_amount_rejected",
  "session_currency_rejected",
  "session_payment_status_rejected",
  "session_status_rejected",
  "session_metadata_rejected",
  "retrieve_failed",
  "expire_failed",
  "expire_verification_failed",
  "orphaned_session_possible",
  "expired",
  "redirect_rejected",
  "request_timeout",
  "request_failed",
  "create_expire_failed",
]);

export type DrillSummary = {
  drill: "create_expire";
  livemode: false;
  amountMinor: 4500;
  currency: "eur";
  paymentStatus: "unpaid";
  finalStatus: "expired";
  paid: false;
};

export type RecoveryRecord = {
  drill: "create_expire";
  runId: string | null;
  connectedAccount: typeof CONNECTED_ACCOUNT;
  githubRunId: string | null;
  githubRunAttempt: string | null;
  state: string;
  operationFailure: string | null;
  cleanupFailure: string | null;
  sessionIdObtained: boolean;
  sessionId: string | null;
  livemode?: false;
  amountMinor?: 4500;
  currency?: "eur";
  paymentStatus?: "unpaid";
  finalStatus?: "expired";
  paid?: false;
};

export type DrillConfig = {
  gate: "closed" | "open";
  ref: string | undefined;
  environment: string | undefined;
  secret: string | undefined;
  liveCheckoutFlag: string | undefined;
  saasCommerce: string | undefined;
  accountId: string;
  amountMinor: number;
  currency: string;
  runId: string;
  idempotencyKey: string;
  githubRunId: string | undefined;
  githubRunAttempt: string | undefined;
  fetchImpl: typeof fetch;
};

export function createDrillRunId(): string {
  return `sbgce_${randomBytes(16).toString("hex")}`;
}

export function safeGithubId(value: string | undefined): string | null {
  return value != null && GITHUB_ID.test(value) ? value : null;
}

export class DrillFailure extends Error {
  readonly recovery: RecoveryRecord;

  constructor(recovery: RecoveryRecord) {
    super(recovery.state);
    this.name = "DrillFailure";
    this.recovery = recovery;
  }
}

type StripeResult = { status: number; body: unknown };

function fail(code: string): never {
  throw new Error(code);
}

export function safeCode(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (SAFE_CODES.has(message)) return message;
  if (/^(create|retrieve|expire)_http_[1-5][0-9]{2}$/.test(message)) return message;
  return "create_expire_failed";
}

function recovery(
  config: DrillConfig,
  state: string,
  sessionId: string | null,
  operationFailure: string | null = null,
  cleanupFailure: string | null = null,
): RecoveryRecord {
  const safeState = safeCode(new Error(state));
  const safeSession = sessionId != null && SESSION_ID.test(sessionId) ? sessionId : null;
  return {
    drill: "create_expire",
    runId: RUN_ID.test(config.runId) ? config.runId : null,
    connectedAccount: CONNECTED_ACCOUNT,
    githubRunId: safeGithubId(config.githubRunId),
    githubRunAttempt: safeGithubId(config.githubRunAttempt),
    state: safeState,
    operationFailure: operationFailure == null ? null : safeCode(new Error(operationFailure)),
    cleanupFailure: cleanupFailure == null ? null : safeCode(new Error(cleanupFailure)),
    sessionIdObtained: safeSession != null,
    sessionId: safeSession,
  };
}

function reject(config: DrillConfig, state: string, sessionId: string | null = null): never {
  throw new DrillFailure(recovery(config, state, sessionId));
}

function assertReady(config: DrillConfig): string {
  if (config.gate !== "open") reject(config, "create_expire_execution_closed");
  if (!RUN_ID.test(config.runId)) reject(config, "run_id_rejected");
  if (config.ref !== REQUIRED_REF) reject(config, "branch_rejected");
  if (config.environment !== REQUIRED_ENVIRONMENT) reject(config, "environment_rejected");
  const secret = config.secret ?? "";
  if (!secret) reject(config, "credential_absent");
  if (/^(sk|rk)_live_/.test(secret)) reject(config, "live_credential_rejected");
  if (!/^rk_test_[A-Za-z0-9]+$/.test(secret) || secret.length < 20) reject(config, "credential_malformed");
  if (config.liveCheckoutFlag === "true" || config.saasCommerce === "live") reject(config, "live_payment_flag");
  if (config.accountId !== CONNECTED_ACCOUNT) reject(config, "account_rejected");
  if (config.amountMinor !== AMOUNT_MINOR) reject(config, "amount_rejected");
  if (config.currency !== CURRENCY) reject(config, "currency_rejected");
  return secret;
}

function httpToken(prefix: "create" | "retrieve" | "expire", status: number): string {
  if (!Number.isInteger(status) || status < 100 || status > 599) return `${prefix}_rejected`;
  return `${prefix}_http_${status}`;
}

function errorCode(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return code === "more_permissions_required" ? code : "";
}

function sessionId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" && SESSION_ID.test(id) ? id : null;
}

function checkoutUrl(id: string, expire = false): string {
  return `${CHECKOUT_COLLECTION}/${encodeURIComponent(id)}${expire ? "/expire" : ""}`;
}

async function stripeRequest(
  config: DrillConfig,
  secret: string,
  method: "GET" | "POST",
  url: string,
  idempotencyKey?: string,
  body?: URLSearchParams,
): Promise<StripeResult> {
  if (!url.startsWith(`${CHECKOUT_COLLECTION}/`) && url !== CHECKOUT_COLLECTION) fail("request_failed");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    Accept: "application/json",
    "Stripe-Account": CONNECTED_ACCOUNT,
  };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let response: Response;
  try {
    response = await config.fetchImpl(url, {
      method,
      headers,
      body: body?.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") fail("request_timeout");
    const message = err instanceof Error ? err.message : "";
    if (/redirect/i.test(message)) fail("redirect_rejected");
    fail("request_failed");
  }
  const text = await response.text();
  if (!text) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: null };
  }
}

function createBody(config: DrillConfig): URLSearchParams {
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": config.currency,
    "line_items[0][price_data][product_data][name]": "SBG synthetic transfer drill",
    "line_items[0][price_data][unit_amount]": String(config.amountMinor),
    "line_items[0][quantity]": "1",
    success_url: SUCCESS_URL,
    cancel_url: CANCEL_URL,
    "metadata[sbg_drill]": "create_expire",
    "metadata[sbg_connected_account]": CONNECTED_ACCOUNT,
    "metadata[sbg_synthetic]": "true",
    "metadata[sbg_drill_run_id]": config.runId,
  });
  const githubRunId = safeGithubId(config.githubRunId);
  const githubRunAttempt = safeGithubId(config.githubRunAttempt);
  if (githubRunId) body.set("metadata[sbg_github_run_id]", githubRunId);
  if (githubRunAttempt) body.set("metadata[sbg_github_run_attempt]", githubRunAttempt);
  const encoded = body.toString();
  if (encoded.includes("application_fee") || encoded.includes("transfer_data") || encoded.includes("payment_intent_data")) {
    fail("create_rejected");
  }
  return body;
}

async function createSession(config: DrillConfig, secret: string): Promise<string> {
  let lost = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await stripeRequest(
        config,
        secret,
        "POST",
        CHECKOUT_COLLECTION,
        config.idempotencyKey,
        createBody(config),
      );
      if (response.status === 403 && errorCode(response.body) === "more_permissions_required") {
        fail("create_permission_denied");
      }
      if (response.status !== 200) {
        if (response.status >= 500 && attempt === 0) {
          lost = true;
          continue;
        }
        fail(httpToken("create", response.status));
      }
      const id = sessionId(response.body);
      if (!id) {
        lost = true;
        continue;
      }
      return id;
    } catch (err) {
      const code = safeCode(err);
      if (code === "create_permission_denied" || code.startsWith("create_http_")) throw err;
      if (attempt === 0 && (code === "request_timeout" || code === "request_failed" || code === "redirect_rejected")) {
        lost = true;
        continue;
      }
      if (lost) fail("orphaned_session_possible");
      throw err;
    }
  }
  fail("orphaned_session_possible");
}

function assertSyntheticMetadata(metadata: unknown, runId: string): void {
  if (!metadata || typeof metadata !== "object") fail("session_metadata_rejected");
  const fields = metadata as {
    sbg_drill?: unknown;
    sbg_connected_account?: unknown;
    sbg_synthetic?: unknown;
    sbg_drill_run_id?: unknown;
  };
  if (
    fields.sbg_drill !== "create_expire"
    || fields.sbg_connected_account !== CONNECTED_ACCOUNT
    || fields.sbg_synthetic !== "true"
    || fields.sbg_drill_run_id !== runId
  ) {
    fail("session_metadata_rejected");
  }
}

function assertOpenSession(id: string, body: unknown, runId: string): void {
  if (!body || typeof body !== "object") fail("session_metadata_rejected");
  const session = body as {
    id?: unknown;
    livemode?: unknown;
    mode?: unknown;
    amount_total?: unknown;
    currency?: unknown;
    payment_status?: unknown;
    status?: unknown;
    metadata?: unknown;
  };
  if (session.id !== id) fail("session_id_rejected");
  if (session.livemode !== false) fail("session_livemode_rejected");
  if (session.mode !== "payment") fail("session_mode_rejected");
  if (session.amount_total !== AMOUNT_MINOR) fail("session_amount_rejected");
  if (session.currency !== CURRENCY) fail("session_currency_rejected");
  if (session.payment_status !== "unpaid") fail("session_payment_status_rejected");
  if (session.status !== "open") fail("session_status_rejected");
  assertSyntheticMetadata(session.metadata, runId);
}

function assertExpired(id: string, body: unknown, runId: string): void {
  if (!body || typeof body !== "object") fail("expire_verification_failed");
  const session = body as {
    id?: unknown;
    livemode?: unknown;
    mode?: unknown;
    amount_total?: unknown;
    currency?: unknown;
    payment_status?: unknown;
    status?: unknown;
    metadata?: unknown;
  };
  try {
    if (session.id !== id) fail("session_id_rejected");
    if (session.livemode !== false) fail("session_livemode_rejected");
    if (session.mode !== "payment") fail("session_mode_rejected");
    if (session.amount_total !== AMOUNT_MINOR) fail("session_amount_rejected");
    if (session.currency !== CURRENCY) fail("session_currency_rejected");
    if (session.payment_status !== "unpaid") fail("session_payment_status_rejected");
    if (session.status !== "expired") fail("session_status_rejected");
    assertSyntheticMetadata(session.metadata, runId);
  } catch {
    fail("expire_verification_failed");
  }
}

async function retrieveSession(config: DrillConfig, secret: string, id: string): Promise<StripeResult> {
  const response = await stripeRequest(config, secret, "GET", checkoutUrl(id));
  if (response.status !== 200) fail(response.status ? httpToken("retrieve", response.status) : "retrieve_failed");
  return response;
}

function alreadyExpiredIndication(id: string, body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as {
    id?: unknown;
    object?: unknown;
    status?: unknown;
    error?: { code?: unknown };
  };
  if (record.error?.code === "checkout_session_expired") return true;
  return record.id === id && record.object === "checkout.session" && record.status === "expired";
}

async function expireSession(config: DrillConfig, secret: string, id: string): Promise<void> {
  const idempotencyKey = `${config.idempotencyKey}:expire`;
  let last = "expire_failed";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await stripeRequest(config, secret, "POST", checkoutUrl(id, true), idempotencyKey);
      if (response.status === 200 || alreadyExpiredIndication(id, response.body)) return;
      const token = httpToken("expire", response.status);
      if (response.status >= 500 && response.status <= 599 && attempt === 0) {
        last = token;
        continue;
      }
      fail(token);
    } catch (err) {
      const code = safeCode(err);
      if (code === "request_timeout" && attempt === 0) {
        last = code;
        continue;
      }
      if (code === "request_timeout") fail(code);
      throw err;
    }
  }
  fail(last);
}

export async function runCreateExpireDrill(config: DrillConfig): Promise<RecoveryRecord> {
  const secret = assertReady(config);
  let obtainedId: string | null = null;
  let sessionIdToExpire: string | null = null;
  let paid = false;
  let failure: Error | null = null;
  let operationFailure: string | null = null;
  let cleanupFailure: string | null = null;
  try {
    const id = await createSession(config, secret);
    obtainedId = id;
    sessionIdToExpire = id;
    if (id.startsWith("cs_live_")) fail("session_livemode_rejected");
    let retrieved: StripeResult;
    try {
      retrieved = await retrieveSession(config, secret, id);
    } catch (err) {
      fail(safeCode(err).startsWith("retrieve_") ? safeCode(err) : "retrieve_failed");
    }
    if ((retrieved.body as { payment_status?: unknown } | null)?.payment_status === "paid") {
      paid = true;
      sessionIdToExpire = null;
    }
    assertOpenSession(id, retrieved.body, config.runId);
  } catch (err) {
    operationFailure = safeCode(err);
    failure = err instanceof Error ? err : new Error("create_expire_failed");
  }
  if (sessionIdToExpire && !paid) {
    try {
      await expireSession(config, secret, sessionIdToExpire);
      try {
        const after = await retrieveSession(config, secret, sessionIdToExpire);
        assertExpired(sessionIdToExpire, after.body, config.runId);
      } catch {
        fail("expire_verification_failed");
      }
    } catch (err) {
      const code = safeCode(err);
      cleanupFailure = code.startsWith("expire_") || code === "request_timeout" ? code : "expire_failed";
      failure = new Error(cleanupFailure);
    }
  }
  if (failure) throw new DrillFailure(recovery(config, safeCode(failure), obtainedId, operationFailure, cleanupFailure));
  return {
    ...recovery(config, "expired", obtainedId),
    livemode: false,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    paymentStatus: "unpaid",
    finalStatus: "expired",
    paid: false,
  };
}

export async function reportDrill(config: DrillConfig, lines: string[]): Promise<number> {
  try {
    lines.push(JSON.stringify(await runCreateExpireDrill(config)));
    return 0;
  } catch (err) {
    const record = err instanceof DrillFailure ? err.recovery : recovery(config, safeCode(err), null);
    lines.push(JSON.stringify(record));
    return 1;
  }
}

async function main(): Promise<void> {
  const runId = createDrillRunId();
  const lines: string[] = [];
  const code = await reportDrill({
    gate: CREATE_EXPIRE_EXECUTION_GATE,
    ref: process.env.GITHUB_REF,
    environment: process.env.SBG_DRILL_ENVIRONMENT,
    secret: process.env.STRIPE_SECRET_KEY,
    liveCheckoutFlag: process.env.SBG_DOMAIN_B_LIVE_CHECKOUT,
    saasCommerce: process.env.SBG_SAAS_COMMERCE,
    accountId: CONNECTED_ACCOUNT,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    runId,
    idempotencyKey: `sbg-create-expire-${runId}`,
    githubRunId: process.env.GITHUB_RUN_ID,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    fetchImpl: globalThis.fetch,
  }, lines);
  const line = lines[0] ?? "create_expire_failed";
  if (code === 0) console.log(line);
  else console.error(line);
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(() => {
    console.error("create_expire_failed");
    process.exit(1);
  });
}
