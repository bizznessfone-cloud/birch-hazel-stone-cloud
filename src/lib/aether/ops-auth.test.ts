import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  THROTTLE_MAX_FAILURES,
  type AuthEnv,
  type CookieJar,
  type CookieOpts,
  type OpsDb,
  OpsAuthError,
  createOperator,
  hashPassword,
  loginOperator,
  logoutOperator,
  requireOps,
  verifyPassword,
} from "./ops-auth.ts";

const FOUNDATION_SQL = readFileSync(
  new URL("../../../migrations/0002_foundation.sql", import.meta.url),
  "utf8",
);
const OCCUPANCY_SQL = readFileSync(
  new URL("../../../migrations/0003_occupancy.sql", import.meta.url),
  "utf8",
);
const AUTH_SQL = readFileSync(
  new URL("../../../migrations/0004_ops_auth.sql", import.meta.url),
  "utf8",
);

const FAST_SCRYPT = { N: 16, r: 8, p: 1 };

type StoredCookie = { value: string; options: CookieOpts };

function memoryJar(): CookieJar & { store: Map<string, StoredCookie> } {
  const store = new Map<string, StoredCookie>();
  return {
    store,
    get: (name) => store.get(name)?.value,
    set: (name, value, options) => {
      store.set(name, { value, options });
    },
    delete: (name) => {
      store.delete(name);
    },
  };
}

function headersFrom(jar: CookieJar): { get(name: string): string | null } {
  return {
    get(name) {
      if (name.toLowerCase() === CSRF_HEADER) {
        return jar.get(CSRF_COOKIE) ?? null;
      }
      return null;
    },
  };
}

async function openDb(): Promise<{ db: OpsDb; close: () => Promise<void> }> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  await pg.exec(FOUNDATION_SQL);
  await pg.exec(OCCUPANCY_SQL);
  await pg.exec(AUTH_SQL);
  const db: OpsDb = {
    async query<T>(text: string, params?: unknown[]) {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
  return { db, close: () => pg.close() };
}

function envFor(db: OpsDb, jar: CookieJar, extra?: Partial<AuthEnv>): AuthEnv {
  return {
    db,
    cookies: jar,
    headers: extra?.headers ?? headersFrom(jar),
    cookieSecure: extra?.cookieSecure ?? false,
    now: extra?.now,
  };
}

async function expectCode(fn: () => Promise<unknown>, code: OpsAuthError["code"]) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof OpsAuthError, `expected OpsAuthError, got ${err}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected ${code}`);
}

