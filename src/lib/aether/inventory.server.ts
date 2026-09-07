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

async function operatorId(): Promise<string> {
  const { requireOps } = await import("./ops-auth.server");
  const ops = await requireOps({ csrf: true });
  return ops.operatorId;
}

export async function assignVehicleFromRequest(
  bookingId: string,
  vehicleId: string,
): Promise<AssignmentSnapshot> {
  const opsId = await operatorId();
  return assignVehicleEngine(await appDb(), {
    bookingId,
    vehicleId,
    operatorId: opsId,
  });
}

export async function unassignVehicleFromRequest(bookingId: string): Promise<AssignmentSnapshot> {
  const opsId = await operatorId();
  return unassignVehicleEngine(await appDb(), { bookingId, operatorId: opsId });
}

export async function assignDriverFromRequest(
  bookingId: string,
  driverId: string,
): Promise<AssignmentSnapshot> {
  const opsId = await operatorId();
  return assignDriverEngine(await appDb(), {
    bookingId,
    driverId,
    operatorId: opsId,
  });
}

export async function unassignDriverFromRequest(bookingId: string): Promise<AssignmentSnapshot> {
  const opsId = await operatorId();
  return unassignDriverEngine(await appDb(), { bookingId, operatorId: opsId });
}

export async function cancelBookingFromRequest(bookingId: string): Promise<AssignmentSnapshot> {
  const opsId = await operatorId();
  return cancelBookingEngine(await appDb(), { bookingId, operatorId: opsId });
}

export async function setBookingStatusFromRequest(
  bookingId: string,
  status: string,
): Promise<AssignmentSnapshot> {
  const opsId = await operatorId();
  return setBookingStatusEngine(await appDb(), {
    bookingId,
    status,
    operatorId: opsId,
  });
}

export { InventoryError } from "./inventory";
export type { AssignmentSnapshot } from "./inventory";
