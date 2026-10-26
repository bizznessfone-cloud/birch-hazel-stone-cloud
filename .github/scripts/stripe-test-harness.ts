/**
 * Isolated Stripe TEST payment harness.
 * The execution gate is closed. Reaching this file does not call Stripe.
 * A later commit must change the gate before any Checkout Session can be created.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const STRIPE_TEST_EXECUTION_GATE = "closed";
const CONNECTED_ACCOUNT = "acct_1UKEFuFHnHoOWAJE";
const AMOUNT_MINOR = 4500;
export { STRIPE_TEST_EXECUTION_GATE, CONNECTED_ACCOUNT as PAYMENT_CONNECTED_ACCOUNT, AMOUNT_MINOR as PAYMENT_AMOUNT_MINOR };

const PAYMENT_SHA = /^[0-9a-f]{40}$/;
const PAYMENT_REPOSITORY = "bizznessfone-cloud/birch-hazel-stone-cloud";
const PAYMENT_REF = "refs/heads/test/stripe-gate2-runner";
const PAYMENT_WORKFLOW = "SBG Stripe TEST payment";
const PAYMENT_WORKFLOW_REF =
  `${PAYMENT_REPOSITORY}/.github/workflows/sbg-stripe-test-payment.yml@${PAYMENT_REF}`;

function permitValue(env: { [key: string]: string | undefined }, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value : "";
}

/**
 * GitHub's GITHUB_SHA is 40 lowercase hex characters. Comparison is exact.
 * A repeated match stays authorised: this permit is not single-use.
 * The function reads no credentials and does not contact Stripe.
 */
export function paymentExecutionAuthorised(
  env: { [key: string]: string | undefined },
  sourceGate: string = STRIPE_TEST_EXECUTION_GATE,
): boolean {
  if (sourceGate !== "closed") return false;
  const permit = permitValue(env, "SBG_AUTHORISED_PAYMENT_SHA");
  const sha = permitValue(env, "GITHUB_SHA");
  if (!PAYMENT_SHA.test(permit) || !PAYMENT_SHA.test(sha) || permit !== sha) return false;
  return permitValue(env, "GITHUB_REF") === PAYMENT_REF
    && permitValue(env, "GITHUB_EVENT_NAME") === "workflow_dispatch"
    && permitValue(env, "GITHUB_WORKFLOW") === PAYMENT_WORKFLOW
    && permitValue(env, "GITHUB_WORKFLOW_REF") === PAYMENT_WORKFLOW_REF
    && permitValue(env, "GITHUB_REPOSITORY") === PAYMENT_REPOSITORY
    && permitValue(env, "GITHUB_ACTIONS") === "true";
}
const CLI_VERSION = "1.55.0";
const CLI_SHA256 = "95b028177e12d5e5537a9d62366dce852bd78e104599bdc067268fe68dad1083";
const CLI_ARCHIVE = `stripe_${CLI_VERSION}_linux_x86_64.tar.gz`;
const ADMIN_URL = "postgresql://postgres@127.0.0.1:54329/postgres";
const DATABASE_URL = "postgresql://postgres@127.0.0.1:54329/neondb";
const GATEWAY_URL = "postgresql://aether_payment_gateway@127.0.0.1:54329/neondb";
const APP_URL = "postgresql://aether_app@127.0.0.1:54329/neondb";
const RETURN_ORIGIN = "http://127.0.0.1:9";

class HarnessClosed extends Error {
  constructor() {
    super("stripe_test_execution_closed");
    this.name = "HarnessClosed";
  }
}

export function sanitiseBrowserFailure(): Error {
  return new Error("checkout_browser_failed");
}

export const BROWSER_STAGES = [
  "chromium_launch",
  "checkout_navigation",
  "card_field_discovery",
  "card_number_entry",
  "expiry_entry",
  "cvc_entry",
  "payment_submission",
  "completion_redirect",
  "challenge_detection",
] as const;

export const BROWSER_FAILURES = [
  "browser_launch_failed",
  "checkout_navigation_failed",
  "checkout_field_missing",
  "checkout_field_timeout",
  "checkout_field_ambiguous",
  "checkout_card_entry_failed",
  "checkout_submission_failed",
  "checkout_redirect_failed",
  "checkout_challenge",
  "checkout_browser_unknown",
] as const;

export type BrowserStage = (typeof BROWSER_STAGES)[number];
export type BrowserFailure = (typeof BROWSER_FAILURES)[number];

export class HostedCheckoutBrowserError extends Error {
  readonly browserStage: BrowserStage;
  readonly browserFailure: BrowserFailure;
  readonly challengeCheck: ChallengeCheck | null;
  readonly challengeCounts: ChallengeCountReport | null;

  constructor(
    stage: BrowserStage,
    failure: BrowserFailure,
    diagnostic?: { challengeCheck: ChallengeCheck; challengeCounts: ChallengeCountReport },
  ) {
    super(failure === "checkout_challenge" ? "checkout_challenge" : "checkout_browser_failed");
    this.name = "HostedCheckoutBrowserError";
    this.browserStage = stage;
    this.browserFailure = failure;
    this.challengeCheck = failure === "checkout_challenge" ? diagnostic?.challengeCheck ?? null : null;
    this.challengeCounts = failure === "checkout_challenge" ? diagnostic?.challengeCounts ?? "unavailable" : null;
  }
}

function browserStageOf(value: string | null | undefined): BrowserStage | null {
  return BROWSER_STAGES.find((stage) => stage === value) ?? null;
}

function browserFailureOf(value: string | null | undefined): BrowserFailure | null {
  return BROWSER_FAILURES.find((failure) => failure === value) ?? null;
}

function classifyBrowserFailure(stage: BrowserStage, err: unknown): BrowserFailure {
  if (err instanceof HostedCheckoutBrowserError) return err.browserFailure;
  if (err instanceof Error && err.message === "checkout_challenge") return "checkout_challenge";
  const name = err instanceof Error ? err.name : "";
  const timeout = name === "TimeoutError";
  const missing = name === "FieldMissing";
  const ambiguous = name === "FieldAmbiguous";
  if (stage === "chromium_launch") return "browser_launch_failed";
  if (stage === "checkout_navigation") return "checkout_navigation_failed";
  if (stage === "payment_submission") return "checkout_submission_failed";
  if (stage === "completion_redirect") return "checkout_redirect_failed";
  if (stage === "challenge_detection") return "checkout_browser_unknown";
  if (stage === "card_field_discovery") {
    if (missing) return "checkout_field_missing";
    if (timeout) return "checkout_field_timeout";
    if (ambiguous) return "checkout_field_ambiguous";
    return "checkout_browser_unknown";
  }
  if (timeout) return "checkout_field_timeout";
  if (missing) return "checkout_field_missing";
  if (name === "Error") return "checkout_card_entry_failed";
  return "checkout_browser_unknown";
}

function browserDiagnostic(stage: BrowserStage, err: unknown): HostedCheckoutBrowserError {
  if (err instanceof HostedCheckoutBrowserError) return err;
  return new HostedCheckoutBrowserError(stage, classifyBrowserFailure(stage, err));
}

function challengeDiagnostic(check: ChallengeCheck, err: unknown): HostedCheckoutBrowserError {
  if (err instanceof HostedCheckoutBrowserError && err.browserFailure === "checkout_challenge") return err;
  const counts = err instanceof ChallengeDetected ? err.counts : "unavailable";
  return new HostedCheckoutBrowserError("challenge_detection", "checkout_challenge", {
    challengeCheck: check,
    challengeCounts: counts,
  });
}

const FIXTURE_STAGES = new Set([
  "cluster_identity",
  "migrations",
  "test_user",
  "catalogue_fixture",
  "booking",
  "hold_verification",
  "app_role",
  "payment_prepare",
  "payee_binding",
  "test_mode",
  "connection_privilege",
  "cleanup",
]);

const FIXTURE_SQLSTATES = new Set([
  "08006",
  "0a000",
  "0lp01",
  "22p02",
  "22023",
  "23502",
  "23503",
  "23505",
  "23514",
  "25006",
  "28000",
  "28p01",
  "3d000",
  "40p01",
  "42501",
  "42601",
  "42703",
  "42704",
  "42710",
  "42883",
  "42p01",
  "42p07",
  "55006",
  "55p03",
  "57p01",
  "p0001",
]);

export function fixtureStageCode(stage: string, err: unknown): string {
  if (!FIXTURE_STAGES.has(stage)) return "fixture_stage_unknown";
  const raw = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const sqlstate = /^[0-9A-Za-z]{5}$/.test(raw) ? raw.toLowerCase() : "";
  return FIXTURE_SQLSTATES.has(sqlstate) ? `fixture_${stage}_${sqlstate}` : `fixture_${stage}_failed`;
}

async function runFixtureStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && /^fixture_[a-z0-9_]+_(failed|[0-9a-z]{5})$/.test(err.message)) throw err;
    throw new Error(fixtureStageCode(stage, err));
  }
}

export function safeCode(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  return /^[a-z0-9_]+$/.test(message) ? message : "stripe_test_harness_failed";
}

export type PaymentRecoveryOutcome =
  | "no_session"
  | "unpaid_expired"
  | "paid_confirmed"
  | "paid_unconfirmed"
  | "recovery_required";

export type PaymentRecoveryRecord = {
  harness: "stripe_test_payment";
  outcome: PaymentRecoveryOutcome;
  connectedAccount: typeof CONNECTED_ACCOUNT;
  sessionId: string | null;
  bookingId: string | null;
  paymentId: string | null;
  githubRunId: string | null;
  githubRunAttempt: string | null;
  amountMinor: typeof AMOUNT_MINOR;
  currency: "EUR";
  idempotencyKey: string | null;
  operationFailure: string | null;
  recoveryFailure: string | null;
  cleanupFailure: string | null;
  cleanupFailures: string[];
  creationAmbiguous: boolean;
  databaseUnreadable: boolean;
  browserStage: BrowserStage | null;
  browserFailure: BrowserFailure | null;
  challengeCheck: ChallengeCheck | null;
  challengeCounts: ChallengeCountReport | null;
};

