import { createFileRoute } from "@tanstack/react-router";
import pg from "pg";
import { PRODUCTION_NEON_ENDPOINT } from "@/lib/aether/guest-payment-test-isolation";

/**
 * Preview-only Connect webhook. Closed on production.
 * Uses the gateway role URL, never the application runtime connection.
 * Does not replace /api/stripe/webhook.
 */
export const Route = createFileRoute("/api/stripe/guest-payment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const env = process.env;
        if (
          env.SBG_GUEST_PAYMENT_TEST !== "true"
          || env.VERCEL_ENV === "production"
          || env.AETHER_RESTORE_TARGET === "production"
        ) {
          return Response.json({ received: false, outcome: "test_closed" }, { status: 503 });
        }
        const gatewayUrl = env.SBG_PAYMENT_GATEWAY_URL ?? "";
        const secret = env.STRIPE_GUEST_WEBHOOK_SECRET ?? "";
        if (!gatewayUrl || !secret || gatewayUrl.includes(PRODUCTION_NEON_ENDPOINT)) {
          return Response.json({ received: false, outcome: "secret_unavailable" }, { status: 503 });
        }
        let username = "";
        try {
          username = new URL(gatewayUrl).username;
        } catch {
          username = "";
        }
        if (username !== "aether_payment_gateway") {
          return Response.json({ received: false, outcome: "database_not_authorised" }, { status: 503 });
        }
        const raw = await request.text();
        const signature = request.headers.get("stripe-signature");
        const { acceptIsolatedGuestPaymentTest } = await import("@/lib/aether/guest-payment-gateway-entry");
        const client = new pg.Client({ connectionString: gatewayUrl });
        try {
          await client.connect();
          const result = await acceptIsolatedGuestPaymentTest({
            rawBody: raw,
            signatureHeader: signature,
            webhookSecret: secret,
            db: {
              query: async <T>(text: string, params?: unknown[]) =>
                (await client.query(text, params)).rows as T[],
            },
            env,
          });
          return Response.json(result.body, { status: result.status });
        } catch {
          return Response.json({ received: false, outcome: "unavailable" }, { status: 503 });
        } finally {
          await client.end().catch(() => undefined);
        }
      },
    },
  },
});
