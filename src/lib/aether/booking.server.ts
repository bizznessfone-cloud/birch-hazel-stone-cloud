/**
 * HTTP adapter for the public booking engine. Server-only.
 * Does not call requireOps — guest create/lookup is unauthenticated.
 */
import { CompiledQuery, type Kysely, type Transaction } from "kysely";
import { getAetherDb } from "./kysely";
import type { AetherDatabase } from "./schema";
import {
  createBooking as createBookingEngine,
  getPublicBookingByToken as getPublicBookingByTokenEngine,
  getPublicHotel as getPublicHotelEngine,
  type BookingDb,
  type CreateBookingInput,
  type PublicBooking,
} from "./booking";

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

export async function createBookingFromRequest(
  input: CreateBookingInput,
): Promise<PublicBooking> {
  return createBookingEngine(await appDb(), input);
}

export async function getPublicBookingFromRequest(token: string): Promise<PublicBooking> {
  return getPublicBookingByTokenEngine(await appDb(), token);
}

export async function getPublicHotelFromRequest(hotelCode: string) {
  return getPublicHotelEngine(await appDb(), hotelCode);
}

export { BookingError } from "./booking";
export type { CreateBookingInput, PublicBooking } from "./booking";

