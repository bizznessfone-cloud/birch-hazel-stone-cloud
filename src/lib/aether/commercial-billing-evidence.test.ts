import assert from "node:assert/strict";
import { test } from "node:test";
import { readCommercialBillingEvidence } from "./commercial-billing-evidence.ts";
const user = "founder";
test("commercial billing reader validates exact subscription and allocation evidence", async () => {
  const result = await readCommercialBillingEvidence({
    sessionUserId: user,
    db: { query: async () => [{ billing_status: "active", purchased_quantity: 3,
      allocated_quantity: 2, available_quantity: 1, allocation_integrity_ok: true }] } as any,
  });
  assert.deepEqual(result, { available: true, billingStatus: "active",
    purchasedQuantity: 3, allocatedQuantity: 2, availableQuantity: 1, allocationIntegrityOk: true });
});
test("billing reader rejects invented balances, absent session and database errors", async () => {
  for (const invalid of [
    { billing_status: "active", purchased_quantity: 1, allocated_quantity: 2, available_quantity: 1, allocation_integrity_ok: true },
    { billing_status: "unknown", purchased_quantity: 1, allocated_quantity: 0, available_quantity: 1, allocation_integrity_ok: true },
  ]) {
    assert.deepEqual(await readCommercialBillingEvidence({
      sessionUserId: user, db: { query: async () => [invalid] } as any,
    }), { available: false });
  }
  assert.deepEqual(await readCommercialBillingEvidence({
    sessionUserId: "", db: { query: async () => { throw Error("should not query"); } } as any,
  }), { available: false });
  assert.deepEqual(await readCommercialBillingEvidence({
    sessionUserId: user, db: { query: async () => { throw Error("database unavailable"); } } as any,
  }), { available: false });
});
