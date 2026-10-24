/** Read-only authenticated commercial onboarding state. Never activates checkout. */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { readCommercialOnboarding } from "./commercial-onboarding-read";
export const readCommercialOnboardingFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => readCommercialOnboarding({
    db: await getSql(), sessionUserId: context.userId,
  }));
