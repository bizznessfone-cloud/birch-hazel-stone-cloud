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

/** Returns only explicitly granted hotel identifiers and names, never booking records. */
export const listOperatorWorkspacePropertiesFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const db = await getSql();
      const founding = await readFoundingOnboardingState({ db, userId: context.userId });
      if (founding.status !== "ready" || founding.organisationType !== "transfer_operator") {
        return { properties: [] as Array<{ hotelId: string; name: string }> };
      }
      const rows = await db.query<{ hotel_id: string; hotel_name: string }>(
        "select hotel_id::text, hotel_name from public.sbg_operator_properties_for_user($1)",
        [context.userId],
      );
      if (!Array.isArray(rows) || rows.length > 100 || rows.some(row =>
        typeof row.hotel_id !== "string" || typeof row.hotel_name !== "string"
      )) return { properties: [] as Array<{ hotelId: string; name: string }> };
      return { properties: rows.map(row => ({ hotelId: row.hotel_id, name: row.hotel_name })) };
    } catch {
      // Missing migration, ambiguous membership or DB failure never exposes properties.
      return { properties: [] as Array<{ hotelId: string; name: string }> };
    }
  });
