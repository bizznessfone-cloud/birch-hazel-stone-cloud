/** Contract 3: explicit acceptance is impossible without the displayed effective document. */
import type { Sql } from "@/lib/db";
import { readEffectiveFoundingAgreement } from "./approved-founding-agreement";

export async function acceptEffectiveFoundingAgreement(input: {
  db: Pick<Sql, "query">;
  sessionUserId: string | null | undefined;
  displayedVersion: string;
  displayedSha256: string;
  explicitlyAccepted: boolean;
}): Promise<{ version: string; alreadyAccepted: boolean }> {
  if (!input.sessionUserId?.trim() || input.explicitlyAccepted !== true) {
    throw new Error("Explicit agreement acceptance required");
  }
  const effective = await readEffectiveFoundingAgreement({ db: input.db });
  if (!effective.available || effective.version !== input.displayedVersion ||
      effective.sha256 !== input.displayedSha256) {
    throw new Error("Approved agreement unavailable or changed");
  }
  const rows = await input.db.query<{ agreement_version: string; already_accepted: boolean }>(
    "select agreement_version, already_accepted from public.sbg_accept_approved_founding_agreement_for_user($1,$2)",
    [input.sessionUserId, effective.version],
  );
  if (rows.length !== 1 || rows[0]?.agreement_version !== effective.version) {
    throw new Error("Approved agreement acceptance not recorded");
  }
  return { version: effective.version, alreadyAccepted: rows[0]?.already_accepted === true };
}
