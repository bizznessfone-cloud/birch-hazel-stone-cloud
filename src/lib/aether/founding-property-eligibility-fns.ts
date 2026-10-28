import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { readFoundingPropertyEligibility } from "./founding-property-eligibility";

export const readFoundingPropertyEligibilityFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const db = await getSql();
    return readFoundingPropertyEligibility({ db, userId: context.userId });
  });
