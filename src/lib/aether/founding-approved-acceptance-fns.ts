import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { acceptApprovedFoundingAgreement } from "./founding-approved-acceptance";

/** Never call from a placeholder or preview screen.
 * UI must display the published approved version and require an explicit
 * unticked acceptance action before invoking this handler.
 */
export const acceptApprovedFoundingAgreementFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    agreementVersion: z.string().trim().min(1).max(160).refine(v => v !== "terms-v1"),
  }).strict())
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return acceptApprovedFoundingAgreement({
      db, userId: context.userId, agreementVersion: data.agreementVersion,
    });
  });
