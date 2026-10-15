/** Read-only Gate 2 eligibility. Never mutates agreements or creates hotels. */
import type { Sql } from "@/lib/db";

export type FoundingPropertyEligibility =
  | { eligible: true; reason: "ready" }
  | { eligible: false; reason: "unauthorized" | "organisation_unavailable" | "organisation_ineligible" | "agreement_required" | "unavailable" };

export async function readFoundingPropertyEligibility(input: {
  db: Pick<Sql, "query">;
  userId: string | null | undefined;
}): Promise<FoundingPropertyEligibility> {
  if (!input.userId?.trim()) return { eligible: false, reason: "unauthorized" };
  const rows = await input.db.query<{ eligible: boolean; reason: string }>(
    "select eligible, reason from sbg_founding_property_eligibility_for_user($1)",
    [input.userId],
  );
  if (rows.length !== 1) return { eligible: false, reason: "unavailable" };
  const row = rows[0];
  if (row?.eligible === true && row.reason === "ready") return { eligible: true, reason: "ready" };
  if (row?.eligible === false && (
    row.reason === "unauthorized" || row.reason === "organisation_unavailable" ||
    row.reason === "organisation_ineligible" || row.reason === "agreement_required"
  )) return { eligible: false, reason: row.reason };
  return { eligible: false, reason: "unavailable" };
}
