/**
 * Gate 2 booking lifecycle contract. Decision logic only.
 * Not wired to checkout, webhooks, email, or migrations.
 * The provisional 60-minute occupancy duration is not this module's concern.
 */

export const PROVISIONAL_HOLD_TTL_MS = 30 * 60 * 1000;
export const PROVISIONAL_HOLD_TTL_STATUS = "provisional_pending_approval" as const;

export const BOOKING_LIFECYCLE_STATES = [
  "draft",
  "awaiting_payment",
  "payment_processing",
  "confirmed_paid",
  "expired",
  "failed",
  "cancelled",
  "refunded",
] as const;

export type BookingLifecycleState = (typeof BOOKING_LIFECYCLE_STATES)[number];

/** Payment evidence. Distinct from booking lifecycle and from dispatch. */
export const PAYMENT_DISPOSITIONS = [
  "none",
  "pending",
  "paid",
  "failed",
  "expired",
  "canceled",
  "received_after_expiry",
] as const;

export type PaymentDisposition = (typeof PAYMENT_DISPOSITIONS)[number];

export type LifecycleActor =
  | "guest"
  | "server"
  | "stripe_webhook"
  | "expiry_worker"
  | "reconciliation"
  | "dispatch"
  | "return_url";

export type BookingSnapshot = {
  lifecycle: BookingLifecycleState;
  payment: PaymentDisposition;
  holdExpiresAt: number | null;
  vehicleAssigned: boolean;
  driverAssigned: boolean;
  confirmationEmailSent: boolean;
  appliedEventIds: readonly string[];
};

export type PayeeKind = "hotel_in_house" | "independent_operator";

export type PayeeFacts = {
  kind: PayeeKind;
  providerAgreementActive: boolean;
  propertyGrantActive: boolean;
  providerAuthorisationActive: boolean;
  payeeAccountId: string;
  hotelAccountId: string;
  eventAccountId: string;
  licenceAllocated: boolean;
  subscriptionActive: boolean;
};

export type BindingResult =
  | { ok: true; accountId: string; kind: PayeeKind }
  | { ok: false; reason: BindingFailure };

export type BindingFailure =
  | "inactive_agreement"
  | "grant_revoked"
  | "authorisation_revoked"
  | "hotel_account_not_payee"
  | "wrong_account"
  | "licence_missing"
  | "subscription_inactive";

export type LifecycleEvent =
  | { type: "open_hold"; now: number }
  | {
      type: "open_checkout";
      now: number;
      commerceAdmitted: boolean;
      payee: PayeeFacts;
    }
  | { type: "return_url"; outcome: "success" | "cancel" }
  | {
      type: "verified_payment";
      now: number;
      eventId: string;
      paid: boolean;
      failed: boolean;
      payee: PayeeFacts;
      providerAuthorised: boolean;
      licenceAllocated: boolean;
    }
  | { type: "expire"; now: number }
  | { type: "assign_resource"; resource: "vehicle" | "driver" }
  | { type: "send_confirmation_email" }
  | { type: "cancel"; actor: "reconciliation" | "server" }
  | { type: "refund_settled" };

export type TransitionResult = {
  allowed: boolean;
  reason: string;
  snapshot: BookingSnapshot;
  audit: { actor: LifecycleActor; action: string };
};

export function emptyDraft(): BookingSnapshot {
  return {
    lifecycle: "draft",
    payment: "none",
    holdExpiresAt: null,
    vehicleAssigned: false,
    driverAssigned: false,
    confirmationEmailSent: false,
    appliedEventIds: [],
  };
}

export function holdExpiresAt(createdAtMs: number): number {
  return createdAtMs + PROVISIONAL_HOLD_TTL_MS;
}

/** Unassigned rows do not take a GiST slot. Do not change that predicate for a hold. */
export function provisionalHoldConsumesGist(): false {
  return false;
}

export function occupancyClaim(snapshot: BookingSnapshot): "none" | "vehicle" | "driver" | "both" {
  if (snapshot.lifecycle !== "confirmed_paid") return "none";
  if (snapshot.vehicleAssigned && snapshot.driverAssigned) return "both";
  if (snapshot.vehicleAssigned) return "vehicle";
  if (snapshot.driverAssigned) return "driver";
  return "none";
}

export function operationallyAdmitted(snapshot: BookingSnapshot, providerAuthorised: boolean): boolean {
  return snapshot.lifecycle === "confirmed_paid" && snapshot.payment === "paid" && providerAuthorised;
}

