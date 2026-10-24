/** Contract 3: read the approved effective legal text, never a placeholder. */
import type { Sql } from "@/lib/db";
export type EffectiveFoundingAgreement =
  | { available: false }
  | { available: true; version: string; text: string; sha256: string };
export async function readEffectiveFoundingAgreement(input: {
  db: Pick<Sql, "query">;
}): Promise<EffectiveFoundingAgreement> {
  const rows = await input.db.query<{
    agreement_version: string; document_text: string; document_sha256: string;
  }>("select agreement_version, document_text, document_sha256 from public.sbg_read_effective_founding_agreement()", []);
  if (rows.length !== 1) return { available: false };
  const r = rows[0];
  if (!r || !r.agreement_version || r.agreement_version === "terms-v1" ||
      !r.document_text?.trim() || !/^[0-9a-f]{64}$/.test(r.document_sha256)) return { available: false };
  return { available: true, version: r.agreement_version, text: r.document_text, sha256: r.document_sha256 };
}
