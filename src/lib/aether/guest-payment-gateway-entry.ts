/**
 * Isolated capacity-payment webhook adapter.
 * Not mounted on /api/stripe/webhook and not a deployment.
 * The caller supplies a connection already authenticated as aether_payment_gateway
 * and a Connect signing secret that is not the SaaS webhook secret.
 */
import { classifyStripeSecretKey } from "./saas-commerce.server.ts";
import {
  handleGuestPaymentWebhook,
  type GatewayDb,
  type GuestPaymentWebhookResult,
} from "./payment-gateway.ts";
import { SBG_GUEST_PAYMENT_TEST, guestPaymentTestEnabled } from "./guest-payment-fns.ts";

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
  return handleGuestPaymentWebhook({
    rawBody: input.rawBody,
    signatureHeader: input.signatureHeader,
    secret: input.webhookSecret,
    db: input.db,
    nowMs: input.nowMs,
  });
}
