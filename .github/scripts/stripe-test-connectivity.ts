/**
 * Non-payment Stripe TEST connectivity check.
 * Two Checkout GET requests and one temporary CLI listen session.
 * It does not create a Checkout Session or call the payment harness.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CONNECTED_ACCOUNT = "acct_1UKEFuFHnHoOWAJE";
const CHECKOUT_LIST_URL = "https://api.stripe.com/v1/checkout/sessions?limit=1";
const CLI_VERSION = "1.55.0";
const CLI_SHA256 = "95b028177e12d5e5537a9d62366dce852bd78e104599bdc067268fe68dad1083";
const CLI_ARCHIVE = `stripe_${CLI_VERSION}_linux_x86_64.tar.gz`;
const REQUEST_TIMEOUT_MS = 15_000;
const CLI_READY_TIMEOUT_MS = 20_000;
const SAFE_CODES = new Set([
  "credential_absent",
  "credential_malformed",
  "live_credential_rejected",
  "stripe_redirect_rejected",
  "stripe_request_failed",
  "stripe_request_timeout",
  "connected_checkout_rejected",
  "connected_checkout_malformed",
  "live_checkout_session",
  "platform_checkout_authentication_failed",
  "platform_checkout_rate_limited",
  "platform_checkout_server_error",
  "platform_checkout_not_permission_denied",
  "forward_target_not_loopback",
  "stripe_cli_download_failed",
  "stripe_cli_checksum_mismatch",
  "stripe_cli_extract_failed",
  "cli_session_timeout",
  "cli_session_not_ready",
  "cli_start_failed",
  "cli_cleanup_failed",
  "listener_cleanup_failed",
]);

const STRIPE_ERROR_CODES = new Set([
  "more_permissions_required",
  "account_invalid",
  "api_key_expired",
  "secret_key_required",
  "rate_limit",
]);
const STRIPE_ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "api_error",
  "rate_limit_error",
  "idempotency_error",
]);
const DIAGNOSTIC_CLASSES = new Set([
  "permission_denied",
  "authentication_failed",
  "request_rejected",
  "rate_limited",
  "server_error",
  "forbidden",
  "rejected",
]);

type LivemodeEvidence = "livemode_false" | "livemode_unproven";

let listener: Server | null = null;
let cli: ChildProcess | null = null;
let directory = "";
let cleaning = false;

function fail(code: string): never {
  throw new Error(code);
}

export function safeCode(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  return SAFE_CODES.has(message) || isConnectedDiagnostic(message) ? message : "connectivity_check_failed";
}

function assertRestrictedTestKey(value: string | undefined): string {
  if (!value) fail("credential_absent");
  if (/^(sk|rk)_live_/.test(value)) fail("live_credential_rejected");
  if (!/^rk_test_[A-Za-z0-9]+$/.test(value) || value.length < 20) fail("credential_malformed");
  return value;
}

function errorCode(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

async function stripeGet(key: string, account: string | null): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
  if (account) headers["Stripe-Account"] = account;
  let response: Response;
  try {
    response = await fetch(CHECKOUT_LIST_URL, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") fail("stripe_request_timeout");
    const message = err instanceof Error ? err.message : "";
    if (/redirect/i.test(message)) fail("stripe_redirect_rejected");
    fail("stripe_request_failed");
  }
  const text = await response.text();
  if (text.length === 0) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: null };
  }
}

function allowlistedStripeError(body: unknown): { code: string; type: string } {
  if (!body || typeof body !== "object") return { code: "code_absent", type: "type_absent" };
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return { code: "code_absent", type: "type_absent" };
  const rawCode = (error as { code?: unknown }).code;
  const rawType = (error as { type?: unknown }).type;
  const code = typeof rawCode !== "string" ? "code_absent" : STRIPE_ERROR_CODES.has(rawCode) ? rawCode : "code_unrecognised";
  const type = typeof rawType !== "string" ? "type_absent" : STRIPE_ERROR_TYPES.has(rawType) ? rawType : "type_unrecognised";
  return { code, type };
}

export function connectedCheckoutDiagnostic(status: number, body: unknown): string {
  if (!Number.isInteger(status) || status < 100 || status > 599) return "connected_checkout_http_invalid";
  const { code, type } = allowlistedStripeError(body);
  const klass =
    status === 401 ? "authentication_failed"
    : status === 400 ? "request_rejected"
    : status === 429 ? "rate_limited"
    : status >= 500 ? "server_error"
    : status === 403 && code === "more_permissions_required" ? "permission_denied"
    : status === 403 ? "forbidden"
    : "rejected";
  return ["connected_checkout", String(status), klass, code, type].join("__");
}

function isConnectedDiagnostic(message: string): boolean {
  if (message === "connected_checkout_http_invalid") return true;
  const parts = message.split("__");
  if (parts.length !== 5 || parts[0] !== "connected_checkout") return false;
  const [statusText, klass, code, type] = parts.slice(1);
  if (!/^[1-5][0-9]{2}$/.test(statusText)) return false;
  const status = Number(statusText);
  if (String(status) !== statusText) return false;
  if (!DIAGNOSTIC_CLASSES.has(klass)) return false;
  if (!new Set([...STRIPE_ERROR_CODES, "code_absent", "code_unrecognised"]).has(code)) return false;
  if (!new Set([...STRIPE_ERROR_TYPES, "type_absent", "type_unrecognised"]).has(type)) return false;
  return message === connectedCheckoutDiagnostic(status, {
    error: {
      code: code === "code_absent" ? undefined : code === "code_unrecognised" ? "not-allowlisted" : code,
      type: type === "type_absent" ? undefined : type === "type_unrecognised" ? "not-allowlisted" : type,
    },
  });
}

export function assessConnectedCheckout(status: number, body: unknown): LivemodeEvidence {
  if (status !== 200) fail(connectedCheckoutDiagnostic(status, body));
  if (!body || typeof body !== "object") fail("connected_checkout_malformed");
  const record = body as { object?: unknown; data?: unknown };
  if (record.object !== "list" || !Array.isArray(record.data)) fail("connected_checkout_malformed");
  if (record.data.length === 0) return "livemode_unproven";
  for (const item of record.data) {
    if (!item || typeof item !== "object") fail("connected_checkout_malformed");
    const session = item as { object?: unknown; livemode?: unknown };
    if (session.object !== "checkout.session") fail("connected_checkout_malformed");
    if (session.livemode === true) fail("live_checkout_session");
    if (session.livemode !== false) fail("connected_checkout_malformed");
  }
  return "livemode_false";
}

function assertPlatformIsolated(status: number, body: unknown): void {
  if (status === 401) fail("platform_checkout_authentication_failed");
  if (status === 429) fail("platform_checkout_rate_limited");
  if (status >= 500) fail("platform_checkout_server_error");
  if (status === 403 && errorCode(body) === "more_permissions_required") return;
  fail("platform_checkout_not_permission_denied");
}

async function installStripeCli(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "sbg-stripe-cli-"));
  const archive = join(directory, CLI_ARCHIVE);
  let response: Response;
  try {
    response = await fetch(
      `https://github.com/stripe/stripe-cli/releases/download/v${CLI_VERSION}/${CLI_ARCHIVE}`,
      { redirect: "follow", signal: AbortSignal.timeout(60_000) },
    );
  } catch {
    fail("stripe_cli_download_failed");
  }
  const host = new URL(response.url).hostname;
  const allowedHost = host === "github.com" || host.endsWith(".githubusercontent.com");
  if (!response.ok || new URL(response.url).protocol !== "https:" || !allowedHost) fail("stripe_cli_download_failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== CLI_SHA256) fail("stripe_cli_checksum_mismatch");
  await writeFile(archive, bytes);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", directory], { stdio: "ignore" });
    child.once("error", () => reject(new Error("stripe_cli_extract_failed")));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("stripe_cli_extract_failed"))));
  });
  return join(directory, "stripe");
}

function listenOnLoopback(): Promise<string> {
  listener = createServer((request, response) => {
    request.resume();
    response.writeHead(204);
    response.end();
  });
  return new Promise((resolve, reject) => {
    listener?.once("error", () => reject(new Error("forward_target_not_loopback")));
    listener?.listen(0, "127.0.0.1", () => {
      const address = listener?.address();
      if (!address || typeof address === "string") {
        reject(new Error("forward_target_not_loopback"));
        return;
      }
      const target = new URL(`http://127.0.0.1:${address.port}/`);
      if (target.hostname !== "127.0.0.1" || target.protocol !== "http:") {
        reject(new Error("forward_target_not_loopback"));
        return;
      }
      resolve(target.toString());
    });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopCli(): Promise<void> {
  const child = cli;
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 2_000))) fail("cli_cleanup_failed");
}

async function cleanup(): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  let failure: Error | null = null;
  try {
    await stopCli();
  } catch (err) {
    failure = err instanceof Error ? err : new Error("cli_cleanup_failed");
  }
  const server = listener;
  listener = null;
  if (server?.listening) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(new Error("listener_cleanup_failed")) : resolve()));
      });
    } catch (err) {
      if (!failure) failure = err instanceof Error ? err : new Error("listener_cleanup_failed");
    }
  }
  if (directory) {
    const path = directory;
    directory = "";
    await rm(path, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

async function proveCliSession(key: string, forwardTo: string): Promise<void> {
  const target = new URL(forwardTo);
  if (target.hostname !== "127.0.0.1" || target.protocol !== "http:") fail("forward_target_not_loopback");
  const bin = await installStripeCli();
  const childEnv = { ...process.env };
  delete childEnv.STRIPE_SECRET_KEY;
  delete childEnv.DEBUG;
  delete childEnv.NODE_DEBUG;
  childEnv.STRIPE_API_KEY = key;
  cli = spawn(
    bin,
    ["listen", "--forward-connect-to", target.toString(), "--events", "checkout.session.completed"],
    { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let privateOutput = "";
  const child = cli;
  const ready = new Promise<void>((resolve, reject) => {
    const watch = (chunk: Buffer) => {
      privateOutput = (privateOutput + chunk.toString("utf8")).slice(-4000);
      const secretSeen = /whsec_[A-Za-z0-9]+/.test(privateOutput);
      if (privateOutput.includes("Ready!") && secretSeen) {
        privateOutput = "";
        resolve();
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    child.once("error", () => reject(new Error("cli_start_failed")));
    child.once("exit", () => {
      privateOutput = "";
      reject(new Error("cli_session_not_ready"));
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("cli_session_timeout")), CLI_READY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    privateOutput = "";
  }
  await stopCli();
}

async function runChecks(key: string): Promise<{ connectedCheckout: "accepted"; livemode: LivemodeEvidence; platformCheckout: "permission_denied"; cliSession: "ready" }> {
  const connected = await stripeGet(key, CONNECTED_ACCOUNT);
  const livemode = assessConnectedCheckout(connected.status, connected.body);
  const platform = await stripeGet(key, null);
  assertPlatformIsolated(platform.status, platform.body);
  const forwardTo = await listenOnLoopback();
  await proveCliSession(key, forwardTo);
  return {
    connectedCheckout: "accepted",
    livemode,
    platformCheckout: "permission_denied",
    cliSession: "ready",
  };
}

async function main(): Promise<void> {
  const key = assertRestrictedTestKey(process.env.STRIPE_SECRET_KEY);
  let failure: Error | null = null;
  let result: Awaited<ReturnType<typeof runChecks>> | null = null;
  try {
    result = await runChecks(key);
  } catch (err) {
    failure = err instanceof Error ? err : new Error("connectivity_check_failed");
  } finally {
    try {
      await cleanup();
    } catch (err) {
      if (!failure) failure = err instanceof Error ? err : new Error("cli_cleanup_failed");
    }
  }
  if (failure || !result) {
    console.error(safeCode(failure));
    process.exit(1);
  }
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.once("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void cleanup().finally(() => process.exit(143));
  });
  void main();
}
