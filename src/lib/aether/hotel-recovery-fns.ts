/**
 * CP30.05E-2D-2D A3-R server wrappers.
 * Session user and hotel id only. No organisation id, role, billing flag,
 * agreement version, or timestamp. Does not record Terms or create a property.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import {
  attachHotelRecovery,
  classifyHotelRecovery,
  readHotelRecovery,
  submitHotelRecoveryName,
} from "./hotel-recovery.ts";

const hotelInput = z.object({ hotelId: z.string().uuid() }).strict();
const nameInput = z
  .object({
    hotelId: z.string().uuid(),
    businessName: z.string().min(1).max(160),
  })
  .strict();

export const readHotelRecoveryFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(hotelInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return readHotelRecovery({ db, userId: context.userId, hotelId: data.hotelId });
  });

export const submitHotelRecoveryNameFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(nameInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return submitHotelRecoveryName({
      db,
      userId: context.userId,
      hotelId: data.hotelId,
      businessName: data.businessName,
    });
  });

export const classifyHotelRecoveryFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(hotelInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return classifyHotelRecovery({ db, userId: context.userId, hotelId: data.hotelId });
  });

export const attachHotelRecoveryFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(hotelInput)
  .handler(async ({ data, context }) => {
    const db = await getSql();
    return attachHotelRecovery({ db, userId: context.userId, hotelId: data.hotelId });
  });
