/** Contract 3: session-bound legal retrieval and explicit version/hash acceptance. No UI. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { readEffectiveFoundingAgreement } from "./approved-founding-agreement";
import { acceptEffectiveFoundingAgreement } from "./approved-founding-agreement-accept";

export const readEffectiveFoundingAgreementFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => readEffectiveFoundingAgreement({ db: await getSql() }));

const acceptanceInput = z.object({
  displayedVersion: z.string().min(1).max(121),
  displayedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  explicitlyAccepted: z.literal(true),
}).strict();
export const acceptEffectiveFoundingAgreementFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(acceptanceInput)
  .handler(async ({ data, context }) =>
    acceptEffectiveFoundingAgreement({ db: await getSql(), sessionUserId: context.userId, ...data }));
