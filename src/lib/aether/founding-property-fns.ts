import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { createFoundingProperty } from "./founding-property";

const propertyInput = z.object({
  name: z.string().trim().min(1).max(120),
  locality: z.string().trim().min(1).max(160),
  code: z.string().min(2).max(32),
  ianaTimezone: z.string().min(1).max(120),
  currency: z.string().length(3),
}).strict();

export const createFoundingPropertyFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(propertyInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return createFoundingProperty({ db, userId: context.userId, property: data });
  });
