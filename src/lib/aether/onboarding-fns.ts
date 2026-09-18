import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";

const uuid = z.string().uuid();
const hotelInput = z.object({
  code: z.string().min(2).max(32),
  name: z.string().min(1).max(120),
  locality: z.string().min(1).max(160),
  ianaTimezone: z.string().min(1).max(120),
  currency: z.string().length(3),
});
const serviceInput = z.object({ hotelId: uuid, name: z.string().min(1).max(120) });
const destinationInput = z.object({
  hotelId: uuid,
  kind: z.enum(["airport", "port", "hotel", "other"]),
  name: z.string().min(1).max(160),
  amountMinor: z.number().int().min(0),
});
const hotelIdInput = z.object({ hotelId: uuid });

function fail(err: unknown) {
  return {
    ok: false as const,
    code: "server_error",
    message: err instanceof Error ? err.message : "Something went wrong. Please try again.",
  };
}

export const getOnboardingState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const db = await getSql();
      const hotels = await db.query<{
        id: string; code: string; public_slug: string; name: string; locality: string;
        iana_timezone: string; currency: string; status: string;
      }>(
        `select h.id, h.code, h.public_slug, h.name, h.locality, h.iana_timezone, h.currency, h.status
           from app_hotel_accounts aha
           join hotels h on h.id = aha.hotel_id
          where aha.user_id = $1
          order by aha.created_at asc`,
        [context.userId],
      );
      const details = [];
      for (const hotel of hotels) {
        const services = await db.query<{ id: string; kind: string; name: string; active: boolean }>(
          "select id, kind, name, active from hotel_services where hotel_id = $1 order by created_at asc",
          [hotel.id],
        );
        const destinations = await db.query<{
          id: string; kind: string; name: string; amount_minor: number; active: boolean;
        }>(
          "select id, kind, name, amount_minor, active from hotel_destinations where hotel_id = $1 order by sort_order asc, name asc",
          [hotel.id],
        );
        details.push({ hotel, services, destinations });
      }
      return { ok: true as const, hotels: details };
    } catch (err) {
      return fail(err);
    }
  });

export const createOnboardingHotel = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(hotelInput)
  .handler(async ({ data, context }) => {
    try {
      const db = await getSql();
      const rows = await db.query<{ hotel_id: string; provider_id: string }>(
        "select * from sbg_create_hotel_for_user($1, $2, $3, $4, $5, $6)",
        [context.userId, data.code, data.name, data.locality, data.ianaTimezone, data.currency.toUpperCase()],
      );
      if (!rows[0]) throw new Error("Hotel could not be created.");
      return { ok: true as const, hotelId: rows[0].hotel_id, providerId: rows[0].provider_id };
    } catch (err) {
      return fail(err);
    }
  });

export const createOnboardingService = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serviceInput)
  .handler(async ({ data, context }) => {
    try {
      const db = await getSql();
      const rows = await db.query<{ sbg_create_service_for_user: string }>(
        "select sbg_create_service_for_user($1, $2::uuid, 'transfer', $3)",
        [context.userId, data.hotelId, data.name],
      );
      if (!rows[0]?.sbg_create_service_for_user) throw new Error("Service could not be created.");
      return { ok: true as const, serviceId: rows[0].sbg_create_service_for_user };
    } catch (err) {
      return fail(err);
    }
  });

export const createOnboardingDestination = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(destinationInput)
  .handler(async ({ data, context }) => {
    try {
      const db = await getSql();
      const rows = await db.query<{ sbg_add_destination_for_user: string }>(
        "select sbg_add_destination_for_user($1, $2::uuid, $3, $4, $5)",
        [context.userId, data.hotelId, data.kind, data.name, data.amountMinor],
      );
      if (!rows[0]?.sbg_add_destination_for_user) throw new Error("Destination could not be created.");
      return { ok: true as const, destinationId: rows[0].sbg_add_destination_for_user };
    } catch (err) {
      return fail(err);
    }
  });

export const prepareOnboardingHotel = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(hotelIdInput)
  .handler(async ({ data, context }) => {
    try {
      const db = await getSql();
      await db.query("select sbg_promote_configured_for_user($1, $2::uuid)", [context.userId, data.hotelId]);
      return { ok: true as const };
    } catch (err) {
      return fail(err);
    }
  });
