/**
 * CP30.05E-2D-2B — session-scoped founding organisation call.
 * The database function is the authority. This module does not create hotels,
 * billing, acceptance, or Stripe objects.
 */
import type { Sql } from "@/lib/db";

export const FOUNDING_BUSINESS_NAME_MAX = 160;

export class FoundingOrganisationError extends Error {
  readonly code: "unauthorized" | "invalid_name" | "not_established";

  constructor(code: FoundingOrganisationError["code"], message: string) {
    super(message);
    this.name = "FoundingOrganisationError";
    this.code = code;
  }
}

export type FoundingOrganisation = {
  organisationId: string;
  name: string;
  organisationType: string | null;
};

/** Server-side business name. Trimmed. Not derived from a hotel. */
export function parseFoundingBusinessName(value: unknown): string {
  if (typeof value !== "string") {
    throw new FoundingOrganisationError("invalid_name", "invalid organisation name");
  }
  const name = value.trim();
  if (name.length < 1 || name.length > FOUNDING_BUSINESS_NAME_MAX || /[\u0000-\u001F\u007F]/.test(name)) {
    throw new FoundingOrganisationError("invalid_name", "invalid organisation name");
  }
  return name;
}

export async function ensureFoundingOrganisation(input: {
  db: Pick<Sql, "query">;
  userId: string | null | undefined;
  businessName: unknown;
}): Promise<FoundingOrganisation> {
  if (typeof input.userId !== "string" || input.userId.trim() === "") {
    throw new FoundingOrganisationError("unauthorized", "Unauthorized");
  }
  const businessName = parseFoundingBusinessName(input.businessName);
  const rows = await input.db.query<{
    organisation_id: string;
    name: string;
    organisation_type: string | null;
  }>(
    `select organisation_id::text as organisation_id, name, organisation_type
       from sbg_ensure_founding_organisation($1, $2)`,
    [input.userId, businessName],
  );
  const row = rows[0];
  if (!row?.organisation_id || !row.name) {
    throw new FoundingOrganisationError("not_established", "founding organisation was not established");
  }
  return {
    organisationId: row.organisation_id,
    name: row.name,
    organisationType: row.organisation_type,
  };
}
