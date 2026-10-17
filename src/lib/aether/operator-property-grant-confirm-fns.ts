/** Gate 2 explicit operator confirmation before issuing a property grant.
 * No UI is exposed yet. Lookup does not itself grant access.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { confirmOperatorPropertyGrant, revokeConfirmedOperatorPropertyGrant } from "./operator-property-grant-confirm";

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
    return confirmOperatorPropertyGrant({ db, sessionUserId: context.userId, ...data });
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
    return revokeConfirmedOperatorPropertyGrant({ db, sessionUserId: context.userId, ...data });
  });
