/** Gate 2 isolated service. Only call from an authenticated server wrapper.
 * Database 0035/0036 owns agreement, classification, billing and uniqueness gates.
 * Never call against production until migrations and legal approvals are authorised.
 */
import type { Sql } from "@/lib/db";
import { validateFoundingPropertyDraft, type FoundingPropertyDraft } from "./founding-property-draft.ts";
export type FoundingPropertyInput = FoundingPropertyDraft & {
  ianaTimezone: string;
  currency: string;
};
export async function createFoundingProperty(input: {
  db: Pick<Sql, "query">;
  userId: string | null | undefined;
  property: FoundingPropertyInput;
}): Promise<{ hotelId: string; providerId: string }> {
  if (!input.userId?.trim()) throw new Error("Unauthorized");
  if (Object.keys(validateFoundingPropertyDraft(input.property)).length) {
    throw new Error("Invalid property details");
  }
  if (!/^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(input.property.ianaTimezone)) {
    throw new Error("Invalid timezone");
  }
  if (!/^[A-Z]{3}$/.test(input.property.currency)) throw new Error("Invalid currency");
  const rows = await input.db.query<{ hotel_id: string; provider_id: string }>(
    "select hotel_id::text as hotel_id, provider_id::text as provider_id from sbg_create_founding_property_for_user($1, $2, $3, $4, $5, $6)",
    [input.userId, input.property.code.trim(), input.property.name.trim(),
      input.property.locality.trim(), input.property.ianaTimezone, input.property.currency],
  );
  if (rows.length !== 1 || !rows[0]?.hotel_id || !rows[0]?.provider_id) {
    throw new Error("Founding property was not created");
  }
  return { hotelId: rows[0].hotel_id, providerId: rows[0].provider_id };
}
