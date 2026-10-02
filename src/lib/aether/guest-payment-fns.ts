import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Sql } from "../db.ts";
import { guestCheckoutIsReusable } from "./domain-b-payment.ts";

const tokenInput = z.object({ token: z.string().min(1) });

export async function startGuestPaymentForBooking(db: Sql, token: string, origin: string) {
  const { createGuestTransferCheckout } = await import("./stripe.server.ts");
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
  }>("select * from sbg_prepare_booking_payment($1)", [token.trim()]);
  const payment = rows[0];
  if (!payment) throw new Error("Payment is not available for this booking.");
  if (payment.status === "paid") return { status: "paid" as const, url: null };
  if (
    guestCheckoutIsReusable({
      status: payment.status,
      checkout_session_id: payment.checkout_session_id,
      checkout_url: payment.checkout_url,
    })
  ) {
    return { status: "pending" as const, url: payment.checkout_url };
  }

  const checkout = await createGuestTransferCheckout({
    accountId: payment.stripe_account_id,
    bookingId: payment.booking_id,
    paymentId: payment.payment_id,
    amountMinor: Number(payment.amount_minor),
    currency: payment.currency,
    successUrl: `${origin}/confirmed/${encodeURIComponent(token)}?payment=success`,
    cancelUrl: `${origin}/confirmed/${encodeURIComponent(token)}?payment=cancel`,
  });

  await db.query("select sbg_set_booking_checkout_session($1::uuid, $2, $3)", [
    payment.payment_id,
    checkout.id,
    checkout.url,
  ]);
  return { status: "pending" as const, url: checkout.url };
}

export const startGuestPayment = createServerFn({ method: "POST" })
  .validator(tokenInput)
  .handler(async ({ data }) => {
    const { getSql } = await import("../db.ts");
    const db = await getSql();
    const origin = new URL((await import("@tanstack/react-start/server")).getRequest()!.url).origin;
    return startGuestPaymentForBooking(db, data.token, origin);
  });