export type PaymentBookingEvidence = {
  lifecycleState: string;
  paymentStatus: string;
  paidCount: number;
  sessionId: string;
  accountId: string;
  amountMinor: number;
  currency: string;
};

export class PaymentRecoveryError extends Error {
  readonly record: PaymentRecoveryRecord;

  constructor(record: PaymentRecoveryRecord) {
    super(record.outcome);
    this.name = "PaymentRecoveryError";
    this.record = record;
  }
}

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]+$/;
const TEST_SESSION_ID = /^cs_test_[A-Za-z0-9]+$/;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[0-9a-f-]{36}:[1-9][0-9]{0,5}$/i;
const GITHUB_ID = /^\d{1,20}$/;
const FAILURE_CODE = /^(?:[a-z0-9_]{1,80}|fixture_[a-z0-9_]{1,80})$/;
const CHECKOUT_COLLECTION = "https://api.stripe.com/v1/checkout/sessions";

type SessionVerdict = "paid" | "unpaid_open" | "unpaid_expired" | "rejected";

function cleanFailure(value: string | null): string | null {
  if (value == null) return null;
  return FAILURE_CODE.test(value) ? value : "stripe_test_harness_failed";
}

function cleanSession(value: string | null): string | null {
  return value != null && SESSION_ID.test(value) ? value : null;
}

function cleanUuid(value: string | null): string | null {
  return value != null && UUID_ID.test(value) ? value : null;
}

function cleanIdempotency(value: string | null): string | null {
  return value != null && IDEMPOTENCY_KEY.test(value) ? value : null;
}

function cleanGithub(value: string | undefined): string | null {
  return value != null && GITHUB_ID.test(value) ? value : null;
}

export function paymentRecoveryRecord(input: {
  outcome: PaymentRecoveryOutcome;
  sessionId?: string | null;
  bookingId?: string | null;
  paymentId?: string | null;
  githubRunId?: string;
  githubRunAttempt?: string;
  idempotencyKey?: string | null;
  operationFailure?: string | null;
  recoveryFailure?: string | null;
  cleanupFailure?: string | null;
  cleanupFailures?: string[];
  creationAmbiguous?: boolean;
  databaseUnreadable?: boolean;
  browserStage?: string | null;
  browserFailure?: string | null;
  challengeCheck?: unknown;
  challengeCounts?: unknown;
}): PaymentRecoveryRecord {
  const browserFailure = browserFailureOf(input.browserFailure);
  const challenge = browserFailure === "checkout_challenge";
  return {
    harness: "stripe_test_payment",
    outcome: input.outcome,
    connectedAccount: CONNECTED_ACCOUNT,
    sessionId: cleanSession(input.sessionId ?? null),
    bookingId: cleanUuid(input.bookingId ?? null),
    paymentId: cleanUuid(input.paymentId ?? null),
    githubRunId: cleanGithub(input.githubRunId),
    githubRunAttempt: cleanGithub(input.githubRunAttempt),
    amountMinor: AMOUNT_MINOR,
    currency: "EUR",
    idempotencyKey: cleanIdempotency(input.idempotencyKey ?? null),
    operationFailure: cleanFailure(input.operationFailure ?? null),
    recoveryFailure: cleanFailure(input.recoveryFailure ?? null),
    cleanupFailure: cleanFailure(input.cleanupFailure ?? null),
    cleanupFailures: (input.cleanupFailures ?? []).map((code) => cleanFailure(code)).filter((code): code is string => code != null),
    creationAmbiguous: input.creationAmbiguous === true,
    databaseUnreadable: input.databaseUnreadable === true,
    browserStage: browserStageOf(input.browserStage),
    browserFailure,
    challengeCheck: challenge ? challengeCheckOf(input.challengeCheck) : null,
    challengeCounts: challenge ? challengeCountReport(input.challengeCounts) ?? "unavailable" : null,
  };
}

function classifySession(id: string, body: unknown): SessionVerdict {
  if (!body || typeof body !== "object") return "rejected";
  const session = body as {
    id?: unknown;
    livemode?: unknown;
    mode?: unknown;
    amount_total?: unknown;
    currency?: unknown;
    payment_status?: unknown;
    status?: unknown;
    account?: unknown;
  };
  if (session.id !== id || session.livemode !== false) return "rejected";
  if (session.amount_total !== AMOUNT_MINOR || session.currency !== "eur") return "rejected";
  if (session.mode != null && session.mode !== "payment") return "rejected";
  if (typeof session.account === "string" && session.account !== CONNECTED_ACCOUNT) return "rejected";
  if (session.payment_status === "paid") return "paid";
  if (session.payment_status === "unpaid" && session.status === "open") return "unpaid_open";
  if (session.payment_status === "unpaid" && session.status === "expired") return "unpaid_expired";
  return "rejected";
}

function bookingConfirms(evidence: PaymentBookingEvidence | null, sessionId: string): boolean {
  return evidence != null
    && evidence.lifecycleState === "confirmed_paid"
    && evidence.paymentStatus === "paid"
    && evidence.paidCount === 1
    && evidence.sessionId === sessionId
    && evidence.accountId === CONNECTED_ACCOUNT
    && evidence.amountMinor === AMOUNT_MINOR
    && evidence.currency.toUpperCase() === "EUR";
}

async function stripeRecoveryRequest(
  fetchImpl: typeof fetch,
  secret: string,
  method: "GET" | "POST",
  url: string,
  idempotencyKey?: string,
): Promise<{ status: number; body: unknown }> {
  if (!url.startsWith(`${CHECKOUT_COLLECTION}/`)) throw new Error("retrieve_failed");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    Accept: "application/json",
    "Stripe-Account": CONNECTED_ACCOUNT,
  };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new Error("request_timeout");
    throw new Error(method === "POST" ? "expire_failed" : "retrieve_failed");
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

async function paidOutcome(
  input: {
    sessionId: string;
    bookingId: string | null;
    paymentId: string | null;
    githubRunId?: string;
    githubRunAttempt?: string;
    idempotencyKey: string | null;
    operationFailure: string | null;
    recoveryFailure: string | null;
    readBooking: () => Promise<PaymentBookingEvidence | null>;
  },
): Promise<PaymentRecoveryRecord> {
  let evidence: PaymentBookingEvidence | null = null;
  try {
    evidence = await input.readBooking();
  } catch {
    evidence = null;
  }
  return paymentRecoveryRecord({
    outcome: bookingConfirms(evidence, input.sessionId) ? "paid_confirmed" : "paid_unconfirmed",
    sessionId: input.sessionId,
    bookingId: input.bookingId,
    paymentId: input.paymentId,
    githubRunId: input.githubRunId,
    githubRunAttempt: input.githubRunAttempt,
    idempotencyKey: input.idempotencyKey,
    operationFailure: input.operationFailure,
    recoveryFailure: input.recoveryFailure,
  });
}

export async function reconcilePaymentRecovery(input: {
  secret: string;
  sessionId: string | null;
  creationAmbiguous: boolean;
  bookingId: string | null;
  paymentId: string | null;
  idempotencyKey: string | null;
  githubRunId?: string;
  githubRunAttempt?: string;
  operationFailure: string | null;
  blocked?: "identity_rejected" | null;
  fetchImpl: typeof fetch;
  readBooking: () => Promise<PaymentBookingEvidence | null>;
}): Promise<PaymentRecoveryRecord> {
  const common = {
    sessionId: input.sessionId,
    bookingId: input.bookingId,
    paymentId: input.paymentId,
    githubRunId: input.githubRunId,
    githubRunAttempt: input.githubRunAttempt,
    idempotencyKey: input.idempotencyKey,
    operationFailure: input.operationFailure,
    creationAmbiguous: input.creationAmbiguous,
  };
  if (input.blocked === "identity_rejected") {
    return paymentRecoveryRecord({ ...common, outcome: "recovery_required", recoveryFailure: "identity_rejected" });
  }
  const sessionId = cleanSession(input.sessionId);
  if (!sessionId) {
    return paymentRecoveryRecord({
      ...common,
      sessionId: null,
      outcome: input.creationAmbiguous ? "recovery_required" : "no_session",
      recoveryFailure: input.creationAmbiguous ? "creation_ambiguous" : null,
    });
  }
  if (!TEST_SESSION_ID.test(sessionId) || !input.secret.startsWith("rk_test_")) {
    return paymentRecoveryRecord({
      ...common,
      sessionId,
      outcome: "recovery_required",
      recoveryFailure: "identity_rejected",
    });
  }

  const retrieveUrl = `${CHECKOUT_COLLECTION}/${encodeURIComponent(sessionId)}`;
  let retrieved: { status: number; body: unknown };
  try {
    retrieved = await stripeRecoveryRequest(input.fetchImpl, input.secret, "GET", retrieveUrl);
    if (retrieved.status !== 200) throw new Error("retrieve_failed");
  } catch (err) {
    return paymentRecoveryRecord({
      ...common,
      sessionId,
      outcome: "recovery_required",
      recoveryFailure: cleanFailure(err instanceof Error ? err.message : null) ?? "retrieve_failed",
    });
  }

  const verdict = classifySession(sessionId, retrieved.body);
  if (verdict === "rejected") {
    return paymentRecoveryRecord({
      ...common,
      sessionId,
      outcome: "recovery_required",
      recoveryFailure: "identity_rejected",
    });
  }
  if (verdict === "paid") {
    return paidOutcome({ ...input, sessionId, recoveryFailure: null });
  }
  if (verdict === "unpaid_expired") {
    return paymentRecoveryRecord({ ...common, sessionId, outcome: "unpaid_expired" });
  }

  let expireFailure: string | null = null;
  try {
    const expired = await stripeRecoveryRequest(
      input.fetchImpl,
      input.secret,
      "POST",
      `${retrieveUrl}/expire`,
      `${sessionId}:expire`,
    );
    if (expired.status !== 200) expireFailure = "expire_failed";
  } catch (err) {
    expireFailure = cleanFailure(err instanceof Error ? err.message : null) ?? "expire_failed";
  }

  try {
    const finalView = await stripeRecoveryRequest(input.fetchImpl, input.secret, "GET", retrieveUrl);
    if (finalView.status !== 200) throw new Error("retrieve_failed");
    const finalVerdict = classifySession(sessionId, finalView.body);
    if (finalVerdict === "paid") {
      return paidOutcome({ ...input, sessionId, recoveryFailure: expireFailure });
    }
    if (finalVerdict === "unpaid_expired") {
      return paymentRecoveryRecord({
        ...common,
        sessionId,
        outcome: "unpaid_expired",
        recoveryFailure: expireFailure,
      });
    }
    return paymentRecoveryRecord({
      ...common,
      sessionId,
      outcome: "recovery_required",
      recoveryFailure: expireFailure ?? "expire_unverified",
    });
  } catch (err) {
    return paymentRecoveryRecord({
      ...common,
      sessionId,
      outcome: "recovery_required",
      recoveryFailure: expireFailure ?? (cleanFailure(err instanceof Error ? err.message : null) ?? "retrieve_failed"),
    });
  }
}

