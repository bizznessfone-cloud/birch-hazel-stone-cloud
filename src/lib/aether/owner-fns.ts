/**
 * CP26C-O2 — Owner server functions.
 * Every handler: authMiddleware + requirePlatformOwner before any query.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { PlatformOwnerForbiddenError, requirePlatformOwner } from "./owner-auth.ts";
import {
  loadOwnerHotelDetail,
  loadOwnerHotels,
  loadOwnerOverview,
  loadOwnerRevenue,
  resolveAllowlistHotelNames,
} from "./owner-queries.ts";
import {
  CatalogueCommandError,
  activateOwnerPriceVersion,
  createOwnerPriceVersion,
  loadOwnerCatalogue,
  retireOwnerPriceVersion,
  updateOwnerPlan,
} from "./owner-catalogue.ts";
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

const planEdit = z.object({
  code: z.enum(["basic", "pro", "premium"]),
  name: z.string().max(80),
  description: z.string().max(400),
  active: z.boolean(),
});

const priceCreate = z.object({
  code: z.enum(["basic", "pro", "premium"]),
  amount: z.string().max(16),
});

const priceVersionId = z.object({
  priceVersionId: z.string().uuid(),
});

function catalogueResult(err: unknown): { ok: false; message: string } {
  if (err instanceof PlatformOwnerForbiddenError) throw err;
  if (err instanceof CatalogueCommandError) return { ok: false, message: err.message };
  return { ok: false, message: "Catalogue change could not be saved." };
}

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
    return loadOwnerCatalogue(db);
  });

export const updateOwnerPlanFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(planEdit)
  .handler(async ({ context, data }) => {
    const db = await getSql();
    await requirePlatformOwner(db, context.userId);
    try {
      await updateOwnerPlan(db, context.userId, data);
      return { ok: true as const, catalogue: await loadOwnerCatalogue(db) };
    } catch (err) {
      return catalogueResult(err);
    }
  });

export const createOwnerPriceFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(priceCreate)
  .handler(async ({ context, data }) => {
    const db = await getSql();
    await requirePlatformOwner(db, context.userId);
    try {
      await createOwnerPriceVersion(db, context.userId, data);
      return { ok: true as const, catalogue: await loadOwnerCatalogue(db) };
    } catch (err) {
      return catalogueResult(err);
    }
  });

export const activateOwnerPriceFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(priceVersionId)
  .handler(async ({ context, data }) => {
    const db = await getSql();
    await requirePlatformOwner(db, context.userId);
    try {
      await activateOwnerPriceVersion(db, context.userId, data.priceVersionId);
      return { ok: true as const, catalogue: await loadOwnerCatalogue(db) };
    } catch (err) {
      return catalogueResult(err);
    }
  });

export const retireOwnerPriceFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(priceVersionId)
  .handler(async ({ context, data }) => {
    const db = await getSql();
    await requirePlatformOwner(db, context.userId);
    try {
      await retireOwnerPriceVersion(db, context.userId, data.priceVersionId);
      return { ok: true as const, catalogue: await loadOwnerCatalogue(db) };
    } catch (err) {
      return catalogueResult(err);
    }
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
