/** Contract 4: commercial evidence is never equivalent to operational activation. */
import type { CommercialBillingEvidence } from "./commercial-billing-evidence";
import type { CommercialOnboardingDecision } from "./commercial-onboarding-contract";

export type CommercialActivationAssessment = {
  commercialEvidenceVerified: boolean;
  operationalActivationAllowed: false;
  reason: "onboarding_incomplete" | "billing_unavailable" | "subscription_not_active" |
    "allocation_integrity_failed" | "licence_allocation_missing" | "activation_gate_closed";
};

/** This assessment cannot issue entitlements or authorise transfers.
 * Operational activation requires a separate, future, explicitly admitted gate.
 */
export function assessCommercialActivation(input: {
  onboarding: CommercialOnboardingDecision;
  billing: CommercialBillingEvidence;
}): CommercialActivationAssessment {
  const { onboarding, billing } = input;
  if (onboarding.status !== "billing_verification_required")
    return { commercialEvidenceVerified: false, operationalActivationAllowed: false, reason: "onboarding_incomplete" };
  if (!billing.available)
    return { commercialEvidenceVerified: false, operationalActivationAllowed: false, reason: "billing_unavailable" };
  if (billing.billingStatus !== "active")
    return { commercialEvidenceVerified: false, operationalActivationAllowed: false, reason: "subscription_not_active" };
  if (!billing.allocationIntegrityOk || billing.availableQuantity < 0)
    return { commercialEvidenceVerified: false, operationalActivationAllowed: false, reason: "allocation_integrity_failed" };
  if (billing.allocatedQuantity < 1)
    return { commercialEvidenceVerified: false, operationalActivationAllowed: false, reason: "licence_allocation_missing" };
  return { commercialEvidenceVerified: true, operationalActivationAllowed: false, reason: "activation_gate_closed" };
}
