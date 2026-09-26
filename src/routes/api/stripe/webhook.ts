import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { domainAWebhookEligible, domainAWebhookOrganisationAllowed } from "@/lib/aether/saas-commerce.server";
import {
  DomainAWebhookExtractError,
  OrderedBillingSchemaError,
  applyDomainABillingEvent,
  extractDomainASubscriptionEvent,
} from "@/lib/aether/saas-billing-webhook";
import { SaasLifecycleError } from "@/lib/aether/saas-lifecycle";

export const Route = createFileRoute("/api/stripe/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const signature = request.headers.get("stripe-signature");
        const { verifyStripeSignature } = await import("@/lib/aether/stripe.server");
        if (!signature || !verifyStripeSignature(raw, signature)) {
          return new Response("Invalid Stripe signature.", { status: 400 });
        }

        let event: any;
        try {
          event = JSON.parse(raw);
        } catch {
          return new Response("Invalid JSON.", { status: 400 });
        }

        const relevant = new Set([
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
          "checkout.session.async_payment_failed",
          "customer.subscription.created",
          "customer.subscription.updated",
          "customer.subscription.deleted",
          "account.application.deauthorized",
        ]);

        if (!relevant.has(event.type)) {
          return Response.json({ received: true });
        }

        const db = await getSql();

        if (event.type.startsWith("checkout.session.")) {
          const object = event?.data?.object;
          const metadata = object?.metadata ?? {};
          const bookingId = typeof metadata.booking_id === "string" ? metadata.booking_id : null;
          const paymentId = typeof metadata.payment_id === "string" ? metadata.payment_id : null;
          if (!bookingId || !paymentId) return Response.json({ received: true });
          const paymentStatus =
            event.type === "checkout.session.completed" && object?.payment_status === "paid"
              ? "paid"
              : event.type === "checkout.session.async_payment_succeeded"
                ? "paid"
                : event.type === "checkout.session.async_payment_failed"
                  ? "failed"
                  : "pending";
          const paymentIntentId = typeof object?.payment_intent === "string" ? object.payment_intent : null;
          await db.query(
            "select sbg_apply_payment_event($1, $2, $3::uuid, $4::uuid, $5, $6, $7)",
            [event.id, event.type, bookingId, paymentId, paymentIntentId, paymentStatus, typeof event?.account === "string" ? event.account : null],
          );
          return Response.json({ received: true });
        }

        if (event.type === "account.application.deauthorized") {
          const accountId = event?.account?.id ?? event?.data?.object?.id;
          if (typeof accountId === "string") {
            await db.query("select sbg_disconnect_stripe_by_account($1)", [accountId]);
          }
          return Response.json({ received: true });
        }

        if (!domainAWebhookEligible(event)) {
          return Response.json({ received: true });
        }

        let extracted;
        try {
          extracted = extractDomainASubscriptionEvent(event);
        } catch (error) {
          if (error instanceof DomainAWebhookExtractError) {
            return Response.json({ received: true, outcome: "rejected" });
          }
          throw error;
        }

        if (!domainAWebhookOrganisationAllowed(extracted.organisationId)) {
          return Response.json({ received: true, outcome: "isolated" });
        }

        try {
          const outcome = await applyDomainABillingEvent(db, extracted);
          return Response.json({ received: true, outcome });
        } catch (error) {
          if (error instanceof OrderedBillingSchemaError) {
            return new Response("Ordered billing persistence is not installed.", { status: 503 });
          }
          if (error instanceof SaasLifecycleError) {
            return Response.json({ received: true, outcome: "rejected" });
          }
          throw error;
        }
      },
    },
  },
});
