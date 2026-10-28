import assert from "node:assert/strict";
import { test } from "node:test";
import { canOperatorAccessProperty, operatorWorkspaceStatus } from "./operator-property-access.ts";

const grants = [
  { operatorOrganisationId: "operator-a", hotelId: "hotel-a", active: true },
  { operatorOrganisationId: "operator-a", hotelId: "hotel-b", active: false },
  { operatorOrganisationId: "operator-b", hotelId: "hotel-c", active: true },
] as const;

test("operator can access only a property with its own active grant", () => {
  assert.equal(canOperatorAccessProperty({ authenticatedOperatorOrganisationId: "operator-a", hotelId: "hotel-a", grants }), true);
  for (const hotelId of ["hotel-b", "hotel-c", "hotel-unknown"]) {
    assert.equal(canOperatorAccessProperty({ authenticatedOperatorOrganisationId: "operator-a", hotelId, grants }), false);
  }
  assert.equal(canOperatorAccessProperty({ authenticatedOperatorOrganisationId: null, hotelId: "hotel-a", grants }), false);
  assert.equal(canOperatorAccessProperty({ authenticatedOperatorOrganisationId: "operator-a", hotelId: "", grants }), false);
});
test("operator workspace requires type, agreement and explicit authorised property", () => {
  assert.equal(operatorWorkspaceStatus({ organisationType: "hotel", agreementApproved: true, authorisedPropertyCount: 1 }), "unavailable");
  assert.equal(operatorWorkspaceStatus({ organisationType: "transfer_operator", agreementApproved: false, authorisedPropertyCount: 1 }), "agreement_required");
  assert.equal(operatorWorkspaceStatus({ organisationType: "transfer_operator", agreementApproved: true, authorisedPropertyCount: 0 }), "property_grant_required");
  assert.equal(operatorWorkspaceStatus({ organisationType: "transfer_operator", agreementApproved: true, authorisedPropertyCount: -1 }), "property_grant_required");
  assert.equal(operatorWorkspaceStatus({ organisationType: "transfer_operator", agreementApproved: true, authorisedPropertyCount: 1 }), "ready");
});
