import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import {
  loadDomainABillingState,
  startDomainACheckout,
  startDomainAPortal,
} from "./saas-billing.server.ts";

const hotelInput = z.object({ hotelId: z.string().uuid() });
const planInput = z.object({ hotelId: z.string().uuid(), plan: z.enum(["basic", "pro", "premium"]) });

function origin() {
  const request = getRequest();
  if (!request) throw new Error("Request context unavailable.");
  return new URL(request.url).origin;
}

export const getBillingState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(hotelInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return loadDomainABillingState(db, context.userId, data.hotelId);
  });

export const createSubscriptionCheckoutFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(planInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return startDomainACheckout({
      db,
      userId: context.userId,
      hotelId: data.hotelId,
      plan: data.plan,
      origin: origin(),
    });
  });

export const createBillingPortalFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(hotelInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return startDomainAPortal({
      db,
      userId: context.userId,
      hotelId: data.hotelId,
      origin: origin(),
    });
  });

export const startStripeConnectFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(hotelInput)
  .handler(async ({ data, context }) => {
    const { createConnectState, stripeConnectAuthorizeUrl } = await import("@/lib/aether/stripe.server");
    const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (!clientId) throw new Error("Stripe Connect is not configured.");
    const db = await getSql();
    const rows = await db.query<{ id: string }>(
      "select hotel_id as id from app_hotel_accounts where user_id = $1 and hotel_id = $2::uuid",
      [context.userId, data.hotelId],
    );
    if (!rows[0]) throw new Error("Hotel not found.");
    const redirectUri = `${origin()}/api/stripe/connect/callback`;
    const state = await createConnectState(context.userId, data.hotelId);
    return { url: stripeConnectAuthorizeUrl({ clientId, redirectUri, state }) };
  });
