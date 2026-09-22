/**
 * CP26A.1 — Domain A (SBG SaaS subscription) commercial dormancy.
 * CP26C.2 — fail-closed Stripe TEST hotel isolation (allowlist).
 * SBG_SAAS_COMMERCE=live is reserved for CP31. Do not set it before then.
 * Domain B (hotel guest payments / Connect) must not use these gates.
 */

export type SaasCommerceMode = "off" | "test" | "live";
export type StripeKeyMode = "test" | "live";

export const SBG_SAAS_TEST_HOTEL_IDS = "SBG_SAAS_TEST_HOTEL_IDS";

const HOTEL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SaasCommerceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaasCommerceError";
  }
}

function readEnv(env: NodeJS.Dict<string>, key: string): string {
  return String(env[key] ?? "").trim();
}

export function parseSaasCommerceMode(raw: string | undefined | null): SaasCommerceMode {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "off" || value === "false" || value === "0") return "off";
  if (value === "test") return "test";
  if (value === "live") return "live";
  return "off";
}

export function saasCommerceMode(env: NodeJS.Dict<string> = process.env): SaasCommerceMode {
  return parseSaasCommerceMode(readEnv(env, "SBG_SAAS_COMMERCE"));
}

export function classifyStripeSecretKey(
  secret: string | undefined | null,
): StripeKeyMode | "absent" | "unrecognised" {
  const value = String(secret ?? "").trim();
  if (!value) return "absent";
  if (value.startsWith("sk_test_") || value.startsWith("rk_test_")) return "test";
  if (value.startsWith("sk_live_") || value.startsWith("rk_live_")) return "live";
  return "unrecognised";
}

export function expectedLivemode(mode: Exclude<SaasCommerceMode, "off">): boolean {
  return mode === "live";
}

export type ParsedTestHotelAllowlist =
  | { ok: true; ids: readonly string[] }
  | { ok: false };

/** Parse SBG_SAAS_TEST_HOTEL_IDS. Never logs the raw value. Malformed tokens fail closed. */
export function parseSaasTestHotelIds(raw: string | undefined | null): ParsedTestHotelAllowlist {
  const tokens = String(raw ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!HOTEL_UUID_RE.test(token)) return { ok: false };
    const id = token.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ok: true, ids };
}

export function normalizeHotelUuid(hotelId: string | undefined | null): string | null {
  const id = String(hotelId ?? "").trim().toLowerCase();
  return HOTEL_UUID_RE.test(id) ? id : null;
}

/**
 * Fail-closed Domain A permission check. Call BEFORE any Stripe network request
 * on SaaS Checkout / billing portal / future paid SBG add-on paths.
 * Does not inspect or log the secret beyond prefix classification.
 * Hotel isolation is assertDomainACommerceAllowedForHotel (CP26C.2).
 */
export function assertDomainACommerceAllowed(
  env: NodeJS.Dict<string> = process.env,
): { mode: Exclude<SaasCommerceMode, "off">; expectedLivemode: boolean } {
  const mode = saasCommerceMode(env);
  if (mode === "off") {
    throw new SaasCommerceError("SBG SaaS commerce is not enabled.");
  }
  const keyMode = classifyStripeSecretKey(readEnv(env, "STRIPE_SECRET_KEY"));
  if (keyMode === "absent") {
    throw new SaasCommerceError("Stripe is not configured.");
  }
  if (keyMode === "unrecognised") {
    throw new SaasCommerceError("Stripe credential mode is unrecognised.");
  }
  if (mode === "test" && keyMode !== "test") {
    throw new SaasCommerceError("SBG SaaS test commerce requires Stripe test credentials.");
  }
  if (mode === "live" && keyMode !== "live") {
    throw new SaasCommerceError("SBG SaaS live commerce requires Stripe live credentials.");
  }
  return { mode, expectedLivemode: expectedLivemode(mode) };
}

function assertTestHotelAllowlisted(hotelId: string, env: NodeJS.Dict<string>): void {
  const id = normalizeHotelUuid(hotelId);
  if (!id) {
    throw new SaasCommerceError("SBG SaaS test commerce is not authorised for this hotel.");
  }
  const parsed = parseSaasTestHotelIds(readEnv(env, SBG_SAAS_TEST_HOTEL_IDS));
  if (!parsed.ok || parsed.ids.length === 0 || !parsed.ids.includes(id)) {
    throw new SaasCommerceError("SBG SaaS test commerce is not authorised for this hotel.");
  }
}

/**
 * Hotel-aware Domain A gate (CP26C.2).
 * off → reject. test → mode/key + non-empty valid allowlist + hotel present.
 * live → existing CP26A.1 live-key pairing; test allowlist is ignored.
 */
export function assertDomainACommerceAllowedForHotel(
  hotelId: string,
  env: NodeJS.Dict<string> = process.env,
): { mode: Exclude<SaasCommerceMode, "off">; expectedLivemode: boolean } {
  const allowed = assertDomainACommerceAllowed(env);
  if (allowed.mode === "test") assertTestHotelAllowlisted(hotelId, env);
  return allowed;
}

/** Test-mode webhook hotel isolation. Live ignores the allowlist. Off is false. Never throws. */
export function domainAWebhookHotelAllowed(
  hotelId: string,
  env: NodeJS.Dict<string> = process.env,
): boolean {
  const mode = saasCommerceMode(env);
  if (mode === "off") return false;
  if (mode === "live") return true;
  const id = normalizeHotelUuid(hotelId);
  if (!id) return false;
  const parsed = parseSaasTestHotelIds(readEnv(env, SBG_SAAS_TEST_HOTEL_IDS));
  if (!parsed.ok || parsed.ids.length === 0) return false;
  return parsed.ids.includes(id);
}

export function assertDomainALivemode(livemode: unknown, expected: boolean): void {
  if (typeof livemode !== "boolean") {
    throw new SaasCommerceError("Stripe response did not include livemode.");
  }
  if (livemode !== expected) {
    throw new SaasCommerceError("Stripe execution mode does not match SBG SaaS commerce mode.");
  }
}

/** Domain A webhook: acknowledge but do not mutate billing when ineligible. */
export function domainAWebhookEligible(
  event: { livemode?: unknown },
  env: NodeJS.Dict<string> = process.env,
): boolean {
  const mode = saasCommerceMode(env);
  if (mode === "off") return false;
  if (event.livemode === true) return mode === "live";
  if (event.livemode === false) return mode === "test";
  return false;
}
