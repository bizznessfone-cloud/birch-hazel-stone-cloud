/**
 * Stage C payment-authority boundary.
 * Not imported by guest checkout, domain-b-payment.ts, or the confirmation email.
 * A resolved payee does not admit Checkout or CP31.
 *
 * sbg_accept_verified_payment_event calls sbg_assess_payment_authority_event
 * before it inserts a Stripe event id. This module does not call
 * sbg_apply_payment_event and is not mounted on the webhook.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESOLVE_CODES = [
  "booking_not_found",
  "booking_not_payable",
  "ambiguous_authority",
  "inactive_agreement",
  "authorisation_revoked",
  "grant_revoked",
  "licence_missing",
  "subscription_inactive",
  "stripe_disconnected",
  "hotel_account_not_payee",
] as const;

const BIND_CODES = [
  ...RESOLVE_CODES,
  "payment_attempt_missing",
  "incompatible_authority",
] as const;

export const AUTHORITY_OUTCOMES = [
  "matched",
  "payment",
  "booking",
  "unbound",
  "provider",
  "hotel_account_not_payee",
  "wrong_account",
  "session",
  "amount",
  "currency",
] as const;

export type AuthorityOutcome = (typeof AUTHORITY_OUTCOMES)[number];

export type AuthorityDb = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export type ResolvedPayee = {
  bookingId: string;
  providerId: string;
  payeeOrganisationId: string;
  payeeKind: "hotel_in_house" | "independent_operator";
  stripeAccountId: string;
};

export type BoundPaymentAuthority = ResolvedPayee & {
  paymentId: string;
  bindingState: "established" | "immutable";
};

export type AuthorityDrift = {
  paymentId: string;
  boundAccountId: string | null;
  boundOrganisationId: string | null;
  currentAccountId: string | null;
  currentOrganisationId: string | null;
  state: "unbound" | "unchanged" | "account_changed" | "payee_changed" | "current_unresolved";
};

export type AuthorityEventClaim = {
  bookingId: string;
  paymentId: string;
  executingProviderId: string;
  accountId: string;
  sessionId: string;
  amountMinor: number;
  currency: string;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function rethrowKnown(err: unknown, codes: readonly string[]): never {
  const message = messageOf(err);
  for (const code of codes) {
    if (message.includes(code)) throw new Error(code);
  }
  throw err;
}

function assertUuid(value: string, code: string): void {
  if (!UUID_RE.test(value)) throw new Error(code);
}

export async function resolveExecutingPayee(db: AuthorityDb, bookingId: string): Promise<ResolvedPayee> {
  assertUuid(bookingId, "booking_not_found");
  try {
    const rows = await db.query<{
      resolved_booking_id: string;
      resolved_provider_id: string;
      resolved_payee_organisation_id: string;
      resolved_payee_kind: "hotel_in_house" | "independent_operator";
      resolved_stripe_account_id: string;
    }>("select * from sbg_resolve_executing_payee($1::uuid)", [bookingId]);
    const row = rows[0];
    if (!row) throw new Error("booking_not_found");
    return {
      bookingId: row.resolved_booking_id,
      providerId: row.resolved_provider_id,
      payeeOrganisationId: row.resolved_payee_organisation_id,
      payeeKind: row.resolved_payee_kind,
      stripeAccountId: row.resolved_stripe_account_id,
    };
  } catch (err) {
    rethrowKnown(err, RESOLVE_CODES);
  }
}

export async function bindPaymentAuthority(db: AuthorityDb, bookingId: string): Promise<BoundPaymentAuthority> {
  assertUuid(bookingId, "booking_not_found");
  try {
    const rows = await db.query<{
      bound_payment_id: string;
      bound_booking_id: string;
      bound_provider_id: string;
      bound_payee_organisation_id: string;
      bound_payee_kind: "hotel_in_house" | "independent_operator";
      bound_stripe_account_id: string;
      binding_state: "established" | "immutable";
    }>("select * from sbg_bind_payment_authority($1::uuid)", [bookingId]);
    const row = rows[0];
    if (!row) throw new Error("payment_attempt_missing");
    return {
      paymentId: row.bound_payment_id,
      bookingId: row.bound_booking_id,
      providerId: row.bound_provider_id,
      payeeOrganisationId: row.bound_payee_organisation_id,
      payeeKind: row.bound_payee_kind,
      stripeAccountId: row.bound_stripe_account_id,
      bindingState: row.binding_state,
    };
  } catch (err) {
    rethrowKnown(err, BIND_CODES);
  }
}

export async function readPaymentAuthorityDrift(db: AuthorityDb, bookingId: string): Promise<AuthorityDrift> {
  assertUuid(bookingId, "booking_not_found");
  const rows = await db.query<{
    drift_payment_id: string;
    drift_bound_account: string | null;
    drift_bound_organisation_id: string | null;
    drift_current_account: string | null;
    drift_current_organisation_id: string | null;
    drift_state: AuthorityDrift["state"];
  }>("select * from sbg_payment_authority_drift($1::uuid)", [bookingId]);
  const row = rows[0];
  if (!row) throw new Error("payment_attempt_missing");
  return {
    paymentId: row.drift_payment_id,
    boundAccountId: row.drift_bound_account,
    boundOrganisationId: row.drift_bound_organisation_id,
    currentAccountId: row.drift_current_account,
    currentOrganisationId: row.drift_current_organisation_id,
    state: row.drift_state,
  };
}

export async function assessPaymentAuthorityEvent(db: AuthorityDb, claim: AuthorityEventClaim): Promise<AuthorityOutcome> {
  assertUuid(claim.bookingId, "booking");
  assertUuid(claim.paymentId, "payment");
  assertUuid(claim.executingProviderId, "provider");
  const rows = await db.query<{ sbg_assess_payment_authority_event: string }>(
    `select sbg_assess_payment_authority_event(
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::integer, $7
     )`,
    [
      claim.bookingId,
      claim.paymentId,
      claim.executingProviderId,
      claim.accountId,
      claim.sessionId,
      claim.amountMinor,
      claim.currency,
    ],
  );
  const outcome = rows[0]?.sbg_assess_payment_authority_event;
  if (!outcome || !AUTHORITY_OUTCOMES.includes(outcome as AuthorityOutcome)) {
    throw new Error("authority_outcome_invalid");
  }
  return outcome as AuthorityOutcome;
}
