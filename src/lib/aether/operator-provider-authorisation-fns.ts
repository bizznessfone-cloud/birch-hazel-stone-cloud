/** Contract 2: authenticated provider authorisation/revocation. No UI or operational activation. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { setOperatorProviderAuthorisation } from "./operator-provider-authorisation";

const input = z.object({
  hotelId: z.string().uuid(),
  providerId: z.string().uuid(),
  operatorOrganisationId: z.string().uuid(),
  enable: z.boolean(),
}).strict();

export const setOperatorProviderAuthorisationFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(input)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return setOperatorProviderAuthorisation({ db, sessionUserId: context.userId, ...data });
  });
