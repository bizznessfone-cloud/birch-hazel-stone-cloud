/**
 * Token lookup for the guest status page. Server only.
 * Does not open checkout or write a booking.
 */
import { BookingError, type PublicBooking } from "./booking.ts";
import { projectPublicGuestStatus, type PublicGuestBooking } from "./public-booking-status.ts";

type GuestReadDb = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

type GuestRow = {
  hotel_code: string;
  hotel_name: string;
  transfer_date: string;
  pickup_time: string;
  duration_minutes: number;
  guest_name: string;
  passenger_count: number;
  luggage_count: number;
  pickup_text: string;
  destination_text: string;
  destination_id: string | null;
  quoted_amount_minor: number | null;
  quoted_currency: string | null;
  human_reference: string;
  lifecycle_state: string | null;
  confirmed_paid_at: string | null;
  cancelled_at: string | null;
  payment_status: string | null;
  paid_at: string | null;
  binding_complete: boolean | null;
  provider_match: boolean | null;
};

const GUEST_SELECT = `
  select
    h.code as hotel_code,
    h.name as hotel_name,
    b.transfer_date::text as transfer_date,
    b.pickup_time::text as pickup_time,
    b.duration_minutes,
    b.guest_name,
    b.passenger_count,
    b.luggage_count,
    b.pickup_text,
    b.destination_text,
    b.destination_id,
    b.quoted_amount_minor,
    btrim(b.quoted_currency) as quoted_currency,
    b.human_reference,
    b.lifecycle_state,
    b.confirmed_paid_at,
    b.cancelled_at,
    p.status as payment_status,
    p.paid_at,
    (
      p.payee_organisation_id is not null
      and p.payee_stripe_account_id is not null
      and btrim(p.payee_stripe_account_id) <> ''
      and p.payee_kind is not null
      and p.authority_bound_at is not null
    ) as binding_complete,
    (
      p.executing_provider_id is not null
      and p.executing_provider_id = b.executing_provider_id
    ) as provider_match
  from bookings b
  join hotels h on h.id = b.hotel_id
  left join sbg_booking_payments p on p.booking_id = b.id
  where b.confirmation_token = $1
`;

function toGuestBooking(row: GuestRow): PublicGuestBooking {
  const pickup = String(row.pickup_time);
  const pricing: PublicBooking["pricing"] =
    row.quoted_amount_minor == null || row.quoted_currency == null
      ? { priced: false, currency: null, amountMinor: null }
      : {
          priced: true,
          currency: String(row.quoted_currency).trim(),
          amountMinor: Number(row.quoted_amount_minor),
        };
  return {
    humanReference: row.human_reference,
    hotelCode: row.hotel_code,
    hotelName: row.hotel_name,
    transferDate: String(row.transfer_date).slice(0, 10),
    pickupTime: pickup.length >= 5 ? pickup.slice(0, 5) : pickup,
    durationMinutes: Number(row.duration_minutes),
    guestName: row.guest_name,
    passengerCount: Number(row.passenger_count),
    luggageCount: Number(row.luggage_count),
    pickupText: row.pickup_text,
    destinationText: row.destination_text,
    destinationId: row.destination_id,
    cancelled: row.cancelled_at != null,
    pricing,
    guestStatus: projectPublicGuestStatus({
      lifecycle: row.lifecycle_state,
      confirmedPaidAt: row.confirmed_paid_at == null ? null : String(row.confirmed_paid_at),
      cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
      paymentStatus: row.payment_status,
      paidAt: row.paid_at == null ? null : String(row.paid_at),
      bindingComplete: row.binding_complete === true,
      providerMatch: row.provider_match === true,
    }),
  };
}

export async function getPublicGuestBooking(db: GuestReadDb, token: string): Promise<PublicGuestBooking> {
  const value = typeof token === "string" ? token.trim() : "";
  if (!value) throw new BookingError("not_found", 404, "booking not found");
  const rows = await db.query<GuestRow>(GUEST_SELECT, [value]);
  const row = rows[0];
  if (!row) throw new BookingError("not_found", 404, "booking not found");
  return toGuestBooking(row);
}