export function dispatchEligible(snapshot: BookingSnapshot, providerAuthorised: boolean): boolean {
  return operationallyAdmitted(snapshot, providerAuthorised) && (!snapshot.vehicleAssigned || !snapshot.driverAssigned);
}

export function payeeBinding(facts: PayeeFacts): BindingResult {
  if (!facts.providerAgreementActive) return { ok: false, reason: "inactive_agreement" };
  if (!facts.licenceAllocated) return { ok: false, reason: "licence_missing" };
  if (!facts.subscriptionActive) return { ok: false, reason: "subscription_inactive" };
  if (facts.kind === "independent_operator") {
    if (!facts.propertyGrantActive) return { ok: false, reason: "grant_revoked" };
    if (!facts.providerAuthorisationActive) return { ok: false, reason: "authorisation_revoked" };
    if (!facts.payeeAccountId || facts.payeeAccountId === facts.hotelAccountId) {
      return { ok: false, reason: "hotel_account_not_payee" };
    }
  }
  if (!facts.eventAccountId || facts.eventAccountId !== facts.payeeAccountId) {
    return { ok: false, reason: "wrong_account" };
  }
  return { ok: true, accountId: facts.payeeAccountId, kind: facts.kind };
}

function refuse(snapshot: BookingSnapshot, actor: LifecycleActor, reason: string): TransitionResult {
  return { allowed: false, reason, snapshot, audit: { actor, action: reason } };
}

function holdOpen(snapshot: BookingSnapshot, now: number): boolean {
  return snapshot.holdExpiresAt != null && now <= snapshot.holdExpiresAt;
}

