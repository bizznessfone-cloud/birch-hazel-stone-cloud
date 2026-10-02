/**
 * CP27.3a — Better Auth perimeter only.
 * Does not change signup enumeration, billing reads, guest XFF, or Ops.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailAndPasswordEnabled } from "./email-password.ts";
import {
  AUTH_RATE_LIMIT_STORAGE,
  AuthPerimeterError,
  LOCAL_DEV_ORIGINS,
  NO_TRUSTED_IP_KEY,
  authRateLimitIdentity,
  classifyAuthDeployment,
  resolveAuthPerimeter,
  type AuthIpAddress,
  type AuthPerimeter,
} from "./perimeter.ts";

const PRODUCTION_URL = "https://scan-book-go.vercel.app";
const PROXY = "192.0.2.10";
const SIGN_IN_PATH = "/sign-in/email";

function productionEnv(extra: Record<string, string | undefined> = {}) {
  return { NODE_ENV: "production", BETTER_AUTH_URL: PRODUCTION_URL, ...extra };
}

function productionPerimeter(extra: Record<string, string | undefined> = {}): AuthPerimeter {
  return resolveAuthPerimeter(productionEnv(extra), []);
}

function requireIp(perimeter: AuthPerimeter): AuthIpAddress {
  assert.ok(perimeter.ipAddress);
  return perimeter.ipAddress;
}

function forwarded(headers: Record<string, string>): Request {
  return new Request(`${PRODUCTION_URL}/api/auth/sign-in/email`, { headers });
}

type OriginMatch = (url: string, pattern: string) => boolean;

async function originMatcher(): Promise<OriginMatch> {
  const href = pathToFileURL(
    join(process.cwd(), "node_modules/better-auth/dist/auth/trusted-origins.mjs"),
  ).href;
  const mod = (await import(href)) as { matchesOriginPattern: OriginMatch };
  return mod.matchesOriginPattern;
}

function originAllowed(match: OriginMatch, origins: string[], origin: string): boolean {
  return origins.some((pattern) => match(origin, pattern));
}

test("production with BETTER_AUTH_URL trusts only that origin", async () => {
  const perimeter = productionPerimeter();
  const match = await originMatcher();
  assert.equal(perimeter.deployment, "production");
  assert.equal(perimeter.baseURL, PRODUCTION_URL);
  assert.deepEqual(perimeter.trustedOrigins, [PRODUCTION_URL]);
  assert.equal(originAllowed(match, perimeter.trustedOrigins, PRODUCTION_URL), true);
});

test("production without BETTER_AUTH_URL fails closed", () => {
  assert.throws(
    () => resolveAuthPerimeter({ NODE_ENV: "production" }, []),
    (err: unknown) => err instanceof AuthPerimeterError && /BETTER_AUTH_URL/.test(err.message),
  );
  assert.throws(
    () => resolveAuthPerimeter({ VERCEL_ENV: "production", BETTER_AUTH_URL: "   " }, []),
    AuthPerimeterError,
  );
});

test("production rejects loopback and grok-sandbox origins", async () => {
  const perimeter = productionPerimeter();
  const match = await originMatcher();
  for (const origin of [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "https://preview-abc.grok-sandbox.com",
    "http://preview-abc.grok-sandbox.com",
  ]) {
    assert.equal(originAllowed(match, perimeter.trustedOrigins, origin), false, origin);
  }
  assert.equal(typeof perimeter.baseURL, "string");
});

test("preview keeps the grok-sandbox dynamic baseURL", () => {
  const perimeter = resolveAuthPerimeter({ VERCEL_ENV: "preview" }, []);
  assert.equal(perimeter.deployment, "preview");
  assert.equal(typeof perimeter.baseURL, "object");
  if (typeof perimeter.baseURL === "string") return;
  assert.ok(perimeter.baseURL.allowedHosts.includes("*.grok-sandbox.com"));
  assert.ok(perimeter.trustedOrigins.includes("https://*.grok-sandbox.com"));
  assert.equal(perimeter.ipAddress, undefined);
});

test("development keeps localhost variants and the sandbox dev server allowlist", async () => {
  const perimeter = resolveAuthPerimeter({ NODE_ENV: "development" }, []);
  const match = await originMatcher();
  assert.equal(perimeter.deployment, "development");
  assert.equal(classifyAuthDeployment({ NODE_ENV: "development" }, []), "development");
  assert.equal(typeof perimeter.baseURL, "object");
  if (typeof perimeter.baseURL === "string") return;
  assert.ok(perimeter.baseURL.allowedHosts.includes("localhost"));
  assert.ok(perimeter.baseURL.allowedHosts.includes("127.0.0.1"));
  assert.ok(perimeter.baseURL.allowedHosts.includes("[::1]"));
  assert.ok(perimeter.baseURL.allowedHosts.includes("*.grok-sandbox.com"));
  for (const origin of LOCAL_DEV_ORIGINS) {
    assert.equal(originAllowed(match, perimeter.trustedOrigins, origin), true, origin);
  }
  assert.equal(
    originAllowed(match, perimeter.trustedOrigins, "https://preview-abc.grok-sandbox.com"),
    true,
  );
});

test("vite build does not fail closed when production env is unset", () => {
  assert.doesNotThrow(() =>
    resolveAuthPerimeter({ NODE_ENV: "production", npm_lifecycle_event: "build" }, []),
  );
  const duringBuild = resolveAuthPerimeter(
    { NODE_ENV: "production" },
    ["node", "vite", "build"],
  );
  assert.equal(duringBuild.deployment, "development");
});

test("configured proxy chain resolves the client and ignores a forged left hop", () => {
  const ipAddress = requireIp(productionPerimeter({ BETTER_AUTH_TRUSTED_PROXIES: PROXY }));
  const chain = authRateLimitIdentity(
    forwarded({ "x-forwarded-for": `198.51.100.9, 203.0.113.10, ${PROXY}` }),
    ipAddress,
    SIGN_IN_PATH,
  );
  const forged = authRateLimitIdentity(
    forwarded({ "x-forwarded-for": `198.51.100.99, 203.0.113.10, ${PROXY}` }),
    ipAddress,
    SIGN_IN_PATH,
  );
  assert.equal(chain.ip, "203.0.113.10");
  assert.equal(forged.ip, "203.0.113.10");
  assert.equal(forged.key, chain.key);
  assert.equal(forged.key.startsWith(`${NO_TRUSTED_IP_KEY}|`), false);
});

test("two clients get distinct keys and one client is stable", () => {
  const ipAddress = requireIp(productionPerimeter({ BETTER_AUTH_TRUSTED_PROXIES: PROXY }));
  const left = authRateLimitIdentity(
    forwarded({ "x-forwarded-for": `203.0.113.10, ${PROXY}` }),
    ipAddress,
    SIGN_IN_PATH,
  );
  const right = authRateLimitIdentity(
    forwarded({ "x-forwarded-for": `203.0.113.11, ${PROXY}` }),
    ipAddress,
    SIGN_IN_PATH,
  );
  const again = authRateLimitIdentity(
    forwarded({ "x-forwarded-for": `203.0.113.10, ${PROXY}` }),
    ipAddress,
    SIGN_IN_PATH,
  );
  assert.equal(left.ip, "203.0.113.10");
  assert.equal(right.ip, "203.0.113.11");
  assert.notEqual(left.key, right.key);
  assert.equal(left.key, again.key);
});

test("platform single-IP beats a forged X-Forwarded-For chain", () => {
  const ipAddress = requireIp(productionPerimeter());
  const identity = authRateLimitIdentity(
    forwarded({
      "x-real-ip": "203.0.113.10",
      "x-forwarded-for": "198.51.100.99, 203.0.113.50",
    }),
    ipAddress,
    SIGN_IN_PATH,
  );
  assert.equal(identity.ip, "203.0.113.10");
  assert.equal(identity.key.includes(NO_TRUSTED_IP_KEY), false);
});

test("malformed or untrusted forwarding does not select an attacker IP", () => {
  const configured = requireIp(productionPerimeter({ BETTER_AUTH_TRUSTED_PROXIES: PROXY }));
  const malformed = authRateLimitIdentity(
    forwarded({ "x-forwarded-for": `not-an-ip, ${PROXY}` }),
    configured,
    SIGN_IN_PATH,
  );
  assert.equal(malformed.ip, null);
  assert.equal(malformed.key, `${NO_TRUSTED_IP_KEY}|${SIGN_IN_PATH}`);

  const unconfigured = requireIp(productionPerimeter());
  const multi = authRateLimitIdentity(
    forwarded({ "x-forwarded-for": "198.51.100.99, 203.0.113.10" }),
    unconfigured,
    SIGN_IN_PATH,
  );
  assert.equal(multi.ip, null);
  assert.notEqual(multi.ip, "198.51.100.99");
});

test("multi-hop no longer collapses when the production proxy hop is configured", () => {
  const ipAddress = requireIp(productionPerimeter({ BETTER_AUTH_TRUSTED_PROXIES: PROXY }));
  const clientA = authRateLimitIdentity(
    forwarded({ "x-forwarded-for": `198.51.100.1, 203.0.113.21, ${PROXY}` }),
    ipAddress,
    SIGN_IN_PATH,
  );
  const clientB = authRateLimitIdentity(
    forwarded({ "x-forwarded-for": `198.51.100.1, 203.0.113.22, ${PROXY}` }),
    ipAddress,
    SIGN_IN_PATH,
  );
  assert.equal(clientA.ip, "203.0.113.21");
  assert.equal(clientB.ip, "203.0.113.22");
  assert.equal(clientA.key.includes(NO_TRUSTED_IP_KEY), false);
  assert.notEqual(clientA.key, clientB.key);
});

test("invalid BETTER_AUTH_TRUSTED_PROXIES fails closed in production", () => {
  assert.throws(
    () => productionPerimeter({ BETTER_AUTH_TRUSTED_PROXIES: "192.0.2.10, nope" }),
    AuthPerimeterError,
  );
});

test("rate-limit storage stays process-local memory", () => {
  assert.equal(AUTH_RATE_LIMIT_STORAGE, "memory");
  const server = readFileSync(join(process.cwd(), "src/lib/auth/server.ts"), "utf8");
  assert.doesNotMatch(server, /secondaryStorage/);
  assert.doesNotMatch(server, /storage:\s*"database"/);
  assert.doesNotMatch(server, /rateLimit:\s*\{[^}]*enabled:\s*false/);
});

test("installed Better Auth still rate-limits sign-in and sign-up and rejects foreign origins", async () => {
  const perimeter = productionPerimeter({ BETTER_AUTH_TRUSTED_PROXIES: PROXY });
  const auth = betterAuth({
    baseURL: perimeter.baseURL as string,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: perimeter.trustedOrigins,
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: true },
    advanced: { ipAddress: perimeter.ipAddress },
  });

  const localhost = await auth.handler(
    new Request(`${PRODUCTION_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: "http://localhost:8080",
        "content-type": "application/json",
        "x-forwarded-for": `203.0.113.40, ${PROXY}`,
      },
      body: JSON.stringify({ email: "a@example.com", password: "password123" }),
    }),
  );
  assert.equal(localhost.status, 403);
  await localhost.text();

  const sandbox = await auth.handler(
    new Request(`${PRODUCTION_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: "https://preview-abc.grok-sandbox.com",
        "content-type": "application/json",
        "x-forwarded-for": `203.0.113.41, ${PROXY}`,
      },
      body: JSON.stringify({ email: "a@example.com", password: "password123" }),
    }),
  );
  assert.equal(sandbox.status, 403);
  await sandbox.text();

  const signInStatuses: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await auth.handler(
      new Request(`${PRODUCTION_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          origin: PRODUCTION_URL,
          "content-type": "application/json",
          "x-forwarded-for": `203.0.113.42, ${PROXY}`,
        },
        body: JSON.stringify({ email: "nobody@example.com", password: "password123" }),
      }),
    );
    signInStatuses.push(res.status);
    await res.text();
  }
  assert.equal(signInStatuses[0], 401);
  assert.equal(signInStatuses.at(-1), 429);

  const signUpStatuses: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await auth.handler(
      new Request(`${PRODUCTION_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          origin: PRODUCTION_URL,
          "content-type": "application/json",
          "x-forwarded-for": `203.0.113.43, ${PROXY}`,
        },
        body: JSON.stringify({
          email: `cp273a-${i}@example.com`,
          password: "password123",
          name: "CP273A",
        }),
      }),
    );
    signUpStatuses.push(res.status);
    await res.text();
  }
  assert.equal(signUpStatuses[0], 200);
  assert.equal(signUpStatuses.at(-1), 429);
});

test("cookie, bearer, signup, guest limiter, ops, and commerce source stay put", () => {
  const root = process.cwd();
  const server = readFileSync(join(root, "src/lib/auth/server.ts"), "utf8");
  assert.match(server, /__Host-grok-auth\.session_token/);
  assert.match(server, /sameSite: "lax"/);
  assert.match(server, /secure: true/);
  assert.match(server, /useSecureCookies: false/);
  assert.match(server, /cookieCache: \{ enabled: true, maxAge: 300 \}/);
  assert.match(server, /bearer\(\)/);
  assert.match(server, /emailAndPassword: \{ enabled: true \}/);
  assert.doesNotMatch(server, /requireEmailVerification/);
  assert.doesNotMatch(server, /sendResetPassword/);
  assert.equal(emailAndPasswordEnabled, true);

  const booking = readFileSync(join(root, "src/lib/aether/booking.server.ts"), "utf8");
  assert.match(booking, /forwarded\.split\(","\)\[0\]/);

  const ops = readFileSync(join(root, "src/lib/aether/ops-auth.ts"), "utf8");
  assert.match(ops, /sameSite: "lax"/);
  assert.match(ops, /"invalid_credentials"/);

  const domainB = readFileSync(join(root, "src/lib/aether/domain-b-live.ts"), "utf8");
  assert.match(domainB, /=== "true"/);

  const billing = readFileSync(join(root, "src/lib/aether/saas-billing.server.ts"), "utf8");
  assert.match(billing, /export async function loadDomainABillingState/);
  assert.match(billing, /await ownedHotel\(db, userId, hotelId\)/);

  assert.equal(existsSync(join(root, "migrations/0031_cp273a.sql")), false);
  const preflight = readFileSync(join(root, "scripts/production-db-preflight.mjs"), "utf8");
  assert.match(preflight, /export const AUTHORISED_PENDING = \[\];/);
  assert.match(preflight, /"0030_cp272_fix_prepare_booking_payment.sql"/);
  assert.doesNotMatch(preflight, /0031_/);
});
