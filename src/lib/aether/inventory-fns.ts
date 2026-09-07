/**
 * Operator inventory server functions. Mutations require requireOps CSRF.
 * Public guest booking must not import these.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

function fail(err: unknown): { ok: false; code: string; message: string } {
  if (err && typeof err === "object" && (err as { name?: string }).name === "InventoryError") {
    return {
      ok: false,
      code: String((err as { code: string }).code),
      message: String((err as { message: string }).message),
    };
  }
  if (err && typeof err === "object" && (err as { name?: string }).name === "OpsAuthError") {
    return {
      ok: false,
      code: String((err as { code: string }).code),
      message: String((err as { message: string }).message),
    };
  }
  return { ok: false, code: "server_error", message: "Something went wrong. Please try again." };
}

const bookingId = z.object({ bookingId: z.string().uuid() });
const vehicleAssign = z.object({
  bookingId: z.string().uuid(),
  vehicleId: z.string().uuid(),
});
const driverAssign = z.object({
  bookingId: z.string().uuid(),
  driverId: z.string().uuid(),
});
const statusInput = z.object({
  bookingId: z.string().uuid(),
  status: z.string(),
});

export const opsAssignVehicle = createServerFn({ method: "POST" })
  .validator(vehicleAssign)
  .handler(async ({ data }) => {
    try {
      const { assignVehicleFromRequest } = await import("./inventory.server");
      return { ok: true as const, snapshot: await assignVehicleFromRequest(data.bookingId, data.vehicleId) };
    } catch (err) {
      return fail(err);
    }
  });

export const opsUnassignVehicle = createServerFn({ method: "POST" })
  .validator(bookingId)
  .handler(async ({ data }) => {
    try {
      const { unassignVehicleFromRequest } = await import("./inventory.server");
      return { ok: true as const, snapshot: await unassignVehicleFromRequest(data.bookingId) };
    } catch (err) {
      return fail(err);
    }
  });

export const opsAssignDriver = createServerFn({ method: "POST" })
  .validator(driverAssign)
  .handler(async ({ data }) => {
    try {
      const { assignDriverFromRequest } = await import("./inventory.server");
      return { ok: true as const, snapshot: await assignDriverFromRequest(data.bookingId, data.driverId) };
    } catch (err) {
      return fail(err);
    }
  });

export const opsUnassignDriver = createServerFn({ method: "POST" })
  .validator(bookingId)
  .handler(async ({ data }) => {
    try {
      const { unassignDriverFromRequest } = await import("./inventory.server");
      return { ok: true as const, snapshot: await unassignDriverFromRequest(data.bookingId) };
    } catch (err) {
      return fail(err);
    }
  });

export const opsCancelBooking = createServerFn({ method: "POST" })
  .validator(bookingId)
  .handler(async ({ data }) => {
    try {
      const { cancelBookingFromRequest } = await import("./inventory.server");
      return { ok: true as const, snapshot: await cancelBookingFromRequest(data.bookingId) };
    } catch (err) {
      return fail(err);
    }
  });

export const opsSetBookingStatus = createServerFn({ method: "POST" })
  .validator(statusInput)
  .handler(async ({ data }) => {
    try {
      const { setBookingStatusFromRequest } = await import("./inventory.server");
      return { ok: true as const, snapshot: await setBookingStatusFromRequest(data.bookingId, data.status) };
    } catch (err) {
      return fail(err);
    }
  });
