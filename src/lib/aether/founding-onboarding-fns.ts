/**
 * CP30.05E-2D-2C server wrappers.
 * Session user only. No organisation id, role, billing flag, agreement version,
 * timestamp, hotel id, or Stripe id. Not called by signup or founding.
 * terms-v1 is provisional. Acceptance is an explicit call, never a page load.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import {
  classifyFoundingOrganisation,
  readFoundingOnboardingState,
  recordFoundingTermsAcceptance,
} from "./founding-onboarding.ts";

const classificationInput = z
  .object({
    organisationType: z.enum(["hotel", "transfer_operator"]),
  })
  .strict();

const acceptanceInput = z.object({}).strict();

export const classifyFoundingOrganisationFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(classificationInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return classifyFoundingOrganisation({
      db,
      userId: context.userId,
      organisationType: data.organisationType,
    });
  });

export const recordFoundingTermsAcceptanceFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(acceptanceInput)
  .handler(async ({ context }) => {
    const db = await getSql();
    return recordFoundingTermsAcceptance({ db, userId: context.userId });
  });

export const readFoundingOnboardingStateFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const db = await getSql();
    return readFoundingOnboardingState({ db, userId: context.userId });
  });
