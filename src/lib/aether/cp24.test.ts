import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("CP24 adds isolated SBG billing and Stripe connection state", () => {
  const migration = read("migrations/0020_cp24_stripe_billing.sql");
  const paymentMigration = read("migrations/0021_cp25_hotel_guest_payments.sql");
  assert.match(migration, /create table if not exists sbg_billing_accounts/);
  assert.match(migration, /create table if not exists sbg_stripe_connections/);
  assert.match(migration, /create table if not exists sbg_stripe_events/);
  assert.match(migration, /sbg_save_stripe_connection_for_user/);
  assert.match(migration, /sbg_apply_billing_event/);
  assert.match(migration, /sbg_sync_hotel_entitlement/);
  assert.match(migration, /grant select on table sbg_billing_accounts to aether_app/);
  assert.match(migration, /grant select on table sbg_stripe_connections to aether_app/);
  assert.doesNotMatch(migration, /alter table bookings/i);
  assert.doesNotMatch(migration, /\bEXCLUDE\s+(USING|\()/i);
  assert.doesNotMatch(migration, /create role/i);
  assert.match(paymentMigration, /sbg_booking_payments/);
  assert.match(paymentMigration, /sbg_prepare_booking_payment/);
  assert.match(paymentMigration, /Stripe|stripe_account_id/i);
  assert.doesNotMatch(paymentMigration, /alter table bookings/i);
  assert.doesNotMatch(paymentMigration, /\bEXCLUDE\s+(USING|\()/i);
});

test("CP24 keeps Stripe secrets server-side and uses Connect account scoping", () => {
  const stripe = read("src/lib/aether/stripe.server.ts");
  const fns = read("src/lib/aether/stripe-fns.ts");
  const billing = read("src/routes/app.billing.tsx");
  const serverFlow = `${stripe}\n${fns}`;
  assert.match(stripe, /STRIPE_SECRET_KEY/);
  assert.match(stripe, /STRIPE_WEBHOOK_SECRET/);
  assert.match(serverFlow, /STRIPE_CONNECT_CLIENT_ID/);
  assert.match(fns, /process\.env\.STRIPE_CONNECT_CLIENT_ID/);
  assert.match(stripe, /Stripe-Account/);
  assert.match(stripe, /connect\.stripe\.com\/oauth\/authorize/);
  assert.doesNotMatch(serverFlow, /VITE_|PUBLIC_STRIPE|NEXT_PUBLIC_/);
  assert.doesNotMatch(billing, /STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|STRIPE_CONNECT_CLIENT_ID/);
  assert.doesNotMatch(billing, /VITE_|NEXT_PUBLIC_/);
});

test("CP24 subscription flow is authenticated and webhook-signed", () => {
  const fns = read("src/lib/aether/stripe-fns.ts");
  const billingOrch = read("src/lib/aether/saas-billing.server.ts");
  const webhook = read("src/routes/api/stripe/webhook.ts");
  const callback = read("src/routes/api/stripe/connect/callback.ts");
  assert.match(fns, /authMiddleware/);
  assert.match(billingOrch, /createSubscriptionCheckout/);
  assert.match(billingOrch, /createBillingPortal/);
  assert.match(fns, /startStripeConnectFn/);
  assert.match(webhook, /stripe-signature/);
  assert.match(webhook, /verifyStripeSignature/);
  assert.match(webhook, /customer\.subscription\.updated/);
  assert.match(callback, /completeStripeConnect/);
});

test("CP24 does not make SBG the hotel guest-payment custodian", () => {
  const billing = read("src/routes/app.billing.tsx");
  assert.match(billing, /hotel’s own Stripe account/i);
  assert.match(billing, /does not receive or hold the hotel’s guest payment funds/i);
});

test("CP25 keeps guest transfer payment on the connected hotel account", () => {
  const migration = read("migrations/0021_cp25_hotel_guest_payments.sql");
  const stripe = read("src/lib/aether/stripe.server.ts");
  const payment = read("src/lib/aether/guest-payment-fns.ts");
  const confirmation = read("src/routes/confirmed.$token.tsx");

  assert.match(migration, /sbg_booking_payments/);
  assert.match(migration, /sbg_prepare_booking_payment/);
  assert.match(migration, /sbg_apply_payment_event/);
  assert.match(stripe, /mode: "payment"/);
  assert.match(stripe, /Stripe-Account/);
  assert.match(stripe, /metadata\[booking_id\]/);
  assert.match(stripe, /metadata\[payment_id\]/);
  assert.match(payment, /sbg_prepare_booking_payment/);
  assert.match(payment, /createGuestTransferCheckout/);
  assert.match(payment, /stripe_account_id/);
  assert.match(confirmation, /startGuestPayment/);
  assert.match(confirmation, /Pay for transfer/);
});
