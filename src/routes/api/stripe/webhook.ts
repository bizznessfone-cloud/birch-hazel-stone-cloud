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

        // Refunds carry no booking metadata. The application role cannot
        // correlate them, so acknowledging one would burn Stripe's retry
        // before the isolated endpoint can release a capacity vehicle.
        if (event.type === "charge.refunded" || event.type === "refund.updated") {
          return Response.json(
            { received: false, outcome: "capacity_payment_unmounted" },
            { status: 503 },
          );
        }

        if (!(typeof event.type === "string" && event.type.startsWith("checkout.session.")) && !relevant.has(event.type)) {
          return Response.json({ received: true });
        }

        const db = await getSql();

        if (event.type.startsWith("checkout.session.")) {
          const object = event?.data?.object;
          const metadata = object?.metadata ?? {};
          const bookingId = typeof metadata.booking_id === "string" ? metadata.booking_id : null;
          const paymentId = typeof metadata.payment_id === "string" ? metadata.payment_id : null;
          if (!bookingId || !paymentId) {
            if (!relevant.has(event.type)) {
              return Response.json(
                { received: false, outcome: "capacity_payment_unmounted" },
                { status: 503 },
              );
            }
            return Response.json({ received: true });
          }
          const { CapacityLatchUnavailable, capacityWebhookLatch } = await import(
            "@/lib/aether/guest-payment-latch"
          );
          try {
            const latch = await capacityWebhookLatch(db, bookingId);
            if (latch === "fail_closed" || latch === "unproven") {
              return Response.json(
                { received: false, outcome: "capacity_payment_unmounted" },
                { status: 503 },
              );
            }
          } catch (error) {
            if (error instanceof CapacityLatchUnavailable) {
              return Response.json(
                { received: false, outcome: "capacity_payment_unmounted" },
                { status: 503 },
              );
            }
            throw error;
          }
          if (!relevant.has(event.type)) {
            return Response.json({ received: true, outcome: "checkout_not_applied" });
          }
          const { evaluateDomainBCheckoutBinding } = await import("@/lib/aether/domain-b-payment");
          const decision = await evaluateDomainBCheckoutBinding(db, event);
          if (decision.action === "ignore") return Response.json({ received: true });
          if (decision.action === "mismatch") {
            return Response.json({ received: false, outcome: "binding_mismatch" }, { status: 409 });
          }
          await db.query(
            "select sbg_apply_payment_event($1, $2, $3::uuid, $4::uuid, $5, $6, $7)",
            [
              decision.eventId,
              decision.eventType,
              decision.bookingId,
              decision.paymentId,
              decision.paymentIntentId,
              decision.paymentStatus,
              decision.accountId,
            ],
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
          if (error instanceof DomainAWebhookExtractError || error instanceof SaasLifecycleError) {
            return Response.json({ received: true, outcome: "rejected" });
          }
          throw error;
        }
      },
    },
  },
});
