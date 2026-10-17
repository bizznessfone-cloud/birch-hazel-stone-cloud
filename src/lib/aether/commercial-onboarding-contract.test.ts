import assert from "node:assert/strict";
import { test } from "node:test";
import { commercialOnboardingDecision } from "./commercial-onboarding-contract.ts";
for (const organisationType of ["hotel", "transfer_operator"] as const) {
  test(`${organisationType} uses the same licence progression without live activation`, () => {
    assert.equal(commercialOnboardingDecision({
      organisationExists: true, organisationType, approvedAgreementAccepted: false,
      accessiblePropertyCount: 1, propertyAccessVerified: true,
    }).status, "agreement_required");
    assert.deepEqual(commercialOnboardingDecision({
      organisationExists: true, organisationType, approvedAgreementAccepted: true,
      accessiblePropertyCount: 3, propertyAccessVerified: true,
    }), { status: "billing_verification_required", organisationType, accessiblePropertyCount: 3, canActivate: false });
    assert.equal(commercialOnboardingDecision({
      organisationExists: true, organisationType, approvedAgreementAccepted: true,
      accessiblePropertyCount: 0, propertyAccessVerified: false,
    }).status, "property_access_required");
  });
}
test("unknown, unclassified and invalid property quantities fail closed", () => {
  assert.equal(commercialOnboardingDecision({
    organisationExists: false, organisationType: null, approvedAgreementAccepted: false,
    accessiblePropertyCount: 0, propertyAccessVerified: false,
  }).status, "organisation_required");
  assert.equal(commercialOnboardingDecision({
    organisationExists: true, organisationType: null, approvedAgreementAccepted: true,
    accessiblePropertyCount: 1, propertyAccessVerified: true,
  }).status, "classification_required");
  assert.equal(commercialOnboardingDecision({
    organisationExists: true, organisationType: "hotel", approvedAgreementAccepted: true,
    accessiblePropertyCount: -1, propertyAccessVerified: true,
  }).status, "unavailable");
});
