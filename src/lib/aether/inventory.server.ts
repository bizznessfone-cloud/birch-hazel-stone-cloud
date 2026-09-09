/**
 * HTTP adapter for inventory assignment. Server-only.
 * Every mutation must go through requireOps({ csrf: true }).
 */
import { CompiledQuery, type Kysely, type Transaction } from "kysely";
import { getAetherDb } from "./kysely";
import type { AetherDatabase } from "./schema";
import type { BookingDb } from "./booking";
import {
  assignDriver as assignDriverEngine,
  assignVehicle as assignVehicleEngine,
  cancelBooking as cancelBookingEngine,
  setBookingStatus as setBookingStatusEngine,
  unassignDriver as unassignDriverEngine,
  unassignVehicle as unassignVehicleEngine,
  type AssignmentSnapshot,
} from "./inventory";

type Executable = Kysely<AetherDatabase> | Transaction<AetherDatabase>;

function asDb(exec: Executable): BookingDb {
  return {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await exec.executeQuery<T>(CompiledQuery.raw(text, params));
      return result.rows as T[];
    },
    transaction<T>(fn: (db: BookingDb) => Promise<T>): Promise<T> {
      if ("transaction" in exec && typeof exec.transaction === "function") {
        return exec.transaction().execute((trx) => fn(asDb(trx)));
      }
      throw new Error("nested inventory transaction");
    },
  };
}

async function appDb(): Promise<BookingDb> {
  return asDb(await getAetherDb());
}

async function opsScope() {
  const { requireOps } = await import("./ops-auth.server");
  return requireOps({ csrf: true });
}

export async function assignVehicleFromRequest(
  bookingId: string,
  vehicleId: string,
): Promise<AssignmentSnapshot> {
  const scope = await opsScope();
  return assignVehicleEngine(await appDb(), {
    bookingId,
    vehicleId,
    scope,
  });
}

export async function unassignVehicleFromRequest(bookingId: string): Promise<AssignmentSnapshot> {
  const scope = await opsScope();
  return unassignVehicleEngine(await appDb(), { bookingId, scope });
}

export async function assignDriverFromRequest(
  bookingId: string,
  driverId: string,
): Promise<AssignmentSnapshot> {
  const scope = await opsScope();
  return assignDriverEngine(await appDb(), {
    bookingId,
    driverId,
    scope,
  });
}

export async function unassignDriverFromRequest(bookingId: string): Promise<AssignmentSnapshot> {
  const scope = await opsScope();
  return unassignDriverEngine(await appDb(), { bookingId, scope });
}

export async function cancelBookingFromRequest(bookingId: string): Promise<AssignmentSnapshot> {
  const scope = await opsScope();
  return cancelBookingEngine(await appDb(), { bookingId, scope });
}

export async function setBookingStatusFromRequest(
  bookingId: string,
  status: string,
): Promise<AssignmentSnapshot> {
  const scope = await opsScope();
  return setBookingStatusEngine(await appDb(), {
    bookingId,
    status,
    scope,
  });
}

export { InventoryError } from "./inventory";
export type { AssignmentSnapshot } from "./inventory";
