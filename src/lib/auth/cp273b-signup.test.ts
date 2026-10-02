/**
 * CP27.3b — signup enumeration only.
 * Does not enable verification, password reset, or shared rate-limit storage.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailAndPasswordEnabled } from "./email-password.ts";
import {
  emailAndPasswordAuthOptions,
  signUpEnumerationAfterHook,
} from "./signup-enumeration.ts";

const BASE = "http://localhost:8080";
const SECRET = "cp273b-signup-enumeration-secret-not-production";

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

function contract(text: string) {
  const body = JSON.parse(text) as {
    token: unknown;
    code?: unknown;
    message?: unknown;
    user: Record<string, unknown>;
  };
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...user } = body.user;
  return {
    token: body.token,
    code: body.code ?? null,
    message: body.message ?? null,
    keys: Object.keys(body),
    userKeys: Object.keys(body.user),
    user,
  };
}

test("unknown and existing signup share one non-session response and do not duplicate the user", async () => {
  const state = { user: [] as Row[], session: [] as Row[], account: [] as Row[], verification: [] as Row[] };
  const auth = authFor(state);
  const unknown = await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "New.User@example.com", password: "password123", name: "Operator" },
      { "x-forwarded-for": "203.0.113.10" },
    ),
  );
  assert.equal(state.user.length, 1);
  const stored = { ...state.user[0] };
  const storedAccount = { ...state.account[0] };
  const existing = await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "new.user@example.com", password: "other-password-99", name: "Operator" },
      { "x-forwarded-for": "203.0.113.11" },
    ),
  );

  assert.equal(unknown.status, 200);
  assert.equal(existing.status, 200);
  assert.deepEqual(contract(unknown.text), contract(existing.text));
  assert.equal(contract(unknown.text).token, null);
  assert.equal(contract(unknown.text).user.emailVerified, false);
  assert.equal(contract(unknown.text).user.image, null);
  assert.equal(unknown.cookies.length, 0);
  assert.equal(existing.cookies.length, 0);
  assert.equal(unknown.text.includes("token\":\""), false);
  assert.equal(existing.text.includes("USER_ALREADY_EXISTS"), false);

  const unknownBody = JSON.parse(unknown.text) as { user: { id: string } };
  const existingBody = JSON.parse(existing.text) as { user: { id: string } };
  assert.equal(state.user.length, 1);
  assert.equal(state.account.length, 1);
  assert.equal(state.session.length, 0);
  assert.equal(state.user[0]?.id, stored.id);
  assert.equal(state.user[0]?.name, stored.name);
  assert.equal(state.user[0]?.email, stored.email);
  assert.equal(state.account[0]?.password, storedAccount.password);
  assert.equal(unknownBody.user.id, stored.id);
  assert.notEqual(existingBody.user.id, stored.id);

  const attacker = await read(
    await post(
      auth,
      "/sign-in/email",
      { email: "new.user@example.com", password: "other-password-99" },
      { "x-forwarded-for": "203.0.113.12" },
    ),
  );
  assert.equal(attacker.status, 401);
  const original = await read(
    await post(
      auth,
      "/sign-in/email",
      { email: "new.user@example.com", password: "password123" },
      { "x-forwarded-for": "203.0.113.13" },
    ),
  );
  assert.equal(original.status, 200);
  assert.match(original.text, /"token":"[^"]+"/);
});

test("malformed signup still fails and is not rewritten as success", async () => {
  const state = { user: [] as Row[], session: [] as Row[], account: [] as Row[], verification: [] as Row[] };
  const auth = authFor(state);
  const badEmail = await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "not-an-email", password: "password123", name: "Operator" },
      { "x-forwarded-for": "203.0.113.20" },
    ),
  );
  const short = await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "short@example.com", password: "short", name: "Operator" },
      { "x-forwarded-for": "203.0.113.21" },
    ),
  );
  assert.equal(badEmail.status, 400);
  assert.equal(short.status, 400);
  assert.match(badEmail.text, /"message"/);
  assert.match(short.text, /"message"/);
  assert.equal(badEmail.text.includes('"token"'), false);
  assert.equal(state.user.length, 0);
});

test("signup rate limit and invalid origin stay outside the success contract", async () => {
  const state = { user: [] as Row[], session: [] as Row[], account: [] as Row[], verification: [] as Row[] };
  const auth = authFor(state);
  const statuses: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await read(
      await post(
        auth,
        "/sign-up/email",
        { email: `rl-${i}@example.com`, password: "password123", name: "Operator" },
        { "x-forwarded-for": "203.0.113.30" },
      ),
    );
    statuses.push(res.status);
  }
  const limited = await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "rl-0@example.com", password: "password123", name: "Operator" },
      { "x-forwarded-for": "203.0.113.30" },
    ),
  );
  statuses.push(limited.status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.match(limited.text, /Too many requests/);
  assert.equal(state.user.filter((user) => user.email === "rl-0@example.com").length, 1);

  const origin = await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "evil-origin@example.com", password: "password123", name: "Operator" },
      { origin: "https://evil.example", "x-forwarded-for": "203.0.113.31" },
    ),
  );
  assert.equal(origin.status, 403);
  assert.equal(state.user.some((user) => user.email === "evil-origin@example.com"), false);
});

test("sign-in and disabled password reset stay uniform", async () => {
  const state = { user: [] as Row[], session: [] as Row[], account: [] as Row[], verification: [] as Row[] };
  const auth = authFor(state);
  await read(
    await post(
      auth,
      "/sign-up/email",
      { email: "member@example.com", password: "password123", name: "Operator" },
      { "x-forwarded-for": "203.0.113.40" },
    ),
  );
  const missing = await read(
    await post(
      auth,
      "/sign-in/email",
      { email: "missing@example.com", password: "password123" },
      { "x-forwarded-for": "203.0.113.41" },
    ),
  );
  const wrong = await read(
    await post(
      auth,
      "/sign-in/email",
      { email: "member@example.com", password: "not-the-password" },
      { "x-forwarded-for": "203.0.113.42" },
    ),
  );
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(missing.text, wrong.text);

  const resetMissing = await read(
    await post(
      auth,
      "/request-password-reset",
      { email: "missing@example.com", redirectTo: `${BASE}/` },
      { "x-forwarded-for": "203.0.113.43" },
    ),
  );
  const resetExisting = await read(
    await post(
      auth,
      "/request-password-reset",
      { email: "member@example.com", redirectTo: `${BASE}/` },
      { "x-forwarded-for": "203.0.113.44" },
    ),
  );
  assert.equal(resetMissing.status, 400);
  assert.equal(resetExisting.status, 400);
  assert.equal(resetMissing.text, resetExisting.text);
  assert.match(resetMissing.text, /RESET_PASSWORD_DISABLED/);
  assert.equal(state.user.length, 1);
  assert.equal(state.user[0]?.email, "member@example.com");
});

test("server wires the enumeration options and does not enable verification or reset", () => {
  const server = readFileSync(join(process.cwd(), "src/lib/auth/server.ts"), "utf8");
  assert.match(server, /emailAndPassword: emailAndPasswordAuthOptions/);
  assert.match(server, /hooks: \{ after: signUpEnumerationAfterHook \}/);
  assert.equal(emailAndPasswordEnabled, true);
  assert.equal(emailAndPasswordAuthOptions.enabled, true);
  assert.equal(emailAndPasswordAuthOptions.autoSignIn, false);
  assert.doesNotMatch(server, /requireEmailVerification/);
  assert.doesNotMatch(server, /sendResetPassword/);
  assert.doesNotMatch(server, /storage:\s*"database"/);
});
