/** Contract 4: guarded licence release service. No public route, no UI or commerce activation. */
import type { Sql } from "@/lib/db";

export type LicenceReleaseResult = { released: true } | { released: false };

export async function releasePropertyLicence(input: {
  db: Pick<Sql, "query">;
  sessionUserId: string | null | undefined;
  allocationId: string;
}): Promise<LicenceReleaseResult> {
  if (!input.sessionUserId?.trim() ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.allocationId)) {
    return { released: false };
  }
  try {
    const rows = await input.db.query<{ released: boolean }>(
      "select public.sbg_release_property_licence_for_user($1,$2::uuid) as released",
      [input.sessionUserId, input.allocationId],
    );
    return rows.length === 1 && rows[0]?.released === true
      ? { released: true } : { released: false };
  } catch {
    return { released: false };
  }
}
