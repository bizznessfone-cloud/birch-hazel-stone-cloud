/**
 * CP27.2 M8 — Domain B LIVE checkout lock.
 * Independent of SBG_SAAS_COMMERCE and the Domain A live pairing.
 * Absent, empty, and any value other than the exact string "true" are off.
 * Do not set this true. Only CP31 may activate LIVE commerce.
 */
import { classifyStripeSecretKey } from "./saas-commerce.server.ts";

export const SBG_DOMAIN_B_LIVE_CHECKOUT = "SBG_DOMAIN_B_LIVE_CHECKOUT";

export class DomainBLiveCheckoutError extends Error {
  readonly code = "domain_b_live_checkout_disabled" as const;

  constructor(message = "Domain B live checkout is not enabled.") {
    super(message);
    this.name = "DomainBLiveCheckoutError";
  }
}

/** Exact "true" only. Not trimmed, not case-folded, not "1". */
export function domainBLiveCheckoutEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env[SBG_DOMAIN_B_LIVE_CHECKOUT] === "true";
}

/**
 * TEST Stripe keys follow the existing Domain B path.
 * LIVE Stripe keys require the explicit Domain B lock.
 */
export function assertDomainBLiveCheckoutAllowed(env: NodeJS.Dict<string> = process.env): void {
  if (classifyStripeSecretKey(env.STRIPE_SECRET_KEY) !== "live") return;
  if (!domainBLiveCheckoutEnabled(env)) throw new DomainBLiveCheckoutError();
}
