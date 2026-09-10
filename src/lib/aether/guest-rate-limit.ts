/**
 * Public booking-create rate limit. SQL-backed, no Redis.
 *
 * Limitations (future production hardening, not CP12B):
 * - Counts per hashed client key in PostgreSQL. Shared across isolates that
 *   share the database. Not an edge/WAF limiter.
 * - Fail-open if the limiter table is missing or the statement errors, so a
 *   limiter outage cannot block legitimate guests.
 * - Multi-region / disconnected replicas are not coordinated here.
 * - Tenant isolation is not a substitute for this limiter.
 */
import { createHash } from "node:crypto";
import { BookingError } from "./booking.ts";

export const GUEST_CREATE_LIMIT = 20;
export const GUEST_CREATE_WINDOW_MS = 10 * 60 * 1000;

export type RateLimitDb = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export function hashGuestClientKey(raw: string): string {
  const value = raw.trim() || "unknown";
  return createHash("sha256").update(`aether-guest-create:${value}`).digest("hex");
}

export async function assertGuestCreateRateLimit(
  db: RateLimitDb,
  clientKey: string,
  now: Date = new Date(),
): Promise<void> {
  const key = clientKey.trim();
  if (!key) return;
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
    // Fail open: limiter SQL must not take down guest create.
  }
}
