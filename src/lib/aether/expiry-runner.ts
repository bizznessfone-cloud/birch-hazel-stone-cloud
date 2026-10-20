/**
 * Restricted expiry invocation. Not scheduled and not mounted.
 *
 * The caller must already be connected as aether_expiry_runner. This module
 * does not open a database connection, does not read application credentials,
 * and does not confirm a payment.
 *
 * Production cadence, once a later approval adds a schedule: at least once
 * a minute. A 30-minute capacity hold can stay occupied for at most one
 * missed interval after hold_expires_at. The function is idempotent. A second
 * call returns no rows. It skips paid and received_after_expiry rows.
 *
 * Monitoring is a non-zero exit from the invoker plus an owner-plane count of
 * capacity rows still awaiting payment or processing with hold_expires_at in
 * the past. Recovery is to invoke again. A missed run does not require a
 * schema change. Stripe session expiry is not a substitute.
 */

import { expireProvisionalHolds, type ExpiredHold, type HoldDb } from "./provisional-hold.ts";

export async function runExpiryWorker(db: HoldDb, limit = 100): Promise<ExpiredHold[]> {
  return expireProvisionalHolds(db, limit);
}
