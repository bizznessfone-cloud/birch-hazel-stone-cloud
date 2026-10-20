/**
 * Fail closed for capacity events on the application webhook.
 *
 * The isolated gateway is not mounted here. A capacity Checkout event must
 * not be acknowledged with HTTP 200, because sbg_apply_payment_event returns
 * false without storing the event id and Stripe then stops retrying.
 *
 * Stripe retries a non-2xx response for about three days and then abandons
 * it. Before this latch is removed, the isolated endpoint has to be the
 * Checkout subscriber, and any event Stripe has already given up on has to
 * be resent. This module does not call admission and does not open Checkout.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CapacityLatchUnavailable extends Error {
  readonly code = "capacity_latch_unavailable" as const;

  constructor() {
    super("Capacity payment classification is unavailable.");
    this.name = "CapacityLatchUnavailable";
  }
}

type LatchDb = {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
};

export async function capacityWebhookLatch(
  db: LatchDb,
  bookingId: string | null,
): Promise<"legacy" | "fail_closed" | "unproven"> {
  if (!bookingId || !UUID_RE.test(bookingId)) return "legacy";
  let present: { present: boolean }[];
  try {
    present = await db.query<{ present: boolean }>(
      `select exists (
         select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'bookings'
            and column_name = 'capacity_managed'
       ) as present`,
    );
  } catch {
    throw new CapacityLatchUnavailable();
  }
  if (present[0]?.present !== true) return "legacy";
  let rows: { capacity_managed: boolean }[];
  try {
    rows = await db.query<{ capacity_managed: boolean }>(
      `select capacity_managed from bookings where id = $1::uuid`,
      [bookingId],
    );
  } catch {
    throw new CapacityLatchUnavailable();
  }
  if (!rows[0]) return "unproven";
  return rows[0].capacity_managed === true ? "fail_closed" : "legacy";
}
