/**
 * HTTP adapter for the public booking engine. Server-only.
 * Does not call requireOps — guest create/lookup is unauthenticated.
 */
import { CompiledQuery, type Kysely, type Transaction } from "kysely";
import { getRequest } from "@tanstack/react-start/server";
import { getAetherDb } from "./kysely";
import type { AetherDatabase } from "./schema";
import {
  createBooking as createBookingEngine,
  getPublicBookingByToken as getPublicBookingByTokenEngine,
  getPublicHotel as getPublicHotelEngine,
  type BookingDb,
  type CreateBookingInput,
  type CreatedBooking,
  type PublicBooking,
  type PublicHotel,
} from "./booking";
import { assertGuestCreateRateLimit, hashGuestClientKey } from "./guest-rate-limit";
import { sendConfirmationEmail, type ConfirmationEmailStatus } from "./confirmation-email";

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
  try {
    const request = getRequest();
    const forwarded = request?.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = request?.headers.get("x-real-ip")?.trim();
    if (real) return real;
  } catch {
    /* no request context (tests) */
  }
  return "unknown";
}

function requestOrigin(): string | undefined {
  try {
    return getRequest()?.headers.get("origin") || undefined;
  } catch {
    /* no request context (tests) */
    return undefined;
  }
}

export async function createBookingFromRequest(
  input: CreateBookingInput,
): Promise<CreatedBooking & { confirmationEmailStatus: ConfirmationEmailStatus }> {
  const db = await appDb();
  await assertGuestCreateRateLimit(db, hashGuestClientKey(requestClientHint()));

  // The booking engine completes its transaction before returning. Email is a
  // separate side effect: a provider failure must never roll back a booking.
  const booking = await createBookingEngine(db, input);
  const email = await sendConfirmationEmail(booking, input.guestEmail, { origin: requestOrigin() });

  return {
    ...booking,
    confirmationEmailStatus: email.status,
  };
}

export async function getPublicBookingFromRequest(token: string): Promise<PublicBooking> {
  return getPublicBookingByTokenEngine(await appDb(), token);
}

export async function getPublicHotelFromRequest(hotelCode: string): Promise<PublicHotel> {
  return getPublicHotelEngine(await appDb(), hotelCode);
}

export { BookingError } from "./booking";
export type { CreateBookingInput, CreatedBooking, PublicBooking, PublicHotel } from "./booking";
