/** Gate 2 read-only operator workspace access. Session identity only; no booking data. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { readFoundingOnboardingState } from "./founding-onboarding";
import { readOperatorPropertyAccess } from "./operator-property-grant-read";

export const checkOperatorWorkspacePropertyFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ hotelId: z.string().uuid() }).strict())
  .handler(async ({ data, context }) => {
    const db = await getSql();
    const founding = await readFoundingOnboardingState({ db, userId: context.userId });
    if (founding.status !== "ready" || founding.organisationType !== "transfer_operator") {
      return { allowed: false as const };
    }
    const decision = await readOperatorPropertyAccess({
      db, sessionUserId: context.userId, hotelId: data.hotelId,
    });
    return { allowed: decision.allowed };
  });
