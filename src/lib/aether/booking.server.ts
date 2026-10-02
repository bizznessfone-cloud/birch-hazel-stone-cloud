/**
 * HTTP adapter for the public booking engine. Server-only.
 * Does not call requireOps — guest create/lookup is unauthenticated.
 */
import { CompiledQuery, type Kysely, type Transaction } from "kysely";
import { getRequest } from "@tanstack/react-start/server";
import { getAetherDb } from "./kysely";
import type { AetherDatabase } from "./schema";
import {
  getPublicBookingByToken as getPublicBookingByTokenEngine,
  getPublicHotel as getPublicHotelEngine,
  type BookingDb,
  type CreateBookingInput,
  type PublicBooking,
  type PublicHotel,
} from "./booking";
import { guestLimiterIdentity } from "./client-ip";
import { createLimitedGuestBooking } from "./guest-create";

type Executable = Kysely<AetherDatabase> | Transaction<AetherDatabase>;

function asBookingDb(exec: Executable): BookingDb {
  return {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await exec.executeQuery<T>(CompiledQuery.raw(text, params));
      return result.rows as T[];
    },
    transaction<T>(fn: (db: BookingDb) => Promise<T>): Promise<T> {
      if ("transaction" in exec && typeof exec.transaction === "function") {
        return exec.transaction().execute((trx) => fn(asBookingDb(trx)));
      }
      throw new Error("nested booking transaction");
    },
  };
}

async function appDb(): Promise<BookingDb> {
  return asBookingDb(await getAetherDb());
}

function requestClientHint(): string {
  let headers: { get(name: string): string | null } | null = null;
  try {
    const request = getRequest();
    headers = request?.headers ?? null;
  } catch {
    /* no request context (tests) */
  }
  return guestLimiterIdentity(headers);
}

export async function createBookingFromRequest(
  input: CreateBookingInput,
): Promise<Awaited<ReturnType<typeof createLimitedGuestBooking>>> {
  return createLimitedGuestBooking(await appDb(), input, requestClientHint());
}

export async function getPublicBookingFromRequest(token: string): Promise<PublicBooking> {
  return getPublicBookingByTokenEngine(await appDb(), token);
}

export async function getPublicHotelFromRequest(hotelCode: string): Promise<PublicHotel> {
  return getPublicHotelEngine(await appDb(), hotelCode);
}

export { BookingError } from "./booking";
export type { CreateBookingInput, CreatedBooking, PublicBooking, PublicHotel } from "./booking";