describe("Phase 2 operator authentication", () => {
  test("scrypt hash verifies and rejects a wrong password", async () => {
    const stored = await hashPassword("correct-horse", FAST_SCRYPT);
    assert.match(stored, /^scrypt\$16\$8\$1\$/);
    assert.equal(await verifyPassword("correct-horse", stored), true);
    assert.equal(await verifyPassword("wrong", stored), false);
  });

  test("unauthenticated requireOps fails", async () => {
    const { db, close } = await openDb();
    const jar = memoryJar();
    await expectCode(() => requireOps(envFor(db, jar), { csrf: true }), "unauthenticated");
    await expectCode(
      () => requireOps(envFor(db, jar), { csrf: false }),
      "unauthenticated",
    );
    await close();
  });

  test("login sets HttpOnly session cookie and non-HttpOnly CSRF cookie", async () => {
    const { db, close } = await openDb();
    await createOperator(db, "Ops", "secret-pass", FAST_SCRYPT);
    const jar = memoryJar();
    const result = await loginOperator(envFor(db, jar, { cookieSecure: true }), "ops", "secret-pass");

    assert.equal(result.login, "ops");
    assert.equal("sessionToken" in result, false);
    assert.equal("token" in result, false);

    const session = jar.store.get(SESSION_COOKIE);
    const csrf = jar.store.get(CSRF_COOKIE);
    assert.ok(session);
    assert.ok(csrf);
    assert.equal(session.options.httpOnly, true);
    assert.equal(session.options.secure, true);
    assert.equal(session.options.sameSite, "lax");
    assert.equal(session.options.path, "/");
    assert.equal(csrf.options.httpOnly, false);
    assert.equal(csrf.options.secure, true);
    assert.equal(csrf.options.sameSite, "lax");
    assert.notEqual(session.value, csrf.value);
    await close();
  });

  test("authenticated ops mutation succeeds; CSRF is required", async () => {
    const { db, close } = await openDb();
    await createOperator(db, "ops", "secret-pass", FAST_SCRYPT);
    const jar = memoryJar();
    await loginOperator(envFor(db, jar), "ops", "secret-pass");

    const ok = await requireOps(envFor(db, jar), { csrf: true });
    assert.equal(ok.login, "ops");

    await expectCode(
      () =>
        requireOps(
          envFor(db, jar, { headers: { get: () => null } }),
          { csrf: true },
        ),
      "csrf",
    );
    await expectCode(
      () =>
        requireOps(
          envFor(db, jar, {
            headers: { get: () => "forged-csrf-token-value-not-real" },
          }),
          { csrf: true },
        ),
      "csrf",
    );
    await close();
  });

  test("logout revokes the session", async () => {
    const { db, close } = await openDb();
    await createOperator(db, "ops", "secret-pass", FAST_SCRYPT);
    const jar = memoryJar();
    await loginOperator(envFor(db, jar), "ops", "secret-pass");
    const token = jar.get(SESSION_COOKIE);
    assert.ok(token);

    await logoutOperator(envFor(db, jar));
    assert.equal(jar.get(SESSION_COOKIE), undefined);
    assert.equal(jar.get(CSRF_COOKIE), undefined);

    const replay = memoryJar();
    replay.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: 1,
    });
    await expectCode(
      () => requireOps(envFor(db, replay), { csrf: false }),
      "unauthenticated",
    );
    await close();
  });

  test("logout without a valid CSRF token is rejected", async () => {
    const { db, close } = await openDb();
    await createOperator(db, "ops", "secret-pass", FAST_SCRYPT);
    const jar = memoryJar();
    await loginOperator(envFor(db, jar), "ops", "secret-pass");
    await expectCode(
      () =>
        logoutOperator(envFor(db, jar, { headers: { get: () => null } })),
      "csrf",
    );
    assert.ok(jar.get(SESSION_COOKIE));
    const still = await requireOps(envFor(db, jar), { csrf: false });
    assert.equal(still.login, "ops");
    await close();
  });

  test("expired session is rejected", async () => {
    const { db, close } = await openDb();
    await createOperator(db, "ops", "secret-pass", FAST_SCRYPT);
    const jar = memoryJar();
    const start = new Date("2026-01-01T00:00:00.000Z");
    await loginOperator(envFor(db, jar, { now: start }), "ops", "secret-pass");
    const later = new Date(start.getTime() + SESSION_TTL_MS + 1000);
    await expectCode(
      () => requireOps(envFor(db, jar, { now: later }), { csrf: true }),
      "unauthenticated",
    );
    await close();
  });

  test("login throttling locks after too many failures", async () => {
    const { db, close } = await openDb();
    await createOperator(db, "ops", "secret-pass", FAST_SCRYPT);
    const jar = memoryJar();
    const t0 = new Date("2026-02-01T00:00:00.000Z");

    for (let i = 0; i < THROTTLE_MAX_FAILURES; i += 1) {
      await expectCode(
        () =>
          loginOperator(
            envFor(db, jar, { now: new Date(t0.getTime() + i * 1000) }),
            "ops",
            "wrong-password",
          ),
        "invalid_credentials",
      );
    }

    await expectCode(
      () =>
        loginOperator(
          envFor(db, jar, {
            now: new Date(t0.getTime() + THROTTLE_MAX_FAILURES * 1000),
          }),
          "ops",
          "secret-pass",
        ),
      "throttled",
    );
    await close();
  });

  test("unknown login and wrong password share the same error", async () => {
    const { db, close } = await openDb();
    await createOperator(db, "ops", "secret-pass", FAST_SCRYPT);
    const jar = memoryJar();
    const missing = await expectCode(
      () => loginOperator(envFor(db, jar), "nobody", "secret-pass"),
      "invalid_credentials",
    );
    const wrong = await expectCode(
      () => loginOperator(envFor(db, jar), "ops", "nope"),
      "invalid_credentials",
    );
    assert.equal(missing.message, wrong.message);
    await close();
  });

  test("GET requireOps without CSRF still needs a session", async () => {
    const { db, close } = await openDb();
    await createOperator(db, "ops", "secret-pass", FAST_SCRYPT);
    const jar = memoryJar();
    await loginOperator(envFor(db, jar), "ops", "secret-pass");
    const me = await requireOps(
      envFor(db, jar, { headers: { get: () => null } }),
      { csrf: false },
    );
    assert.equal(me.login, "ops");
    await close();
  });

  test("ops-fns never return a session token and public health stays open", async () => {
    const fns = readFileSync(new URL("./ops-fns.ts", import.meta.url), "utf8");
    assert.match(fns, /requireOps\(\{ csrf: true \}\)/);
    assert.match(fns, /loginOperatorFromRequest/);
    assert.doesNotMatch(fns, /sessionToken/);
    assert.doesNotMatch(fns, /localStorage/);
    assert.doesNotMatch(fns, /sessionStorage/);

    const health = readFileSync(new URL("./health.ts", import.meta.url), "utf8");
    assert.doesNotMatch(health, /requireOps/);
    assert.doesNotMatch(health, /opsLogin/);
  });
});
