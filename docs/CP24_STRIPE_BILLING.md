# CP24 — SBG SUBSCRIPTION + STRIPE CONNECT

**Status: historical checkpoint specification (source complete). Production Stripe configuration remains absent. Not the next numbered checkpoint.**

Current living next execution checkpoint is **CP26A.5**. See `docs/ROADMAP.md`.
CP26 reuses this work; it is **not** go-live. Only CP31 activates commerce.

---

Status: **source implementation complete; executable validation pending**

## Purpose

CP24 layers the V1 commercial activation boundary over the hardened onboarding base.

Commercial split:

1. **SBG subscription** — the hotel/operator pays SCAN / BOOK / GO for the SaaS subscription.
2. **Hotel guest payments** — the hotel connects its own Stripe account; guest transfer payments are created on that connected account.

SBG does not receive, hold, or split hotel guest-service funds. No application fee is configured by this source implementation.

Stripe documents direct charges as charges created on the connected account, with the connected account balance increasing from those charges.

## Connect model

CP24 uses Stripe Connect Standard-account onboarding.

The operator starts from `/app/billing`. The server creates a signed short-lived state containing the Better Auth user ID and hotel ID. Stripe redirects to `/api/stripe/connect/callback`.

The callback exchanges the authorization code for the connected account ID and stores only the account ID, livemode state, and connection timestamps. OAuth access/refresh tokens are not stored.

Stripe documents the connection flow and the connected `stripe_user_id` used with the `Stripe-Account` header.

## SBG subscription

Configured Stripe Price IDs:

- `STRIPE_BASIC_PRICE_ID`
- `STRIPE_PRO_PRICE_ID`
- `STRIPE_PREMIUM_PRICE_ID`

The operator chooses a plan in `/app/billing`. Checkout metadata carries the hotel ID and user ID.

Subscription state is updated from verified Stripe webhook events. `active` and `trialing` are treated as active subscription states for the eventual LIVE entitlement.

Stripe recommends using subscription webhook events to maintain application access state.

## Webhook security

`/api/stripe/webhook` reads the raw request body, verifies `Stripe-Signature`, rejects stale signatures, records Stripe event IDs for idempotency, and applies subscription lifecycle events.

Stripe requires signature verification against the unmodified raw request body.

## Database boundary

`migrations/0020_cp24_stripe_billing.sql` adds `sbg_billing_accounts`, `sbg_stripe_connections`, and `sbg_stripe_events`.

Runtime receives SELECT on billing/connection state plus EXECUTE on narrow ownership/state functions. No broad DML is granted.

No occupancy, booking, tenancy, role, or RLS architecture is changed.

## Activation still required

Source implementation does not mean Stripe is live. A controlled deployment checkpoint must configure the SBG Stripe account, Products/Prices, Connect onboarding settings, redirect URI, webhook endpoint, and credentials out of band.

## Guest payment boundary

CP24 establishes the hotel Stripe-account connection. The actual guest transfer Checkout/PaymentIntent flow must use the stored connected account ID and Stripe-Account request scoping.

It must not introduce SBG application fees, destination charges, platform fund custody, platform settlement, or booking commission.