/**
 * CP26B.1 — Domain A Checkout / portal orchestration.
 * Commerce gate runs before any billing mutation. No Domain B imports.
 * CP26C.2 — hotel-aware test isolation before price write / portal Stripe call.
 */
import type { Sql } from "@/lib/db";
import { assertDomainACommerceAllowedForHotel } from "./saas-commerce.server.ts";
import {
  SaasLifecycleError,
  assertCheckoutAllowed,
  assertPortalAllowed,
  billingViewModel,
  type BillingAccountSnapshot,
} from "./saas-lifecycle.ts";
import {
  createBillingPortal,
  createSubscriptionCheckout,
  stripePriceId,
  type StripePlan,
} from "./stripe.server.ts";

export type DomainABillingRow = {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  status: string;
  current_period_end: string | null;
};

async function ownedHotel(db: Sql, userId: string, hotelId: string) {
  const rows = await db.query<{ id: string }>(
    "select hotel_id as id from app_hotel_accounts where user_id = $1 and hotel_id = $2::uuid",
    [userId, hotelId],
  );
  if (!rows[0]) throw new Error("Hotel not found.");
}

async function loadBillingAccount(db: Sql, hotelId: string): Promise<BillingAccountSnapshot> {
  const rows = await db.query<DomainABillingRow>(
    "select stripe_customer_id, stripe_subscription_id, stripe_price_id, status, current_period_end from sbg_billing_accounts where hotel_id = $1::uuid",
    [hotelId],
  );
  return rows[0] ?? null;
}

export async function loadDomainABillingState(db: Sql, userId: string, hotelId: string) {
  await ownedHotel(db, userId, hotelId);
  const billing = await loadBillingAccount(db, hotelId);
  const connection = await db.query<{
    stripe_account_id: string;
    livemode: boolean;
    disconnected_at: string | null;
  }>(
    "select stripe_account_id, livemode, disconnected_at from sbg_stripe_connections where hotel_id = $1::uuid",
    [hotelId],
  );
  return {
    billing,
    connection: connection[0] ?? null,
    lifecycle: billingViewModel(billing),
  };
}

export async function startDomainACheckout(input: {
  db: Sql;
  userId: string;
  hotelId: string;
  plan: StripePlan;
  origin: string;
}) {
  await ownedHotel(input.db, input.userId, input.hotelId);
  const billing = await loadBillingAccount(input.db, input.hotelId);
  assertCheckoutAllowed(billing);
  const priceId = stripePriceId(input.plan);
  assertDomainACommerceAllowedForHotel(input.hotelId);
  await input.db.query("select sbg_set_billing_price_for_user($1, $2::uuid, $3)", [
    input.userId,
    input.hotelId,
    priceId,
  ]);
  const checkout = await createSubscriptionCheckout({
    priceId,
    hotelId: input.hotelId,
    userId: input.userId,
    customerId: billing?.stripe_customer_id,
    successUrl: `${input.origin}/app/billing?hotelId=${input.hotelId}&checkout=success`,
    cancelUrl: `${input.origin}/app/billing?hotelId=${input.hotelId}&checkout=cancel`,
  });
  return { url: checkout.url };
}

export async function startDomainAPortal(input: {
  db: Sql;
  userId: string;
  hotelId: string;
  origin: string;
}) {
  await ownedHotel(input.db, input.userId, input.hotelId);
  const billing = await loadBillingAccount(input.db, input.hotelId);
  assertPortalAllowed(billing);
  if (!billing?.stripe_customer_id) {
    throw new SaasLifecycleError(
      "Stripe billing customer is missing for this subscription.",
      "portal_customer_missing",
    );
  }
  assertDomainACommerceAllowedForHotel(input.hotelId);
  const portal = await createBillingPortal(
    billing.stripe_customer_id,
    `${input.origin}/app/billing?hotelId=${input.hotelId}`,
  );
  return { url: portal.url };
}

export { SaasLifecycleError };