export function applyLifecycle(snapshot: BookingSnapshot, event: LifecycleEvent): TransitionResult {
  if (event.type === "return_url") {
    return refuse(snapshot, "return_url", "return_url_is_not_confirmation");
  }

  if (event.type === "open_hold") {
    if (snapshot.lifecycle !== "draft") return refuse(snapshot, "server", "hold_already_open");
    return {
      allowed: true,
      reason: "hold_opened",
      snapshot: {
        ...snapshot,
        lifecycle: "awaiting_payment",
        payment: "pending",
        holdExpiresAt: holdExpiresAt(event.now),
      },
      audit: { actor: "server", action: "hold_opened" },
    };
  }

  if (event.type === "open_checkout") {
    if (snapshot.lifecycle !== "awaiting_payment" && snapshot.lifecycle !== "payment_processing") {
      return refuse(snapshot, "server", "checkout_not_openable");
    }
    if (!holdOpen(snapshot, event.now)) return refuse(snapshot, "server", "hold_expired");
    if (!event.commerceAdmitted) return refuse(snapshot, "server", "commerce_not_admitted");
    const binding = payeeBinding(event.payee);
    if (!binding.ok) return refuse(snapshot, "server", binding.reason);
    return {
      allowed: true,
      reason: "checkout_opened",
      snapshot: { ...snapshot, lifecycle: "payment_processing" },
      audit: { actor: "server", action: "checkout_opened" },
    };
  }

  if (event.type === "expire") {
    if (snapshot.payment === "paid" || snapshot.lifecycle === "confirmed_paid") {
      return refuse(snapshot, "expiry_worker", "paid_hold_cannot_expire");
    }
    if (snapshot.lifecycle !== "awaiting_payment" && snapshot.lifecycle !== "payment_processing") {
      return refuse(snapshot, "expiry_worker", "not_an_open_hold");
    }
    if (snapshot.holdExpiresAt == null || event.now <= snapshot.holdExpiresAt) {
      return refuse(snapshot, "expiry_worker", "hold_still_valid");
    }
    return {
      allowed: true,
      reason: "hold_expired",
      snapshot: {
        ...snapshot,
        lifecycle: "expired",
        payment: snapshot.payment === "pending" ? "expired" : snapshot.payment,
        vehicleAssigned: false,
        driverAssigned: false,
      },
      audit: { actor: "expiry_worker", action: "hold_expired" },
    };
  }

  if (event.type === "verified_payment") {
    if (!event.eventId.trim()) return refuse(snapshot, "stripe_webhook", "event_id_required");
    if (snapshot.appliedEventIds.includes(event.eventId)) {
      return {
        allowed: true,
        reason: "webhook_replay",
        snapshot,
        audit: { actor: "stripe_webhook", action: "webhook_replay" },
      };
    }
    const binding = payeeBinding(event.payee);
    if (!binding.ok) return refuse(snapshot, "stripe_webhook", binding.reason);
    const late =
      snapshot.lifecycle === "expired" ||
      snapshot.lifecycle === "failed" ||
      snapshot.holdExpiresAt == null ||
      event.now > snapshot.holdExpiresAt;
    if (event.paid && late) {
      return {
        allowed: true,
        reason: "late_payment",
        snapshot: {
          ...snapshot,
          lifecycle: snapshot.lifecycle === "failed" ? "failed" : "expired",
          payment: "received_after_expiry",
          vehicleAssigned: false,
          driverAssigned: false,
          confirmationEmailSent: false,
          appliedEventIds: [...snapshot.appliedEventIds, event.eventId],
        },
        audit: { actor: "stripe_webhook", action: "late_payment_recorded" },
      };
    }
    if (event.failed) {
      if (snapshot.lifecycle !== "payment_processing" && snapshot.lifecycle !== "awaiting_payment") {
        return refuse(snapshot, "stripe_webhook", "failure_not_applicable");
      }
      return {
        allowed: true,
        reason: "payment_failed",
        snapshot: {
          ...snapshot,
          lifecycle: "failed",
          payment: "failed",
          appliedEventIds: [...snapshot.appliedEventIds, event.eventId],
        },
        audit: { actor: "stripe_webhook", action: "payment_failed" },
      };
    }
    if (!event.paid) return refuse(snapshot, "stripe_webhook", "payment_not_verified");
    if (!event.providerAuthorised) return refuse(snapshot, "stripe_webhook", "provider_not_authorised");
    if (!event.licenceAllocated) return refuse(snapshot, "stripe_webhook", "licence_missing");
    if (snapshot.lifecycle !== "awaiting_payment" && snapshot.lifecycle !== "payment_processing") {
      return refuse(snapshot, "stripe_webhook", "not_awaiting_payment");
    }
    return {
      allowed: true,
      reason: "confirmed_paid",
      snapshot: {
        ...snapshot,
        lifecycle: "confirmed_paid",
        payment: "paid",
        appliedEventIds: [...snapshot.appliedEventIds, event.eventId],
      },
      audit: { actor: "stripe_webhook", action: "confirmed_paid" },
    };
  }

  if (event.type === "send_confirmation_email") {
    if (snapshot.lifecycle !== "confirmed_paid" || snapshot.payment !== "paid") {
      return refuse(snapshot, "server", "email_before_verification");
    }
    if (snapshot.confirmationEmailSent) {
      return { allowed: true, reason: "email_already_sent", snapshot, audit: { actor: "server", action: "email_already_sent" } };
    }
    return {
      allowed: true,
      reason: "confirmation_email_sent",
      snapshot: { ...snapshot, confirmationEmailSent: true },
      audit: { actor: "server", action: "confirmation_email_sent" },
    };
  }

  if (event.type === "assign_resource") {
    if (!operationallyAdmitted(snapshot, true)) return refuse(snapshot, "dispatch", "dispatch_not_admitted");
    return {
      allowed: true,
      reason: "resource_assigned",
      snapshot: {
        ...snapshot,
        vehicleAssigned: event.resource === "vehicle" ? true : snapshot.vehicleAssigned,
        driverAssigned: event.resource === "driver" ? true : snapshot.driverAssigned,
      },
      audit: { actor: "dispatch", action: `assign_${event.resource}` },
    };
  }

  if (event.type === "cancel") {
    if (snapshot.lifecycle === "refunded" || snapshot.lifecycle === "cancelled") {
      return refuse(snapshot, event.actor, "already_closed");
    }
    if (snapshot.lifecycle === "draft") return refuse(snapshot, event.actor, "nothing_to_cancel");
    return {
      allowed: true,
      reason: "cancelled",
      snapshot: {
        ...snapshot,
        lifecycle: "cancelled",
        vehicleAssigned: false,
        driverAssigned: false,
      },
      audit: { actor: event.actor, action: "cancelled" },
    };
  }

  if (snapshot.lifecycle !== "confirmed_paid" || snapshot.payment !== "paid") {
    return refuse(snapshot, "reconciliation", "refund_requires_verified_payment");
  }
  return {
    allowed: true,
    reason: "refunded",
    snapshot: {
      ...snapshot,
      lifecycle: "refunded",
      vehicleAssigned: false,
      driverAssigned: false,
    },
    audit: { actor: "reconciliation", action: "refunded" },
  };
}
