/**
 * Public booking server functions. Intentionally unauthenticated.
 * Do not import operator auth here. Confirmation token is the public credential.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { touristMessage } from "./guest";

const createInput = z.object({
  hotelCode: z.string(),
  destinationId: z.string(),
  transferDate: z.string(),
  pickupTime: z.string(),
  durationMinutes: z.number(),
  guestName: z.string(),
  guestPhone: z.string(),
  guestEmail: z.string(),
  passengerCount: z.number(),
  luggageCount: z.number(),
  pickupText: z.string(),
  destinationText: z.string().nullable().optional(),
  specialRequirements: z.string().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
});

const tokenInput = z.object({
  token: z.string(),
});

const hotelInput = z.object({
  hotelCode: z.string(),
});

function fail(err: unknown): { ok: false; code: string; message: string } {
  if (
    err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "BookingError" &&
    "code" in err
  ) {
    const code = String((err as { code: string }).code);
    const message = (err as { message?: string }).message;
    return { ok: false, code, message: touristMessage(code, message) };
  }
  return {
    ok: false,
    code: "server_error",
    message: touristMessage("server_error"),
  };
}

export const createPublicBooking = createServerFn({ method: "POST" })
  .validator(createInput)
  .handler(async ({ data }) => {
    try {
      const { createBookingFromRequest } = await import("./booking.server");
      const booking = await createBookingFromRequest(data);
      return { ok: true as const, booking };
    } catch (err) {
      return fail(err);
    }
  });

export const getPublicBooking = createServerFn({ method: "POST" })
  .validator(tokenInput)
  .handler(async ({ data }) => {
    try {
      const { getPublicBookingFromRequest } = await import("./booking.server");
      const booking = await getPublicBookingFromRequest(data.token);
      return { ok: true as const, booking };
    } catch (err) {
      return fail(err);
    }
  });

export const getPublicHotel = createServerFn({ method: "GET" })
  .validator(hotelInput)
  .handler(async ({ data }) => {
    try {
      const { getPublicHotelFromRequest } = await import("./booking.server");
      const hotel = await getPublicHotelFromRequest(data.hotelCode);
      return { ok: true as const, hotel };
    } catch (err) {
      return fail(err);
    }
  });
