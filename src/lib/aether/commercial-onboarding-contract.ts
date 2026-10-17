/** Gate 2 Contract 4: one property-licence model, two organisation classifications.
 * Decision only: no Stripe checkout, billing mutation, or activation.
 */
export type LicenceOrganisationType = "hotel" | "transfer_operator";
export type CommercialOnboardingDecision =
  | { status: "organisation_required"; canActivate: false }
  | { status: "classification_required"; canActivate: false }
  | { status: "agreement_required"; organisationType: LicenceOrganisationType; canActivate: false }
  | { status: "property_access_required"; organisationType: LicenceOrganisationType; canActivate: false }
  | { status: "billing_verification_required"; organisationType: LicenceOrganisationType; accessiblePropertyCount: number; canActivate: false }
  | { status: "unavailable"; canActivate: false };
export function commercialOnboardingDecision(input: {
  organisationExists: boolean;
  organisationType: LicenceOrganisationType | null;
  approvedAgreementAccepted: boolean;
  accessiblePropertyCount: number;
  propertyAccessVerified: boolean;
}): CommercialOnboardingDecision {
  if (!input.organisationExists) return { status: "organisation_required", canActivate: false };
  if (input.organisationType !== "hotel" && input.organisationType !== "transfer_operator")
    return { status: "classification_required", canActivate: false };
  if (!input.approvedAgreementAccepted)
    return { status: "agreement_required", organisationType: input.organisationType, canActivate: false };
  if (!Number.isSafeInteger(input.accessiblePropertyCount) || input.accessiblePropertyCount < 0)
    return { status: "unavailable", canActivate: false };
  if (!input.propertyAccessVerified || input.accessiblePropertyCount === 0)
    return { status: "property_access_required", organisationType: input.organisationType, canActivate: false };
  return { status: "billing_verification_required", organisationType: input.organisationType,
    accessiblePropertyCount: input.accessiblePropertyCount, canActivate: false };
}
