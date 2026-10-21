/**
 * Local TEST webhook adapter. Not a route and not mounted on /api/stripe/webhook.
 * It binds only to 127.0.0.1 and accepts a guest signing secret that is not the
 * SaaS webhook secret. The connection must already be aether_payment_gateway.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { acceptIsolatedGuestPaymentTest } from "./guest-payment-gateway-entry.ts";
import { connectDisposableRole } from "./guest-payment-test-local.ts";
import {
  assertDistinctGuestWebhookSecret,
  assertGuestPaymentTestProcess,
  GuestPaymentIsolationError,
} from "./guest-payment-test-isolation.ts";

export const LOCAL_TEST_LISTENER_HOST = "127.0.0.1";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new GuestPaymentIsolationError("payload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startLocalGuestPaymentTestListener(input: {
  connectionString: string;
  webhookSecret: string;
  env: NodeJS.Dict<string>;
  port?: number;
}): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  assertGuestPaymentTestProcess(input.env);
  assertDistinctGuestWebhookSecret(input.webhookSecret, input.env.STRIPE_WEBHOOK_SECRET);
  const client = await connectDisposableRole(input.connectionString, "aether_payment_gateway");
  const db = {
    query: async <T>(text: string, params?: unknown[]) => (await client.query(text, params)).rows as T[],
  };
  let pending = Promise.resolve();
  const server: Server = createServer((req, res) => {
    pending = pending.then(() => handle(req, res)).catch(() => send(res, 503, { received: false, outcome: "database_unavailable" }));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      send(res, 404, { received: false, outcome: "not_found" });
      return;
    }
    const who = await client.query<{ current_user: string }>("select current_user");
    if (who.rows[0]?.current_user !== "aether_payment_gateway") {
      send(res, 503, { received: false, outcome: "role_not_authorised" });
      return;
    }
    const rawBody = await readBody(req);
    const result = await acceptIsolatedGuestPaymentTest({
      rawBody,
      signatureHeader: req.headers["stripe-signature"]?.toString() ?? null,
      webhookSecret: input.webhookSecret,
      db,
      env: input.env,
    });
    send(res, result.status, result.body);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: LOCAL_TEST_LISTENER_HOST, port: input.port ?? 0 }, () => resolve());
    });
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOCAL_TEST_LISTENER_HOST) {
    server.close();
    await client.end().catch(() => undefined);
    throw new GuestPaymentIsolationError("listener_not_local");
  }
  return {
    host: address.address,
    port: address.port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.end().catch(() => undefined);
    },
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
