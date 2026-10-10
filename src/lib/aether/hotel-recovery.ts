/**
 * CP30.05E-2D-2D A3-R — link an existing unattached hotel to the caller's
 * founding business. Does not create a property, provider, acceptance, or
 * second organisation, and does not classify unless the customer explicitly
 * chooses Hotel / Accommodation.
 */
import type { Sql } from "@/lib/db";
import { classifyFoundingOrganisation, readFoundingOnboardingState } from "./founding-onboarding.ts";
import { ensureFoundingOrganisation } from "./founding-organisation.ts";
import { ensureHotelOrganisation, HotelOrganisationError } from "./saas-billing.server.ts";

export class HotelRecoveryError extends Error {
  readonly code:
    | "not_found"
    | "attached"
    | "support"
    | "operator"
    | "name_first"
    | "confirm_hotel"
    | "elsewhere"
    | "invalid_name";

  constructor(code: HotelRecoveryError["code"], message: string) {
    super(message);
    this.name = "HotelRecoveryError";
    this.code = code;
  }
}

export type HotelRecoveryView =
  | { kind: "attached" }
  | { kind: "missing"; suggestedName: string }
  | { kind: "classify"; businessName: string }
  | { kind: "attach"; businessName: string }
  | { kind: "operator"; businessName: string }
  | { kind: "support" };

const SUPPORT = "We need to check this account before this property can be linked. Contact support. Nothing was changed.";
const OPERATOR =
  "This business is an independent transfer operator, so this property cannot be linked. The business type was not changed.";

type OwnedHotel = { name: string; organisationId: string | null };

async function ownedHotel(db: Pick<Sql, "query">, userId: string, hotelId: string): Promise<OwnedHotel> {
  const rows = await db.query<{ name: string; organisation_id: string | null }>(
    `select h.name, h.organisation_id::text as organisation_id
       from app_hotel_accounts aha
       join hotels h on h.id = aha.hotel_id
      where aha.user_id = $1 and aha.hotel_id = $2::uuid`,
    [userId, hotelId],
  );
  const hotel = rows[0];
  if (!hotel) throw new HotelRecoveryError("not_found", "Hotel not found.");
  return { name: hotel.name, organisationId: hotel.organisation_id };
}

async function businessName(db: Pick<Sql, "query">, userId: string, organisationId: string): Promise<string | null> {
  const rows = await db.query<{ name: string }>(
    `select name from sbg_organisations
      where id = $1::uuid and created_by_user_id = $2`,
    [organisationId, userId],
  );
  const name = rows[0]?.name?.trim();
  return name ? name : null;
}

async function viewForUnattached(
  db: Pick<Sql, "query">,
  userId: string,
  hotelName: string,
): Promise<HotelRecoveryView> {
  let founding;
  try {
    founding = await readFoundingOnboardingState({ db, userId });
  } catch {
    throw new HotelRecoveryError("support", SUPPORT);
  }
  if (founding.status === "missing") return { kind: "missing", suggestedName: hotelName };
  if (founding.status !== "ready") return { kind: "support" };
  const name = await businessName(db, userId, founding.organisationId);
  if (!name) return { kind: "support" };
  if (founding.organisationType === null) return { kind: "classify", businessName: name };
  if (founding.organisationType === "hotel") return { kind: "attach", businessName: name };
  return { kind: "operator", businessName: name };
}

export async function readHotelRecovery(input: {
  db: Pick<Sql, "query">;
  userId: string;
  hotelId: string;
}): Promise<HotelRecoveryView> {
  const hotel = await ownedHotel(input.db, input.userId, input.hotelId);
  if (hotel.organisationId) return { kind: "attached" };
  return viewForUnattached(input.db, input.userId, hotel.name);
}

export async function submitHotelRecoveryName(input: {
  db: Pick<Sql, "query">;
  userId: string;
  hotelId: string;
  businessName: unknown;
}): Promise<HotelRecoveryView> {
  const hotel = await ownedHotel(input.db, input.userId, input.hotelId);
  if (hotel.organisationId) throw new HotelRecoveryError("attached", "This property is already linked. Nothing was changed.");
  const current = await viewForUnattached(input.db, input.userId, hotel.name);
  if (current.kind !== "missing") return current;
  try {
    await ensureFoundingOrganisation({ db: input.db, userId: input.userId, businessName: input.businessName });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/invalid organisation name/i.test(message)) {
      throw new HotelRecoveryError("invalid_name", "Enter a business name using ordinary letters, numbers, and punctuation.");
    }
    if (/ambiguous/i.test(message)) throw new HotelRecoveryError("support", SUPPORT);
    throw error;
  }
  return viewForUnattached(input.db, input.userId, hotel.name);
}

export async function classifyHotelRecovery(input: {
  db: Pick<Sql, "query">;
  userId: string;
  hotelId: string;
}): Promise<HotelRecoveryView> {
  const hotel = await ownedHotel(input.db, input.userId, input.hotelId);
  if (hotel.organisationId) throw new HotelRecoveryError("attached", "This property is already linked. Nothing was changed.");
  const current = await viewForUnattached(input.db, input.userId, hotel.name);
  if (current.kind === "missing") {
    throw new HotelRecoveryError("name_first", "Enter the business name before choosing a type. Nothing was changed.");
  }
  if (current.kind === "support") throw new HotelRecoveryError("support", SUPPORT);
  if (current.kind === "operator") throw new HotelRecoveryError("operator", OPERATOR);
  if (current.kind === "attach") return current;
  try {
    await classifyFoundingOrganisation({ db: input.db, userId: input.userId, organisationType: "hotel" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/already set|transfer_operator|conflict/i.test(message)) throw new HotelRecoveryError("operator", OPERATOR);
    if (/ambiguous/i.test(message)) throw new HotelRecoveryError("support", SUPPORT);
    throw error;
  }
  return viewForUnattached(input.db, input.userId, hotel.name);
}

export async function attachHotelRecovery(input: {
  db: Pick<Sql, "query">;
  userId: string;
  hotelId: string;
}): Promise<HotelRecoveryView> {
  const hotel = await ownedHotel(input.db, input.userId, input.hotelId);
  if (hotel.organisationId) return { kind: "attached" };
  try {
    await ensureHotelOrganisation({ db: input.db, userId: input.userId, hotelId: input.hotelId });
  } catch (error) {
    if (error instanceof HotelOrganisationError) {
      if (error.code === "not_hotel") throw new HotelRecoveryError("operator", OPERATOR);
      if (error.code === "unclassified" || error.code === "missing") {
        throw new HotelRecoveryError("confirm_hotel", "Confirm that this business is a hotel or accommodation before linking this property. Nothing was changed.");
      }
      if (error.code === "attached_elsewhere") {
        throw new HotelRecoveryError("elsewhere", "This property is already linked to a different business. Nothing was changed.");
      }
      throw new HotelRecoveryError("support", SUPPORT);
    }
    throw error;
  }
  return { kind: "attached" };
}
