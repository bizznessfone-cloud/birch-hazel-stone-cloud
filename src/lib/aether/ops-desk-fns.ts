/**
 * Operator desk server functions. Guest routes must not import this module.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

function fail(err: unknown): { ok: false; code: string; message: string } {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const name = (err as { name?: string }).name;
    if (name === "OpsDeskError" || name === "InventoryError" || name === "OpsAuthError") {
      return {
        ok: false,
        code: String((err as { code: string }).code),
        message: String((err as { message: string }).message),
      };
    }
  }
  return { ok: false, code: "server_error", message: "Something went wrong. Please try again." };
}

const idInput = z.object({ id: z.string().uuid() });

export const opsTodayBoard = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { todayBoardFromRequest } = await import("./ops-desk.server");
    return { ok: true as const, board: await todayBoardFromRequest() };
  } catch (err) {
    return fail(err);
  }
});

export const opsListBookings = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { listBookingsFromRequest } = await import("./ops-desk.server");
    return { ok: true as const, bookings: await listBookingsFromRequest() };
  } catch (err) {
    return fail(err);
  }
});

export const opsGetBooking = createServerFn({ method: "GET" })
  .validator(idInput)
  .handler(async ({ data }) => {
    try {
      const { getBookingFromRequest } = await import("./ops-desk.server");
      const detail = await getBookingFromRequest(data.id);
      return { ok: true as const, ...detail };
    } catch (err) {
      return fail(err);
    }
  });

export const opsListVehicles = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { listVehiclesFromRequest } = await import("./ops-desk.server");
    return { ok: true as const, vehicles: await listVehiclesFromRequest() };
  } catch (err) {
    return fail(err);
  }
});

export const opsListDrivers = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { listDriversFromRequest } = await import("./ops-desk.server");
    return { ok: true as const, drivers: await listDriversFromRequest() };
  } catch (err) {
    return fail(err);
  }
});

export const opsListHotels = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { listHotelsFromRequest } = await import("./ops-desk.server");
    return { ok: true as const, hotels: await listHotelsFromRequest() };
  } catch (err) {
    return fail(err);
  }
});

export const opsUpsertVehicle = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id: z.string().uuid().nullable().optional(),
      name: z.string(),
      capacity: z.number(),
      active: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    try {
      const { upsertVehicleFromRequest } = await import("./ops-desk.server");
      return { ok: true as const, vehicle: await upsertVehicleFromRequest(data) };
    } catch (err) {
      return fail(err);
    }
  });

export const opsUpsertDriver = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id: z.string().uuid().nullable().optional(),
      name: z.string(),
      active: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    try {
      const { upsertDriverFromRequest } = await import("./ops-desk.server");
      return { ok: true as const, driver: await upsertDriverFromRequest(data) };
    } catch (err) {
      return fail(err);
    }
  });

export const opsUpsertHotel = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id: z.string().uuid().nullable().optional(),
      code: z.string(),
      name: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    try {
      const { upsertHotelFromRequest } = await import("./ops-desk.server");
      return { ok: true as const, hotel: await upsertHotelFromRequest(data) };
    } catch (err) {
      return fail(err);
    }
  });
