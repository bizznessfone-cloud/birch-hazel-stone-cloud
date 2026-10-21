/**
 * One local invocation of the existing expiry worker.
 * Not a cron entry and not a change to the expiry implementation.
 * The connection must already be aether_expiry_runner on the disposable database.
 */
import { classifyStripeSecretKey } from "./saas-commerce.server.ts";
import { runExpiryWorker, type ExpiredHold } from "./expiry-runner.ts";
import { connectDisposableRole } from "./guest-payment-test-local.ts";
import { GuestPaymentIsolationError } from "./guest-payment-test-isolation.ts";

export async function runLocalExpiryOnce(
  connectionString: string,
  env: NodeJS.Dict<string> = process.env,
): Promise<ExpiredHold[]> {
  if (classifyStripeSecretKey(env.STRIPE_SECRET_KEY) === "live") {
    throw new GuestPaymentIsolationError("live_credentials_rejected");
  }
  if (env.SBG_DOMAIN_B_LIVE_CHECKOUT === "true" || env.SBG_SAAS_COMMERCE === "live") {
    throw new GuestPaymentIsolationError("live_payment_flag");
  }
  const client = await connectDisposableRole(connectionString, "aether_expiry_runner");
  try {
    return await runExpiryWorker({
      query: async <T>(text: string, params?: unknown[]) => (await client.query(text, params)).rows as T[],
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
