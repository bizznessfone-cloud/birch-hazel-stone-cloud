/**
 * Local human Stripe TEST booking entrypoint.
 * It prepares one unpaid €45 booking and waits. It does not submit a card.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { classifyStripeSecretKey } from "../../src/lib/aether/saas-commerce.server.ts";
import { startLocalGuestPaymentTestListener } from "../../src/lib/aether/guest-payment-test-listener.ts";
import { forwardConnectEvents, prepareDisposableGuestFixture } from "./stripe-test-harness.ts";

export const HUMAN_APP_ORIGIN = "http://127.0.0.1:8080";
export const HUMAN_CONFIRMATION_FILE = "/tmp/sbg-human-confirmation.url";
export const HUMAN_SERVE_STEPS = [
  "identify_cluster",
  "apply_migrations",
  "create_unpaid_booking",
  "start_loopback_app",
  "forward_connect_webhook",
  "wait_for_human",
] as const;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

export function assertHumanTestConfig(env: NodeJS.Dict<string>): void {
  if (env.SBG_GUEST_PAYMENT_TEST !== "true") throw new Error("test_mode_required");
  if (classifyStripeSecretKey(env.STRIPE_SECRET_KEY) !== "test") throw new Error("test_credentials_required");
  if (env.SBG_DOMAIN_B_LIVE_CHECKOUT === "true" || env.SBG_SAAS_COMMERCE === "live") {
    throw new Error("live_payment_flag");
  }
  const databaseUrl = env.DATABASE_URL ?? "";
  if (databaseUrl.includes("neon.tech") || databaseUrl.includes("vercel")) {
    throw new Error("database_not_authorised");
  }
}

export function resolveStripeCli(env: NodeJS.Dict<string>): string {
  const candidate = (env.STRIPE_CLI ?? "").trim() || "/tmp/stripe-cli/stripe";
  if (!candidate.startsWith("/") || candidate.includes("..")) throw new Error("stripe_cli_missing");
  return candidate;
}

export function humanConfirmationUrl(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("booking_token_invalid");
  return `${HUMAN_APP_ORIGIN}/confirmed/${encodeURIComponent(token)}`;
}

export function redactHumanSecrets(text: string, token = ""): string {
  let out = text;
  if (token) out = out.split(token).join("[booking]");
  return out
    .replace(/sk_test_[A-Za-z0-9]+/g, "[test-key]")
    .replace(/rk_test_[A-Za-z0-9]+/g, "[test-key]")
    .replace(/sk_live_[A-Za-z0-9]+/g, "[live-key]")
    .replace(/rk_live_[A-Za-z0-9]+/g, "[live-key]")
    .replace(/whsec_[A-Za-z0-9]+/g, "[webhook-secret]");
}

export function operatorStatusLines(): readonly string[] {
  return [
    `The confirmation page is in ${HUMAN_CONFIRMATION_FILE}.`,
    "Open that private file on this machine. This process will not enter a card.",
    "After checking the booking, stop this process and run: node --experimental-strip-types .github/scripts/stripe-test-human-booking.ts cleanup",
  ];
}

export async function publishConfirmationUrl(token: string): Promise<string> {
  const url = humanConfirmationUrl(token);
  await writeFile(HUMAN_CONFIRMATION_FILE, `${url}\n`, { mode: 0o600 });
  await chmod(HUMAN_CONFIRMATION_FILE, 0o600);
  return HUMAN_CONFIRMATION_FILE;
}

async function removeConfirmationFile(): Promise<void> {
  await rm(HUMAN_CONFIRMATION_FILE, { force: true });
}

export async function requireIdentifiedCluster(
  run: (args: string[]) => Promise<void> = runScript,
): Promise<void> {
  try {
    await run(["identify"]);
  } catch {
    throw new Error("database_not_authorised");
  }
}

function runScript(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [".github/scripts/bootstrap-disposable-postgres.sh", ...args], { stdio: "ignore" });
    child.once("error", () => reject(new Error("database_not_authorised")));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("database_not_authorised"))));
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function startProxy(listenerPort: () => number | null): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    void proxy(req, res);
  });
  async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = listenerPort();
    if (req.method !== "POST" || port == null) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: false, outcome: "listener_not_ready" }));
      return;
    }
    const raw = await readBody(req);
    const signature = req.headers["stripe-signature"]?.toString() ?? "";
    const forwarded = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: raw,
    });
    res.writeHead(forwarded.status, { "content-type": "application/json" });
    res.end(await forwarded.text());
  }
  return new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("listener_not_local")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
        reject(new Error("listener_not_local"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function appEnv(env: NodeJS.Dict<string>): NodeJS.ProcessEnv {
  return {
    ...env,
    DATABASE_URL: "postgresql://aether_app@127.0.0.1:54329/neondb",
    SBG_GUEST_PAYMENT_TEST: "true",
    SBG_DOMAIN_B_LIVE_CHECKOUT: "false",
    SBG_SAAS_COMMERCE: "off",
    STRIPE_WEBHOOK_SECRET: "",
  } as NodeJS.ProcessEnv;
}

async function serve(): Promise<void> {
  assertHumanTestConfig(process.env);
  const stripeBin = resolveStripeCli(process.env);
  if (!existsSync(stripeBin)) throw new Error("stripe_cli_missing");
  await requireIdentifiedCluster();
  const booking = await prepareDisposableGuestFixture();
  await publishConfirmationUrl(booking.token);
  let listenerPort: number | null = null;
  let proxy: { server: Server; port: number } | null = null;
  let forwarding: { ready: Promise<void>; stop: () => Promise<void> } | null = null;
  let listener: { close: () => Promise<void> } | null = null;
  let app: ChildProcess | null = null;
  const stop = async (): Promise<void> => {
    app?.kill("SIGTERM");
    await listener?.close().catch(() => undefined);
    await forwarding?.stop().catch(() => undefined);
    if (proxy) await new Promise<void>((resolve) => proxy?.server.close(() => resolve()));
    await removeConfirmationFile();
  };
  process.once("SIGINT", () => {
    void stop().finally(() => process.exit(0));
  });
  try {
    proxy = await startProxy(() => listenerPort);
    let secret = "";
    forwarding = await forwardConnectEvents({
      stripeBin,
      listenerPort: proxy.port,
      secretReady: (value) => {
        secret = value;
      },
    });
    await forwarding.ready;
    if (!secret.startsWith("whsec_") || secret === "saas-webhook-not-this-listener") {
      throw new Error("webhook_secret_unavailable");
    }
    const started = await startLocalGuestPaymentTestListener({
      connectionString: "postgresql://aether_payment_gateway@127.0.0.1:54329/neondb",
      webhookSecret: secret,
      env: {
        SBG_GUEST_PAYMENT_TEST: "true",
        STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: "saas-webhook-not-this-listener",
      },
    });
    listenerPort = started.port;
    listener = started;
    app = spawn("node", ["scripts/with-app-env.mjs", "vite", "dev", "--host", "127.0.0.1", "--port", "8080"], {
      env: appEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const write = (chunk: Buffer) => {
      process.stderr.write(redactHumanSecrets(chunk.toString("utf8"), booking.token));
    };
    app.stdout?.on("data", write);
    app.stderr?.on("data", write);
    for (const line of operatorStatusLines()) process.stdout.write(`${line}\n`);
    await new Promise<void>((resolve) => app?.once("exit", () => resolve()));
  } finally {
    await stop();
  }
}

async function cleanup(): Promise<void> {
  await runScript(["identify"]);
  await runScript(["cleanup"]);
}

async function main(): Promise<void> {
  if (process.argv[2] === "cleanup") {
    await cleanup();
    return;
  }
  await serve();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    const code = err instanceof Error ? err.message : "human_booking_failed";
    process.stderr.write(`${redactHumanSecrets(code)}\n`);
    process.exit(1);
  });
}
