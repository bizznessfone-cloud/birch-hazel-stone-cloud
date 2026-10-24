/**
 * Internal adapter for Stage B hold operations.
 * Not imported by the guest booking route, checkout, or email sender.
 * The 30-minute ceiling is provisional and is not a production approval.
 * Migration 0062 revokes aether_app execute on bulk expiry. This function is
 * not a privilege and is not a scheduler.
 */
import { PROVISIONAL_HOLD_TTL_MS, PROVISIONAL_HOLD_TTL_STATUS } from "./booking-lifecycle.ts";

export { PROVISIONAL_HOLD_TTL_STATUS };

export const MIN_PROVISIONAL_HOLD_TTL_SECONDS = 60;
export const MAX_PROVISIONAL_HOLD_TTL_SECONDS = PROVISIONAL_HOLD_TTL_MS / 1000;
export const DEFAULT_PROVISIONAL_HOLD_TTL_SECONDS = MAX_PROVISIONAL_HOLD_TTL_SECONDS;
export const MAX_EXPIRY_BATCH = 500;

export type HoldDb = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export type OpenedHold = {
  bookingId: string;
  lifecycleState: string;
  holdExpiresAt: string;
};

export type ExpiredHold = {
  bookingId: string;
  previousLifecycle: string;
  paymentStatus: string | null;
};

export function assertProvisionalHoldTtl(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < MIN_PROVISIONAL_HOLD_TTL_SECONDS || seconds > MAX_PROVISIONAL_HOLD_TTL_SECONDS) {
    throw new Error("unsafe_hold_ttl");
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function rethrowHold(err: unknown): never {
  const message = messageOf(err);
  for (const code of [
    "unsafe_hold_ttl",
    "unsafe_expiry_limit",
    "legacy_protected",
    "not_newly_created",
    "duplicate_hold",
    "incompatible_lifecycle",
    "booking_not_found",
  ]) {
    if (message.includes(code)) throw new Error(code);
  }
  throw err;
}

export async function openProvisionalHold(
  db: HoldDb,
  bookingId: string,
  ttlSeconds: number = DEFAULT_PROVISIONAL_HOLD_TTL_SECONDS,
): Promise<OpenedHold> {
  assertProvisionalHoldTtl(ttlSeconds);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) {
    throw new Error("booking_not_found");
  }
  try {
    const rows = await db.query<{
      opened_booking_id: string;
      opened_lifecycle_state: string;
      opened_hold_expires_at: string;
    }>("select * from sbg_open_provisional_hold($1::uuid, $2::integer)", [bookingId, ttlSeconds]);
    const row = rows[0];
    if (!row) throw new Error("booking_not_found");
    return {
      bookingId: row.opened_booking_id,
      lifecycleState: row.opened_lifecycle_state,
      holdExpiresAt: new Date(row.opened_hold_expires_at).toISOString(),
    };
  } catch (err) {
    rethrowHold(err);
  }
}

export async function expireProvisionalHolds(db: HoldDb, limit = 100): Promise<ExpiredHold[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPIRY_BATCH) {
    throw new Error("unsafe_expiry_limit");
  }
  try {
    const rows = await db.query<{
      expired_booking_id: string;
      previous_lifecycle: string;
      observed_payment_status: string | null;
    }>("select * from sbg_expire_provisional_holds($1::integer)", [limit]);
    return rows.map((row) => ({
      bookingId: row.expired_booking_id,
      previousLifecycle: row.previous_lifecycle,
      paymentStatus: row.observed_payment_status,
    }));
  } catch (err) {
    rethrowHold(err);
  }
}
