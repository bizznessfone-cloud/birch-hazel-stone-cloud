/** Gate 2 approved-agreement acceptance service.
 * Only call from an authenticated server wrapper after the exact approved
 * document version has been displayed and explicitly accepted by the user.
 * Never substitute the historical provisional terms-v1 token.
 * Database migration 0038 independently enforces effective approval,
 * organisation authority and immutable/idempotent acceptance evidence.
 */
import type { Sql } from "@/lib/db";

export async function acceptApprovedFoundingAgreement(input: {
  db: Pick<Sql, "query">;
  userId: string | null | undefined;
  agreementVersion: string;
}): Promise<{ agreementVersion: string; alreadyAccepted: boolean }> {
  if (!input.userId?.trim()) throw new Error("Unauthorized");
  const version = input.agreementVersion.trim();
  if (!version || version === "terms-v1" || version.length > 160) {
    throw new Error("Approved agreement version required");
  }
  const rows = await input.db.query<{ agreement_version: string; already_accepted: boolean }>(
    "select agreement_version, already_accepted from sbg_accept_approved_founding_agreement_for_user($1, $2)",
    [input.userId, version],
  );
  if (rows.length !== 1 || rows[0]?.agreement_version !== version || typeof rows[0]?.already_accepted !== "boolean") {
    throw new Error("Agreement acceptance was not recorded");
  }
  return { agreementVersion: rows[0].agreement_version, alreadyAccepted: rows[0].already_accepted };
}
