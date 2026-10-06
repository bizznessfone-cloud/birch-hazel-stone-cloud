/**
 * CP30.05E-2D-2B server wrapper.
 * Session user only. Business name only. No hotel, role, type, or Stripe input.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { FOUNDING_BUSINESS_NAME_MAX, ensureFoundingOrganisation } from "./founding-organisation.ts";

const foundingInput = z
  .object({
    businessName: z.string().trim().min(1).max(FOUNDING_BUSINESS_NAME_MAX),
  })
  .strict();

export const ensureFoundingOrganisationFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(foundingInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return ensureFoundingOrganisation({
      db,
      userId: context.userId,
      businessName: data.businessName,
    });
  });
