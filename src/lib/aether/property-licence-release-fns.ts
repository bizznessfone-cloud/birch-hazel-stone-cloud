/** Gate 2 authenticated licence release boundary. No UI, checkout or activation. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { releasePropertyLicence } from "./property-licence-release";

export const releasePropertyLicenceFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ allocationId: z.string().uuid() }).strict())
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return releasePropertyLicence({
      db,
      sessionUserId: context.userId,
      allocationId: data.allocationId,
    });
  });