function athensTransferDate(): string {
  const when = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

async function installStripeCli(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sbg-stripe-cli-"));
  const archive = join(root, CLI_ARCHIVE);
  const response = await fetch(
    `https://github.com/stripe/stripe-cli/releases/download/v${CLI_VERSION}/${CLI_ARCHIVE}`,
  );
  if (!response.ok) throw new Error("stripe_cli_download_failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== CLI_SHA256) {
    throw new Error("stripe_cli_checksum_mismatch");
  }
  await writeFile(archive, bytes);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", root], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("stripe_cli_extract_failed"))));
  });
  return join(root, "stripe");
}

async function applyMigrations(query: (sql: string) => Promise<void>): Promise<void> {
  const directory = new URL("../../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    await query(await readFile(new URL(name, directory), "utf8"));
  }
}

type QueryClient = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

async function connectAdmin(databaseUrl: string): Promise<QueryClient> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

async function createCatalogueFixture(admin: QueryClient): Promise<{ destinationId: string }> {
  const hotelOrg = (await admin.query<{ id: string }>(
    `insert into sbg_organisations (name, created_by_user_id, organisation_type)
     values ('SBG TEST Hotel', 'user-sbg-test', 'hotel') returning id`,
  )).rows[0]!.id;
  const hotelId = (await admin.query<{ id: string }>(
    `insert into hotels (code, name, iana_timezone, organisation_id, status, currency)
     values ('sbg-t23', 'SBG TEST Hotel', 'Europe/Athens', $1::uuid, 'live', 'EUR') returning id`,
    [hotelOrg],
  )).rows[0]!.id;
  const providerId = (await admin.query<{ id: string }>(
    `insert into providers (code, name, kind) values ('sbg-t23p', 'SBG TEST Fleet', 'in_house') returning id`,
  )).rows[0]!.id;
  await admin.query(`update providers set reservation_mode = 'capacity' where id = $1::uuid`, [providerId]);
  await admin.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
    [hotelId, providerId],
  );
  const destinationId = (await admin.query<{ id: string }>(
    `insert into hotel_destinations (hotel_id, kind, name, active, amount_minor)
     values ($1::uuid, 'airport', 'Athens Airport', true, $2) returning id`,
    [hotelId, AMOUNT_MINOR],
  )).rows[0]!.id;
  const doorId = (await admin.query<{ id: string }>(
    `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
     values ($1::uuid, 'hotel', $2::uuid, 'sbg-t23-door', 'Hotel door') returning id`,
    [providerId, hotelId],
  )).rows[0]!.id;
  const airportId = (await admin.query<{ id: string }>(
    `insert into sbg_fleet_locations (provider_id, kind, code, name)
     values ($1::uuid, 'airport', 'sbg-t23-ath', 'Athens Airport') returning id`,
    [providerId],
  )).rows[0]!.id;
  await admin.query(
    `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
     values ($1::uuid, $2::uuid, $3::uuid, 45), ($1::uuid, $3::uuid, $2::uuid, 70)`,
    [providerId, doorId, airportId],
  );
  await admin.query(
    `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
     values ($1::uuid, $2::uuid, $3::uuid, 20), ($1::uuid, $3::uuid, $2::uuid, 20)`,
    [providerId, doorId, airportId],
  );
  for (let isodow = 1; isodow <= 7; isodow += 1) {
    await admin.query(
      `insert into sbg_provider_hours (provider_id, isodow, opens_local, closes_local)
       values ($1::uuid, $2, '08:00', '20:00')`,
      [providerId, isodow],
    );
  }
  await admin.query(
    `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
     values ('SBG TEST Vehicle', 6, 4, true, $1::uuid, $1::uuid)`,
    [providerId],
  );
  await admin.query(
    `insert into sbg_guest_destination_bindings (hotel_destination_id, hotel_id, provider_id, fleet_location_id)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    [destinationId, hotelId, providerId, airportId],
  );
  await admin.query(
    `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity, billing_interval)
     values ($1::uuid, 'active', 1, 'month')`,
    [hotelOrg],
  );
  await admin.query(
    `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
     values ($1::uuid, $2::uuid, 'user-sbg-test')`,
    [hotelOrg, hotelId],
  );
  await admin.query(
    `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
     values ($1::uuid, $2, false)`,
    [hotelOrg, CONNECTED_ACCOUNT],
  );
  return { destinationId };
}

async function createFixtureBooking(admin: QueryClient, destinationId: string): Promise<{ token: string; bookingId: string }> {
  const booking = await import("../../src/lib/aether/booking.ts");
  type BookingDb = Parameters<typeof booking.createBooking>[0];
  const db: BookingDb = {
    query: async <T>(text: string, params?: unknown[]) => (await admin.query(text, params)).rows as T[],
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      await admin.query("begin");
      const inner: BookingDb = {
        query: async <R>(text: string, params?: unknown[]) => (await admin.query(text, params)).rows as R[],
        transaction() {
          throw new Error("nested");
        },
      };
      try {
        const result = await fn(inner);
        await admin.query("commit");
        return result;
      } catch (err) {
        await admin.query("rollback");
        throw err;
      }
    },
  };
  const created = await booking.createBooking(db, {
    hotelCode: "sbg-t23",
    destinationId,
    transferDate: athensTransferDate(),
    pickupTime: "10:00",
    durationMinutes: 45,
    guestName: "Ada Guest",
    guestPhone: "+302100000000",
    guestEmail: "ada@example.com",
    passengerCount: 1,
    luggageCount: 0,
    pickupText: "Hotel door",
    direction: "from_hotel",
  });
  const stored = await admin.query<{ id: string }>(
    `select id from bookings where confirmation_token = $1`,
    [created.confirmationToken],
  );
  return { token: created.confirmationToken, bookingId: stored.rows[0]!.id };
}

type CardFieldLocator = {
  count(options?: { timeout: number }): Promise<number>;
  waitFor?(options: { state: "visible"; timeout: number }): Promise<void>;
  fill(value: string, options: { timeout: number }): Promise<void>;
};

type CheckoutFrame = {
  isDetached(): boolean;
  getByRole(role: "textbox", options: { name: RegExp }): CardFieldLocator;
};

export type ChallengeFrameFact = {
  src: string;
  title: string;
  visible: boolean | null;
  unreadable?: boolean;
};

export type ChallengeInspection = {
  visibleHcaptcha: number;
  visibleThreeDs: number;
  visibleCaptcha: number;
  backgroundThreeDs: number;
  ambiguous: number;
};

export const CHALLENGE_CHECKS = [
  "post_navigation",
  "during_discovery",
  "post_discovery",
  "pre_submit",
] as const;

export type ChallengeCheck = (typeof CHALLENGE_CHECKS)[number];
export type ChallengeCounts = {
  visibleHcaptcha: number;
  visibleThreeDs: number;
  visibleCaptcha: number;
  backgroundThreeDs: number;
  ambiguous: number;
};
export type ChallengeCountReport = ChallengeCounts | "unavailable";

const CHALLENGE_COUNT_KEYS = [
  "visibleHcaptcha",
  "visibleThreeDs",
  "visibleCaptcha",
  "backgroundThreeDs",
  "ambiguous",
] as const;

export function challengeCountReport(value: unknown): ChallengeCountReport | null {
  if (value === "unavailable") return "unavailable";
  if (value == null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const counts = {} as ChallengeCounts;
  for (const key of CHALLENGE_COUNT_KEYS) {
    const count = source[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
    counts[key] = count;
  }
  return counts;
}

function challengeCheckOf(value: unknown): ChallengeCheck | null {
  return CHALLENGE_CHECKS.find((check) => check === value) ?? null;
}

class ChallengeDetected extends Error {
  readonly counts: ChallengeCountReport;

  constructor(counts: ChallengeCountReport) {
    super("checkout_challenge");
    this.name = "ChallengeDetected";
    this.counts = counts;
  }
}

type BrowserPage = {
  goto(url: string, options: { timeout: number; waitUntil: "domcontentloaded" }): Promise<unknown>;
  locator(selector: string): { count(): Promise<number> };
  frameLocator(selector: string): { locator(selector: string): CardFieldLocator };
  getByRole(role: "button", options: { name: RegExp }): { click(options: { timeout: number }): Promise<void> };
  on?(event: "console" | "request" | "response", listener: () => void): void;
  waitForURL(predicate: (url: URL) => boolean, options: { timeout: number }): Promise<void>;
  frames?(): CheckoutFrame[];
  inspectChallenges?(options?: { timeout: number }): Promise<ChallengeInspection>;
};

export type HostedCheckoutBrowser = {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
};

export const CARD_FIELD_DISCOVERY_BUDGET_MS = 20_000;
const TITLE_CARD = 'iframe[title*="card number" i]';
const TITLE_EXPIRY = 'iframe[title*="expir" i]';
const TITLE_CVC = 'iframe[title*="CVC" i]';
const CARD_NAME = /card number/i;
const EXPIRY_NAME = /expir/i;
const CVC_NAME = /cvc|security code/i;
const CHALLENGE_SELECTOR = 'iframe[src*="hcaptcha"], iframe[src*="3ds"], iframe[title*="3D Secure" i], iframe[title*="captcha" i]';

export type CheckoutClock = {
  now(): number;
  wait(ms: number): Promise<void>;
};

const realCheckoutClock: CheckoutClock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function discoveryError(kind: "timeout" | "missing" | "ambiguous"): Error {
  const error = new Error(
    kind === "timeout" ? "checkout_field_timeout" : kind === "missing" ? "checkout_field_missing" : "checkout_field_ambiguous",
  );
  error.name = kind === "timeout" ? "TimeoutError" : kind === "missing" ? "FieldMissing" : "FieldAmbiguous";
  return error;
}

function discoveryCrossed(clock: CheckoutClock, before: number, deadline: number): boolean {
  const now = clock.now();
  return now > deadline || (now >= deadline && now > before);
}

async function withinDeadline<T>(deadline: number, clock: CheckoutClock, run: (timeout: number) => Promise<T>): Promise<T> {
  if (clock.now() > deadline) throw discoveryError("timeout");
  const before = clock.now();
  const timeout = Math.max(0, deadline - before);
  if (clock === realCheckoutClock && timeout > 0) return preemptDeadline(deadline, timeout, () => run(timeout));
  let value: T;
  try {
    value = await run(timeout);
  } catch (err) {
    if (discoveryCrossed(clock, before, deadline)) throw discoveryError("timeout");
    if (err instanceof Error && (err.name === "TimeoutError" || err.message === "checkout_field_timeout")) {
      if (clock.now() === before && timeout > 0) await clock.wait(timeout);
      throw discoveryError("timeout");
    }
    throw err;
  }
  if (discoveryCrossed(clock, before, deadline)) throw discoveryError("timeout");
  return value;
}

async function preemptDeadline<T>(deadline: number, timeout: number, run: () => Promise<T>): Promise<T> {
  const operation = run().then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  try {
    const outcome = await new Promise<{ ok: true; value: T } | { ok: false; error: unknown }>((resolve, reject) => {
      timer = setTimeout(() => {
        closed = true;
        reject(discoveryError("timeout"));
      }, timeout);
      operation.then((result) => {
        if (closed) return;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      });
    });
    if (Date.now() >= deadline) throw discoveryError("timeout");
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readFieldCount(field: CardFieldLocator, deadline?: number, clock?: CheckoutClock): Promise<number> {
  try {
    return deadline != null && clock != null
      ? await withinDeadline(deadline, clock, (timeout) => field.count({ timeout }))
      : await field.count();
  } catch (err) {
    if (err instanceof Error && err.message === "checkout_field_timeout") throw err;
    if (err instanceof Error && err.name === "FieldMissing") throw discoveryError("missing");
    throw err;
  }
}

async function awaitCardField(field: CardFieldLocator, deadline: number, clock: CheckoutClock): Promise<void> {
  const initial = await readFieldCount(field);
  if (initial > 1) throw discoveryError("ambiguous");
  if (initial === 1) return;
  const remaining = deadline - clock.now();
  if (remaining <= 0) throw discoveryError("timeout");
  if (field.waitFor) {
    const before = clock.now();
    try {
      await field.waitFor({ state: "visible", timeout: remaining });
    } catch (err) {
      if (err instanceof Error && err.name === "FieldMissing") throw discoveryError("missing");
      if (err instanceof Error && err.name === "TimeoutError") {
        if (clock.now() === before) await clock.wait(remaining);
        throw discoveryError("timeout");
      }
      let count = 0;
      try {
        count = await field.count();
      } catch (countError) {
        if (countError instanceof Error && countError.name === "FieldMissing") throw discoveryError("missing");
        throw err;
      }
      if (count > 1) throw discoveryError("ambiguous");
      throw err;
    }
    const count = await readFieldCount(field);
    if (count === 1) return;
    if (count > 1) throw discoveryError("ambiguous");
    throw discoveryError("missing");
  }
  while (clock.now() < deadline) {
    const count = await readFieldCount(field);
    if (count === 1) return;
    if (count > 1) throw discoveryError("ambiguous");
    const slice = Math.min(50, deadline - clock.now());
    if (slice <= 0) break;
    await clock.wait(slice);
  }
  const count = await readFieldCount(field);
  if (count === 1) return;
  if (count > 1) throw discoveryError("ambiguous");
  throw discoveryError("timeout");
}

export function readIframeMeasurement(element: {
  getAttribute(name: string): string | null;
  title?: string;
  getBoundingClientRect(): { width: number; height: number };
  ownerDocument?: { defaultView?: { getComputedStyle?(element: unknown): { display: string; visibility: string } | null } | null };
}): ChallengeFrameFact {
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element) ?? null;
  const rect = element.getBoundingClientRect();
  if (style == null || rect == null) {
    return {
      src: element.getAttribute("src") ?? "",
      title: element.title || element.getAttribute("title") || "",
      visible: null,
    };
  }
  const ariaHidden = element.getAttribute("aria-hidden") === "true";
  const cssHidden = style.display === "none" || style.visibility === "hidden";
  const sized = rect.width > 0 && rect.height > 0;
  const presented = !cssHidden && sized;
  const visible = ariaHidden && presented ? null : presented;
  return {
    src: element.getAttribute("src") ?? "",
    title: element.title || element.getAttribute("title") || "",
    visible,
  };
}

export function classifyChallengeFrames(frames: ChallengeFrameFact[]): ChallengeInspection {
  const result: ChallengeInspection = {
    visibleHcaptcha: 0,
    visibleThreeDs: 0,
    visibleCaptcha: 0,
    backgroundThreeDs: 0,
    ambiguous: 0,
  };
  for (const fact of frames) {
    if (fact.unreadable) {
      result.ambiguous += 1;
      continue;
    }
    const src = fact.src.toLowerCase();
    const title = fact.title.toLowerCase();
    const hcaptcha = src.includes("hcaptcha") || title.includes("hcaptcha");
    const captcha = title.includes("captcha") || src.includes("captcha");
    const titledThreeDs = title.includes("3d secure");
    const srcThreeDs = src.includes("3ds");
    if (!hcaptcha && !captcha && !titledThreeDs && !srcThreeDs) continue;
    if (fact.visible == null) {
      result.ambiguous += 1;
      continue;
    }
    if (hcaptcha) {
      if (fact.visible) result.visibleHcaptcha += 1;
      else result.ambiguous += 1;
      continue;
    }
    if (captcha || titledThreeDs) {
      if (!fact.visible) result.ambiguous += 1;
      else if (titledThreeDs) result.visibleThreeDs += 1;
      else result.visibleCaptcha += 1;
      continue;
    }
    if (fact.visible) result.visibleThreeDs += 1;
    else result.backgroundThreeDs += 1;
  }
  return result;
}

export function challengeBlocks(inspection: ChallengeInspection): boolean {
  return inspection.visibleHcaptcha > 0
    || inspection.visibleThreeDs > 0
    || inspection.visibleCaptcha > 0
    || inspection.ambiguous > 0;
}

async function assertNoChallenge(page: BrowserPage, deadline?: number, clock?: CheckoutClock): Promise<void> {
  if (page.inspectChallenges) {
    let inspection: ChallengeInspection;
    try {
      inspection = deadline != null && clock != null
        ? await withinDeadline(deadline, clock, (timeout) => page.inspectChallenges!({ timeout }))
        : await page.inspectChallenges();
    } catch (err) {
      if (err instanceof Error && err.message === "checkout_field_timeout") throw err;
      throw new ChallengeDetected("unavailable");
    }
    if (challengeBlocks(inspection)) throw new ChallengeDetected(challengeCountReport(inspection) ?? "unavailable");
    return;
  }
  const challenges = deadline != null && clock != null
    ? await withinDeadline(deadline, clock, () => page.locator(CHALLENGE_SELECTOR).count())
    : await page.locator(CHALLENGE_SELECTOR).count();
  if (challenges > 0) throw new ChallengeDetected("unavailable");
}

async function readAccessibleFields(page: BrowserPage, deadline: number, clock: CheckoutClock): Promise<
  { card: CardFieldLocator; expiry: CardFieldLocator; cvc: CardFieldLocator } | "none" | "ambiguous" | "detached"
> {
  if (!page.frames) return "none";
  const seen = new Set<CheckoutFrame>();
  const found: { card: CardFieldLocator[]; expiry: CardFieldLocator[]; cvc: CardFieldLocator[] } = {
    card: [],
    expiry: [],
    cvc: [],
  };
  for (const frame of page.frames()) {
    if (seen.has(frame)) return "ambiguous";
    seen.add(frame);
    if (frame.isDetached()) return "detached";
    const candidates: Array<["card" | "expiry" | "cvc", RegExp]> = [
      ["card", CARD_NAME],
      ["expiry", EXPIRY_NAME],
      ["cvc", CVC_NAME],
    ];
    for (const [key, name] of candidates) {
      const locator = frame.getByRole("textbox", { name });
      const count = await readFieldCount(locator, deadline, clock);
      if (count > 1) return "ambiguous";
      if (count === 1) found[key].push(locator);
    }
  }
  if (found.card.length > 1 || found.expiry.length > 1 || found.cvc.length > 1) return "ambiguous";
  if (found.card.length === 1 && found.expiry.length === 1 && found.cvc.length === 1) {
    return { card: found.card[0]!, expiry: found.expiry[0]!, cvc: found.cvc[0]! };
  }
  return "none";
}

async function discoverCardFields(page: BrowserPage, clock: CheckoutClock, deadline: number): Promise<{
  card: CardFieldLocator;
  expiry: CardFieldLocator;
  cvc: CardFieldLocator;
}> {
  const card = page.frameLocator(TITLE_CARD).locator("input");
  const expiry = page.frameLocator(TITLE_EXPIRY).locator("input");
  const cvc = page.frameLocator(TITLE_CVC).locator("input");
  while (true) {
    await assertNoChallenge(page, deadline, clock);
    const titleCounts = [
      await readFieldCount(card, deadline, clock),
      await readFieldCount(expiry, deadline, clock),
      await readFieldCount(cvc, deadline, clock),
    ];
    if (titleCounts.some((count) => count > 1)) throw discoveryError("ambiguous");
    if (titleCounts.every((count) => count === 1)) return { card, expiry, cvc };
    const accessible = await readAccessibleFields(page, deadline, clock);
    if (accessible === "ambiguous") throw discoveryError("ambiguous");
    if (accessible === "detached") throw discoveryError("missing");
    if (accessible !== "none" && titleCounts.every((count) => count === 0)) return accessible;
    if (clock.now() >= deadline) throw discoveryError("timeout");
    const slice = Math.min(50, deadline - clock.now());
    if (slice <= 0) throw discoveryError("timeout");
    await clock.wait(slice);
  }
}

async function requireCardFields(page: BrowserPage, clock: CheckoutClock, deadline: number): Promise<{
  card: CardFieldLocator;
  expiry: CardFieldLocator;
  cvc: CardFieldLocator;
}> {
  if (page.frames) return discoverCardFields(page, clock, deadline);
  const card = page.frameLocator(TITLE_CARD).locator("input");
  const expiry = page.frameLocator(TITLE_EXPIRY).locator("input");
  const cvc = page.frameLocator(TITLE_CVC).locator("input");
  await awaitCardField(card, deadline, clock);
  await awaitCardField(expiry, deadline, clock);
  await awaitCardField(cvc, deadline, clock);
  return { card, expiry, cvc };
}

export async function runHostedCheckout(
  checkoutUrl: string,
  launch: () => Promise<HostedCheckoutBrowser>,
  clock: CheckoutClock = realCheckoutClock,
): Promise<void> {
  process.env.DEBUG = "";
  let browser: HostedCheckoutBrowser;
  try {
    browser = await launch();
  } catch (err) {
    throw browserDiagnostic("chromium_launch", err);
  }
  let page: BrowserPage;
  try {
    page = await browser.newPage();
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw browserDiagnostic("chromium_launch", err);
  }
  try {
    page.on?.("console", () => undefined);
    page.on?.("request", () => undefined);
    page.on?.("response", () => undefined);
    try {
      await page.goto(checkoutUrl, { timeout: 30_000, waitUntil: "domcontentloaded" });
    } catch (err) {
      throw browserDiagnostic("checkout_navigation", err);
    }
    try {
      await assertNoChallenge(page);
    } catch (err) {
      if (err instanceof Error && err.message === "checkout_challenge") throw challengeDiagnostic("post_navigation", err);
      throw browserDiagnostic("challenge_detection", err);
    }
    let fields: Awaited<ReturnType<typeof requireCardFields>>;
    const discoveryDeadline = clock.now() + CARD_FIELD_DISCOVERY_BUDGET_MS;
    try {
      fields = await requireCardFields(page, clock, discoveryDeadline);
    } catch (err) {
      if (err instanceof Error && err.message === "checkout_challenge") throw challengeDiagnostic("during_discovery", err);
      throw browserDiagnostic("card_field_discovery", err);
    }
    try {
      await assertNoChallenge(page, discoveryDeadline, clock);
    } catch (err) {
      if (err instanceof Error && err.message === "checkout_field_timeout") throw browserDiagnostic("card_field_discovery", err);
      if (err instanceof Error && err.message === "checkout_challenge") throw challengeDiagnostic("post_discovery", err);
      throw browserDiagnostic("challenge_detection", err);
    }
    try {
      await fields.card.fill("4242424242424242", { timeout: 20_000 });
    } catch (err) {
      throw browserDiagnostic("card_number_entry", err);
    }
    try {
      await fields.expiry.fill("1234", { timeout: 20_000 });
    } catch (err) {
      throw browserDiagnostic("expiry_entry", err);
    }
    try {
      await fields.cvc.fill("123", { timeout: 20_000 });
    } catch (err) {
      throw browserDiagnostic("cvc_entry", err);
    }
    try {
      await assertNoChallenge(page);
    } catch (err) {
      if (err instanceof Error && err.message === "checkout_challenge") throw challengeDiagnostic("pre_submit", err);
      throw browserDiagnostic("challenge_detection", err);
    }
    try {
      await page.getByRole("button", { name: /pay/i }).click({ timeout: 20_000 });
    } catch (err) {
      throw browserDiagnostic("payment_submission", err);
    }
    try {
      await page.waitForURL((url) => url.hostname !== "checkout.stripe.com", { timeout: 60_000 });
    } catch (err) {
      throw browserDiagnostic("completion_redirect", err);
    }
  } finally {
    await browser.close();
  }
}

type PlaywrightCheckoutFrame = {
  isDetached(): boolean;
  parentFrame(): PlaywrightCheckoutFrame | null;
  getByRole(role: "textbox", options: { name: RegExp }): CardFieldLocator;
  frameElement(): Promise<{ evaluate(fn: typeof readIframeMeasurement): Promise<ChallengeFrameFact> }>;
};

function adaptPlaywrightFrame(frame: PlaywrightCheckoutFrame, cache: WeakMap<PlaywrightCheckoutFrame, CheckoutFrame>): CheckoutFrame {
  const cached = cache.get(frame);
  if (cached) return cached;
  const adapted: CheckoutFrame = {
    isDetached: () => frame.isDetached(),
    getByRole: (role, options) => frame.getByRole(role, options),
  };
  cache.set(frame, adapted);
  return adapted;
}

export async function inspectPlaywrightChallenges(
  page: { frames(): PlaywrightCheckoutFrame[] },
  options?: { timeout: number },
): Promise<ChallengeInspection> {
  const facts: ChallengeFrameFact[] = [];
  const seen = new Set<PlaywrightCheckoutFrame>();
  const started = Date.now();
  const deadline = options == null ? null : started + options.timeout;
  const assertInspectionTime = () => {
    if (deadline != null && Date.now() > started && Date.now() >= deadline) throw discoveryError("timeout");
  };
  for (const frame of page.frames()) {
    assertInspectionTime();
    if (seen.has(frame)) {
      facts.push({ src: "", title: "", visible: null, unreadable: true });
      continue;
    }
    seen.add(frame);
    if (frame.parentFrame() == null) continue;
    try {
      const element = await frame.frameElement();
      assertInspectionTime();
      facts.push(await element.evaluate(readIframeMeasurement));
      assertInspectionTime();
    } catch (err) {
      if (err instanceof Error && err.message === "checkout_field_timeout") throw err;
      facts.push({ src: "", title: "", visible: null, unreadable: true });
    }
  }
  return classifyChallengeFrames(facts);
}

export function adaptPlaywrightCheckoutPage(page: BrowserPage & {
  frames(): PlaywrightCheckoutFrame[];
}): BrowserPage {
  const cache = new WeakMap<PlaywrightCheckoutFrame, CheckoutFrame>();
  return {
    goto: (url, options) => page.goto(url, options),
    locator: (selector) => page.locator(selector),
    frameLocator: (selector) => page.frameLocator(selector),
    getByRole: (role, options) => page.getByRole(role, options),
    on: page.on?.bind(page),
    waitForURL: (predicate, options) => page.waitForURL(predicate, options),
    frames: () => page.frames().map((frame) => adaptPlaywrightFrame(frame, cache)),
    inspectChallenges: (options) => inspectPlaywrightChallenges(page, options),
  };
}

async function completeHostedCheckout(checkoutUrl: string): Promise<void> {
  await runHostedCheckout(checkoutUrl, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    return {
      async newPage() {
        const page = await browser.newPage();
        return adaptPlaywrightCheckoutPage(page as unknown as BrowserPage & { frames(): PlaywrightCheckoutFrame[] });
      },
      async close() {
        await browser.close();
      },
    };
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function forwardConnectEvents(input: {
  stripeBin: string;
  listenerPort: number;
  secretReady: (secret: string) => void;
}): Promise<{ ready: Promise<void>; assertAlive: () => void; stop: () => Promise<void> }> {
  const child = spawn(
    input.stripeBin,
    ["listen", "--forward-connect-to", `http://127.0.0.1:${input.listenerPort}`, "--events", "checkout.session.completed"],
    {
      env: { ...process.env, STRIPE_API_KEY: process.env.STRIPE_SECRET_KEY },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let secret = "";
  let readySeen = false;
  let announced = false;
  let pending = "";
  let rejectReady: (err: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    const watch = (chunk: Buffer) => {
      pending = (pending + chunk.toString("utf8")).slice(-8000);
      const match = pending.match(/whsec_[A-Za-z0-9]+/);
      if (match) secret = match[0];
      if (pending.includes("Ready!")) readySeen = true;
      if (!announced && secret && readySeen) {
        announced = true;
        pending = "";
        input.secretReady(secret);
        resolve();
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    child.once("exit", () => {
      if (!announced) reject(new Error("stripe_cli_exited"));
    });
    child.once("error", () => {
      if (!announced) reject(new Error("stripe_cli_exited"));
    });
  });
  const assertAlive = () => {
    if (child.exitCode != null || child.signalCode != null) throw new Error("stripe_cli_exited");
  };
  const stop = async () => {
    if (child.exitCode != null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  return { ready: ready.catch((err) => { rejectReady(err); throw err; }), assertAlive, stop };
}

function assertPaidConnectEvent(event: {
  type?: string;
  account?: string;
  livemode?: boolean;
  data?: { object?: { object?: string; mode?: string; amount_total?: number; currency?: string; payment_status?: string; livemode?: boolean } };
}): void {
  const session = event.data?.object;
  if (
    event.type !== "checkout.session.completed"
    || event.account !== CONNECTED_ACCOUNT
    || event.livemode !== false
    || session?.object !== "checkout.session"
    || session.mode !== "payment"
    || session.livemode !== false
    || session.amount_total !== AMOUNT_MINOR
    || session.currency !== "eur"
    || session.payment_status !== "paid"
  ) {
    throw new Error("webhook_event_rejected");
  }
}

type ClusterIdentityFact = {
  dataDirectory: string;
  listenAddresses: string;
  port: string;
  serverAddr: string | null;
  inRecovery: boolean;
  systemIdentifier: string;
};

export function firstQueryRow<T>(result: { rows?: T[] } | null | undefined): T | undefined {
  return Array.isArray(result?.rows) ? result.rows[0] : undefined;
}

export function identityIsAuthorised(
  fact: ClusterIdentityFact | undefined,
  controlId: bigint,
  expected: { dataDirectory: string; listenAddresses: string },
): boolean {
  if (!fact) return false;
  let sessionId: bigint;
  try {
    sessionId = BigInt(fact.systemIdentifier);
  } catch {
    return false;
  }
  const loopback = fact.serverAddr === "127.0.0.1" || fact.serverAddr === "127.0.0.1/32";
  return loopback
    && sessionId === controlId
    && fact.dataDirectory === expected.dataDirectory
    && fact.listenAddresses === expected.listenAddresses
    && fact.port === "54329"
    && fact.inRecovery === false;
}

async function assertAuthorisedAdminSession(root: QueryClient): Promise<void> {
  const {
    AUTHORISED_DISPOSABLE_DATA_DIRECTORY,
    AUTHORISED_DISPOSABLE_LISTEN,
    readAuthorisedClusterSystemIdentifier,
  } = await import("../../src/lib/aether/guest-payment-test-isolation.ts");
  let fact: ClusterIdentityFact | undefined;
  try {
    const result = await root.query<ClusterIdentityFact>(
      `select current_setting('data_directory') as "dataDirectory",
              current_setting('listen_addresses') as "listenAddresses",
              current_setting('port') as "port",
              inet_server_addr()::text as "serverAddr",
              pg_is_in_recovery() as "inRecovery",
              system_identifier::text as "systemIdentifier"
         from pg_control_system()`,
    );
    fact = firstQueryRow(result);
  } catch {
    throw new Error("database_not_authorised");
  }
  if (!identityIsAuthorised(fact, readAuthorisedClusterSystemIdentifier(), {
    dataDirectory: AUTHORISED_DISPOSABLE_DATA_DIRECTORY,
    listenAddresses: AUTHORISED_DISPOSABLE_LISTEN,
  })) {
    throw new Error("database_not_authorised");
  }
}

async function resetAuthorisedDisposableDatabase(): Promise<{ root: QueryClient; database: QueryClient }> {
  const admin = new URL(ADMIN_URL);
  if (admin.protocol !== "postgresql:" || admin.hostname !== "127.0.0.1" || admin.port !== "54329" || admin.pathname !== "/postgres") {
    throw new Error("database_not_authorised");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sh", [".github/scripts/bootstrap-disposable-postgres.sh", "identify"], { stdio: "inherit" });
    child.once("error", () => reject(new Error("database_not_authorised")));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("database_not_authorised"))));
  });
  const root = await connectAdmin(ADMIN_URL);
  try {
    await assertAuthorisedAdminSession(root);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("sh", [".github/scripts/bootstrap-disposable-postgres.sh", "cleanup"], { stdio: "ignore" });
      child.once("error", () => reject(new Error("database_not_authorised")));
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("database_not_authorised"))));
    });
    await root.query("create database neondb");
    const database = await connectAdmin(DATABASE_URL);
    try {
      const { assertConnectedDisposableDatabase } = await import("../../src/lib/aether/guest-payment-test-isolation.ts");
      await assertConnectedDisposableDatabase({
        query: async <T>(text: string, params?: unknown[]) => (await database.query(text, params)).rows as T[],
      });
      return { root, database };
    } catch (err) {
      await database.end().catch(() => undefined);
      throw err;
    }
  } catch (err) {
    await root.end().catch(() => undefined);
    throw err;
  }
}

