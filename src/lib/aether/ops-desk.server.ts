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

async function requireRead(): Promise<OpsDeskDb> {
  const { requireOps } = await import("./ops-auth.server");
  await requireOps({ csrf: false });
  return asDb(await getAetherDb());
}

async function requireMutate(): Promise<OpsDeskDb> {
  const { requireOps } = await import("./ops-auth.server");
  await requireOps({ csrf: true });
  return asDb(await getAetherDb());
}

export async function todayBoardFromRequest() {
  return loadTodayBoard(await requireRead());
}

export async function listBookingsFromRequest() {
  return listOpsBookings(await requireRead());
}

export async function getBookingFromRequest(bookingId: string) {
  const db = await requireRead();
  const booking = await getOpsBooking(db, bookingId);
  const audit = await listOpsAudit(db, bookingId);
  const vehicles = await listOpsVehicles(db);
  const drivers = await listOpsDrivers(db);
  return { booking, audit, vehicles, drivers };
}

export async function listVehiclesFromRequest() {
  return listOpsVehicles(await requireRead());
}

export async function listDriversFromRequest() {
  return listOpsDrivers(await requireRead());
}

export async function listHotelsFromRequest() {
  return listOpsHotels(await requireRead());
}

export async function upsertVehicleFromRequest(input: {
  id?: string | null;
  name: string;
  capacity: number;
  active: boolean;
}) {
  return upsertVehicle(await requireMutate(), input);
}

export async function upsertDriverFromRequest(input: {
  id?: string | null;
  name: string;
  active: boolean;
}) {
  return upsertDriver(await requireMutate(), input);
}

export async function upsertHotelFromRequest(input: {
  id?: string | null;
  code: string;
  name: string;
}) {
  return upsertHotel(await requireMutate(), input);
}
