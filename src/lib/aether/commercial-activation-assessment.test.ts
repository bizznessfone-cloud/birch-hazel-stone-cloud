import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCommercialActivation } from "./commercial-activation-assessment.ts";
import type { CommercialOnboardingDecision } from "./commercial-onboarding-contract.ts";
import type { CommercialBillingEvidence } from "./commercial-billing-evidence.ts";

const onboarding: CommercialOnboardingDecision = {
  status: "billing_verification_required", organisationType: "transfer_operator",
  accessiblePropertyCount: 2, canActivate: false,
};
const billing: CommercialBillingEvidence = {
  available: true, billingStatus: "active", purchasedQuantity: 2,
  allocatedQuantity: 1, availableQuantity: 1, allocationIntegrityOk: true,
};
test("active paid and allocated operator remains operationally blocked", () => {
  assert.deepEqual(assessCommercialActivation({ onboarding, billing }), {
    commercialEvidenceVerified: true, operationalActivationAllowed: false, reason: "activation_gate_closed",
  });
});
test("payment, grant and agreement never independently activate operations", () => {
  const cases: Array<[CommercialOnboardingDecision, CommercialBillingEvidence, string]> = [
    [{ status: "agreement_required", organisationType: "transfer_operator", canActivate: false }, billing, "onboarding_incomplete"],
    [onboarding, { available: false }, "billing_unavailable"],
    [onboarding, { ...billing, billingStatus: "past_due" }, "subscription_not_active"],
    [onboarding, { ...billing, billingStatus: "canceled" }, "subscription_not_active"],
    [onboarding, { ...billing, allocationIntegrityOk: false }, "allocation_integrity_failed"],
    [onboarding, { ...billing, allocatedQuantity: 0, availableQuantity: 2 }, "licence_allocation_missing"],
  ];
  for (const [o, b, reason] of cases) {
    const result = assessCommercialActivation({ onboarding: o, billing: b });
    assert.equal(result.reason, reason);
    assert.equal(result.operationalActivationAllowed, false);
  }
});
test("hotel and operator share the same evidence policy", () => {
  assert.equal(assessCommercialActivation({
    onboarding: { ...onboarding, organisationType: "hotel" }, billing,
  }).operationalActivationAllowed, false);
});
