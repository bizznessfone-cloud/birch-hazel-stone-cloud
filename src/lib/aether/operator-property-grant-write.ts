/** Gate 2 grant management. Only authenticated server routes may call this.
 * The database is the final authority for hotel ownership and billing rights.
 */
import type { Sql } from "@/lib/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function setOperatorPropertyGrant(input: {
  db: Pick<Sql, "query">;
  sessionUserId: string | null | undefined;
  hotelId: string;
  operatorOrganisationId: string;
  enable: boolean;
}): Promise<{ updated: true }> {
  if (!input.sessionUserId?.trim()) throw new Error("Unauthorized");
  if (!UUID.test(input.hotelId) || !UUID.test(input.operatorOrganisationId) || typeof input.enable !== "boolean") {
    throw new Error("Invalid operator grant request");
  }
  const rows = await input.db.query<{ updated: boolean }>(
    "select public.sbg_set_operator_property_grant_for_user($1,$2::uuid,$3::uuid,$4) as updated",
    [input.sessionUserId, input.hotelId, input.operatorOrganisationId, input.enable],
  );
  if (rows.length !== 1 || rows[0]?.updated !== true) throw new Error("Operator grant was not updated");
  return { updated: true };
}
