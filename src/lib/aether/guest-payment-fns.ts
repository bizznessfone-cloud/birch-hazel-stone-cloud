/**
 * Guest transfer checkout. Closed unless SBG_GUEST_PAYMENT_TEST is exactly "true".
 * A test key is required. A live key is rejected even when the flag is set.
 * The charge account is the bound executing payee. SaaS subscription checkout
 * is a different function and is not used here.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Sql } from "../db.ts";
import { bindPaymentAuthority } from "./payment-authority.ts";
import { classifyStripeSecretKey } from "./saas-commerce.server.ts";

const tokenInput = z.object({ token: z.string().min(1) });

export const SBG_GUEST_PAYMENT_TEST = "SBG_GUEST_PAYMENT_TEST";

export class GuestCheckoutClosed extends Error {
  readonly code = "guest_checkout_closed";
  constructor() {
    super("Online payment is not open for this booking.");
    this.name = "GuestCheckoutClosed";
  }
}

export class GuestPaymentTestError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "GuestPaymentTestError";
    this.code = code;
  }
}

export function guestPaymentTestEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env[SBG_GUEST_PAYMENT_TEST] === "true";
}

function closedSql(): Sql {
  const deny = async (): Promise<never> => {
    throw new GuestCheckoutClosed();
  };
  return Object.assign(deny, { query: deny }) as Sql;
}

type PaymentDb = {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
};

export type GuestCheckoutRequest = {
  accountId: string;
  bookingId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
};

export type GuestCheckoutSession = { id: string; url: string };

export type GuestPaymentDeps = {
  createCheckout: (input: GuestCheckoutRequest) => Promise<GuestCheckoutSession>;
  expireCheckout: (input: { accountId: string; sessionId: string }) => Promise<void>;
};

const KNOWN = [
  "hold_expired",
  "booking_not_found",
  "booking_not_payable",
  "stripe_disconnected",
  "licence_missing",
  "subscription_inactive",
  "ambiguous_authority",
  "inactive_agreement",
  "authorisation_revoked",
  "grant_revoked",
  "hotel_account_not_payee",
  "payment_attempt_missing",
  "incompatible_authority",
  "checkout_in_progress",
] as const;

function knownCode(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  for (const code of KNOWN) {
    if (message.includes(code)) return code;
  }
  return null;
}

async function defaultDeps(): Promise<GuestPaymentDeps> {
  const stripe = await import("./stripe.server.ts");
  return {
    createCheckout: (input) => stripe.createGuestTransferCheckout(input),
    expireCheckout: (input) => stripe.expireGuestTransferCheckout(input),
  };
}

export async function startGuestPaymentForBooking(
  db: PaymentDb,
  token: string,
  origin: string,
  env: NodeJS.Dict<string> = process.env,
  deps?: GuestPaymentDeps,
): Promise<{ url: string; paymentId: string; accountId: string }> {
  if (!guestPaymentTestEnabled(env)) throw new GuestCheckoutClosed();
  const keyMode = classifyStripeSecretKey(env.STRIPE_SECRET_KEY);
  if (keyMode !== "test") {
    throw new GuestPaymentTestError("live_credentials_rejected", "Stripe test credentials are required.");
  }
  if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
    throw new GuestPaymentTestError("invalid_origin", "A return origin is required.");
  }
  const checkout = deps ?? (await defaultDeps());
  let prepared: {
    payment_id: string;
    booking_id: string;
    amount_minor: number;
    currency: string;
    status: string;
    checkout_session_id: string | null;
    checkout_url: string | null;
  };
  try {
    const rows = await db.query<typeof prepared>(
      `select payment_id, booking_id, amount_minor, currency, status, checkout_session_id, checkout_url
         from public.sbg_prepare_capacity_guest_payment($1)`,
      [token],
    );
    const row = rows[0];
    if (!row) throw new GuestPaymentTestError("booking_not_found");
    prepared = { ...row, amount_minor: Number(row.amount_minor) };
  } catch (err) {
    if (err instanceof GuestPaymentTestError) throw err;
    const code = knownCode(err);
    if (code) throw new GuestPaymentTestError(code);
    throw err;
  }

  let bound;
  try {
    bound = await bindPaymentAuthority(db, prepared.booking_id);
  } catch (err) {
    const code = knownCode(err);
    if (code) throw new GuestPaymentTestError(code);
    throw err;
  }
  if (!bound.stripeAccountId) throw new GuestPaymentTestError("stripe_disconnected");

  if (
    prepared.status === "pending" &&
    prepared.checkout_session_id &&
    prepared.checkout_url?.startsWith("https://")
  ) {
    return {
      url: prepared.checkout_url,
      paymentId: prepared.payment_id,
      accountId: bound.stripeAccountId,
    };
  }

  let claim: { claim_outcome: string; claim_attempt: number; claim_session_id: string | null; claim_url: string | null };
  try {
    const claims = await db.query<typeof claim>(
      `select claim_outcome, claim_attempt, claim_session_id, claim_url
         from public.sbg_claim_capacity_checkout($1::uuid)`,
      [prepared.payment_id],
    );
    const row = claims[0];
    if (!row) throw new GuestPaymentTestError("checkout_in_progress");
    claim = { ...row, claim_attempt: Number(row.claim_attempt) };
  } catch (err) {
    if (err instanceof GuestPaymentTestError) throw err;
    const code = knownCode(err);
    if (code) throw new GuestPaymentTestError(code);
    throw err;
  }
  if (claim.claim_outcome === "stored" && claim.claim_url?.startsWith("https://")) {
    return { url: claim.claim_url, paymentId: prepared.payment_id, accountId: bound.stripeAccountId };
  }
  if (claim.claim_outcome === "in_progress") {
    throw new GuestPaymentTestError("checkout_in_progress");
  }
  if (claim.claim_outcome !== "claimed" && claim.claim_outcome !== "recover") {
    throw new GuestPaymentTestError("checkout_in_progress");
  }

  const session = await checkout.createCheckout({
    accountId: bound.stripeAccountId,
    bookingId: prepared.booking_id,
    paymentId: prepared.payment_id,
    amountMinor: prepared.amount_minor,
    currency: prepared.currency,
    successUrl: `${origin}/confirmed/${encodeURIComponent(token)}`,
    cancelUrl: `${origin}/confirmed/${encodeURIComponent(token)}`,
    idempotencyKey: `${prepared.payment_id}:${claim.claim_attempt}`,
  });
  const stored = await db.query<{ sbg_store_capacity_checkout_session: string }>(
    `select public.sbg_store_capacity_checkout_session($1::uuid, $2::integer, $3, $4)`,
    [prepared.payment_id, claim.claim_attempt, session.id, session.url],
  );
  if (stored[0]?.sbg_store_capacity_checkout_session === "stored") {
    return { url: session.url, paymentId: prepared.payment_id, accountId: bound.stripeAccountId };
  }
  await checkout.expireCheckout({ accountId: bound.stripeAccountId, sessionId: session.id });
  await db.query(
    `select public.sbg_release_capacity_checkout_claim($1::uuid, $2::integer)`,
    [prepared.payment_id, claim.claim_attempt],
  );
  throw new GuestPaymentTestError("checkout_not_stored", "The Checkout session could not be correlated.");
}

export const startGuestPayment = createServerFn({ method: "POST" })
  .validator(tokenInput)
  .handler(async ({ data }) => {
    if (!guestPaymentTestEnabled()) {
      return startGuestPaymentForBooking(closedSql(), data.token, "");
    }
    const { getSql } = await import("../db.ts");
    let origin = "";
    try {
      const { getRequest } = await import("@tanstack/react-start/server");
      const request = getRequest();
      origin = request?.url ? new URL(request.url).origin : "";
    } catch {
      origin = "";
    }
    return startGuestPaymentForBooking(await getSql(), data.token, origin);
  });
