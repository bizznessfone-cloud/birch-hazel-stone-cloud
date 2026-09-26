/**
 * CP26B.1 — Domain A (SBG SaaS subscription) application lifecycle.
 * Pure policy. No database, no Stripe, no hotels.status / Domain B.
 */

export const BILLING_STATUSES = [
  "inactive",
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "paused",
  "unpaid",
  "canceled",
] as const;

export type BillingStatus = (typeof BILLING_STATUSES)[number];

const CHECKOUT_ELIGIBLE: ReadonlySet<string> = new Set([
  "inactive",
  "canceled",
  "incomplete_expired",
]);

const EXISTING_SUBSCRIPTION: ReadonlySet<string> = new Set([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "paused",
  "unpaid",
]);

const ENTITLED: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);

export type SaasLifecycleCode =
  | "subscription_exists"
  | "portal_customer_missing"
  | "portal_not_applicable"
  | "invalid_price_id"
  | "unknown_status";

export class SaasLifecycleError extends Error {
  readonly code: SaasLifecycleCode;

  constructor(message: string, code: SaasLifecycleCode) {
    super(message);
    this.name = "SaasLifecycleError";
    this.code = code;
  }
}

export type BillingAccountSnapshot = {
  status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id?: string | null;
  stripe_price_id: string | null;
  current_period_end: string | null;
} | null;

export type BillingViewModel = {
  status: BillingStatus | null;
  displayStatus: string;
  canStartCheckout: boolean;
  shouldManageBilling: boolean;
  isEntitled: boolean;
  showPlanSelection: boolean;
};

function hasCustomer(customerId: string | null | undefined): boolean {
  return typeof customerId === "string" && customerId.trim().length > 0;
}

export function isBillingStatus(value: string): value is BillingStatus {
  return (BILLING_STATUSES as readonly string[]).includes(value);
}

export function parseBillingStatus(raw: string | null | undefined): BillingStatus | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  return isBillingStatus(value) ? value : null;
}

export function canStartCheckout(status: BillingStatus | null): boolean {
  if (status == null) return true;
  return CHECKOUT_ELIGIBLE.has(status);
}

export function isExistingSubscriptionLifecycle(status: BillingStatus | null): boolean {
  if (status == null) return false;
  return EXISTING_SUBSCRIPTION.has(status);
}

export function isSaasEntitled(status: BillingStatus | null): boolean {
  if (status == null) return false;
  return ENTITLED.has(status);
}

export function billingViewModel(account: BillingAccountSnapshot): BillingViewModel {
  if (account == null) {
    return {
      status: null,
      displayStatus: "none",
      canStartCheckout: true,
      shouldManageBilling: false,
      isEntitled: false,
      showPlanSelection: true,
    };
  }

  const status = parseBillingStatus(account.status);
  const customer = hasCustomer(account.stripe_customer_id);

  if (status == null) {
    return {
      status: null,
      displayStatus: account.status?.trim() || "unknown",
      canStartCheckout: false,
      shouldManageBilling: false,
      isEntitled: false,
      showPlanSelection: false,
    };
  }

  const checkout = canStartCheckout(status);
  const existing = isExistingSubscriptionLifecycle(status);

  return {
    status,
    displayStatus: status,
    canStartCheckout: checkout,
    shouldManageBilling: existing && customer,
    isEntitled: isSaasEntitled(status),
    showPlanSelection: checkout,
  };
}

export function assertCheckoutAllowed(account: BillingAccountSnapshot): void {
  const view = billingViewModel(account);
  if (view.canStartCheckout) return;
  if (isExistingSubscriptionLifecycle(view.status) || account != null) {
    throw new SaasLifecycleError(
      "This organisation already has a SCAN BOOK GO subscription. Use Manage billing.",
      "subscription_exists",
    );
  }
  throw new SaasLifecycleError(
    "This organisation cannot start a SCAN BOOK GO subscription Checkout.",
    "subscription_exists",
  );
}

export function assertPortalAllowed(account: BillingAccountSnapshot): void {
  const view = billingViewModel(account);
  if (isExistingSubscriptionLifecycle(view.status)) {
    if (!hasCustomer(account?.stripe_customer_id)) {
      throw new SaasLifecycleError(
        "Stripe billing customer is missing for this subscription.",
        "portal_customer_missing",
      );
    }
    return;
  }
  throw new SaasLifecycleError(
    "Billing portal is not available for this organisation.",
    "portal_not_applicable",
  );
}

export function assertStripePriceId(value: string, label = "Stripe price"): string {
  const raw = String(value ?? "");
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} is not configured.`);
  }
  if (trimmed !== raw || /\s/.test(raw)) {
    throw new SaasLifecycleError(`${label} is malformed.`, "invalid_price_id");
  }
  if (!/^price_[A-Za-z0-9_]+$/.test(trimmed)) {
    throw new SaasLifecycleError(`${label} is not a valid Stripe Price id.`, "invalid_price_id");
  }
  return trimmed;
}
