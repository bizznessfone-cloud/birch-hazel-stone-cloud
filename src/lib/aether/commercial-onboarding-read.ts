/** Read-only commercial state derived from the authenticated session and DB authority. */
import type { Sql } from "@/lib/db";
import { commercialOnboardingDecision, type CommercialOnboardingDecision } from "./commercial-onboarding-contract";
export async function readCommercialOnboarding(input: {
  db: Pick<Sql, "query">; sessionUserId: string | null | undefined;
}): Promise<CommercialOnboardingDecision> {
  if (!input.sessionUserId?.trim()) return { status: "unavailable", canActivate: false };
  try {
    const rows = await input.db.query<{
      organisation_exists: boolean; organisation_type: string | null;
      approved_agreement_accepted: boolean; accessible_property_count: number;
    }>("select * from public.sbg_commercial_founding_snapshot_for_user($1)", [input.sessionUserId]);
    if (rows.length !== 1 || !rows[0]) return { status: "unavailable", canActivate: false };
    const r = rows[0];
    if (typeof r.organisation_exists !== "boolean" ||
      typeof r.approved_agreement_accepted !== "boolean" ||
      !Number.isSafeInteger(r.accessible_property_count)) return { status: "unavailable", canActivate: false };
    return commercialOnboardingDecision({
      organisationExists: r.organisation_exists,
      organisationType: r.organisation_type === "hotel" || r.organisation_type === "transfer_operator"
        ? r.organisation_type : null,
      approvedAgreementAccepted: r.approved_agreement_accepted,
      licensedPropertyCount: r.accessible_property_count,
      propertyAccessVerified: r.accessible_property_count > 0,
    });
  } catch {
    return { status: "unavailable", canActivate: false };
  }
}
