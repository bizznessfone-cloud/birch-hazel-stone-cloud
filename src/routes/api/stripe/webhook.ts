import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";

function unixToIso(value: unknown) {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

function subscriptionData(event: any) {
  const object = event?.data?.object;
  const metadata = object?.metadata ?? {};
  const item = object?.items?.data?.[0];
  return {
    hotelId: typeof metadata.hotel_id === "string" ? metadata.hotel_id : null,
    customerId: typeof object?.customer === "string" ? object.customer : null,
    subscriptionId: typeof object?.id === "string" ? object.id : null,
    priceId: typeof item?.price?.id === "string" ? item.price.id : null,
    status: typeof object?.status === "string" ? object.status : "inactive",
    currentPeriodEnd: unixToIso(object?.current_period_end),
  };
}

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

        const data = subscriptionData(event);
        if (!data.hotelId || !data.subscriptionId) {
          return Response.json({ received: true });
        }
        await db.query(
          "select sbg_apply_billing_event($1, $2, $3::uuid, $4, $5, $6, $7, $8::timestamptz)",
          [
            event.id,
            event.type,
            data.hotelId,
            data.customerId,
            data.subscriptionId,
            data.priceId,
            data.status,
            data.currentPeriodEnd,
          ],
        );
        await db.query("select sbg_sync_hotel_entitlement($1::uuid)", [data.hotelId]);

        return Response.json({ received: true });
      },
    },
  },
});
