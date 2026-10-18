/**
 * Guest create after the client-IP limiter. No auth server, no operator auth.
 * Booking creation does not send a paid confirmation email.
 * That delivery is a separate claim after confirmed_paid, outside this request.
 */
import {
  createBooking as createBookingEngine,
  type BookingDb,
  type CreateBookingInput,
  type CreatedBooking,
} from "./booking.ts";
import type { ConfirmationEmailStatus } from "./confirmation-email.ts";
import { assertGuestCreateRateLimit, hashGuestClientKey } from "./guest-rate-limit.ts";
import type { EnvMap } from "./runtime-config.ts";

export async function createLimitedGuestBooking(
  db: BookingDb,
  input: CreateBookingInput,
  clientHint: string,
  env: EnvMap = process.env,
): Promise<CreatedBooking & { confirmationEmailStatus: ConfirmationEmailStatus }> {
  await assertGuestCreateRateLimit(db, hashGuestClientKey(clientHint), new Date(), env);

  const booking = await createBookingEngine(db, input);

  return {
    ...booking,
    confirmationEmailStatus: "not_configured",
  };
}
