/** Gate 2 exact-ID identity confirmation. Not a public operator directory. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";

export const resolveOperatorForHotelFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    hotelId: z.string().uuid(),
    operatorOrganisationId: z.string().uuid(),
  }).strict())
  .handler(async ({ data, context }) => {
    try {
      const db = await getSql();
      const rows = await db.query<{ operator_organisation_id: string; operator_name: string }>(
        "select operator_organisation_id::text, operator_name from public.sbg_resolve_operator_for_hotel_owner($1,$2::uuid,$3::uuid)",
        [context.userId, data.hotelId, data.operatorOrganisationId],
      );
      if (rows.length !== 1 || rows[0]?.operator_organisation_id !== data.operatorOrganisationId ||
          typeof rows[0]?.operator_name !== "string") {
        return { found: false as const };
      }
      return { found: true as const, operator: {
        organisationId: rows[0].operator_organisation_id, name: rows[0].operator_name,
      } };
    } catch {
      // Unauthorized, unknown, ambiguous and unavailable are indistinguishable.
      return { found: false as const };
    }
  });
