/**
 * CP27.2 M7 — Domain B payment binding.
 * The prepared payment row is authoritative. Guest input is not.
 * A mismatch does not call sbg_apply_payment_event and does not consume the Stripe event id.
 */
import type { Sql } from "@/lib/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PreparedGuestPayment = {
  payment_id: string;
  booking_id: string;
  hotel_id: string;
  stripe_account_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  checkout_session_id: string | null;
  checkout_url: string | null;
};

export type DomainBBindingFailure =
  | "payment"
  | "booking"
  | "account"
  | "session"
  | "amount"
  | "currency";

export function guestCheckoutIsReusable(payment: {
  status: string;
  checkout_session_id: string | null;
  checkout_url: string | null;
}): boolean {
  return (
    payment.status === "pending" &&
    typeof payment.checkout_session_id === "string" &&
    /^cs_[A-Za-z0-9_]+$/.test(payment.checkout_session_id) &&
    typeof payment.checkout_url === "string" &&
    payment.checkout_url.startsWith("https://")
  );
}

export function domainBPaymentStatus(eventType: string, paymentStatus: unknown): string {
  if (eventType === "checkout.session.completed" && paymentStatus === "paid") return "paid";
  if (eventType === "checkout.session.async_payment_succeeded") return "paid";
  if (eventType === "checkout.session.async_payment_failed") return "failed";
  return "pending";
}

function asUuid(value: unknown): string | null {
  if (typeof value !== "string" || !UUID_RE.test(value)) return null;
  return value.toLowerCase();
}

function asMinor(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return null;
}

export function domainBBindingFailures(input: {
  payment: PreparedGuestPayment;
  paymentId: string | null;
  bookingId: string | null;
  accountId: string | null;
  sessionId: string | null;
  amountTotal: number | null;
  currency: string | null;
}): DomainBBindingFailure[] {
  const failures: DomainBBindingFailure[] = [];
  const paymentId = asUuid(input.paymentId);
  const bookingId = asUuid(input.bookingId);
  if (!paymentId || paymentId !== input.payment.payment_id.toLowerCase()) failures.push("payment");
  if (!bookingId || bookingId !== input.payment.booking_id.toLowerCase()) failures.push("booking");
  const account = typeof input.accountId === "string" ? input.accountId.trim() : "";
  if (!account || account !== input.payment.stripe_account_id) failures.push("account");
  const session = typeof input.sessionId === "string" ? input.sessionId : "";
  if (!input.payment.checkout_session_id || session !== input.payment.checkout_session_id) {
    failures.push("session");
  }
  if (input.amountTotal == null || input.amountTotal !== Number(input.payment.amount_minor)) {
    failures.push("amount");
  }
  const currency = typeof input.currency === "string" ? input.currency.trim().toLowerCase() : "";
  if (!currency || currency !== input.payment.currency.trim().toLowerCase()) failures.push("currency");
  return failures;
}

type CheckoutEvent = {
  id?: unknown;
  type?: unknown;
  account?: unknown;
  data?: { object?: Record<string, unknown> };
};

export type DomainBCheckoutDecision =
  | { action: "ignore" }
  | { action: "mismatch" }
  | {
      action: "apply";
      eventId: string;
      eventType: string;
      bookingId: string;
      paymentId: string;
      paymentIntentId: string | null;
      paymentStatus: string;
      accountId: string;
    };

export async function evaluateDomainBCheckoutBinding(
  db: Sql,
  event: CheckoutEvent,
): Promise<DomainBCheckoutDecision> {
  const object = event.data?.object ?? {};
  const metadata =
    object.metadata !== null && typeof object.metadata === "object"
      ? (object.metadata as Record<string, unknown>)
      : {};
  const bookingId = typeof metadata.booking_id === "string" ? metadata.booking_id : null;
  const paymentId = typeof metadata.payment_id === "string" ? metadata.payment_id : null;
  if (!bookingId || !paymentId) return { action: "ignore" };
  if (!asUuid(paymentId) || !asUuid(bookingId)) return { action: "mismatch" };

  let rows: PreparedGuestPayment[];
  try {
    rows = await db.query<PreparedGuestPayment>(
      `select p.id::text as payment_id,
              p.booking_id::text as booking_id,
              b.hotel_id::text as hotel_id,
              c.stripe_account_id,
              p.amount_minor,
              p.currency,
              p.status,
              p.stripe_checkout_session_id as checkout_session_id,
              p.stripe_checkout_url as checkout_url
         from sbg_booking_payments p
         join bookings b on b.id = p.booking_id
         join sbg_stripe_connections c on c.hotel_id = b.hotel_id and c.disconnected_at is null
        where p.id = $1::uuid`,
      [paymentId],
    );
  } catch {
    return { action: "mismatch" };
  }
  const payment = rows[0];
  if (!payment) return { action: "mismatch" };
  const normalized: PreparedGuestPayment = {
    ...payment,
    amount_minor: Number(payment.amount_minor),
  };
  const accountId = typeof event.account === "string" ? event.account : null;
  const failures = domainBBindingFailures({
    payment: normalized,
    paymentId,
    bookingId,
    accountId,
    sessionId: typeof object.id === "string" ? object.id : null,
    amountTotal: asMinor(object.amount_total),
    currency: typeof object.currency === "string" ? object.currency : null,
  });
  if (failures.length > 0 || !accountId) return { action: "mismatch" };
  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!eventId) return { action: "mismatch" };
  return {
    action: "apply",
    eventId,
    eventType,
    bookingId: normalized.booking_id,
    paymentId: normalized.payment_id,
    paymentIntentId: typeof object.payment_intent === "string" ? object.payment_intent : null,
    paymentStatus: domainBPaymentStatus(eventType, object.payment_status),
    accountId: normalized.stripe_account_id,
  };
}

export async function handleDomainBCheckoutEvent(
  db: Sql,
  event: CheckoutEvent,
): Promise<{ status: number; body: { received: boolean; outcome?: string } }> {
  const decision = await evaluateDomainBCheckoutBinding(db, event);
  if (decision.action === "ignore") return { status: 200, body: { received: true } };
  if (decision.action === "mismatch") {
    return { status: 409, body: { received: false, outcome: "binding_mismatch" } };
  }
  await db.query("select sbg_apply_payment_event($1, $2, $3::uuid, $4::uuid, $5, $6, $7)", [
    decision.eventId,
    decision.eventType,
    decision.bookingId,
    decision.paymentId,
    decision.paymentIntentId,
    decision.paymentStatus,
    decision.accountId,
  ]);
  return { status: 200, body: { received: true } };
}
