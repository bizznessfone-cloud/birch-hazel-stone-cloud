/** Read-only commercial billing evidence; never grants entitlements or activates Stripe. */
import type { Sql } from "@/lib/db";
export type CommercialBillingEvidence =
  | { available: false }
  | { available: true; billingStatus: string; purchasedQuantity: number;
      allocatedQuantity: number; availableQuantity: number; allocationIntegrityOk: boolean };
export async function readCommercialBillingEvidence(input: {
  db: Pick<Sql, "query">; sessionUserId: string | null | undefined;
}): Promise<CommercialBillingEvidence> {
  if (!input.sessionUserId?.trim()) return { available: false };
  try {
    const rows = await input.db.query<{
      billing_status: string; purchased_quantity: number;
      allocated_quantity: number; available_quantity: number;
      allocation_integrity_ok: boolean;
    }>("select * from public.sbg_commercial_billing_evidence_for_user($1)", [input.sessionUserId]);
    if (rows.length !== 1 || !rows[0]) return { available: false };
    const r = rows[0];
    if (!["inactive","incomplete","incomplete_expired","trialing","active","past_due","paused","unpaid","canceled"].includes(r.billing_status)
      || !Number.isSafeInteger(r.purchased_quantity) || r.purchased_quantity < 0
      || !Number.isSafeInteger(r.allocated_quantity) || r.allocated_quantity < 0
      || !Number.isSafeInteger(r.available_quantity)
      || r.available_quantity !== r.purchased_quantity - r.allocated_quantity
      || typeof r.allocation_integrity_ok !== "boolean") return { available: false };
    return { available: true, billingStatus: r.billing_status,
      purchasedQuantity: r.purchased_quantity, allocatedQuantity: r.allocated_quantity,
      availableQuantity: r.available_quantity, allocationIntegrityOk: r.allocation_integrity_ok };
  } catch { return { available: false }; }
}