async function createDisposableBooking(admin: QueryClient): Promise<{ token: string; bookingId: string }> {
  const catalogue = await createCatalogueFixture(admin);
  return createFixtureBooking(admin, catalogue.destinationId);
}

async function loadHarnessPayment(database: QueryClient, bookingId: string): Promise<{
  paymentId: string | null;
  sessionId: string | null;
  checkoutAttempt: number | null;
}> {
  try {
    const rows = await database.query<{ payment_id: string; session_id: string | null; checkout_attempt: number }>(
      `select p.id::text as payment_id,
              p.stripe_checkout_session_id as session_id,
              p.checkout_attempt
         from sbg_booking_payments p
        where p.booking_id = $1::uuid`,
      [bookingId],
    );
    const row = rows.rows[0];
    if (!row) return { paymentId: null, sessionId: null, checkoutAttempt: 0 };
    return { paymentId: row.payment_id, sessionId: row.session_id, checkoutAttempt: Number(row.checkout_attempt) };
  } catch {
    return { paymentId: null, sessionId: null, checkoutAttempt: null };
  }
}

async function readHarnessBooking(database: QueryClient, bookingId: string): Promise<PaymentBookingEvidence | null> {
  const rows = await database.query<{
    lifecycle_state: string;
    payment_status: string;
    session_id: string;
    account_id: string;
    amount_minor: number;
    currency: string;
    paid_count: number;
  }>(
    `select b.lifecycle_state,
            p.status as payment_status,
            p.stripe_checkout_session_id as session_id,
            p.payee_stripe_account_id as account_id,
            p.amount_minor,
            p.currency,
            (select count(*)::int from sbg_booking_payments paid
              where paid.booking_id = b.id and paid.status = 'paid') as paid_count
       from bookings b
       join sbg_booking_payments p on p.booking_id = b.id
      where b.id = $1::uuid`,
    [bookingId],
  );
  const row = rows.rows[0];
  if (!row?.session_id || !row.account_id) return null;
  return {
    lifecycleState: row.lifecycle_state,
    paymentStatus: row.payment_status,
    paidCount: Number(row.paid_count),
    sessionId: row.session_id,
    accountId: row.account_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
  };
}

