/**
 * CP30.05E-2C — organisation classification.
 * Not a membership role, not a hotel status, not a licence quantity.
 * Existing rows may be unclassified. Do not default them to hotel.
 */

export const ORGANISATION_TYPES = ["hotel", "transfer_operator"] as const;

export type OrganisationType = (typeof ORGANISATION_TYPES)[number];

export function isOrganisationType(value: unknown): value is OrganisationType {
  return value === "hotel" || value === "transfer_operator";
}
