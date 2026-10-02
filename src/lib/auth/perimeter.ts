/**
 * CP27.3a — Better Auth deployment perimeter.
 *
 * Installed contract (better-auth 1.6.30 / @better-auth/core 1.6.30):
 * - `advanced.ipAddress.trustedProxies` is `string[]` of IPs or CIDRs.
 *   It is not a hop count and not a callback. A non-empty list walks
 *   `X-Forwarded-For` from the right, skips trusted hops, and uses the
 *   first untrusted address. Empty trusts only a single valid IP;
 *   two or more values resolve to null (`no-trusted-ip|<path>`).
 * - A malformed address on that walk also resolves to null.
 * - `advanced.ipAddress.ipAddressHeaders` is checked in order. The first
 *   header that yields an IP wins. Default is `x-forwarded-for` only.
 * - Rate-limit storage is `"memory"` unless `secondaryStorage` is set
 *   or `rateLimit.storage` is `"database"` / `"secondary-storage"`.
 *   `"database"` persists the `rateLimit` model (key, count, lastRequest).
 *   That table is not in migrations 0001–0030. No Redis is configured.
 *   Memory counters are per process, not per Vercel isolate.
 */
import { createRateLimitKey, findInvalidTrustedProxies, getIp } from "@better-auth/core/utils/ip";
import { isBundlingProcess, readTrimmedEnv, type EnvMap } from "../aether/runtime-config.ts";
import { PREVIEW_ALLOWED_HOSTS } from "./preview.ts";

export type AuthDeployment = "production" | "preview" | "development";

export class AuthPerimeterError extends Error {
  readonly code = "auth_perimeter" as const;

  constructor(message: string) {
    super(message);
    this.name = "AuthPerimeterError";
  }
}

/** Local `npm run dev` origins. Not trusted in production. */
export const LOCAL_DEV_ORIGINS = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://[::1]:8080",
] as const;

/**
 * Platform headers first. Vercel overwrites these with the client IP.
 * `x-forwarded-for` is last so a forged leftmost value is not preferred
 * when a platform header resolved.
 */
export const PRODUCTION_AUTH_IP_HEADERS = [
  "x-vercel-forwarded-for",
  "x-real-ip",
  "x-forwarded-for",
] as const;

/** Library fallback key when no trustworthy IP resolves. Not a client identity. */
export const NO_TRUSTED_IP_KEY = "no-trusted-ip";

/**
 * Shared storage was not enabled. Database storage needs a new table.
 * secondaryStorage needs an external store. Neither is in this checkpoint.
 */
export const AUTH_RATE_LIMIT_STORAGE = "memory" as const;

export type AuthIpAddress = {
  ipAddressHeaders: string[];
  trustedProxies: string[];
};

export type AuthBaseURL =
  | string
  | {
      allowedHosts: string[];
      protocol: "auto";
      fallback: string;
    };

export type AuthPerimeter = {
  deployment: AuthDeployment;
  baseURL: AuthBaseURL;
  trustedOrigins: string[];
  ipAddress?: AuthIpAddress;
};

export function classifyAuthDeployment(
  env: EnvMap = process.env,
  argv: readonly string[] = process.argv,
): AuthDeployment {
  // Vite `npm run build` evaluates this module with NODE_ENV=production.
  // That is not a deployed runtime. The server process classifies again.
  if (!isBundlingProcess(env, argv)) {
    if (env.AETHER_RESTORE_TARGET === "production") return "production";
    if (env.VERCEL_ENV === "production") return "production";
    if (env.NODE_ENV === "production") return "production";
  }
  if (env.VERCEL_ENV === "preview") return "preview";
  return "development";
}

/**
 * Comma-separated IPs or CIDRs. Empty is empty, not an error.
 * Invalid entries throw — a typo must not silently trust the wrong hop.
 */
export function parseTrustedProxies(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalid = findInvalidTrustedProxies(entries);
  if (invalid.length > 0) {
    throw new AuthPerimeterError(
      `BETTER_AUTH_TRUSTED_PROXIES contains an invalid IP or CIDR: ${invalid.join(", ")}`,
    );
  }
  return entries;
}

export function productionTrustedProxies(env: EnvMap): string[] {
  return parseTrustedProxies(readTrimmedEnv("BETTER_AUTH_TRUSTED_PROXIES", env));
}

function nonProductionPerimeter(deployment: "preview" | "development"): AuthPerimeter {
  const previewAllowedHosts = [...PREVIEW_ALLOWED_HOSTS];
  return {
    deployment,
    baseURL: {
      allowedHosts: [...previewAllowedHosts, "localhost", "127.0.0.1", "[::1]"],
      protocol: "auto",
      fallback: "http://localhost:8080",
    },
    trustedOrigins: [
      ...previewAllowedHosts,
      ...previewAllowedHosts.flatMap((host) => [`https://${host}`, `http://${host}`]),
      ...LOCAL_DEV_ORIGINS,
    ],
  };
}

export function resolveAuthPerimeter(
  env: EnvMap = process.env,
  argv: readonly string[] = process.argv,
): AuthPerimeter {
  const deployment = classifyAuthDeployment(env, argv);
  if (deployment !== "production") {
    return nonProductionPerimeter(deployment);
  }
  const url = readTrimmedEnv("BETTER_AUTH_URL", env);
  if (!url) {
    throw new AuthPerimeterError(
      "BETTER_AUTH_URL is required for production auth. Refusing preview and loopback origins.",
    );
  }
  return {
    deployment: "production",
    baseURL: url,
    trustedOrigins: [url],
    ipAddress: {
      ipAddressHeaders: [...PRODUCTION_AUTH_IP_HEADERS],
      trustedProxies: productionTrustedProxies(env),
    },
  };
}

/** Same key Better Auth builds: `getIp` then `ip|path`, or `no-trusted-ip|path`. */
export function authRateLimitIdentity(
  request: Request,
  ipAddress: AuthIpAddress,
  path: string,
): { ip: string | null; key: string } {
  const ip = getIp(request, { advanced: { ipAddress } }) ?? null;
  return { ip, key: createRateLimitKey(ip ?? NO_TRUSTED_IP_KEY, path) };
}