function paymentFailureCode(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  return FAILURE_CODE.test(message) ? message : "stripe_test_harness_failed";
}

export type CheckoutAttemptEvidence = {
  attempted: boolean;
  ambiguous: boolean;
  sessionId: string | null;
  paymentId: string | null;
  checkoutAttempt: number | null;
  failure: string | null;
  lookupUnreadable?: boolean;
};

export type PaymentLookup =
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "stored"; paymentId: string | null; sessionId: string | null; checkoutAttempt: number };

const CLEANUP_STEPS = [
  ["cleanup_listener_failed", "listener"],
  ["cleanup_proxy_failed", "proxy"],
  ["cleanup_cli_failed", "cli"],
  ["cleanup_database_failed", "database"],
  ["cleanup_temporary_directory_failed", "temporaryDirectory"],
] as const;

export async function runPaymentHarnessBoundary(input: {
  secret: string;
  githubRunId?: string;
  githubRunAttempt?: string;
  fetchImpl: typeof fetch;
  steps: {
    prepareFixture: () => Promise<{ bookingId: string }>;
    installCli: () => Promise<void>;
    startProxy: () => Promise<void>;
    awaitCli: () => Promise<void>;
    startListener: () => Promise<void>;
    createCheckout: () => Promise<CheckoutAttemptEvidence>;
    retrieveCheckout: () => Promise<void>;
    completeBrowser: () => Promise<void>;
    confirmWebhook: () => Promise<void>;
    replay: () => Promise<void>;
  };
  lookupPayment: () => Promise<PaymentLookup>;
  readBooking: () => Promise<PaymentBookingEvidence | null>;
  cleanup: Record<(typeof CLEANUP_STEPS)[number][1], () => Promise<void> | void>;
}): Promise<PaymentRecoveryRecord> {
  let bookingId: string | null = null;
  let operationFailure: string | null = null;
  let browserStage: string | null = null;
  let browserFailure: string | null = null;
  let challengeCheck: ChallengeCheck | null = null;
  let challengeCounts: ChallengeCountReport | null = null;
  let checkout: CheckoutAttemptEvidence = {
    attempted: false,
    ambiguous: false,
    sessionId: null,
    paymentId: null,
    checkoutAttempt: null,
    failure: null,
  };
  const flags = { databaseUnreadable: false };

  const stop = (err: unknown) => {
    if (!operationFailure) operationFailure = paymentFailureCode(err);
    if (browserStage == null && err instanceof HostedCheckoutBrowserError) {
      browserStage = err.browserStage;
      browserFailure = err.browserFailure;
      challengeCheck = err.challengeCheck;
      challengeCounts = err.challengeCounts;
    }
  };
  try {
    bookingId = (await input.steps.prepareFixture()).bookingId;
  } catch (err) {
    stop(err);
  }
  if (!operationFailure) {
    try { await input.steps.installCli(); } catch (err) { stop(err); }
  }
  if (!operationFailure) {
    try { await input.steps.startProxy(); } catch (err) { stop(err); }
  }
  if (!operationFailure) {
    try { await input.steps.awaitCli(); } catch (err) { stop(err); }
  }
  if (!operationFailure) {
    try { await input.steps.startListener(); } catch (err) { stop(err); }
  }
  if (!operationFailure) {
    try {
      checkout = await input.steps.createCheckout();
      if (checkout.failure) stop(new Error(checkout.failure));
      if (!checkout.attempted) checkout.ambiguous = false;
      if (checkout.lookupUnreadable) flags.databaseUnreadable = true;
    } catch (err) {
      stop(err);
      checkout = {
        attempted: true,
        ambiguous: true,
        sessionId: null,
        paymentId: null,
        checkoutAttempt: null,
        failure: operationFailure,
      };
    }
  }
  if (!operationFailure && checkout.attempted && checkout.sessionId && !checkout.ambiguous) {
    for (const step of [
      input.steps.retrieveCheckout,
      input.steps.completeBrowser,
      input.steps.confirmWebhook,
      input.steps.replay,
    ]) {
      try {
        await step();
      } catch (err) {
        stop(err);
        break;
      }
    }
  }

  let lookup: PaymentLookup = { state: "absent" };
  if (checkout.attempted) {
    try {
      lookup = await input.lookupPayment();
    } catch {
      lookup = { state: "unreadable" };
    }
    if (lookup.state === "unreadable") flags.databaseUnreadable = true;
  }

  let sessionId = checkout.sessionId;
  let paymentId = checkout.paymentId;
  let attempt = checkout.checkoutAttempt;
  let ambiguous = checkout.ambiguous || checkout.lookupUnreadable === true;
  let blocked: "identity_rejected" | null = null;
  if (lookup.state === "stored") {
    if (sessionId && lookup.sessionId && sessionId !== lookup.sessionId) blocked = "identity_rejected";
    sessionId = sessionId ?? lookup.sessionId;
    paymentId = paymentId ?? lookup.paymentId;
    attempt = attempt ?? lookup.checkoutAttempt;
    if (!sessionId && lookup.checkoutAttempt > 0) ambiguous = true;
  }
  const idempotencyKey = paymentId != null && attempt != null && attempt > 0 ? `${paymentId}:${attempt}` : null;
  let record: PaymentRecoveryRecord;
  if (!checkout.attempted) {
    record = paymentRecoveryRecord({
      outcome: "no_session",
      bookingId,
      githubRunId: input.githubRunId,
      githubRunAttempt: input.githubRunAttempt,
      operationFailure,
    });
  } else if (!sessionId) {
    record = paymentRecoveryRecord({
      outcome: "recovery_required",
      bookingId,
      paymentId,
      idempotencyKey,
      githubRunId: input.githubRunId,
      githubRunAttempt: input.githubRunAttempt,
      operationFailure,
      recoveryFailure: flags.databaseUnreadable ? "database_unreadable" : "creation_ambiguous",
      creationAmbiguous: true,
      databaseUnreadable: flags.databaseUnreadable,
    });
  } else {
    try {
      record = await reconcilePaymentRecovery({
        secret: input.secret,
        sessionId,
        creationAmbiguous: ambiguous,
        bookingId,
        paymentId,
        idempotencyKey,
        githubRunId: input.githubRunId,
        githubRunAttempt: input.githubRunAttempt,
        operationFailure,
        blocked,
        fetchImpl: input.fetchImpl,
        readBooking: async () => {
          try {
            return await input.readBooking();
          } catch (err) {
            flags.databaseUnreadable = true;
            throw err;
          }
        },
      });
    } catch (err) {
      record = paymentRecoveryRecord({
        outcome: "recovery_required",
        sessionId,
        bookingId,
        paymentId,
        idempotencyKey,
        githubRunId: input.githubRunId,
        githubRunAttempt: input.githubRunAttempt,
        operationFailure,
        recoveryFailure: paymentFailureCode(err),
        creationAmbiguous: ambiguous,
      });
    }
  }

  const cleanupFailures: string[] = [];
  for (const [code, name] of CLEANUP_STEPS) {
    try {
      await input.cleanup[name]();
    } catch {
      cleanupFailures.push(code);
    }
  }
  return {
    ...record,
    cleanupFailure: cleanupFailures[0] ?? null,
    cleanupFailures,
    databaseUnreadable: record.databaseUnreadable || flags.databaseUnreadable,
    outcome: !sessionId && flags.databaseUnreadable && checkout.attempted ? "recovery_required" : record.outcome,
    browserStage: browserStageOf(browserStage),
    browserFailure: browserFailureOf(browserFailure),
    challengeCheck: browserFailureOf(browserFailure) === "checkout_challenge" ? challengeCheckOf(challengeCheck) : null,
    challengeCounts: browserFailureOf(browserFailure) === "checkout_challenge"
      ? challengeCountReport(challengeCounts) ?? "unavailable"
      : null,
  };
}

