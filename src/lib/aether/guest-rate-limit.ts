/**
 * Public booking-create rate limit. SQL-backed, no Redis.
 *
 * - Counts per hashed client key in PostgreSQL. Shared across isolates that
 *   share the database. Not an edge/WAF limiter.
 * - Production limiter/storage failures fail closed. A missing table or
 *   statement error must not turn guest create into an unlimited endpoint.
 * - Development and test stay fail-open so a local schema gap does not block
 *   the booking engine. Ordinary booking errors are outside this catch.
 * - Multi-region / disconnected replicas are not coordinated here.
 * - Tenant isolation is not a substitute for this limiter.
 */
import { createHash } from "node:crypto";
import { BookingError } from "./booking.ts";
import { isProductionRuntime, type EnvMap } from "./runtime-config.ts";

export const GUEST_CREATE_LIMIT = 20;
export const GUEST_CREATE_WINDOW_MS = 10 * 60 * 1000;

export type RateLimitDb = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export function hashGuestClientKey(raw: string): string {
  const value = raw.trim() || "unknown";
  return createHash("sha256").update(`aether-guest-create:${value}`).digest("hex");
}

function limiterUnavailable(): BookingError {
  return new BookingError(
    "rate_limited",
    503,
    "Booking attempts are temporarily unavailable",
  );
}

export async function assertGuestCreateRateLimit(
  db: RateLimitDb,
  clientKey: string,
  now: Date = new Date(),
  env: EnvMap = process.env,
): Promise<void> {
  const key = clientKey.trim();
  if (!key) {
    if (isProductionRuntime(env)) throw limiterUnavailable();
    return;
  }
  const since = new Date(now.getTime() - GUEST_CREATE_WINDOW_MS);
  try {
    await db.query(
      `delete from public_booking_attempts
        where client_key = $1 and attempted_at < $2`,
      [key, since.toISOString()],
    );
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n
         from public_booking_attempts
        where client_key = $1 and attempted_at >= $2`,
      [key, since.toISOString()],
    );
    const n = rows[0]?.n ?? 0;
    if (n >= GUEST_CREATE_LIMIT) {
      throw new BookingError("rate_limited", 429, "Too many booking attempts");
    }
    await db.query(
      `insert into public_booking_attempts (client_key, attempted_at)
       values ($1, $2)`,
      [key, now.toISOString()],
    );
  } catch (err) {
    if (err instanceof BookingError) throw err;
    if (isProductionRuntime(env)) throw limiterUnavailable();
  }
}