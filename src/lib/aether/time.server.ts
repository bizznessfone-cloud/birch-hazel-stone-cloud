/**
 * Server adapter for the time domain. SQL remains the authority.
 */
import { getSql } from "@/lib/db";
import {
  athensDate,
  athensInstant,
  athensToday,
  occupancyBounds,
  type TimeDb,
} from "./time";

async function db(): Promise<TimeDb> {
  const sql = await getSql();
  return { query: (text, params) => sql.query(text, params) };
}

export async function athensInstantFromDb(
  transferDate: string,
  pickupTime: string,
): Promise<string> {
  return athensInstant(await db(), transferDate, pickupTime);
}

export async function occupancyBoundsFromDb(
  transferDate: string,
  pickupTime: string,
  durationMinutes: number,
) {
  return occupancyBounds(await db(), transferDate, pickupTime, durationMinutes);
}

export async function athensDateFromDb(instantIso: string): Promise<string> {
  return athensDate(await db(), instantIso);
}

export async function athensTodayFromDb(): Promise<string> {
  return athensToday(await db());
}
