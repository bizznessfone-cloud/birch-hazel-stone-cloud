/** Gate 2 explicit operator confirmation before issuing a property grant.
 * No UI is exposed yet. Lookup does not itself grant access.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { setOperatorPropertyGrant } from "./operator-property-grant-write";

const input = z.object({
  hotelId: z.string().uuid(),
  operatorOrganisationId: z.string().uuid(),
  confirmedOperatorName: z.string().min(1).max(255),
}).strict();

export const confirmOperatorPropertyGrantFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(input)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    const rows = await db.query<{ operator_organisation_id: string; operator_name: string }>(
      "select operator_organisation_id::text, operator_name from public.sbg_resolve_operator_for_hotel_owner($1,$2::uuid,$3::uuid)",
      [context.userId, data.hotelId, data.operatorOrganisationId],
    );
    if (rows.length !== 1 ||
        rows[0]?.operator_organisation_id !== data.operatorOrganisationId ||
        rows[0]?.operator_name !== data.confirmedOperatorName) {
      throw new Error("Operator confirmation is invalid or no longer available");
    }
    // Database grant setter independently rechecks authority and operator type.
    await setOperatorPropertyGrant({
      db, sessionUserId: context.userId,
      hotelId: data.hotelId, operatorOrganisationId: data.operatorOrganisationId,
      enable: true,
    });
    return { granted: true as const };
  });

/** Revocation needs no positive identity lookup; the DB still checks authority. */
export const revokeOperatorPropertyGrantFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    hotelId: z.string().uuid(),
    operatorOrganisationId: z.string().uuid(),
  }).strict())
  .handler(async ({ data, context }) => {
    const db = await getSql();
    await setOperatorPropertyGrant({
      db, sessionUserId: context.userId,
      hotelId: data.hotelId, operatorOrganisationId: data.operatorOrganisationId,
      enable: false,
    });
    return { revoked: true as const };
  });