async function runAuthorisedHarness(): Promise<void> {
  const { assertGuestPaymentTestProcess } = await import("../../src/lib/aether/guest-payment-test-isolation.ts");
  assertGuestPaymentTestProcess(process.env);
  if (process.env.STRIPE_WEBHOOK_SECRET) throw new Error("saas_webhook_secret_present");
  let opened: { root: QueryClient; database: QueryClient };
  try {
    opened = await resetAuthorisedDisposableDatabase();
  } catch (err) {
    throw new PaymentRecoveryError(paymentRecoveryRecord({
      outcome: "no_session",
      githubRunId: process.env.GITHUB_RUN_ID,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
      operationFailure: paymentFailureCode(err),
    }));
  }
  const root = opened.root;
  const database = opened.database;
  let directory = "";
  let stripeBin = "";
  let listener: { port: number; close: () => Promise<void> } | null = null;
  let proxy: ReturnType<typeof createServer> | null = null;
  let proxyPort = 0;
  let forwarding: { ready: Promise<void>; assertAlive: () => void; stop: () => Promise<void> } | null = null;
  let webhookSecret = "";
  let app: QueryClient | null = null;
  let fixture: { token: string; bookingId: string } | null = null;
  let captured: { raw: string; signature: string } | null = null;
  let webhookFailure = "";
  let checkoutUrl = "";
  let knownSession: { sessionId: string; paymentId: string | null; checkoutAttempt: number | null } | null = null;
  const absentCheckout = {
    attempted: false,
    ambiguous: false,
    sessionId: null,
    paymentId: null,
    checkoutAttempt: null,
    failure: "checkout_not_claimed",
  };
  const record = await runPaymentHarnessBoundary({
    secret: process.env.STRIPE_SECRET_KEY ?? "",
    githubRunId: process.env.GITHUB_RUN_ID,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    fetchImpl: globalThis.fetch,
    lookupPayment: async () => {
      if (!fixture) return { state: "unreadable" };
      const stored = await loadHarnessPayment(database, fixture.bookingId);
      if (stored.checkoutAttempt === null) return { state: "unreadable" };
      if (!stored.sessionId && stored.checkoutAttempt === 0) return { state: "absent" };
      return { state: "stored", paymentId: stored.paymentId, sessionId: stored.sessionId, checkoutAttempt: stored.checkoutAttempt };
    },
    readBooking: () => fixture ? readHarnessBooking(database, fixture.bookingId) : Promise.resolve(null),
    cleanup: {
      listener: async () => { await listener?.close(); },
      proxy: async () => {
        if (!proxy) return;
        await new Promise<void>((resolve, reject) => proxy?.close((err) => err ? reject(err) : resolve()));
      },
      cli: async () => { await forwarding?.stop(); },
      database: async () => {
        let failed = false;
        for (const client of [app, database, root]) {
          try { await client?.end(); } catch { failed = true; }
        }
        if (failed) throw new Error("cleanup_database_failed");
      },
      temporaryDirectory: async () => { if (directory) await rm(directory, { recursive: true, force: true }); },
    },
    steps: {
      prepareFixture: async () => {
        await applyMigrations((sql) => database.query(sql).then(() => undefined));
        await database.query(
          `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
           values ('user-sbg-test','SBG Test','sbg-test@example.com',true,now(),now())`,
        );
        fixture = await createDisposableBooking(database);
        return { bookingId: fixture.bookingId };
      },
      installCli: async () => {
        stripeBin = await installStripeCli();
        directory = join(stripeBin, "..");
      },
      startProxy: async () => {
        proxy = createServer(async (req, res) => {
          const raw = await readBody(req);
          const signature = req.headers["stripe-signature"]?.toString() ?? "";
          if (!listener) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ received: false, outcome: "listener_not_ready" }));
            return;
          }
          const forwarded = await fetch(`http://127.0.0.1:${listener.port}/`, {
            method: "POST",
            headers: { "content-type": "application/json", "stripe-signature": signature },
            body: raw,
          });
          const responseText = await forwarded.text();
          let outcome = "";
          try { outcome = String((JSON.parse(responseText) as { outcome?: string }).outcome ?? ""); } catch { outcome = ""; }
          if (forwarded.ok && outcome === "confirmed_paid" && !captured) {
            try {
              assertPaidConnectEvent(JSON.parse(raw) as Parameters<typeof assertPaidConnectEvent>[0]);
              captured = { raw, signature };
            } catch (err) {
              webhookFailure = err instanceof Error && err.message === "webhook_event_rejected" ? err.message : "webhook_event_rejected";
            }
          }
          res.writeHead(forwarded.status, { "content-type": "application/json" });
          res.end(responseText);
        });
        await new Promise<void>((resolve) => proxy?.listen(0, "127.0.0.1", () => resolve()));
        const address = proxy.address();
        if (!address || typeof address === "string") throw new Error("proxy_not_local");
        proxyPort = address.port;
      },
      awaitCli: async () => {
        forwarding = await forwardConnectEvents({
          stripeBin,
          listenerPort: proxyPort,
          secretReady: (secret) => { webhookSecret = secret; },
        });
        await Promise.race([
          forwarding.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error("webhook_secret_timeout")), 20_000)),
        ]);
        forwarding.assertAlive();
        if (!webhookSecret) throw new Error("webhook_secret_timeout");
      },
      startListener: async () => {
        const { startLocalGuestPaymentTestListener } = await import("../../src/lib/aether/guest-payment-test-listener.ts");
        listener = await startLocalGuestPaymentTestListener({
          connectionString: GATEWAY_URL,
          webhookSecret,
          env: process.env,
        });
      },
      createCheckout: async () => {
        if (!fixture) return absentCheckout;
        const { startGuestPaymentForBooking } = await import("../../src/lib/aether/guest-payment-fns.ts");
        app = await connectAdmin(APP_URL);
        const who = await app.query<{ current_user: string }>("select current_user");
        if (who.rows[0]?.current_user !== "aether_app") {
          return { ...absentCheckout, attempted: true, ambiguous: true, failure: "role_not_authorised" };
        }
        const db = { query: async <T>(text: string, params?: unknown[]) => (await app!.query(text, params)).rows as T[] };
        try {
          const payment = await startGuestPaymentForBooking(db, fixture.token, RETURN_ORIGIN, process.env);
          if (payment.accountId !== CONNECTED_ACCOUNT) {
            return { ...absentCheckout, attempted: true, ambiguous: true, failure: "unexpected_payee" };
          }
          checkoutUrl = payment.url;
        } catch (err) {
          const stored = await loadHarnessPayment(database, fixture.bookingId);
          if (stored.checkoutAttempt === null) {
            return { attempted: true, ambiguous: true, sessionId: null, paymentId: null, checkoutAttempt: null, failure: paymentFailureCode(err), lookupUnreadable: true };
          }
          if (stored.sessionId || stored.checkoutAttempt > 0) {
            return { attempted: true, ambiguous: !stored.sessionId, sessionId: stored.sessionId, paymentId: stored.paymentId, checkoutAttempt: stored.checkoutAttempt, failure: paymentFailureCode(err) };
          }
          return { ...absentCheckout, failure: "checkout_not_claimed" };
        }
        const stored = await loadHarnessPayment(database, fixture.bookingId);
        if (stored.checkoutAttempt === null) {
          return { attempted: true, ambiguous: true, sessionId: null, paymentId: null, checkoutAttempt: null, failure: "database_unreadable", lookupUnreadable: true };
        }
        if (!stored.sessionId) {
          return {
            attempted: true,
            ambiguous: true,
            sessionId: null,
            paymentId: stored.paymentId,
            checkoutAttempt: stored.checkoutAttempt,
            failure: "checkout_authority_mismatch",
          };
        }
        const row = await database.query<{ account_id: string; amount_minor: number; currency: string }>(
          `select payee_stripe_account_id as account_id, amount_minor, currency
             from sbg_booking_payments where booking_id = $1::uuid`,
          [fixture.bookingId],
        );
        const paymentRow = row.rows[0];
        if (!paymentRow || paymentRow.account_id !== CONNECTED_ACCOUNT || Number(paymentRow.amount_minor) !== AMOUNT_MINOR || paymentRow.currency !== "EUR") {
          return { attempted: true, ambiguous: false, sessionId: stored.sessionId, paymentId: stored.paymentId, checkoutAttempt: stored.checkoutAttempt, failure: "checkout_authority_mismatch" };
        }
        knownSession = { sessionId: stored.sessionId, paymentId: stored.paymentId, checkoutAttempt: stored.checkoutAttempt };
        return { attempted: true, ambiguous: false, sessionId: stored.sessionId, paymentId: stored.paymentId, checkoutAttempt: stored.checkoutAttempt, failure: null };
      },
      retrieveCheckout: async () => {
        if (!knownSession) throw new Error("checkout_authority_mismatch");
        const retrieved = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(knownSession.sessionId)}`, {
          headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Stripe-Account": CONNECTED_ACCOUNT },
        });
        const body = await retrieved.json() as { livemode?: boolean; amount_total?: number; currency?: string };
        if (!retrieved.ok || body.livemode !== false || body.amount_total !== AMOUNT_MINOR || body.currency !== "eur") {
          throw new Error("checkout_not_test_mode");
        }
      },
      completeBrowser: async () => { await completeHostedCheckout(checkoutUrl); },
      confirmWebhook: async () => {
        if (!fixture || !forwarding) throw new Error("webhook_not_captured");
        forwarding.assertAlive();
        await waitForBooking(database, fixture.bookingId, forwarding.assertAlive);
        if (webhookFailure) throw new Error(webhookFailure);
        if (!captured) throw new Error("webhook_not_captured");
        assertPaidConnectEvent(JSON.parse(captured.raw) as Parameters<typeof assertPaidConnectEvent>[0]);
      },
      replay: async () => {
        if (!fixture || !listener || !captured || !forwarding) throw new Error("replay_not_duplicate");
        const replay = await fetch(`http://127.0.0.1:${listener.port}/`, {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": captured.signature },
          body: captured.raw,
        });
        const replayBody = await replay.json() as { outcome?: string };
        if (replayBody.outcome !== "duplicate") throw new Error("replay_not_duplicate");
        forwarding.assertAlive();
        const afterReplay = await waitForBooking(database, fixture.bookingId, forwarding.assertAlive);
        if (afterReplay.paid_count !== 1) throw new Error("replay_not_duplicate");
      },
    },
  });
  const success = record.outcome === "paid_confirmed"
    && record.operationFailure == null
    && record.recoveryFailure == null
    && record.cleanupFailure == null
    && record.databaseUnreadable === false;
  if (!success) throw new PaymentRecoveryError(record);
  console.log(JSON.stringify(record));
}

