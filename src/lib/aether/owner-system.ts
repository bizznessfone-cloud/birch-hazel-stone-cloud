/**
 * CP26C-O2 — read-only Owner System health.
 * Presence and classification only. Never returns secret values.
 */
import {
  classifyStripeSecretKey,
  parseSaasCommerceMode,
  parseSaasTestHotelIds,
  SBG_SAAS_TEST_HOTEL_IDS,
} from "./saas-commerce.server.ts";

export const OWNER_SYSTEM_CAPTION =
  "LIVE commerce is CP31. This dashboard cannot activate it.";

const PRICE_ENV_KEYS = [
  "STRIPE_BASIC_PRICE_ID",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_PREMIUM_PRICE_ID",
] as const;

function present(value: string | undefined | null): "PRESENT" | "ABSENT" {
  return String(value ?? "").trim() ? "PRESENT" : "ABSENT";
}

export type AllowlistHealth =
  | { status: "absent" | "empty" | "invalid"; count: 0 }
  | { status: "configured"; count: number };

export type OwnerSystemSnapshot = {
  commerceMode: "off" | "test" | "live";
  commerceConfigured: "PRESENT" | "ABSENT";
  stripeSecret: "absent" | "test" | "live" | "unrecognised";
  webhookSecret: "PRESENT" | "ABSENT";
  priceEnv: Record<(typeof PRICE_ENV_KEYS)[number], "PRESENT" | "ABSENT">;
  testAllowlist: AllowlistHealth;
  caption: typeof OWNER_SYSTEM_CAPTION;
};

export function ownerSystemSnapshot(
  env: NodeJS.Dict<string> = process.env,
): OwnerSystemSnapshot {
  const commerceRaw = env.SBG_SAAS_COMMERCE;
  const allowRaw = env[SBG_SAAS_TEST_HOTEL_IDS];
  const parsedAllow = parseSaasTestHotelIds(allowRaw);
  let testAllowlist: AllowlistHealth;
  if (!String(allowRaw ?? "").trim()) {
    testAllowlist = { status: "absent", count: 0 };
  } else if (!parsedAllow.ok) {
    testAllowlist = { status: "invalid", count: 0 };
  } else if (parsedAllow.ids.length === 0) {
    testAllowlist = { status: "empty", count: 0 };
  } else {
    testAllowlist = { status: "configured", count: parsedAllow.ids.length };
  }

  return {
    commerceMode: parseSaasCommerceMode(commerceRaw),
    commerceConfigured: present(commerceRaw),
    stripeSecret: classifyStripeSecretKey(env.STRIPE_SECRET_KEY),
    webhookSecret: present(env.STRIPE_WEBHOOK_SECRET),
    priceEnv: {
      STRIPE_BASIC_PRICE_ID: present(env.STRIPE_BASIC_PRICE_ID),
      STRIPE_PRO_PRICE_ID: present(env.STRIPE_PRO_PRICE_ID),
      STRIPE_PREMIUM_PRICE_ID: present(env.STRIPE_PREMIUM_PRICE_ID),
    },
    testAllowlist,
    caption: OWNER_SYSTEM_CAPTION,
  };
}

export function ownerSystemHasSecretValues(payload: unknown): boolean {
  const json = JSON.stringify(payload ?? "");
  return (
    /sk_(?:live|test)_/i.test(json) ||
    /rk_(?:live|test)_/i.test(json) ||
    /whsec_/i.test(json) ||
    /postgres(?:ql)?:\/\//i.test(json) ||
    /AETHER_DATABASE_OWNER_URL/i.test(json) ||
    /BETTER_AUTH_SECRET/i.test(json)
  );
}

export function parsedAllowlistIds(env: NodeJS.Dict<string> = process.env): readonly string[] {
  const parsed = parseSaasTestHotelIds(env[SBG_SAAS_TEST_HOTEL_IDS]);
  return parsed.ok ? parsed.ids : [];
}
