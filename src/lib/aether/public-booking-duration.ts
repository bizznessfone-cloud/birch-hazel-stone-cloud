/**
 * Provisional occupancy duration for the public guest booking path.
 * Guests cannot supply or configure this value. It is not the final operating rule.
 */
import { BookingError, type CreateBookingInput } from "./booking.ts";

export const PROVISIONAL_PUBLIC_DURATION_MINUTES = 60;

export type PublicBookingRequest = Omit<CreateBookingInput, "durationMinutes">;

export function publicBookingEngineInput(input: PublicBookingRequest): CreateBookingInput {
  if (
    input !== null &&
    typeof input === "object" &&
    Object.prototype.hasOwnProperty.call(input, "durationMinutes")
  ) {
    throw new BookingError("duration_not_accepted", 400, "duration is assigned by the server");
  }
  return {
    hotelCode: input.hotelCode,
    destinationId: input.destinationId,
    transferDate: input.transferDate,
    pickupTime: input.pickupTime,
    durationMinutes: PROVISIONAL_PUBLIC_DURATION_MINUTES,
    guestName: input.guestName,
    guestPhone: input.guestPhone,
    guestEmail: input.guestEmail,
    passengerCount: input.passengerCount,
    luggageCount: input.luggageCount,
    pickupText: input.pickupText,
    destinationText: input.destinationText,
    specialRequirements: input.specialRequirements,
    idempotencyKey: input.idempotencyKey,
    direction: input.direction,
  };
}
