import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { createGuestTransferCheckout } from "@/lib/aether/stripe.server";

const tokenInput = z.object({ token: z.string().min(1) });

export const startGuestPayment = createServerFn({ method: "POST" })
  .validator(tokenInput)
  .handler(async ({ data }) => {
    const db = await getSql();
    const rows = await db.query<{
      payment_id: string;
      booking_id: string;
      hotel_id: string;
      stripe_account_id: string;
      amount_minor: number;
      currency: string;
      status: string;
      checkout_session_id: string | null;
      checkout_url: string | null;
    }>(
      "select * from sbg_prepare_booking_payment($1)",
      [data.token.trim()],
    );
    const payment = rows[0];
    if (!payment) throw new Error("Payment is not available for this booking.");
    if (payment.status === "paid") return { status: "paid" as const, url: null };
    if (payment.checkout_url) return { status: "pending" as const, url: payment.checkout_url };

    const origin = new URL((await import("@tanstack/react-start/server")).getRequest()!.url).origin;
    const checkout = await createGuestTransferCheckout({
      accountId: payment.stripe_account_id,
      bookingId: payment.booking_id,
      paymentId: payment.payment_id,
      amountMinor: Number(payment.amount_minor),
      currency: payment.currency,
      successUrl: `${origin}/confirmed/${encodeURIComponent(data.token)}?payment=success`,
      cancelUrl: `${origin}/confirmed/${encodeURIComponent(data.token)}?payment=cancel`,
    });

    await db.query(
      "select sbg_set_booking_checkout_session($1::uuid, $2, $3)",
      [payment.payment_id, checkout.id, checkout.url],
    );
    return { status: "pending" as const, url: checkout.url };
  });
