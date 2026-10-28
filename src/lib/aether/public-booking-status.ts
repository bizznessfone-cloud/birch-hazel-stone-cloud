/**
 * Guest-facing booking status.
 * Derived only from the booking lifecycle and payment evidence.
 * A return URL is not an input. Account identifiers and internal names are not returned.
 * Does not open checkout, send email, or write a booking.
 */
import type { PublicBooking } from "./booking.ts";

export const GUEST_STATUS_POLL_LIMIT = 4;
export const GUEST_STATUS_POLL_INTERVAL_MS = 3_000;

export const PUBLIC_GUEST_STATUS_CODES = [
  "complete_payment",
  "checking_payment",
  "confirmed",
  "expired",
  "unsuccessful",
  "cancelled",
  "refunded",
  "unavailable",
] as const;

export type PublicGuestStatusCode = (typeof PUBLIC_GUEST_STATUS_CODES)[number];

export type PublicGuestTone = "neutral" | "attention" | "live" | "cancelled";

export type PublicGuestRefresh = "poll" | "none";

export type PublicGuestStatus = {
  code: PublicGuestStatusCode;
  chip: string;
  heading: string;
  detail: string;
  tone: PublicGuestTone;
  refresh: PublicGuestRefresh;
  paymentNote: string | null;
};

/** Server-side facts. Never send this object to the guest. */
export type PublicLifecycleFacts = {
  lifecycle: string | null;
  confirmedPaidAt: string | null;
  cancelledAt: string | null;
  paymentStatus: string | null;
  paidAt: string | null;
  bindingComplete: boolean;
  providerMatch: boolean;
};

export type PublicGuestBooking = PublicBooking & {
  guestStatus: PublicGuestStatus;
};

const UNAVAILABLE: PublicGuestStatus = {
  code: "unavailable",
  chip: "Unavailable",
  heading: "Booking status unavailable",
  detail:
    "Payment status for this booking is not available on this page. Keep the reference below. Nothing here means a payment was taken.",
  tone: "neutral",
  refresh: "none",
  paymentNote: null,
};

function paidEvidence(facts: PublicLifecycleFacts): boolean {
  return (
    facts.lifecycle === "confirmed_paid" &&
    facts.confirmedPaidAt != null &&
    facts.cancelledAt == null &&
    facts.paymentStatus === "paid" &&
    facts.paidAt != null &&
    facts.bindingComplete === true &&
    facts.providerMatch === true
  );
}

export function projectPublicGuestStatus(facts: PublicLifecycleFacts): PublicGuestStatus {
  if (facts.lifecycle === "refunded") {
    return {
      code: "refunded",
      chip: "Refunded",
      heading: "Your transfer has been refunded",
      detail: "The payment for this transfer has been refunded. Keep the reference below.",
      tone: "cancelled",
      refresh: "none",
      paymentNote: null,
    };
  }
  if (facts.lifecycle === "cancelled" || facts.cancelledAt != null) {
    return {
      code: "cancelled",
      chip: "Cancelled",
      heading: "Your transfer is cancelled",
      detail: "This booking is no longer scheduled. Keep the reference if the hotel needs it.",
      tone: "cancelled",
      refresh: "none",
      paymentNote: null,
    };
  }
  switch (facts.lifecycle) {
    case "awaiting_payment":
      return {
        code: "complete_payment",
        chip: "Unpaid",
        heading: "Complete your payment",
        detail: "This transfer is not confirmed. The reference below is only so you can find this booking.",
        tone: "attention",
        refresh: "poll",
        paymentNote: "Online payment is not open on this page. Nothing has been charged.",
      };
    case "payment_processing":
      return {
        code: "checking_payment",
        chip: "Checking",
        heading: "Checking your payment",
        detail:
          "We are still checking this payment. Coming back from the payment page does not prove that it succeeded.",
        tone: "attention",
        refresh: "poll",
        paymentNote: "Nothing has been confirmed yet.",
      };
    case "confirmed_paid":
      if (!paidEvidence(facts)) return UNAVAILABLE;
      return {
        code: "confirmed",
        chip: "Confirmed",
        heading: "Your transfer is confirmed",
        detail: "This transfer is confirmed. Keep this page and the reference below.",
        tone: "live",
        refresh: "none",
        paymentNote: null,
      };
    case "expired":
      return {
        code: "expired",
        chip: "Expired",
        heading: "Your booking has expired",
        detail: "This booking is no longer held. Nothing has been charged.",
        tone: "cancelled",
        refresh: "none",
        paymentNote: null,
      };
    case "failed":
      return {
        code: "unsuccessful",
        chip: "Unsuccessful",
        heading: "Payment was unsuccessful",
        detail: "The payment did not go through. It will not be tried again from this page.",
        tone: "cancelled",
        refresh: "none",
        paymentNote: null,
      };
    default:
      return UNAVAILABLE;
  }
}

export function shouldPollGuestStatus(status: PublicGuestStatus, attempts: number): boolean {
  return status.refresh === "poll" && attempts < GUEST_STATUS_POLL_LIMIT;
}
