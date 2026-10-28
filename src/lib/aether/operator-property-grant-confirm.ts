/** Pure confirmation contract, shared by authenticated server function and tests. */
import type { Sql } from "@/lib/db";
import { setOperatorPropertyGrant } from "./operator-property-grant-write";

export async function confirmOperatorPropertyGrant(input: {
  db: Pick<Sql, "query">;
  sessionUserId: string | null | undefined;
  hotelId: string;
  operatorOrganisationId: string;
  confirmedOperatorName: string;
}): Promise<{ granted: true }> {
  if (!input.sessionUserId?.trim() || !input.confirmedOperatorName?.trim()) {
    throw new Error("Operator confirmation is invalid or no longer available");
  }
  const rows = await input.db.query<{ operator_organisation_id: string; operator_name: string }>(
    "select operator_organisation_id::text, operator_name from public.sbg_resolve_operator_for_hotel_owner($1,$2::uuid,$3::uuid)",
    [input.sessionUserId, input.hotelId, input.operatorOrganisationId],
  );
  if (rows.length !== 1 ||
      rows[0]?.operator_organisation_id !== input.operatorOrganisationId ||
      rows[0]?.operator_name !== input.confirmedOperatorName) {
    throw new Error("Operator confirmation is invalid or no longer available");
  }
  await setOperatorPropertyGrant({
    db: input.db, sessionUserId: input.sessionUserId,
    hotelId: input.hotelId, operatorOrganisationId: input.operatorOrganisationId, enable: true,
  });
  return { granted: true };
}

export async function revokeConfirmedOperatorPropertyGrant(input: {
  db: Pick<Sql, "query">;
  sessionUserId: string | null | undefined;
  hotelId: string;
  operatorOrganisationId: string;
}): Promise<{ revoked: true }> {
  await setOperatorPropertyGrant({ ...input, enable: false });
  return { revoked: true };
}
