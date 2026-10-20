/**
 * Stage D verified-payment transition.
 * Not mounted on the public webhook or guest checkout.
 *
 * This module does not verify a Stripe signature. signatureVerified is only
 * the caller's attestation that verifyStripeSignature already returned true.
 * The database does not check the signature either.
 *
 * Execute is granted only to the aether_webhook role. This module does not
 * change the application pool role and does not call sbg_apply_payment_event.
 */

import type { AuthorityDb } from "./payment-authority.ts";

export type VerifiedPaymentClaim = {
  signatureVerified: boolean;
  eventId: string;
  eventType: string;
  bookingId: string;
  paymentId: string;
  executingProviderId: string;
  accountId: string;
  sessionId: string;
  amountMinor: number;
  currency: string;
  paymentStatus: string;
  paymentIntentId: string | null;
};

export type VerifiedPaymentTransition = {
  outcome: string;
  lifecycle: string | null;
  paymentStatus: string | null;
  eventRecorded: boolean;
};

function isCapacityRetry(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  if (code === "40P01") return true;
  const message = err instanceof Error ? err.message : String(err);
  return code === "40001" && message.includes("capacity_lock_retry");
}

export async function acceptVerifiedPaymentEvent(
  db: AuthorityDb,
  claim: VerifiedPaymentClaim,
): Promise<VerifiedPaymentTransition> {
  try {
    return await acceptVerifiedPaymentEventOnce(db, claim);
  } catch (err) {
    if (!isCapacityRetry(err)) throw err;
    return await acceptVerifiedPaymentEventOnce(db, claim);
  }
}

async function acceptVerifiedPaymentEventOnce(
  db: AuthorityDb,
  claim: VerifiedPaymentClaim,
): Promise<VerifiedPaymentTransition> {
  const rows = await db.query<{
    transition_outcome: string;
    transition_lifecycle: string | null;
    transition_payment_status: string | null;
    transition_event_recorded: boolean;
  }>(
    `select * from sbg_accept_verified_payment_event(
       $1::boolean, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::integer, $10, $11, $12
     )`,
    [
      claim.signatureVerified,
      claim.eventId,
      claim.eventType,
      claim.bookingId,
      claim.paymentId,
      claim.executingProviderId,
      claim.accountId,
      claim.sessionId,
      claim.amountMinor,
      claim.currency,
      claim.paymentStatus,
      claim.paymentIntentId,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("payment_transition_missing");
  return {
    outcome: row.transition_outcome,
    lifecycle: row.transition_lifecycle,
    paymentStatus: row.transition_payment_status,
    eventRecorded: row.transition_event_recorded,
  };
}
