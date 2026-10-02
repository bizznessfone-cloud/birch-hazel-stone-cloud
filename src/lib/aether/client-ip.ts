/**
 * CP27.3c — public client-IP trust.
 * Same header order and X-Forwarded-For walk as CP27.3a (Better Auth getIPFromHeader).
 * Does not import the auth server, sessions, cookies, or auth rate-limit counters.
 */
import { findInvalidTrustedProxies, getIPFromHeader } from "@better-auth/core/utils/ip";
import { readTrimmedEnv, type EnvMap } from "./runtime-config.ts";

/**
 * Platform headers first. Vercel overwrites these with the client IP.
 * `x-forwarded-for` is last so a forged leftmost value is not preferred
 * when a platform header resolved.
 */
export const CLIENT_IP_HEADERS = [
  "x-vercel-forwarded-for",
  "x-real-ip",
  "x-forwarded-for",
] as const;

/** Shared bucket when no trustworthy client IP resolves. Not a client identity. */
export const NO_TRUSTED_CLIENT_IP = "no-trusted-ip";

export class ClientIpConfigError extends Error {
  readonly code = "client_ip_config" as const;

  constructor(message: string) {
    super(message);
    this.name = "ClientIpConfigError";
  }
}

export type ClientIpHeaders = {
  get(name: string): string | null;
};

/**
 * Comma-separated IPs or CIDRs. Empty is empty, not an error.
 * Invalid entries throw — a typo must not silently trust the wrong hop.
 */
export function parseClientTrustedProxies(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalid = findInvalidTrustedProxies(entries);
  if (invalid.length > 0) {
    throw new ClientIpConfigError(
      `BETTER_AUTH_TRUSTED_PROXIES contains an invalid IP or CIDR: ${invalid.join(", ")}`,
    );
  }
  return entries;
}

export function clientTrustedProxies(env: EnvMap = process.env): string[] {
  return parseClientTrustedProxies(readTrimmedEnv("BETTER_AUTH_TRUSTED_PROXIES", env));
}

/**
 * First header that yields an IP wins.
 * Non-empty trusted proxies walk X-Forwarded-For from the right and skip trusted hops.
 * Empty trusted proxies accept only a single valid IP. Multi-value or malformed input
 * does not select the leftmost hop.
 */
export function resolveTrustedClientIp(
  headers: ClientIpHeaders | null | undefined,
  trustedProxies: readonly string[],
): string | null {
  if (!headers) return null;
  for (const name of CLIENT_IP_HEADERS) {
    const value = headers.get(name);
    if (!value?.trim()) continue;
    const ip = getIPFromHeader(value, { trustedProxies: [...trustedProxies] });
    if (ip) return ip;
  }
  return null;
}

/** Limiter identity: a resolved client IP, or the stable untrusted fallback. */
export function guestLimiterIdentity(
  headers: ClientIpHeaders | null | undefined,
  env: EnvMap = process.env,
): string {
  const ip = resolveTrustedClientIp(headers, clientTrustedProxies(env));
  return ip ?? NO_TRUSTED_CLIENT_IP;
}
