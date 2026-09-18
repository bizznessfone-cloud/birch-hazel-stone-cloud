import { createHmac, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

const API = "https://api.stripe.com/v1";

function secretKey() {
  const value = process.env.STRIPE_SECRET_KEY;
  if (!value) throw new Error("Stripe is not configured.");
  return value;
}

function hmacSecret() {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("Auth secret is not configured.");
  return new TextEncoder().encode(value);
}

export type StripePlan = "basic" | "pro" | "premium";

export function stripePriceId(plan: StripePlan): string {
  const key = `STRIPE_${plan.toUpperCase()}_PRICE_ID`;
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not configured.`);
  return value;
}

async function stripePost<T>(path: string, params: Record<string, string>, accountId?: string): Promise<T> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey()}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (accountId) headers["Stripe-Account"] = accountId;

  const response = await fetch(API + path, { method: "POST", headers, body });
  const data = await response.json();
  if (!response.ok) {
    const message = typeof data?.error?.message === "string" ? data.error.message : "Stripe request failed.";
    throw new Error(message);
  }
  return data as T;
}

export async function createSubscriptionCheckout(input: {
  priceId: string;
  hotelId: string;
  userId: string;
  successUrl: string;
  cancelUrl: string;
  customerId?: string | null;
}) {
  return stripePost<{ id: string; url: string }>("/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": input.priceId,
    "line_items[0][quantity]": "1",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    ...(input.customerId ? { customer: input.customerId } : {}),
    "metadata[hotel_id]": input.hotelId,
    "metadata[user_id]": input.userId,
    "subscription_data[metadata][hotel_id]": input.hotelId,
    "subscription_data[metadata][user_id]": input.userId,
  });
}

export async function createBillingPortal(customerId: string, returnUrl: string) {
  return stripePost<{ url: string }>("/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  });
}

export function stripeConnectAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    scope: "read_write",
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

export async function exchangeStripeConnectCode(code: string) {
  const response = await fetch("https://connect.stripe.com/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${secretKey()}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code, grant_type: "authorization_code" }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = typeof data?.error_description === "string" ? data.error_description : "Stripe Connect authorization failed.";
    throw new Error(message);
  }
  return data as {
    stripe_user_id: string;
    livemode: boolean;
    scope: string;
  };
}

/* Legacy shape retained below for source compatibility. */
export async function _unusedStripeConnectTokenShape(code: string) {
  return stripePost<{
    stripe_user_id: string;
    livemode: boolean;
    scope: string;
  }>("/oauth/token", {
    code,
    grant_type: "authorization_code",
  });
}

export async function createConnectState(userId: string, hotelId: string) {
  return new SignJWT({ sub: userId, hotelId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(hmacSecret());
}

export async function verifyConnectState(token: string) {
  const result = await jwtVerify<{ hotelId: string }>(token, hmacSecret());
  return { userId: result.payload.sub ?? "", hotelId: result.payload.hotelId ?? "" };
}

export function verifyStripeSignature(payload: string, header: string, toleranceSeconds = 300) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("Stripe webhook is not configured.");

  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.split("=", 2);
      return [key, value];
    }),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const signed = `${timestamp}.${payload}`;
  const expected = createHmac("sha256", secret).update(signed).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
