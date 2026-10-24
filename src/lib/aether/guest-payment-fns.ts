/**
 * Guest transfer checkout entry. Gate 2 has not authorised it.
 * This module must not prepare a payment, reuse a checkout URL, or call Stripe.
 * SaaS subscription checkout is a different function and is not this module.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Sql } from "../db.ts";

const tokenInput = z.object({ token: z.string().min(1) });

export class GuestCheckoutClosed extends Error {
  readonly code = "guest_checkout_closed";
  constructor() {
    super("Online payment is not open for this booking.");
    this.name = "GuestCheckoutClosed";
  }
}

function closedSql(): Sql {
  const deny = async (): Promise<never> => {
    throw new GuestCheckoutClosed();
  };
  return Object.assign(deny, { query: deny }) as Sql;
}

export async function startGuestPaymentForBooking(
  _db: Sql,
  _token: string,
  _origin: string,
): Promise<never> {
  throw new GuestCheckoutClosed();
}

export const startGuestPayment = createServerFn({ method: "POST" })
  .validator(tokenInput)
  .handler(async ({ data }) => {
    return startGuestPaymentForBooking(closedSql(), data.token, "");
  });
