/**
 * Isolated guest-payment webhook handler.
 *
 * Not mounted on the application routes and not a deployment. The caller
 * supplies a database client already authenticated as aether_payment_gateway
 * and the Connect signing secret. This module does not read application
 * credentials or any SaaS billing secret.
 *
 * Signature verification happens before any database call. Admission is
 * sbg_accept_verified_payment_event. The payee is the bound executing
 * provider, which may be the hotel or an independent operator.
 *
 * HTTP 200 is returned only for a committed terminal outcome or a duplicate.
 * Anything not yet correlated, including a refund whose payment intent is
 * not stored yet, stays non-2xx so Stripe retries for about three days.
 * After that window Stripe does not retry. Recovery is a manual resend of
 * the same event. Do not answer 200 merely because the event looks unfamiliar.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { acceptVerifiedPaymentEvent, type VerifiedPaymentClaim } from "./verified-payment.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_RE = /^evt_[A-Za-z0-9_]+$/;

export type GatewayDb = {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
};

export type GuestPaymentWebhookResult = {
  status: number;
  body: { received: boolean; outcome: string };
};

type CorrelateRow = {
  correlate_booking_id: string;
  correlate_payment_id: string;
  correlate_executing_provider_id: string | null;
  correlate_session_id: string | null;
  correlate_amount_minor: number;
  correlate_currency: string;
  correlate_capacity_managed: boolean;
  correlate_lifecycle: string;
  correlate_payment_status: string;
};

type StripeEvent = {
  id?: unknown;
  type?: unknown;
  account?: unknown;
  data?: { object?: Record<string, unknown> };
};

export function verifyGuestPaymentSignature(
  payload: string,
  header: string,
  secret: string,
  nowMs = Date.now(),
  toleranceSeconds = 300,
): boolean {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.split("=", 2);
      return [key, value];
    }),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonResult(status: number, outcome: string, received = status === 200): GuestPaymentWebhookResult {
  return { status, body: { received, outcome } };
}

function asUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function paymentIntentId(value: unknown): string | null {
  if (typeof value === "string" && /^pi_[A-Za-z0-9_]+$/.test(value)) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && /^pi_[A-Za-z0-9_]+$/.test(id)) return id;
  }
  return null;
}

function isCapacityRetry(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  if (code === "40P01") return true;
  const message = err instanceof Error ? err.message : String(err);
  return code === "40001" && message.includes("capacity_lock_retry");
}

async function correlate(
  db: GatewayDb,
  paymentId: string | null,
  intentId: string | null,
): Promise<CorrelateRow | null> {
  const rows = await db.query<CorrelateRow>(
    `select * from public.sbg_correlate_guest_payment($1::uuid, $2)`,
    [paymentId, intentId],
  );
  return rows[0] ?? null;
}

export async function handleGuestPaymentWebhook(input: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
  db: GatewayDb;
  nowMs?: number;
}): Promise<GuestPaymentWebhookResult> {
  if (!input.secret) return jsonResult(503, "secret_unavailable", false);
  if (
    !input.signatureHeader ||
    !verifyGuestPaymentSignature(input.rawBody, input.signatureHeader, input.secret, input.nowMs ?? Date.now())
  ) {
    return jsonResult(400, "invalid_signature", false);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(input.rawBody) as StripeEvent;
  } catch {
    return jsonResult(400, "invalid_json", false);
  }

  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!EVENT_RE.test(eventId) || eventId.length > 255) {
    return jsonResult(400, "event_id_required", false);
  }

  const object = asObject(event.data?.object);
  const metadata = asObject(object.metadata);
  const accountId = typeof event.account === "string" ? event.account.trim() : "";
  const checkout = eventType.startsWith("checkout.session.");
  const refund = eventType === "charge.refunded" || eventType === "refund.updated";

  try {
    if (!checkout && !refund) return jsonResult(409, "uncorrelated", false);

    const paymentId = checkout ? asUuid(metadata.payment_id) : null;
    const bookingId = checkout ? asUuid(metadata.booking_id) : null;
    const intentId = paymentIntentId(object.payment_intent);
    if (checkout && (!paymentId || !bookingId)) return jsonResult(409, "uncorrelated", false);
    if (refund && !intentId) return jsonResult(409, "uncorrelated", false);
    if (!accountId) return jsonResult(409, "uncorrelated", false);

    const row = await correlate(input.db, paymentId, refund ? intentId : null);
    if (!row) return jsonResult(409, "uncorrelated", false);
    if (!row.correlate_capacity_managed) return jsonResult(503, "legacy_not_admitted", false);
    if (!row.correlate_executing_provider_id || !row.correlate_session_id) {
      return jsonResult(409, "unbound", false);
    }

    const amount = checkout ? object.amount_total : row.correlate_amount_minor;
    const currency = checkout ? object.currency : row.correlate_currency;
    const sessionId = checkout ? object.id : row.correlate_session_id;
    if (typeof amount !== "number" || !Number.isInteger(amount)) return jsonResult(409, "uncorrelated", false);
    if (typeof currency !== "string" || currency.trim() === "") return jsonResult(409, "uncorrelated", false);
    if (typeof sessionId !== "string" || sessionId === "") return jsonResult(409, "uncorrelated", false);

    const claim: VerifiedPaymentClaim = {
      signatureVerified: true,
      eventId,
      eventType,
      bookingId: checkout ? bookingId! : row.correlate_booking_id,
      paymentId: row.correlate_payment_id,
      executingProviderId: row.correlate_executing_provider_id,
      accountId,
      sessionId,
      amountMinor: amount,
      currency,
      paymentStatus: typeof object.payment_status === "string" ? object.payment_status : row.correlate_payment_status,
      paymentIntentId: intentId,
    };
    const transition = await acceptVerifiedPaymentEvent(input.db, claim);
    if (transition.eventRecorded || transition.outcome === "duplicate") {
      return jsonResult(200, transition.outcome, true);
    }
    if (transition.outcome === "signature_not_verified" || transition.outcome === "event_id_required") {
      return jsonResult(400, transition.outcome, false);
    }
    return jsonResult(409, transition.outcome, false);
  } catch (err) {
    if (isCapacityRetry(err)) return jsonResult(503, "capacity_lock_unavailable", false);
    return jsonResult(503, "database_unavailable", false);
  }
}
