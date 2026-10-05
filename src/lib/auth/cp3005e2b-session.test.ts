/**
 * CP30.05E-2B — signup establishes a session by the normal sign-in step.
 * The signup response itself stays non-enumerating and sessionless.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { decideAppAccess } from "./app-session.ts";
import { passwordRecoveryDeliveryAvailable } from "./password-recovery.ts";
import {
  PUBLIC_AUTH_ERRORS,
  establishSignupSession,
} from "./signup-session.ts";
import {
  emailAndPasswordAuthOptions,
  signUpEnumerationAfterHook,
} from "./signup-enumeration.ts";

const BASE = "http://localhost:8080";
const SECRET = "cp3005e2b-session-secret-not-production";
const root = process.cwd();

type Row = Record<string, unknown>;

function authFor(state: { user: Row[]; session: Row[]; account: Row[]; verification: Row[] }) {
  return betterAuth({
    baseURL: BASE,
    secret: SECRET,
    database: memoryAdapter(state),
    trustedOrigins: [BASE],
    emailAndPassword: emailAndPasswordAuthOptions,
    hooks: { after: signUpEnumerationAfterHook },
    rateLimit: { enabled: true },
  });
}

function post(
  auth: ReturnType<typeof authFor>,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: {
        origin: BASE,
        "content-type": "application/json",
        ...headers,
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

function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";")[0] ?? "").filter(Boolean).join("; ");
}

function contract(text: string) {
  const body = JSON.parse(text) as { token: unknown; user: Record<string, unknown> };
  const { id: _id, createdAt: _c, updatedAt: _u, ...user } = body.user;
  return { token: body.token, keys: Object.keys(body.user).sort(), user };
}

test("signup response stays sessionless, then email sign-in opens one session", async () => {
  const state = { user: [] as Row[], session: [] as Row[], account: [] as Row[], verification: [] as Row[] };
  const auth = authFor(state);
  const created = await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "new.customer@example.com", password: "password123", name: "Operator" },
      { "x-forwarded-for": "203.0.113.60" },
    ),
  );
  assert.equal(created.status, 200);
  assert.equal(JSON.parse(created.text).token, null);
  assert.equal(created.cookies.length, 0);
  assert.equal(state.user.length, 1);
  assert.equal(state.session.length, 0);
  assert.equal(state.account.length, 1);

  const signedIn = await read(
    await post(
      auth,
      "/sign-in/email",
      { email: "new.customer@example.com", password: "password123" },
      { "x-forwarded-for": "203.0.113.61" },
    ),
  );
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.text, /"token":"[^"]+"/);
  assert.equal(state.session.length, 1);
  assert.equal(signedIn.cookies.length > 0, true);
  assert.equal(signedIn.text.includes("USER_ALREADY_EXISTS"), false);
  assert.equal(/select |insert |sbg_|stack/i.test(signedIn.text), false);

  const session = await read(
    await auth.handler(
      new Request(`${BASE}/api/auth/get-session`, {
        headers: { origin: BASE, cookie: cookieHeader(signedIn.cookies) },
      }),
    ),
  );
  assert.equal(session.status, 200);
  const body = JSON.parse(session.text) as { user?: { email?: string } } | null;
  assert.equal(body?.user?.email, "new.customer@example.com");
  assert.equal(state.user.length, 1);
  assert.equal(Object.keys(state).sort().join(","), "account,session,user,verification");
});

test("existing-email signup does not enumerate, duplicate, or accept the attacker's password", async () => {
  const state = { user: [] as Row[], session: [] as Row[], account: [] as Row[], verification: [] as Row[] };
  const auth = authFor(state);
  const unknown = await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "taken@example.com", password: "password123", name: "Operator" },
      { "x-forwarded-for": "203.0.113.70" },
    ),
  );
  const existing = await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "taken@example.com", password: "other-password-99", name: "Operator" },
      { "x-forwarded-for": "203.0.113.71" },
    ),
  );
  assert.equal(unknown.status, 200);
  assert.equal(existing.status, 200);
  assert.deepEqual(contract(unknown.text), contract(existing.text));
  assert.equal(unknown.cookies.length, 0);
  assert.equal(existing.cookies.length, 0);
  assert.equal(existing.text.includes("USER_ALREADY_EXISTS"), false);
  assert.equal(state.user.length, 1);
  assert.equal(state.session.length, 0);

  const attacker = await read(
    await post(
      auth,
      "/sign-in/email",
      { email: "taken@example.com", password: "other-password-99" },
      { "x-forwarded-for": "203.0.113.72" },
    ),
  );
  const missing = await read(
    await post(
      auth,
      "/sign-in/email",
      { email: "missing@example.com", password: "other-password-99" },
      { "x-forwarded-for": "203.0.113.73" },
    ),
  );
  assert.equal(attacker.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(attacker.text, missing.text);
  assert.equal(/sql|relation|stack|sbg_/i.test(attacker.text), false);
  assert.equal(state.session.length, 0);

  const owner = await read(
    await post(
      auth,
      "/sign-in/email",
      { email: "taken@example.com", password: "password123" },
      { "x-forwarded-for": "203.0.113.74" },
    ),
  );
  assert.equal(owner.status, 200);
  assert.equal(state.user.length, 1);
  assert.equal(state.session.length, 1);
});

test("logout removes the session and /app access requires one", async () => {
  const state = { user: [] as Row[], session: [] as Row[], account: [] as Row[], verification: [] as Row[] };
  const auth = authFor(state);
  await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "leave@example.com", password: "password123", name: "Operator" },
      { "x-forwarded-for": "203.0.113.80" },
    ),
  );
  const signedIn = await read(
    await post(
      auth,
      "/sign-in/email",
      { email: "leave@example.com", password: "password123" },
      { "x-forwarded-for": "203.0.113.81" },
    ),
  );
  assert.equal(state.session.length, 1);
  const loggedOut = await read(
    await auth.handler(
      new Request(`${BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          origin: BASE,
          cookie: cookieHeader(signedIn.cookies),
        },
      }),
    ),
  );
  assert.equal(loggedOut.status, 200);
  assert.equal(state.session.length, 0);
  const after = await read(
    await auth.handler(
      new Request(`${BASE}/api/auth/get-session`, {
        headers: { origin: BASE, cookie: cookieHeader(signedIn.cookies) },
      }),
    ),
  );
  assert.equal(after.text, "null");
  assert.deepEqual(
    decideAppAccess({ authEnabled: true, databaseConfigured: true, hasSession: false }),
    { ok: false, mode: "unauthenticated" },
  );
});

test("signup session helper does not surface internal auth errors", async () => {
  const rejected = await establishSignupSession({
    signUp: async () => ({ error: { message: 'relation "user" does not exist' } }),
    signIn: async () => ({ error: null }),
  });
  assert.deepEqual(rejected, { ok: false, message: PUBLIC_AUTH_ERRORS.signupRejected });
  const noSession = await establishSignupSession({
    signUp: async () => ({ error: null }),
    signIn: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.deepEqual(noSession, { ok: false, message: PUBLIC_AUTH_ERRORS.sessionNotStarted });
  const ok = await establishSignupSession({
    signUp: async () => ({}),
    signIn: async () => ({}),
  });
  assert.deepEqual(ok, { ok: true });
  for (const message of Object.values(PUBLIC_AUTH_ERRORS)) {
    assert.equal(/sql|stack|token|sbg_|password hash/i.test(message), false);
  }
});

test("identity creation does not provision, elevate, or enable reset delivery", () => {
  const login = readFileSync(join(root, "src/routes/login.tsx"), "utf8");
  const session = readFileSync(join(root, "src/lib/auth/signup-session.ts"), "utf8");
  const recovery = readFileSync(join(root, "src/lib/auth/password-recovery.ts"), "utf8");
  const server = readFileSync(join(root, "src/lib/auth/server.ts"), "utf8");
  const home = readFileSync(join(root, "src/routes/index.tsx"), "utf8");
  const app = readFileSync(join(root, "src/routes/app.tsx"), "utf8");
  for (const source of [login, session]) {
    assert.doesNotMatch(source, /sbg_create_organisation_for_user|sbg_create_hotel_for_user|sbg_organisation_members/);
    assert.doesNotMatch(source, /stripe|organisation_type|billing_authority/);
    assert.doesNotMatch(source, /\/owner|\/ops/);
  }
  assert.match(login, /authClient\.signUp\.email/);
  assert.match(login, /authClient\.signIn\.email/);
  assert.match(login, /establishSignupSession/);
  assert.doesNotMatch(login, /error\.message/);
  assert.match(login, /PASSWORD_RESET_UNAVAILABLE/);
  assert.equal(passwordRecoveryDeliveryAvailable(), false);
  assert.match(recovery, /The callback is registered only when RESEND_API_KEY and RESEND_FROM_EMAIL/);
  assert.doesNotMatch(server, /sendResetPassword/);
  assert.match(server, /autoSignIn stays false/);
  assert.equal(emailAndPasswordAuthOptions.autoSignIn, false);
  assert.doesNotMatch(home, /href="\/login"|to="\/login"|href="\/app"|href="\/owner"|href="\/ops"|href="\/book"/);
  assert.match(app, /if \(!session\.ok\) throw redirect\(\{ to: "\/login" \}\)/);
  assert.match(readFileSync(join(root, "src/routes/app.index.tsx"), "utf8"), /to: "\/app\/onboarding"/);
});
