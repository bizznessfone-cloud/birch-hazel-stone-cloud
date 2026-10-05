/**
 * CP30.05E-2D-1B — Option B password recovery.
 * Better Auth 1.6.30 stays the token authority. Resend is mocked.
 * No migration, no organisation, no Stripe, no real email.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailAndPasswordAuthOptions, signUpEnumerationAfterHook } from "./signup-enumeration.ts";
import {
  PASSWORD_RESET_ACKNOWLEDGEMENT,
  PASSWORD_RESET_LINK_INVALID,
  PASSWORD_RESET_SUBJECT,
  PASSWORD_RESET_TOKEN_EXPIRES_IN,
  PASSWORD_RESET_UNAVAILABLE,
  deliverPasswordReset,
  logPasswordResetDelivery,
  passwordRecoveryConfigured,
  passwordResetDeliveryOptions,
  passwordResetMessage,
  trustedPasswordResetCallbackUrl,
} from "./password-recovery.ts";

const BASE = "http://localhost:8080";
const SECRET = "cp3005e2d1b-recovery-secret-not-production";
const root = process.cwd();
const API_KEY = "re_test_key_not_a_secret_value";
const FROM = "SCAN BOOK GO <reset@example.com>";
const CONFIGURED = { RESEND_API_KEY: API_KEY, RESEND_FROM_EMAIL: FROM };

type Row = Record<string, unknown>;
type State = { user: Row[]; session: Row[]; account: Row[]; verification: Row[] };

function emptyState(): State {
  return { user: [], session: [], account: [], verification: [] };
}

function authFor(state: State, env: NodeJS.ProcessEnv) {
  return betterAuth({
    baseURL: BASE,
    secret: SECRET,
    database: memoryAdapter(state),
    trustedOrigins: [BASE],
    emailAndPassword: {
      ...emailAndPasswordAuthOptions,
      ...passwordResetDeliveryOptions(env),
    },
    hooks: { after: signUpEnumerationAfterHook },
    session: { cookieCache: { enabled: true, maxAge: 300 } },
    advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
    rateLimit: { enabled: true },
  });
}

function post(
  auth: ReturnType<typeof authFor>,
  path: string,
  body: Record<string, unknown>,
  ip: string,
) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: {
        origin: BASE,
        "content-type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function read(res: Response) {
  const text = await res.text();
  const cookies = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, text, cookies };
}

function cookieHeader(cookies: string[], nameIncludes?: string): string {
  return cookies
    .filter((cookie) => (nameIncludes ? cookie.split("=")[0]?.includes(nameIncludes) : true))
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

function ack(text: string) {
  const body = JSON.parse(text) as { status?: boolean; message?: string; code?: string };
  return { status: body.status ?? null, message: body.message ?? null, code: body.code ?? null };
}

function resetRows(state: State) {
  return state.verification.filter((row) => String(row.identifier).startsWith("reset-password:"));
}

function tokenFrom(state: State): string {
  const row = resetRows(state)[0];
  assert.ok(row);
  return String(row.identifier).slice("reset-password:".length);
}

type FetchCall = { url: string; init: RequestInit | undefined };

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const previous = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = { url, init };
    calls.push(call);
    if (!url.startsWith("https://api.resend.com/")) return previous(input, init);
    return handler(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

function spyInfo() {
  const lines: string[] = [];
  const previous = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map((part) => String(part)).join(" "));
  };
  return {
    lines,
    delivery() {
      return lines.flatMap((line) => {
        try {
          const row = JSON.parse(line) as { event?: string; outcome?: string; providerStatus?: number | null };
          return row.event === "sbg.password_reset.delivery" ? [row] : [];
        } catch {
          return [];
        }
      });
    },
    restore() { console.info = previous; },
  };
}

function assertNoSecrets(blob: string, secrets: string[]) {
  for (const secret of secrets) assert.equal(blob.includes(secret), false);
}

test("recovery stays closed until both Resend variables are set", () => {
  assert.equal(passwordRecoveryConfigured({}), false);
  assert.equal(passwordRecoveryConfigured({ RESEND_API_KEY: "  ", RESEND_FROM_EMAIL: FROM }), false);
  assert.equal(passwordRecoveryConfigured({ RESEND_API_KEY: API_KEY, RESEND_FROM_EMAIL: " " }), false);
  assert.equal(passwordRecoveryConfigured(CONFIGURED), true);
  assert.deepEqual(passwordResetDeliveryOptions({}), {});
  const open = passwordResetDeliveryOptions(CONFIGURED);
  assert.equal("sendResetPassword" in open, true);
  if (!("sendResetPassword" in open)) return;
  assert.equal(typeof open.sendResetPassword, "function");
  assert.equal(open.revokeSessionsOnPasswordReset, true);
  assert.equal(open.resetPasswordTokenExpiresIn, 3600);
  assert.equal(PASSWORD_RESET_TOKEN_EXPIRES_IN, 3600);
  assert.equal(emailAndPasswordAuthOptions.autoSignIn, false);
});

test("reset origin is BETTER_AUTH_URL in production and never PUBLIC_APP_URL or Host", () => {
  const argv = ["node", "cp3005e2d1b"];
  assert.equal(
    trustedPasswordResetCallbackUrl({
      NODE_ENV: "production",
      BETTER_AUTH_URL: "https://auth.sbg.test/",
      PUBLIC_APP_URL: "https://public.sbg.test",
      HOST: "evil.test",
    }, argv),
    "https://auth.sbg.test/reset-password",
  );
  assert.equal(
    trustedPasswordResetCallbackUrl({
      NODE_ENV: "development",
      PUBLIC_APP_URL: "https://public.sbg.test",
      HOST: "evil.test",
    }, argv),
    "http://localhost:8080/reset-password",
  );
  assert.throws(() => trustedPasswordResetCallbackUrl({ NODE_ENV: "production" }, argv));
  const recovery = readFileSync(join(root, "src/lib/auth/password-recovery.ts"), "utf8");
  assert.doesNotMatch(recovery, /readTrimmedEnv\("PUBLIC_APP_URL"\)|process\.env\.PUBLIC_APP_URL/);
});

test("reset email is a short transactional message and escapes the link", () => {
  const url = "https://auth.sbg.test/reset-password?token=abc&next=1<script>";
  const message = passwordResetMessage(url);
  assert.equal(message.subject, PASSWORD_RESET_SUBJECT);
  assert.match(message.text, /SCAN BOOK GO/);
  assert.match(message.text, /password reset was requested/i);
  assert.match(message.text, /expires in 1 hour/);
  assert.match(message.text, /did not request/);
  assert.match(message.text, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(message.html, /SCAN BOOK GO/);
  assert.equal(message.html.includes("token=abc\u0026amp;next=1"), true);
  assert.equal(message.html.includes("\u0026lt;script\u0026gt;"), true);
  assert.doesNotMatch(message.html, /<script>/);
  assert.doesNotMatch(message.text, /newsletter|unsubscribe|%\s*off/i);
});

test("sender observation distinguishes accept, reject, throw, and missing config without logging secrets", async () => {
  const token = "reset-token-must-not-be-logged";
  const url = `https://auth.sbg.test/reset-password?token=${token}`;
  const password = "password-must-not-be-logged";
  const logs = spyInfo();
  try {
    const accepted = installFetch(() => new Response("{}", { status: 200 }));
    assert.equal(await deliverPasswordReset({ to: "known@example.com", url, env: CONFIGURED }), "accepted");
    accepted.restore();

    const rejected = installFetch(() => new Response("no", { status: 422 }));
    assert.equal(await deliverPasswordReset({ to: "known@example.com", url, env: CONFIGURED }), "rejected");
    const authHeader = String((rejected.calls[0]?.init?.headers as Record<string, string>).Authorization);
    assert.equal(authHeader, `Bearer ${API_KEY}`);
    const mailed = JSON.parse(String(rejected.calls[0]?.init?.body)) as { subject: string; text: string };
    assert.equal(mailed.subject, PASSWORD_RESET_SUBJECT);
    assert.match(mailed.text, /reset-token-must-not-be-logged/);
    rejected.restore();

    const thrown = installFetch(() => { throw new Error(`network ${token} ${API_KEY}`); });
    assert.equal(await deliverPasswordReset({ to: "known@example.com", url, env: CONFIGURED }), "failed");
    thrown.restore();

    assert.equal(await deliverPasswordReset({ to: "known@example.com", url, env: {} }), "not_configured");
    logPasswordResetDelivery("accepted", 200);
  } finally {
    logs.restore();
  }
  const events = logs.delivery();
  assert.deepEqual(events.map((event) => [event.outcome, event.providerStatus]), [
    ["accepted", 200],
    ["rejected", 422],
    ["failed", null],
    ["not_configured", null],
    ["accepted", 200],
  ]);
  assertNoSecrets(logs.lines.join("\n"), [token, url, password, API_KEY, "known@example.com"]);
});

test("unconfigured reset is disabled for known and unknown addresses and stores nothing", async () => {
  const state = emptyState();
  const auth = authFor(state, {});
  const fetchLog = installFetch(() => new Response("{}", { status: 200 }));
  try {
    await read(await post(auth, "/sign-up/email", {
      email: "member@example.com", password: "password123", name: "Operator",
    }, "203.0.113.20"));
    const known = await read(await post(auth, "/request-password-reset", {
      email: "member@example.com", redirectTo: `${BASE}/reset-password`,
    }, "203.0.113.21"));
    const unknown = await read(await post(auth, "/request-password-reset", {
      email: "missing@example.com", redirectTo: `${BASE}/reset-password`,
    }, "203.0.113.22"));
    assert.equal(known.status, 400);
    assert.equal(unknown.status, 400);
    assert.equal(known.text, unknown.text);
    assert.equal(ack(known.text).code, "RESET_PASSWORD_DISABLED");
    assert.equal(state.verification.length, 0);
    assert.equal(fetchLog.calls.length, 0);
    assert.equal(state.user.length, 1);
  } finally {
    fetchLog.restore();
  }
});

test("known, unknown, and failed delivery share one acknowledgement and logs stay clean", async () => {
  const state = emptyState();
  const auth = authFor(state, CONFIGURED);
  const logs = spyInfo();
  let mode: "ok" | "reject" | "throw" = "ok";
  const fetchLog = installFetch(() => {
    if (mode === "throw") throw new Error("smtp down");
    if (mode === "reject") return new Response("no", { status: 503 });
    return new Response("{}", { status: 200 });
  });
  try {
    const created = await read(await post(auth, "/sign-up/email", {
      email: "known@example.com", password: "password123", name: "Operator",
    }, "203.0.113.30"));
    assert.equal(JSON.parse(created.text).token, null);
    assert.equal(state.session.length, 0);
    const known = await read(await post(auth, "/request-password-reset", {
      email: "known@example.com", redirectTo: `${BASE}/reset-password`,
    }, "203.0.113.31"));
    mode = "reject";
    const unknown = await read(await post(auth, "/request-password-reset", {
      email: "unknown@example.com", redirectTo: `${BASE}/reset-password`,
    }, "203.0.113.32"));
    mode = "throw";
    const failed = await read(await post(auth, "/request-password-reset", {
      email: "known@example.com", redirectTo: `${BASE}/reset-password`,
    }, "203.0.113.33"));
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.equal(failed.status, 200);
    assert.deepEqual(ack(known.text), ack(unknown.text));
    assert.deepEqual(ack(known.text), ack(failed.text));
    assert.equal(ack(known.text).status, true);
    assert.doesNotMatch(known.text, /known@example.com|503|smtp|re_test/);
    assert.equal(fetchLog.calls.length, 2);
    assert.equal(resetRows(state).length, 2);
    const expires = resetRows(state).map((row) => new Date(String(row.expiresAt)).getTime());
    for (const exp of expires) {
      const seconds = (exp - Date.now()) / 1000;
      assert.ok(seconds > 3500 && seconds < 3700);
    }
    const events = logs.delivery();
    assert.deepEqual(events.map((event) => event.outcome), ["accepted", "failed"]);
    const token = tokenFrom(state);
    assertNoSecrets(logs.lines.join("\n"), [token, API_KEY, "known@example.com", `${BASE}/api/auth/reset-password/`]);
  } finally {
    logs.restore();
    fetchLog.restore();
  }
});

test("invalid, expired, and spent tokens do not change the password; a valid token does", async () => {
  const state = emptyState();
  const auth = authFor(state, CONFIGURED);
  const fetchLog = installFetch(() => new Response("{}", { status: 200 }));
  const logs = spyInfo();
  try {
    await read(await post(auth, "/sign-up/email", {
      email: "lifecycle@example.com", password: "password123", name: "Operator",
    }, "203.0.113.40"));
    const signedIn = await read(await post(auth, "/sign-in/email", {
      email: "lifecycle@example.com", password: "password123",
    }, "203.0.113.41"));
    assert.equal(signedIn.status, 200);
    assert.equal(state.session.length, 1);
    const before = String(state.account[0]?.password);
    await read(await post(auth, "/request-password-reset", {
      email: "lifecycle@example.com", redirectTo: `${BASE}/reset-password`,
    }, "203.0.113.42"));
    const expiredToken = tokenFrom(state);
    state.verification[0]!.expiresAt = new Date(Date.now() - 60_000);
    const expired = await read(await post(auth, "/reset-password", {
      newPassword: "expired-password-99", token: expiredToken,
    }, "203.0.113.43"));
    assert.equal(expired.status, 400);
    assert.equal(ack(expired.text).code, "INVALID_TOKEN");
    assert.equal(String(state.account[0]?.password), before);
    assert.doesNotMatch(expired.text, /expiredToken|password|relation|stack/i);

    await read(await post(auth, "/request-password-reset", {
      email: "lifecycle@example.com", redirectTo: `${BASE}/reset-password`,
    }, "203.0.113.44"));
    const token = tokenFrom(state);
    const invalid = await read(await post(auth, "/reset-password", {
      newPassword: "invalid-password-99", token: "not-a-real-token",
    }, "203.0.113.45"));
    assert.equal(invalid.status, 400);
    assert.equal(ack(invalid.text).code, "INVALID_TOKEN");
    assert.equal(String(state.account[0]?.password), before);

    const redirect = await auth.handler(new Request(
      `${BASE}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(`${BASE}/reset-password`)}`,
      { redirect: "manual" },
    ));
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), `${BASE}/reset-password?token=${token}`);

    const evil = await read(await post(auth, "/request-password-reset", {
      email: "lifecycle@example.com", redirectTo: "https://evil.example/reset-password",
    }, "203.0.113.46"));
    assert.equal(evil.status, 403);
    assert.doesNotMatch(evil.text, new RegExp(token));
    assert.equal(String(state.account[0]?.password), before);

    const updated = await read(await post(auth, "/reset-password", {
      newPassword: "newpassword99", token,
    }, "203.0.113.47"));
    assert.equal(updated.status, 200);
    assert.notEqual(String(state.account[0]?.password), before);
    assert.equal(state.session.length, 0);
    assert.equal(resetRows(state).some((row) => String(row.identifier).endsWith(token)), false);

    const again = await read(await post(auth, "/reset-password", {
      newPassword: "anotherpassword99", token,
    }, "203.0.113.48"));
    assert.equal(again.status, 400);
    assert.equal(ack(again.text).code, "INVALID_TOKEN");

    const tokenOnly = await read(await auth.handler(new Request(`${BASE}/api/auth/get-session`, {
      headers: { origin: BASE, cookie: cookieHeader(signedIn.cookies, "session_token") },
    })));
    assert.equal(tokenOnly.status, 200);
    assert.equal(tokenOnly.text, "null");

    const cached = await read(await auth.handler(new Request(`${BASE}/api/auth/get-session`, {
      headers: { origin: BASE, cookie: cookieHeader(signedIn.cookies) },
    })));
    const cachedBody = JSON.parse(cached.text) as { user?: { email?: string } };
    assert.equal(cachedBody.user?.email, "lifecycle@example.com");
    assert.equal(state.session.length, 0);

    const oldPassword = await read(await post(auth, "/sign-in/email", {
      email: "lifecycle@example.com", password: "password123",
    }, "203.0.113.49"));
    assert.equal(oldPassword.status, 401);
    assert.equal(ack(oldPassword.text).code, "INVALID_EMAIL_OR_PASSWORD");
    assert.doesNotMatch(oldPassword.text, /newpassword99|hash|stack/);
    const newPassword = await read(await post(auth, "/sign-in/email", {
      email: "lifecycle@example.com", password: "newpassword99",
    }, "203.0.113.50"));
    assert.equal(newPassword.status, 200);
    assert.equal(state.session.length, 1);
    assert.equal(state.user.length, 1);
    assertNoSecrets(logs.lines.join("\n"), [token, expiredToken, API_KEY, "newpassword99", "password123"]);
  } finally {
    logs.restore();
    fetchLog.restore();
  }
});

test("recovery surfaces stay identity-only and do not open onboarding, Owner, or Ops", () => {
  const login = readFileSync(join(root, "src/routes/login.tsx"), "utf8");
  const forgot = readFileSync(join(root, "src/routes/forgot-password.tsx"), "utf8");
  const reset = readFileSync(join(root, "src/routes/reset-password.tsx"), "utf8");
  const home = readFileSync(join(root, "src/routes/index.tsx"), "utf8");
  const server = readFileSync(join(root, "src/lib/auth/server.ts"), "utf8");
  const recovery = readFileSync(join(root, "src/lib/auth/password-recovery.ts"), "utf8");
  for (const source of [login, forgot, reset, recovery]) {
    assert.doesNotMatch(source, /sbg_organisations|sbg_organisation_members|sbg_organisation_acceptances|organisation_type/);
    assert.doesNotMatch(source, /sbg_create_hotel|insert into hotels|property licence|licensed_quantity/i);
    assert.doesNotMatch(source, /stripe|checkout\.sessions/i);
    assert.doesNotMatch(source, /href="\/owner"|to="\/owner"|href="\/ops"|to="\/ops"/);
    assert.doesNotMatch(source, /response\.text\(|response\.json\(|error\.message/);
  }
  assert.match(login, /Forgot password\?/);
  assert.match(login, /PASSWORD_RESET_UNAVAILABLE/);
  assert.equal(PASSWORD_RESET_UNAVAILABLE, "Password recovery is not available until email delivery is configured.");
  assert.match(forgot, /PASSWORD_RESET_ACKNOWLEDGEMENT/);
  assert.equal(PASSWORD_RESET_ACKNOWLEDGEMENT, "If an account exists for that email, password reset instructions will be sent.");
  assert.match(forgot, /resetCallbackUrl/);
  assert.doesNotMatch(forgot, /window\.location|PUBLIC_APP_URL|We sent an email/);
  assert.match(reset, /PASSWORD_RESET_LINK_INVALID/);
  assert.equal(PASSWORD_RESET_LINK_INVALID, "This reset link is invalid or has expired.");
  assert.doesNotMatch(reset, /\{token\}|\{search\.token\}/);
  assert.match(server, /autoSignIn stays false/);
  assert.match(server, /passwordResetDeliveryOptions\(\)/);
  assert.doesNotMatch(server, /sendResetPassword/);
  assert.match(server, /cookieCache: \{ enabled: true, maxAge: 300 \}/);
  assert.match(home, /href="#start"/);
  assert.doesNotMatch(home, /forgot-password|\/get-started|href="\/login"|to="\/login"/);
  const names = readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql"));
  assert.equal(names.includes("0032_cp3005e2c1_organisation_acceptance.sql"), true);
  assert.equal(names.some((name) => name.startsWith("0033")), false);
  assert.equal(existsSync(join(root, "migrations/0033_cp3005e2d1b.sql")), false);
  const preflight = readFileSync(join(root, "scripts/production-db-preflight.mjs"), "utf8");
  assert.match(preflight, /"0032_cp3005e2c1_organisation_acceptance.sql",\n\];/);
  assert.match(preflight, /AUTHORISED_PENDING = \[\];/);
});
