/** Contract 2: provider authorisation. Database rechecks owner, grant and active agreement. */
import type { Sql } from "@/lib/db";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function setOperatorProviderAuthorisation(input: {
  db: Pick<Sql, "query">;
  sessionUserId: string | null | undefined;
  hotelId: string;
  providerId: string;
  operatorOrganisationId: string;
  enable: boolean;
}): Promise<{ updated: true }> {
  if (!input.sessionUserId?.trim()) throw new Error("Unauthorized");
  if (![input.hotelId, input.providerId, input.operatorOrganisationId].every(id => UUID.test(id)) ||
      typeof input.enable !== "boolean") throw new Error("Invalid provider authorisation request");
  const rows = await input.db.query<{ updated: boolean }>(
    "select public.sbg_set_operator_provider_authorisation_for_user($1,$2::uuid,$3::uuid,$4::uuid,$5) as updated",
    [input.sessionUserId, input.hotelId, input.providerId, input.operatorOrganisationId, input.enable],
  );
  if (rows.length !== 1 || rows[0]?.updated !== true) throw new Error("Provider authorisation denied");
  return { updated: true };
}
