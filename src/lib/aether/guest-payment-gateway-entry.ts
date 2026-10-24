/**
 * Isolated capacity-payment webhook adapter.
 * Not mounted on /api/stripe/webhook and not a deployment.
 * The caller supplies a connection already authenticated as aether_payment_gateway
 * and a Connect signing secret that is not the SaaS webhook secret.
 */
import { classifyStripeSecretKey } from "./saas-commerce.server.ts";
import {
  handleGuestPaymentWebhook,
  verifyGuestPaymentSignature,
  type GatewayDb,
  type GuestPaymentWebhookResult,
} from "./payment-gateway.ts";
import { SBG_GUEST_PAYMENT_TEST, guestPaymentTestEnabled } from "./guest-payment-fns.ts";

function isolatedEventMode(rawBody: string): "test" | "live" | "invalid" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return "invalid";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "live";
  const event = parsed as { livemode?: unknown; data?: unknown };
  const data = event.data;
  const object = data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as { object?: unknown }).object
    : undefined;
  const objectMode = object !== null && typeof object === "object" && !Array.isArray(object)
    ? (object as { livemode?: unknown }).livemode
    : undefined;
  if (event.livemode !== false) return "live";
  if (objectMode !== undefined && objectMode !== false) return "live";
  return "test";
}

export async function acceptIsolatedGuestPaymentTest(input: {
  rawBody: string;
  signatureHeader: string | null;
  webhookSecret: string;
  db: GatewayDb;
  env?: NodeJS.Dict<string>;
  nowMs?: number;
}): Promise<GuestPaymentWebhookResult> {
  const env = input.env ?? process.env;
  if (!guestPaymentTestEnabled(env)) {
    return { status: 503, body: { received: false, outcome: "test_closed" } };
  }
  if (classifyStripeSecretKey(env.STRIPE_SECRET_KEY) === "live") {
    return { status: 503, body: { received: false, outcome: "live_credentials_rejected" } };
  }
  const saasSecret = env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!input.webhookSecret || (saasSecret !== "" && input.webhookSecret === saasSecret)) {
    return { status: 503, body: { received: false, outcome: "secret_unavailable" } };
  }
  if (env[SBG_GUEST_PAYMENT_TEST] !== "true") {
    return { status: 503, body: { received: false, outcome: "test_closed" } };
  }
  if (
    !input.signatureHeader
    || !verifyGuestPaymentSignature(input.rawBody, input.signatureHeader, input.webhookSecret, input.nowMs ?? Date.now())
  ) {
    return { status: 400, body: { received: false, outcome: "invalid_signature" } };
  }
  const mode = isolatedEventMode(input.rawBody);
  if (mode === "invalid") return { status: 400, body: { received: false, outcome: "invalid_json" } };
  if (mode === "live") return { status: 409, body: { received: false, outcome: "live_event_rejected" } };
  return handleGuestPaymentWebhook({
    rawBody: input.rawBody,
    signatureHeader: input.signatureHeader,
    secret: input.webhookSecret,
    db: input.db,
    nowMs: input.nowMs,
  });
}