async function waitForBooking(
  database: QueryClient,
  bookingId: string,
  assertAlive: () => void,
): Promise<{
  lifecycle_state: string;
  vehicle_id: string | null;
  amount_minor: number;
  currency: string;
  paid_count: number;
}> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assertAlive();
    const rows = await database.query<{
      lifecycle_state: string;
      vehicle_id: string | null;
      amount_minor: number;
      currency: string;
      paid_count: number;
    }>(
      `select b.lifecycle_state,
              b.vehicle_id::text,
              p.amount_minor,
              p.currency,
              (select count(*)::int from sbg_booking_payments paid
                where paid.booking_id = b.id and paid.status = 'paid') as paid_count
         from bookings b
         join sbg_booking_payments p on p.booking_id = b.id
        where b.id = $1::uuid`,
      [bookingId],
    );
    const row = rows.rows[0];
    if (
      row?.lifecycle_state === "confirmed_paid"
      && row.paid_count === 1
      && row.vehicle_id
      && row.amount_minor === AMOUNT_MINOR
      && row.currency === "EUR"
    ) return row;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("payment_not_confirmed");
}

async function verifyDisposableFixture(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target.includes("stripe.com") || target.includes("playwright")) {
      throw new Error("stripe_call_forbidden");
    }
    return originalFetch(input, init);
  };
  let root: QueryClient | null = null;
  let database: QueryClient | null = null;
  let app: QueryClient | null = null;
  let failure: unknown;
  try {
    try {
      const opened = await runFixtureStage("cluster_identity", () => resetAuthorisedDisposableDatabase());
      root = opened.root;
      database = opened.database;
      const active = database;
      await runFixtureStage("migrations", () => applyMigrations((sql) => active.query(sql).then(() => undefined)));
      await runFixtureStage("test_user", () => active.query(
        `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
         values ('user-sbg-test','SBG Test','sbg-test@example.com',true,now(),now())`,
      ));
      const catalogue = await runFixtureStage("catalogue_fixture", () => createCatalogueFixture(active));
      const fixture = await runFixtureStage("booking", () => createFixtureBooking(active, catalogue.destinationId));
      await runFixtureStage("hold_verification", async () => {
        const held = await active.query<{ assigned: boolean; hold_open: boolean; amount_minor: number }>(
          `select b.vehicle_id is not null as assigned,
                  b.hold_expires_at > clock_timestamp() as hold_open,
                  d.amount_minor
             from bookings b
             join hotel_destinations d on d.id = b.destination_id
            where b.id = $1::uuid`,
          [fixture.bookingId],
        );
        const booking = held.rows[0];
        if (!booking?.assigned || booking.hold_open !== true || Number(booking.amount_minor) !== AMOUNT_MINOR) {
          throw new Error("fixture_not_payable");
        }
      });
      app = await runFixtureStage("app_role", async () => {
        const client = await connectAdmin(APP_URL);
        const who = await client.query<{ current_user: string }>("select current_user");
        if (who.rows[0]?.current_user !== "aether_app") throw new Error("role_not_authorised");
        return client;
      });
      const payment = await runFixtureStage("payment_prepare", async () => {
        const prepared = await app!.query<{ payment_id: string; amount_minor: number; currency: string }>(
          `select payment_id, amount_minor, currency from public.sbg_prepare_capacity_guest_payment($1)`,
          [fixture.token],
        );
        const row = prepared.rows[0];
        if (!row || Number(row.amount_minor) !== AMOUNT_MINOR || row.currency !== "EUR") throw new Error("fixture_not_payable");
        return row;
      });
      await runFixtureStage("payee_binding", async () => {
        const bound = await app!.query<{ bound_stripe_account_id: string }>(
          `select bound_stripe_account_id from public.sbg_bind_payment_authority($1::uuid)`,
          [fixture.bookingId],
        );
        if (bound.rows[0]?.bound_stripe_account_id !== CONNECTED_ACCOUNT) throw new Error("unexpected_payee");
      });
      await runFixtureStage("test_mode", async () => {
        const testMode = await app!.query<{ test_mode: boolean }>(
          `select public.sbg_bound_payee_is_test_mode($1::uuid) as test_mode`,
          [payment.payment_id],
        );
        if (testMode.rows[0]?.test_mode !== true) throw new Error("live_payee_rejected");
      });
      await runFixtureStage("connection_privilege", async () => {
        const hidden = await app!.query<{ denied: boolean }>(
          `select has_table_privilege('aether_app', 'public.sbg_organisation_stripe_connections', 'select') as denied`,
        );
        if (hidden.rows[0]?.denied !== false) throw new Error("connection_table_readable");
      });
      console.log(JSON.stringify({
        fixture: "payable",
        amountMinor: AMOUNT_MINOR,
        currency: "EUR",
        connectedAccount: CONNECTED_ACCOUNT,
        vehicleAssigned: true,
        checkoutCreated: false,
      }));
    } catch (err) {
      failure = err;
    } finally {
      try {
        await runFixtureStage("cleanup", async () => {
          await app?.end();
          await database?.end();
          await root?.end();
          app = null;
          database = null;
          root = null;
        });
      } catch (err) {
        if (!failure) failure = err;
      }
    }
    if (failure) throw failure;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "fixture-check") {
    await verifyDisposableFixture();
    return;
  }
  if (!paymentExecutionAuthorised(process.env)) throw new HarnessClosed();
  await runAuthorisedHarness();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    if (err instanceof PaymentRecoveryError) {
      console.error(JSON.stringify(err.record));
      process.exit(1);
    }
    console.error(safeCode(err));
    process.exit(err instanceof HarnessClosed ? 2 : 1);
  });
}
