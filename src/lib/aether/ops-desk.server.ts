/**
 * HTTP adapter for the ops desk. Server-only. requireOps on every call.
 */
import { CompiledQuery, type Kysely } from "kysely";
import { getAetherDb } from "./kysely";
import type { AetherDatabase } from "./schema";
import type { OpsDeskDb } from "./ops-desk";
import {
  getOpsBooking,
  listOpsAudit,
  listOpsBookings,
  listOpsDrivers,
  listOpsHotels,
  listOpsVehicles,
  loadTodayBoard,
  upsertDriver,
  upsertHotel,
  upsertVehicle,
} from "./ops-desk";

function asDb(exec: Kysely<AetherDatabase>): OpsDeskDb {
  return {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await exec.executeQuery<T>(CompiledQuery.raw(text, params));
      return result.rows as T[];
    },
  };
}

async function requireRead() {
  const { requireOps } = await import("./ops-auth.server");
  const scope = await requireOps({ csrf: false });
  return { db: asDb(await getAetherDb()), scope };
}

async function requireMutate() {
  const { requireOps } = await import("./ops-auth.server");
  const scope = await requireOps({ csrf: true });
  return { db: asDb(await getAetherDb()), scope };
}

export async function todayBoardFromRequest() {
  const { db, scope } = await requireRead();
  return loadTodayBoard(db, scope);
}

export async function listBookingsFromRequest() {
  const { db, scope } = await requireRead();
  return listOpsBookings(db, scope);
}

export async function getBookingFromRequest(bookingId: string) {
  const { db, scope } = await requireRead();
  const booking = await getOpsBooking(db, scope, bookingId);
  const audit = await listOpsAudit(db, scope, bookingId);
  if (scope.accessClass === "hotel_desk") {
    return { booking, audit, vehicles: [], drivers: [] };
  }
  const vehicles = await listOpsVehicles(db, scope);
  const drivers = await listOpsDrivers(db, scope);
  return { booking, audit, vehicles, drivers };
}

export async function listVehiclesFromRequest() {
  const { db, scope } = await requireRead();
  return listOpsVehicles(db, scope);
}

export async function listDriversFromRequest() {
  const { db, scope } = await requireRead();
  return listOpsDrivers(db, scope);
}

export async function listHotelsFromRequest() {
  const { db, scope } = await requireRead();
  return listOpsHotels(db, scope);
}

export async function upsertVehicleFromRequest(input: {
  id?: string | null;
  name: string;
  capacity: number;
  active: boolean;
}) {
  const { db, scope } = await requireMutate();
  return upsertVehicle(db, scope, input);
}

export async function upsertDriverFromRequest(input: {
  id?: string | null;
  name: string;
  active: boolean;
}) {
  const { db, scope } = await requireMutate();
  return upsertDriver(db, scope, input);
}

export async function upsertHotelFromRequest(input: {
  id?: string | null;
  code: string;
  name: string;
}) {
  const { db, scope } = await requireMutate();
  return upsertHotel(db, scope, input);
}
