/**
 * CP26 FINALISATION — property-licence quantity and entitlement policy.
 * Self-service quantity is 1–49. 50+ is Enterprise / contact, not a second product.
 * No monetary amount lives here.
 */
import { isSaasEntitled, parseBillingStatus } from "./saas-lifecycle.ts";

export const PROPERTY_LICENCE_PLAN = "property_licence" as const;
export const HISTORICAL_PLAN_CODES = ["basic", "pro", "premium"] as const;
export const SELF_SERVICE_LICENCE_MIN = 1;
export const SELF_SERVICE_LICENCE_MAX = 49;

export class PropertyLicenceQuantityError extends Error {
  readonly code = "quantity_unauthorised" as const;
  constructor(message = "Property licence quantity is not authorised.") {
    super(message);
    this.name = "PropertyLicenceQuantityError";
  }
}

/** Server authority. Rejects strings, floats, and quantities outside 1–49. */
export function authorisePropertyLicenceQuantity(quantity: unknown): number {
  if (typeof quantity !== "number" || !Number.isInteger(quantity)) {
    throw new PropertyLicenceQuantityError("Property licence quantity must be a whole number.");
  }
  if (quantity < SELF_SERVICE_LICENCE_MIN || quantity > SELF_SERVICE_LICENCE_MAX) {
    throw new PropertyLicenceQuantityError(
      `Self-service property licences are ${SELF_SERVICE_LICENCE_MIN}–${SELF_SERVICE_LICENCE_MAX}.`,
    );
  }
  return quantity;
}

export function isHistoricalPlanCode(code: string): boolean {
  return (HISTORICAL_PLAN_CODES as readonly string[]).includes(code);
}

/**
 * A property is entitled only when it holds an active allocation against an
 * entitled organisation subscription. Organisation membership, organisation_id
 * alone, and user counts do not consume or grant a licence.
 */
export function propertyHasDomainAEntitlement(input: {
  organisationId: string | null;
  allocationActive: boolean;
  subscriptionStatus: string | null;
}): boolean {
  if (!input.organisationId || !input.allocationActive) return false;
  return isSaasEntitled(parseBillingStatus(input.subscriptionStatus));
}
