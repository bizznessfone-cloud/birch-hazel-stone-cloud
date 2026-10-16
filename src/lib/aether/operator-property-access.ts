/** Gate 2 operator access policy.
 * An operator's founding organisation is not a hotel and does not confer
 * rights over any hotel merely because the operator names or serves it.
 * Future provisioning must check a persisted, active hotel/operator grant.
 */
export type OperatorPropertyGrant = {
  operatorOrganisationId: string;
  hotelId: string;
  active: boolean;
};

export function canOperatorAccessProperty(input: {
  authenticatedOperatorOrganisationId: string | null | undefined;
  hotelId: string | null | undefined;
  grants: readonly OperatorPropertyGrant[];
}): boolean {
  const organisationId = input.authenticatedOperatorOrganisationId?.trim();
  const hotelId = input.hotelId?.trim();
  if (!organisationId || !hotelId) return false;
  return input.grants.some(grant =>
    grant.active === true &&
    grant.operatorOrganisationId === organisationId &&
    grant.hotelId === hotelId,
  );
}

/** Operator classification alone cannot activate an operator workspace. */
export function operatorWorkspaceStatus(input: {
  organisationType: "hotel" | "transfer_operator" | null;
  authorisedPropertyCount: number;
  agreementApproved: boolean;
}): "unavailable" | "agreement_required" | "property_grant_required" | "ready" {
  if (input.organisationType !== "transfer_operator") return "unavailable";
  if (!input.agreementApproved) return "agreement_required";
  if (!Number.isSafeInteger(input.authorisedPropertyCount) || input.authorisedPropertyCount <= 0) {
    return "property_grant_required";
  }
  return "ready";
}
