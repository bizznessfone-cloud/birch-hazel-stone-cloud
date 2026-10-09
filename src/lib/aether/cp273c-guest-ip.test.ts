/**
 * CP27.3c — guest booking client IP and limiter failure policy.
 * No migration. No auth server. Trusted proxies exist only inside this test.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { authRateLimitIdentity } from "../auth/perimeter.ts";
import { BookingError, type BookingDb, type CreateBookingInput } from "./booking.ts";
import { applyCp14LiveCatalog } from "./cp14-fixture.ts";
import {
  CLIENT_IP_HEADERS,
  ClientIpConfigError,
  NO_TRUSTED_CLIENT_IP,
  guestLimiterIdentity,
} from "./client-ip.ts";
import { createLimitedGuestBooking } from "./guest-create.ts";
import {
  GUEST_CREATE_LIMIT,
  assertGuestCreateRateLimit,
  hashGuestClientKey,
} from "./guest-rate-limit.ts";

const PROXY = "192.0.2.10";
const PROXY_ENV = { BETTER_AUTH_TRUSTED_PROXIES: PROXY };
const PRODUCTION_ENV = { VERCEL_ENV: "production", NODE_ENV: "production" };
const DEV_ENV = { NODE_ENV: "test" };

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

function input(extra: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    hotelCode: "gate",
    destinationId: "00000000-0000-4000-8000-000000000099",
    transferDate: "2026-01-15",
    pickupTime: "09:00",
    durationMinutes: 60,
    guestName: "Ada Guest",
    guestPhone: "+302101234567",
    guestEmail: "ada@example.com",
    passengerCount: 1,
    luggageCount: 0,
    pickupText: "Lobby",
    destinationText: "Airport",
    ...extra,
  };
}

function attemptDb() {
  const rows: { key: string; at: string }[] = [];
  const db = {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const key = String(params[0] ?? "");
      if (text.includes("delete from")) {
        const since = String(params[1]);
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i]?.key === key && rows[i]!.at < since) rows.splice(i, 1);
        }
        return [];
      }
      if (text.includes("count(*)")) {
        const since = String(params[1]);
        const n = rows.filter((row) => row.key === key && row.at >= since).length;
        return [{ n } as T];
      }
      if (text.includes("insert into")) {
        rows.push({ key, at: String(params[1]) });
        return [];
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };
  return db;
}

test("forged leftmost XFF is not the guest limiter identity", () => {
  const forged = headers({
    "x-forwarded-for": `198.51.100.9, 203.0.113.10, ${PROXY}`,
  });
  const identity = guestLimiterIdentity(forged, PROXY_ENV);
  assert.equal(identity, "203.0.113.10");
  assert.notEqual(identity, "198.51.100.9");

  const request = new Request("https://scan-book-go.vercel.app/book", { headers: forged });
  const auth = authRateLimitIdentity(
    request,
    { ipAddressHeaders: [...CLIENT_IP_HEADERS], trustedProxies: [PROXY] },
    "/book",
  );
  assert.equal(auth.ip, identity);
});

test("two clients behind one trusted edge do not share a guest identity", () => {
  const a = guestLimiterIdentity(
    headers({ "x-forwarded-for": `203.0.113.10, ${PROXY}` }),
    PROXY_ENV,
  );
  const b = guestLimiterIdentity(
    headers({ "x-forwarded-for": `203.0.113.11, ${PROXY}` }),
    PROXY_ENV,
  );
  assert.equal(a, "203.0.113.10");
  assert.equal(b, "203.0.113.11");
  assert.notEqual(hashGuestClientKey(a), hashGuestClientKey(b));
});

test("platform headers beat a forged X-Forwarded-For chain", () => {
  const vercel = guestLimiterIdentity(
    headers({
      "x-vercel-forwarded-for": "203.0.113.77",
      "x-forwarded-for": "198.51.100.99, 203.0.113.50",
    }),
    {},
  );
  assert.equal(vercel, "203.0.113.77");

  const real = guestLimiterIdentity(
    headers({
      "x-real-ip": "203.0.113.80",
      "x-forwarded-for": "198.51.100.1, 203.0.113.2",
    }),
    {},
  );
  assert.equal(real, "203.0.113.80");
});

test("malformed forwarding does not become an attacker-selected limiter key", () => {
  const malformed = guestLimiterIdentity(
    headers({ "x-forwarded-for": `not-an-ip, ${PROXY}` }),
    PROXY_ENV,
  );
  assert.equal(malformed, NO_TRUSTED_CLIENT_IP);

  const multi = guestLimiterIdentity(
    headers({ "x-forwarded-for": "198.51.100.9, 203.0.113.10" }),
    {},
  );
  assert.equal(multi, NO_TRUSTED_CLIENT_IP);
  assert.notEqual(multi, "198.51.100.9");
});

test("missing client IP uses one stable fallback bucket", () => {
  const missing = guestLimiterIdentity(null, {});
  const empty = guestLimiterIdentity(headers({ "x-forwarded-for": "   " }), {});
  assert.equal(missing, NO_TRUSTED_CLIENT_IP);
  assert.equal(empty, NO_TRUSTED_CLIENT_IP);
  assert.equal(hashGuestClientKey(missing), hashGuestClientKey(empty));
});

test("invalid trusted proxies fail closed and do not select the leftmost hop", () => {
  assert.throws(
    () =>
      guestLimiterIdentity(headers({ "x-forwarded-for": "198.51.100.9" }), {
        BETTER_AUTH_TRUSTED_PROXIES: "not-a-proxy",
      }),
    (err: unknown) => err instanceof ClientIpConfigError && /invalid IP or CIDR/.test(err.message),
  );
});

test("one resolved client hits the guest limit and another does not", async () => {
  const db = attemptDb();
  const keyA = hashGuestClientKey(
    guestLimiterIdentity(headers({ "x-forwarded-for": `203.0.113.10, ${PROXY}` }), PROXY_ENV),
  );
  const keyB = hashGuestClientKey(
    guestLimiterIdentity(headers({ "x-forwarded-for": `203.0.113.11, ${PROXY}` }), PROXY_ENV),
  );
  const shared = hashGuestClientKey(guestLimiterIdentity(null, {}));
  const t0 = new Date("2026-06-01T12:00:00.000Z");
  for (let i = 0; i < GUEST_CREATE_LIMIT; i += 1) {
    await assertGuestCreateRateLimit(db, keyA, new Date(t0.getTime() + i * 1000));
  }
  await assert.rejects(
    () => assertGuestCreateRateLimit(db, keyA, new Date(t0.getTime() + 60_000)),
    (err: unknown) =>
      err instanceof BookingError && err.code === "rate_limited" && err.status === 429,
  );
  await assertGuestCreateRateLimit(db, keyB, t0);
  await assertGuestCreateRateLimit(db, shared, t0);
  await assertGuestCreateRateLimit(db, shared, new Date(t0.getTime() + 1000));
});

test("production limiter storage failure does not create a booking or leak SQL", async () => {
  const secret = "relation public_booking_attempts does not exist DETAIL secret-cp273c";
  let transactions = 0;
  const db: BookingDb = {
    async query() {
      throw new Error(secret);
    },
    async transaction() {
      transactions += 1;
      throw new Error("engine reached");
    },
  };
  await assert.rejects(
    () => createLimitedGuestBooking(db, input(), "203.0.113.10", PRODUCTION_ENV),
    (err: unknown) => {
      assert.ok(err instanceof BookingError);
      assert.equal(err.code, "rate_limited");
      assert.equal(err.status, 503);
      assert.equal(err.message, "Booking attempts are temporarily unavailable");
      assert.doesNotMatch(String(err.message), /secret-cp273c|public_booking_attempts/);
      return true;
    },
  );
  assert.equal(transactions, 0);
});

test("development limiter storage failure stays fail-open and is not rewritten as rate_limited", async () => {
  let engineQueries = 0;
  const db: BookingDb = {
    async query(text: string) {
      if (text.includes("public_booking_attempts")) throw new Error("limiter table missing");
      engineQueries += 1;
      throw new Error("engine reached");
    },
    async transaction() {
      throw new Error("transaction reached");
    },
  };
  await assert.rejects(
    () => createLimitedGuestBooking(db, input(), "203.0.113.10", DEV_ENV),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "engine reached");
      assert.ok(!(err instanceof BookingError));
      return true;
    },
  );
  assert.equal(engineQueries, 1);
});

test("a request under the limit commits the booking and email failure does not roll it back", async () => {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  for (const name of [
    "0002_foundation.sql",
    "0003_occupancy.sql",
    "0004_ops_auth.sql",
    "0005_time_domain.sql",
    "0006_booking_engine.sql",
    "0008_guest_ux.sql",
    "0010_hotel_white_label.sql",
    "0012_cp12_tenancy.sql",
  ]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  await pg.exec(
    `create table public_booking_attempts (
       id uuid primary key default gen_random_uuid(),
       client_key text not null,
       attempted_at timestamptz not null default now()
     )`,
  );
  const destinationIdByCode = await applyCp14LiveCatalog(pg);
  const db: BookingDb = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner: BookingDb = {
          query: async <R>(text: string, params?: unknown[]) => (await tx.query<R>(text, params)).rows,
          transaction() {
            throw new Error("nested");
          },
        };
        return fn(inner);
      });
    },
  };
  const hint = "203.0.113.10";
  const first = await createLimitedGuestBooking(
    db,
    input({ destinationId: destinationIdByCode.gate!, idempotencyKey: "cp273c-1" }),
    hint,
    DEV_ENV,
  );
  assert.equal(first.confirmationEmailStatus, "not_configured");
  assert.equal(first.hotelCode, "gate");

  const previousFetch = globalThis.fetch;
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.RESEND_FROM_EMAIL;
  process.env.RESEND_API_KEY = "re_test_cp273c";
  process.env.RESEND_FROM_EMAIL = "bookings@example.com";
  globalThis.fetch = (async () => {
    throw new Error("resend down");
  }) as typeof fetch;
  try {
    const second = await createLimitedGuestBooking(
      db,
      input({
        destinationId: destinationIdByCode.gate!,
        pickupTime: "11:00",
        idempotencyKey: "cp273c-2",
      }),
      hint,
      DEV_ENV,
    );
    assert.equal(second.confirmationEmailStatus, "failed");
    assert.notEqual(second.confirmationToken, first.confirmationToken);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = previousFrom;
  }

  const bookings = await pg.query<{ n: number }>("select count(*)::int as n from bookings");
  const attempts = await pg.query<{ n: number }>(
    "select count(*)::int as n from public_booking_attempts where client_key = $1",
    [hashGuestClientKey(hint)],
  );
  assert.equal(bookings.rows[0]?.n, 2);
  assert.equal(attempts.rows[0]?.n, 2);

  await pg.exec("drop table public_booking_attempts");
  await assert.rejects(
    () =>
      createLimitedGuestBooking(
        db,
        input({
          destinationId: destinationIdByCode.gate!,
          pickupTime: "13:00",
          idempotencyKey: "cp273c-3",
        }),
        hint,
        PRODUCTION_ENV,
      ),
    (err: unknown) =>
      err instanceof BookingError &&
      err.status === 503 &&
      err.message === "Booking attempts are temporarily unavailable",
  );
  const afterFailure = await pg.query<{ n: number }>("select count(*)::int as n from bookings");
  assert.equal(afterFailure.rows[0]?.n, 2);
  await pg.close();
});

test("guest booking source does not trust the leftmost XFF hop", () => {
  const root = process.cwd();
  const booking = readFileSync(`${root}/src/lib/aether/booking.server.ts`, "utf8");
  const create = readFileSync(`${root}/src/lib/aether/guest-create.ts`, "utf8");
  const ip = readFileSync(`${root}/src/lib/aether/client-ip.ts`, "utf8");
  assert.match(booking, /guestLimiterIdentity/);
  assert.match(booking, /createLimitedGuestBooking/);
  assert.doesNotMatch(booking, /split\(","\)\[0\]/);
  assert.doesNotMatch(booking, /better-auth/);
  assert.doesNotMatch(booking, /lib\/auth\/server/);
  const body = create.slice(create.indexOf("export async function createLimitedGuestBooking"));
  assert.match(body, /assertGuestCreateRateLimit/);
  assert.ok(body.indexOf("assertGuestCreateRateLimit") < body.indexOf("createBookingEngine("));
  assert.ok(body.indexOf("createBookingEngine(") < body.indexOf("sendConfirmationEmail"));
  assert.match(ip, /getIPFromHeader/);
  assert.match(ip, /x-vercel-forwarded-for/);
  const preflight = readFileSync(`${root}/scripts/production-db-preflight.mjs`, "utf8");
  assert.match(preflight, /0031_cp3005e2c_organisation_type\.sql/);
  assert.match(preflight, /0032_cp3005e2c1_organisation_acceptance\.sql/);
  assert.doesNotMatch(preflight, /0031_cp273a/);
});
