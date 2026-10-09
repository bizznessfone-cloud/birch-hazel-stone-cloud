/**
 * CP30.05E-2D-2C — classify the caller's founding organisation and record one
 * provisional Terms acceptance. The database functions are the authority.
 *
 * Trust boundary: userId is the server session. The database functions receive
 * that id and no organisation id, role, billing flag, agreement version, or
 * timestamp. Any other server code that can execute as aether_app could pass a
 * different user id. Routes must not do that. Direct table writes stay denied.
 *
 * terms-v1 is a provisional technical token. It does not mean final legal
 * Terms have been published or approved. This module does not create hotels,
 * billing, allocation, or Stripe objects, and it does not record acceptance
 * merely because an organisation exists.
 */
import type { Sql } from "@/lib/db";

export const PROVISIONAL_TERMS_VERSION = "terms-v1" as const;

export const FOUNDING_ORGANISATION_TYPES = ["hotel", "transfer_operator"] as const;

export type FoundingOrganisationType = (typeof FOUNDING_ORGANISATION_TYPES)[number];

export class FoundingOnboardingError extends Error {
  readonly code:
    | "unauthorized"
    | "invalid_type"
    | "not_found"
    | "missing"
    | "ambiguous"
    | "conflict"
    | "unclassified"
    | "not_recorded";

  constructor(code: FoundingOnboardingError["code"], message: string) {
    super(message);
    this.name = "FoundingOnboardingError";
    this.code = code;
  }
}

export type FoundingClassification = {
  organisationId: string;
  organisationType: FoundingOrganisationType;
};

export type FoundingTermsAcceptance = {
  organisationId: string;
  agreementVersion: typeof PROVISIONAL_TERMS_VERSION;
  alreadyAccepted: boolean;
};

export type FoundingOnboardingState =
  | { status: "missing" }
  | { status: "ambiguous" }
  | {
      status: "ready";
      organisationId: string;
      organisationType: FoundingOrganisationType | null;
      termsVersion: typeof PROVISIONAL_TERMS_VERSION;
      termsAccepted: boolean;
    };

function requireUserId(userId: string | null | undefined): string {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new FoundingOnboardingError("unauthorized", "Unauthorized");
  }
  return userId;
}

export function parseFoundingOrganisationType(value: unknown): FoundingOrganisationType {
  if (value === "hotel" || value === "transfer_operator") return value;
  throw new FoundingOnboardingError("invalid_type", "invalid organisation type");
}

function failClosed(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("account not found")) {
    throw new FoundingOnboardingError("not_found", "account not found");
  }
  if (message.includes("founding organisation is missing")) {
    throw new FoundingOnboardingError("missing", "founding organisation is missing");
  }
  if (message.includes("founding organisation is ambiguous")) {
    throw new FoundingOnboardingError("ambiguous", "founding organisation is ambiguous");
  }
  if (message.includes("invalid organisation type")) {
    throw new FoundingOnboardingError("invalid_type", "invalid organisation type");
  }
  if (message.includes("organisation type is already set")) {
    throw new FoundingOnboardingError("conflict", "organisation type is already set");
  }
  if (message.includes("organisation is unclassified")) {
    throw new FoundingOnboardingError("unclassified", "organisation is unclassified");
  }
  throw err;
}

export async function classifyFoundingOrganisation(input: {
  db: Pick<Sql, "query">;
  userId: string | null | undefined;
  organisationType: unknown;
}): Promise<FoundingClassification> {
  const userId = requireUserId(input.userId);
  const organisationType = parseFoundingOrganisationType(input.organisationType);
  let rows: Array<{ organisation_id: string; organisation_type: string | null }>;
  try {
    rows = await input.db.query<{ organisation_id: string; organisation_type: string | null }>(
      `select organisation_id::text as organisation_id, organisation_type
         from sbg_classify_founding_organisation($1, $2)`,
      [userId, organisationType],
    );
  } catch (err) {
    failClosed(err);
  }
  const row = rows[0];
  if (!row?.organisation_id || (row.organisation_type !== "hotel" && row.organisation_type !== "transfer_operator")) {
    throw new FoundingOnboardingError("not_recorded", "founding organisation was not classified");
  }
  return { organisationId: row.organisation_id, organisationType: row.organisation_type };
}

export async function recordFoundingTermsAcceptance(input: {
  db: Pick<Sql, "query">;
  userId: string | null | undefined;
}): Promise<FoundingTermsAcceptance> {
  const userId = requireUserId(input.userId);
  let rows: Array<{ organisation_id: string; agreement_version: string; already_accepted: boolean }>;
  try {
    rows = await input.db.query<{
      organisation_id: string;
      agreement_version: string;
      already_accepted: boolean;
    }>(
      `select organisation_id::text as organisation_id, agreement_version, already_accepted
         from sbg_record_founding_terms_acceptance($1)`,
      [userId],
    );
  } catch (err) {
    failClosed(err);
  }
  const row = rows[0];
  if (!row?.organisation_id || row.agreement_version !== PROVISIONAL_TERMS_VERSION) {
    throw new FoundingOnboardingError("not_recorded", "terms acceptance was not recorded");
  }
  return {
    organisationId: row.organisation_id,
    agreementVersion: PROVISIONAL_TERMS_VERSION,
    alreadyAccepted: row.already_accepted === true,
  };
}

export async function readFoundingOnboardingState(input: {
  db: Pick<Sql, "query">;
  userId: string | null | undefined;
}): Promise<FoundingOnboardingState> {
  const userId = requireUserId(input.userId);
  let rows: Array<{
    state: string;
    organisation_id: string | null;
    organisation_type: string | null;
    terms_accepted: boolean;
  }>;
  try {
    rows = await input.db.query<{
      state: string;
      organisation_id: string | null;
      organisation_type: string | null;
      terms_accepted: boolean;
    }>(
      `select state, organisation_id::text as organisation_id, organisation_type, terms_accepted
         from sbg_read_founding_onboarding_state($1)`,
      [userId],
    );
  } catch (err) {
    failClosed(err);
  }
  const row = rows[0];
  if (!row) throw new FoundingOnboardingError("not_recorded", "founding onboarding state was not read");
  if (row.state === "missing") return { status: "missing" };
  if (row.state === "ambiguous") return { status: "ambiguous" };
  if (row.state !== "ready" || !row.organisation_id) {
    throw new FoundingOnboardingError("not_recorded", "founding onboarding state was not read");
  }
  if (
    row.organisation_type !== null &&
    row.organisation_type !== "hotel" &&
    row.organisation_type !== "transfer_operator"
  ) {
    throw new FoundingOnboardingError("not_recorded", "founding onboarding state was not read");
  }
  return {
    status: "ready",
    organisationId: row.organisation_id,
    organisationType: row.organisation_type,
    termsVersion: PROVISIONAL_TERMS_VERSION,
    termsAccepted: row.terms_accepted === true,
  };
}
