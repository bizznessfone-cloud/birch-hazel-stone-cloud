/**
 * Guest UX helpers. No operator auth. Token is the only booking credential.
 * Vehicle cards are informational, not inventory SKUs.
 */
import type { BookingErrorCode } from "./booking.ts";

export const THEME_STORAGE_KEY = "aether-theme";
export const DEFAULT_DURATION_MINUTES = 60;

export type PlaceKind = "airport" | "port" | "hotel" | "other";
export type Direction = "from_hotel" | "to_hotel";

export type GuestDraft = {
  direction: Direction;
  placeKind: PlaceKind;
  destinationId: string | null;
  pickupText: string;
  destinationText: string;
  transferDate: string;
  pickupTime: string;
  durationMinutes: number;
  passengerCount: number;
  luggageCount: number;
  guestName: string;
  guestPhone: string;
  guestEmail: string;
  specialRequirements: string;
};

export function emptyDraft(hotelName: string): GuestDraft {
  return {
    direction: "from_hotel",
    placeKind: "airport",
    destinationId: null,
    pickupText: hotelName,
    destinationText: "",
    transferDate: "",
    pickupTime: "",
    durationMinutes: DEFAULT_DURATION_MINUTES,
    passengerCount: 1,
    luggageCount: 0,
    guestName: "",
    guestPhone: "",
    guestEmail: "",
    specialRequirements: "",
  };
}

export function applyDirection(
  draft: GuestDraft,
  direction: Direction,
  hotelName: string,
  destinationName?: string,
): GuestDraft {
  const other = (destinationName ?? draft.destinationText).trim();
  if (direction === "from_hotel") {
    return { ...draft, direction, pickupText: hotelName, destinationText: other };
  }
  return { ...draft, direction, pickupText: other, destinationText: hotelName };
}

export function touristMessage(code: string, fallback?: string): string {
  switch (code as BookingErrorCode | "server_error") {
    case "hotel_not_found":
      return "We could not find this booking page.";
    case "hotel_not_live":
      return "Transfers are not available for this hotel yet.";
    case "invalid_time":
      return "Please choose a valid date and time.";
    case "nonexistent":
      return "That time does not exist on this date. Please choose another time.";
    case "ambiguous":
      return "That time is ambiguous on this date. Please choose another time.";
    case "invalid_duration":
      return "Please choose a duration between 1 and 1440 minutes.";
    case "invalid_party":
      return "Please check the passenger and luggage counts.";
    case "invalid_contact":
      return "Please check name, phone and email.";
    case "invalid_location":
      return "Please add a pickup and destination.";
    case "invalid_destination":
      return "Please choose a destination from the list.";
    case "not_found":
      return "We could not find that booking.";
    case "no_provider":
      return "Transfers are not available for this hotel yet.";
    case "idempotency_conflict":
      return "This request does not match a booking already started. Please review and try again.";
    case "rate_limited":
      return "Please wait a moment and try again.";
    case "server_error":
      return "Something went wrong. Please try again.";
    default:
      return fallback || "Something went wrong. Please try again.";
  }
}

export type VehicleHint = {
  title: string;
  note: string;
};

/** Informational comfort guide. Not a reserved vehicle and not an inventory SKU. */
export function vehicleHint(passengers: number, luggage: number): VehicleHint {
  if (passengers >= 5 || luggage >= 5) {
    return {
      title: "Minivan",
      note: "A larger vehicle is usually more comfortable for this party. The hotel assigns the actual car.",
    };
  }
  if (passengers >= 3 || luggage >= 3) {
    return {
      title: "Estate",
      note: "A little extra space is usually more comfortable. The hotel assigns the actual car.",
    };
  }
  return {
    title: "Saloon",
    note: "A standard car is usually comfortable for this party. The hotel assigns the actual car.",
  };
}

export function formatQuotedPrice(currency: string, amountMinor: number): string {
  return `${currency} ${(amountMinor / 100).toFixed(2)}`;
}

export { hotelMarkLetters } from "./hotel.ts";

export function placeKindLabel(kind: PlaceKind): string {
  switch (kind) {
    case "airport":
      return "Airport";
    case "port":
      return "Port";
    case "hotel":
      return "Hotel";
    case "other":
      return "Other";
  }
}
