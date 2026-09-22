/**
 * CP26C-O2 — Owner server functions.
 * Every handler: authMiddleware + requirePlatformOwner before any query.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requirePlatformOwner } from "./owner-auth.ts";
import {
  loadOwnerHotelDetail,
  loadOwnerHotels,
  loadOwnerOverview,
  loadOwnerRevenue,
  resolveAllowlistHotelNames,
  SBG_SAAS_PLAN_CODES,
  SBG_SAAS_PLAN_LABELS,
} from "./owner-queries.ts";
import {
  OWNER_SYSTEM_CAPTION,
  ownerSystemHasSecretValues,
  ownerSystemSnapshot,
  parsedAllowlistIds,
} from "./owner-system.ts";

const hotelSearch = z.object({
  q: z.string().max(80).optional(),
  status: z.string().max(32).optional(),
});

const hotelIdInput = z.object({
  hotelId: z.string().uuid(),
});

export const getOwnerOverviewFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const db = await getSql();
    await requirePlatformOwner(db, context.userId);
    return loadOwnerOverview(db);
  });

export const getOwnerHotelsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(hotelSearch)
  .handler(async ({ context, data }) => {
    const db = await getSql();
    await requirePlatformOwner(db, context.userId);
    return loadOwnerHotels(db, { q: data.q, status: data.status });
  });

export const getOwnerHotelFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(hotelIdInput)
  .handler(async ({ context, data }) => {
    const db = await getSql();
    await requirePlatformOwner(db, context.userId);
    const hotel = await loadOwnerHotelDetail(db, data.hotelId);
    if (!hotel) return { ok: false as const, code: "not_found" as const };
    return { ok: true as const, hotel };
  });

export const getOwnerRevenueFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const db = await getSql();
    await requirePlatformOwner(db, context.userId);
    return loadOwnerRevenue(db);
  });

export const getOwnerPlansFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const db = await getSql();
    await requirePlatformOwner(db, context.userId);
    return {
      catalogue: "pending_o3" as const,
      plans: SBG_SAAS_PLAN_CODES.map((code) => ({
        code,
        name: SBG_SAAS_PLAN_LABELS[code],
        amount: "pending_catalogue" as const,
        interval: "month" as const,
        currency: "EUR" as const,
      })),
    };
  });

export const getOwnerSystemFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const db = await getSql();
    await requirePlatformOwner(db, context.userId);
    const snapshot = ownerSystemSnapshot();
    if (ownerSystemHasSecretValues(snapshot)) {
      throw new Error("Owner system snapshot refused a secret value.");
    }
    const ids = snapshot.testAllowlist.status === "configured" ? parsedAllowlistIds() : [];
    const allowlistNames = ids.length ? await resolveAllowlistHotelNames(db, ids) : [];
    return {
      ...snapshot,
      allowlistNames,
      caption: OWNER_SYSTEM_CAPTION,
    };
  });
