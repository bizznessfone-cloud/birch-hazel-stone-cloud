import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import {
  createBillingPortal,
  createConnectState,
  createSubscriptionCheckout,
  exchangeStripeConnectCode,
  stripeConnectAuthorizeUrl,
  stripePriceId,
  verifyConnectState,
  type StripePlan,
} from "@/lib/aether/stripe.server";

const hotelInput = z.object({ hotelId: z.string().uuid() });
const planInput = z.object({ hotelId: z.string().uuid(), plan: z.enum(["basic", "pro", "premium"]) });

function origin() {
  const request = getRequest();
  if (!request) throw new Error("Request context unavailable.");
  return new URL(request.url).origin;
}

async function ownedHotel(db: Awaited<ReturnType<typeof getSql>>, userId: string, hotelId: string) {
  const rows = await db.query<{ id: string }>(
    "select hotel_id as id from app_hotel_accounts where user_id = $1 and hotel_id = $2::uuid",
    [userId, hotelId],
  );
  if (!rows[0]) throw new Error("Hotel not found.");
}

export const getBillingState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(hotelInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    await ownedHotel(db, context.userId, data.hotelId);
    const billing = await db.query<{
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      stripe_price_id: string | null;
      status: string;
      current_period_end: string | null;
    }>(
      "select stripe_customer_id, stripe_subscription_id, stripe_price_id, status, current_period_end from sbg_billing_accounts where hotel_id = $1::uuid",
      [data.hotelId],
    );
    const connection = await db.query<{ stripe_account_id: string; livemode: boolean; disconnected_at: string | null }>(
      "select stripe_account_id, livemode, disconnected_at from sbg_stripe_connections where hotel_id = $1::uuid",
      [data.hotelId],
    );
    return {
      billing: billing[0] ?? null,
      connection: connection[0] ?? null,
    };
  });

export const createSubscriptionCheckoutFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(planInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    await ownedHotel(db, context.userId, data.hotelId);
    const priceId = stripePriceId(data.plan as StripePlan);
    await db.query(
      "select sbg_set_billing_price_for_user($1, $2::uuid, $3)",
      [context.userId, data.hotelId, priceId],
    );
    const billing = await db.query<{ stripe_customer_id: string | null }>(
      "select stripe_customer_id from sbg_billing_accounts where hotel_id = $1::uuid",
      [data.hotelId],
    );
    const checkout = await createSubscriptionCheckout({
      priceId,
      hotelId: data.hotelId,
      userId: context.userId,
      customerId: billing[0]?.stripe_customer_id,
      successUrl: `${origin()}/app/billing?hotelId=${data.hotelId}&checkout=success`,
      cancelUrl: `${origin()}/app/billing?hotelId=${data.hotelId}&checkout=cancel`,
    });
    return { url: checkout.url };
  });

export const createBillingPortalFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(hotelInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    await ownedHotel(db, context.userId, data.hotelId);
    const billing = await db.query<{ stripe_customer_id: string | null }>(
      "select stripe_customer_id from sbg_billing_accounts where hotel_id = $1::uuid",
      [data.hotelId],
    );
    if (!billing[0]?.stripe_customer_id) throw new Error("No active Stripe billing customer.");
    const portal = await createBillingPortal(billing[0].stripe_customer_id, `${origin()}/app/billing?hotelId=${data.hotelId}`);
    return { url: portal.url };
  });

export const startStripeConnectFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(hotelInput)
  .handler(async ({ data, context }) => {
    const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (!clientId) throw new Error("Stripe Connect is not configured.");
    const db = await getSql();
    await ownedHotel(db, context.userId, data.hotelId);
    const redirectUri = `${origin()}/api/stripe/connect/callback`;
    const state = await createConnectState(context.userId, data.hotelId);
    return { url: stripeConnectAuthorizeUrl({ clientId, redirectUri, state }) };
  });

export const completeStripeConnect = async (code: string, state: string) => {
  const { userId, hotelId } = await verifyConnectState(state);
  if (!userId || !hotelId) throw new Error("Invalid Stripe Connect state.");
  const account = await exchangeStripeConnectCode(code);
  const db = await getSql();
  await db.query(
    "select sbg_save_stripe_connection_for_user($1, $2::uuid, $3, $4)",
    [userId, hotelId, account.stripe_user_id, account.livemode],
  );
  await db.query("select sbg_sync_hotel_entitlement($1::uuid)", [hotelId]);
  return hotelId;
};
