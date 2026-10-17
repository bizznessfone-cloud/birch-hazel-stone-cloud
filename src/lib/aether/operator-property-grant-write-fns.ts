import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { setOperatorPropertyGrant } from "./operator-property-grant-write";

const grantInput = z.object({
  hotelId: z.string().uuid(),
  operatorOrganisationId: z.string().uuid(),
  enable: z.boolean(),
}).strict();

/** No user ID, owner ID, role, or billing authority accepted from the client. */
export const setOperatorPropertyGrantFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(grantInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    // Grant creation must use confirmOperatorPropertyGrantFn with exact identity confirmation.
    if (data.enable) throw new Error("Operator identity confirmation required");
    return setOperatorPropertyGrant({
      db, sessionUserId: context.userId,
      hotelId: data.hotelId,
      operatorOrganisationId: data.operatorOrganisationId,
      enable: data.enable,
    });
  });
