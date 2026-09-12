/**
 * Public booking engine. Hotel-scoped create + token lookup.
 * Does not write bookings.occupies — the PostgreSQL trigger does.
 * Does not assign vehicles or drivers. No guest accounts.
 * CP14.2: LIVE hotel + catalogue destination; server stamps the quote.
 */
import { createHash, randomBytes } from "node:crypto";
import { hotelIdentity, type HotelIdentity } from "./hotel.ts";
import {
  civilInstant,
  CivilTimeError,
  assertDurationMinutes,
  type TimeDb,
} from "./time.ts";

export const BOOKING_CREATE_SCOPE = "booking.create";
export const HUMAN_REFERENCE_PREFIX = "PT-";

export type BookingDb = TimeDb & {
  transaction<T>(fn: (db: BookingDb) => Promise<T>): Promise<T>;
};

export type BookingErrorCode =
  | "hotel_not_found"
  | "hotel_not_live"
  | "invalid_time"
  | "invalid_duration"
  | "nonexistent"
  | "ambiguous"
  | "invalid_party"
  | "invalid_contact"
  | "invalid_location"
  | "invalid_destination"
  | "idempotency_conflict"
  | "not_found"
  | "no_provider"
  | "rate_limited";

export class BookingError extends Error {
  readonly code: BookingErrorCode;
  readonly status: number;
  constructor(code: BookingErrorCode, status: number, message: string) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    this.status = status;
  }
}

export type PriceQuote =
  | { priced: false; currency: null; amountMinor: null }
  | { priced: true; currency: string; amountMinor: number };

export function quoteBooking(): PriceQuote {
  return { priced: false, currency: null, amountMinor: null };
}

export function formatQuotedPrice(currency: string, amountMinor: number): string {
  return `${currency} ${(amountMinor / 100).toFixed(2)}`;
}

export type PublicDestination = {
  id: string;
  kind: "airport" | "port" | "hotel" | "other";
  name: string;
  amountMinor: number;
  sortOrder: number;
};

export type PublicHotel = HotelIdentity & {
  currency: string;
  destinations: PublicDestination[];
};

export type CreateBookingInput = {
  hotelCode: string;
  destinationId: string;
  transferDate: string;
  pickupTime: string;
  durationMinutes: number;
  guestName: string;
  guestPhone: string;
  guestEmail: string;
  passengerCount: number;
  luggageCount: number;
  pickupText: string;
  destinationText?: string | null;
  specialRequirements?: string | null;
  idempotencyKey?: string | null;
  quotedAmountMinor?: unknown;
  quotedCurrency?: unknown;
  amountMinor?: unknown;
  currency?: unknown;
  amount?: unknown;
};

export type PublicBooking = {
  humanReference: string;
  hotelCode: string;
  hotelName: string;
  transferDate: string;
  pickupTime: string;
  durationMinutes: number;
  guestName: string;
  passengerCount: number;
  luggageCount: number;
  pickupText: string;
  destinationText: string;
  destinationId: string | null;
  cancelled: boolean;
  pricing: PriceQuote;
};

/** Create response may include the confirmation token so the client can redirect. */
export type CreatedBooking = PublicBooking & {
  confirmationToken: string;
};

type Validated = {
  hotelCode: string;
  destinationId: string;
  transferDate: string;
  pickupTime: string;
  durationMinutes: number;
  guestName: string;
  guestPhone: string;
  guestEmail: string;
  passengerCount: number;
  luggageCount: number;
  pickupText: string;
  specialRequirements: string | null;
};

type ResolvedQuote = {
  hotelId: string;
  hotelCode: string;
  currency: string;
  providerId: string;
  destinationId: string;
  destinationName: string;
  amountMinor: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CROCKFORD = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

function trimRequired(value: unknown, code: BookingErrorCode, message: string): string {
  if (typeof value !== "string") throw new BookingError(code, 400, message);
  const trimmed = value.trim();
  if (!trimmed) throw new BookingError(code, 400, message);
  return trimmed;
}

function normalizeTime(raw: string): string {
  if (!TIME_RE.test(raw)) {
    throw new BookingError("invalid_time", 400, "invalid pickup time");
  }
  return raw.length === 5 ? `${raw}:00` : raw;
}

function newHumanReference(): string {
  const bytes = randomBytes(10);
  let out = HUMAN_REFERENCE_PREFIX;
  for (let i = 0; i < 10; i += 1) {
    out += CROCKFORD[bytes[i]! % CROCKFORD.length];
  }
  return out;
}

export function newConfirmationToken(): string {
  return randomBytes(32).toString("base64url");
}

function requestHash(v: Validated, quote: ResolvedQuote): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        hotelCode: v.hotelCode,
        destinationId: quote.destinationId,
        quotedAmountMinor: quote.amountMinor,
        quotedCurrency: quote.currency,
        destinationName: quote.destinationName,
        transferDate: v.transferDate,
        pickupTime: v.pickupTime,
        durationMinutes: v.durationMinutes,
        guestName: v.guestName,
        guestPhone: v.guestPhone,
        guestEmail: v.guestEmail,
        passengerCount: v.passengerCount,
        luggageCount: v.luggageCount,
        pickupText: v.pickupText,
        specialRequirements: v.specialRequirements,
      }),
    )
    .digest("hex");
}

function validateInput(input: CreateBookingInput): Validated {
  const hotelCode = trimRequired(input.hotelCode, "hotel_not_found", "hotel is required").toLowerCase();
  const destinationId = trimRequired(
    input.destinationId,
    "invalid_destination",
    "destination is required",
  ).toLowerCase();
  if (!UUID_RE.test(destinationId)) {
    throw new BookingError("invalid_destination", 400, "destination is required");
  }
  const transferDate = trimRequired(input.transferDate, "invalid_time", "transfer date is required");
  if (!DATE_RE.test(transferDate)) {
    throw new BookingError("invalid_time", 400, "invalid transfer date");
  }
  const pickupTime = normalizeTime(
    trimRequired(input.pickupTime, "invalid_time", "pickup time is required"),
  );
  try {
    assertDurationMinutes(input.durationMinutes);
  } catch (err) {
    if (err instanceof CivilTimeError) {
      throw new BookingError("invalid_duration", 400, err.message);
    }
    throw err;
  }

  if (!Number.isInteger(input.passengerCount) || input.passengerCount < 1 || input.passengerCount > 1000) {
    throw new BookingError("invalid_party", 400, "invalid passenger count");
  }
  if (!Number.isInteger(input.luggageCount) || input.luggageCount < 0 || input.luggageCount > 1000) {
    throw new BookingError("invalid_party", 400, "invalid luggage count");
  }

  const guestName = trimRequired(input.guestName, "invalid_contact", "guest name is required");
  const guestPhone = trimRequired(input.guestPhone, "invalid_contact", "guest phone is required");
  if (guestPhone.replace(/[+\d\s()-]/g, "").length > 0 || guestPhone.replace(/\D/g, "").length < 5) {
    throw new BookingError("invalid_contact", 400, "invalid guest phone");
  }
  const guestEmail = trimRequired(input.guestEmail, "invalid_contact", "guest email is required").toLowerCase();
  if (!EMAIL_RE.test(guestEmail)) {
    throw new BookingError("invalid_contact", 400, "invalid guest email");
  }

  const pickupText = trimRequired(input.pickupText, "invalid_location", "pickup is required");

  let specialRequirements: string | null = null;
  if (input.specialRequirements != null && String(input.specialRequirements).trim()) {
    specialRequirements = String(input.specialRequirements).trim();
  }

  return {
    hotelCode,
    destinationId,
    transferDate,
    pickupTime,
    durationMinutes: input.durationMinutes,
    guestName,
    guestPhone,
    guestEmail,
    passengerCount: input.passengerCount,
    luggageCount: input.luggageCount,
    pickupText,
    specialRequirements,
  };
}

type BookingRow = {
  id: string;
  hotel_code: string;
  hotel_name: string;
  transfer_date: string;
  pickup_time: string;
  duration_minutes: number;
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  passenger_count: number;
  luggage_count: number;
  pickup_text: string;
  destination_text: string;
  destination_id: string | null;
  quoted_amount_minor: number | null;
  quoted_currency: string | null;
  special_requirements: string | null;
  human_reference: string;
  confirmation_token: string;
  cancelled_at: string | null;
};

function toPriceQuote(row: BookingRow): PriceQuote {
  if (row.quoted_amount_minor == null || row.quoted_currency == null) {
    return quoteBooking();
  }
  return {
    priced: true,
    currency: String(row.quoted_currency).trim(),
    amountMinor: Number(row.quoted_amount_minor),
  };
}

function toPublic(row: BookingRow): PublicBooking {
  const pickup = String(row.pickup_time);
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
    pricing: toPriceQuote(row),
  };
}

function toCreated(row: BookingRow): CreatedBooking {
  return {
    ...toPublic(row),
    confirmationToken: row.confirmation_token,
  };
}

const PUBLIC_SELECT = `
  select
    b.id,
    h.code as hotel_code,
    h.name as hotel_name,
    b.transfer_date::text as transfer_date,
    b.pickup_time::text as pickup_time,
    b.duration_minutes,
    b.guest_name,
    b.guest_phone,
    b.guest_email,
    b.passenger_count,
    b.luggage_count,
    b.pickup_text,
    b.destination_text,
    b.destination_id,
    b.quoted_amount_minor,
    btrim(b.quoted_currency) as quoted_currency,
    b.special_requirements,
    b.human_reference,
    b.confirmation_token,
    b.cancelled_at
  from bookings b
  join hotels h on h.id = b.hotel_id
`;

async function loadCreatedById(db: BookingDb, id: string): Promise<CreatedBooking> {
  const rows = await db.query<BookingRow>(`${PUBLIC_SELECT} where b.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new BookingError("not_found", 404, "booking not found");
  return toCreated(row);
}

async function resolveLiveQuote(db: BookingDb, v: Validated): Promise<ResolvedQuote> {
  const hotels = await db.query<{
    id: string;
    code: string;
    currency: string;
    status: string;
    iana_timezone: string;
  }>(
    `select id, code, btrim(currency) as currency, status,
            btrim(iana_timezone) as iana_timezone
       from hotels
      where lower(code) = $1`,
    [v.hotelCode],
  );
  const hotel = hotels[0];
  if (!hotel) throw new BookingError("hotel_not_found", 404, "hotel not found");
  if (hotel.status !== "live") {
    throw new BookingError("hotel_not_live", 409, "hotel is not live");
  }

  const dest = await db.query<{
    id: string;
    name: string;
    amount_minor: number;
    active: boolean;
  }>(
    `select id, name, amount_minor, active
       from hotel_destinations
      where id = $1::uuid and hotel_id = $2::uuid`,
    [v.destinationId, hotel.id],
  );
  const destination = dest[0];
  if (!destination) {
    throw new BookingError("invalid_destination", 400, "destination is not available");
  }
  if (!destination.active) {
    throw new BookingError("invalid_destination", 400, "destination is not available");
  }

  const provider = await db.query<{ provider_id: string }>(
    `select provider_id
       from hotel_provider_agreements
      where hotel_id = $1::uuid and active
      limit 1`,
    [hotel.id],
  );
  if (!provider[0]) {
    throw new BookingError("no_provider", 409, "no active executing provider");
  }

  try {
    await civilInstant(db, v.transferDate, v.pickupTime, hotel.iana_timezone);
  } catch (err) {
    if (err instanceof CivilTimeError) {
      throw new BookingError(err.code, 400, err.message);
    }
    throw err;
  }

  return {
    hotelId: hotel.id,
    hotelCode: hotel.code,
    currency: hotel.currency,
    providerId: provider[0].provider_id,
    destinationId: destination.id,
    destinationName: destination.name.trim(),
    amountMinor: Number(destination.amount_minor),
  };
}

async function insertBooking(
  db: BookingDb,
  quote: ResolvedQuote,
  v: Validated,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const human = newHumanReference();
    const token = newConfirmationToken();
    try {
      const rows = await db.query<{ id: string }>(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email,
           passenger_count, luggage_count,
           pickup_text, destination_text, special_requirements,
           human_reference, confirmation_token,
           destination_id, quoted_amount_minor, quoted_currency
         ) values (
           $1, $2, $3::date, $4::time, $5,
           $6, $7, $8,
           $9, $10,
           $11, $12, $13::text,
           $14, $15,
           $16::uuid, $17, $18
         )
         returning id`,
        [
          quote.hotelId,
          quote.providerId,
          v.transferDate,
          v.pickupTime,
          v.durationMinutes,
          v.guestName,
          v.guestPhone,
          v.guestEmail,
          v.passengerCount,
          v.luggageCount,
          v.pickupText,
          quote.destinationName,
          v.specialRequirements,
          human,
          token,
          quote.destinationId,
          quote.amountMinor,
          quote.currency,
        ],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("booking insert failed");
      return id;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") continue;
      throw err;
    }
  }
  throw new Error("could not allocate unique reference/token");
}

async function createFresh(db: BookingDb, v: Validated, quote: ResolvedQuote): Promise<string> {
  const id = await insertBooking(db, quote, v);
  await db.query(
    `insert into audit_events (actor_type, action, booking_id, payload)
     values ('guest', 'booking.create', $1::uuid, jsonb_build_object(
       'hotel_code', $2::text,
       'destination_id', $3::text,
       'quoted_amount_minor', $4::int,
       'quoted_currency', $5::text
     ))`,
    [id, v.hotelCode, quote.destinationId, quote.amountMinor, quote.currency],
  );
  return id;
}

export async function createBooking(
  db: BookingDb,
  input: CreateBookingInput,
): Promise<CreatedBooking> {
  const v = validateInput(input);
  const key = input.idempotencyKey?.trim() || null;
  if (key && key.length > 200) {
    throw new BookingError("idempotency_conflict", 400, "invalid idempotency key");
  }

  const run = async (txn: BookingDb): Promise<string> => {
    const quote = await resolveLiveQuote(txn, v);
    const hash = requestHash(v, quote);
    if (!key) return createFresh(txn, v, quote);

    const claimed = await txn.query<{ id: string }>(
      `insert into idempotency_keys (scope, key, request_hash)
       values ($1, $2, $3)
       on conflict (scope, key) do nothing
       returning id`,
      [BOOKING_CREATE_SCOPE, key, hash],
    );

    if (claimed[0]) {
      const bookingId = await createFresh(txn, v, quote);
      await txn.query(
        `update idempotency_keys set booking_id = $1 where id = $2`,
        [bookingId, claimed[0].id],
      );
      return bookingId;
    }

    const existing = await txn.query<{ request_hash: string; booking_id: string | null }>(
      `select request_hash, booking_id
       from idempotency_keys
       where scope = $1 and key = $2`,
      [BOOKING_CREATE_SCOPE, key],
    );
    const row = existing[0];
    if (!row) throw new BookingError("idempotency_conflict", 409, "idempotency conflict");
    if (row.request_hash !== hash) {
      throw new BookingError("idempotency_conflict", 409, "idempotency conflict");
    }
    if (row.booking_id) return row.booking_id;
    const bookingId = await createFresh(txn, v, quote);
    await txn.query(
      `update idempotency_keys
       set booking_id = $1
       where scope = $2 and key = $3 and booking_id is null`,
      [bookingId, BOOKING_CREATE_SCOPE, key],
    );
    return bookingId;
  };

  const id = key ? await db.transaction(run) : await run(db);
  return loadCreatedById(db, id);
}

export async function getPublicBookingByToken(
  db: BookingDb,
  token: string,
): Promise<PublicBooking> {
  const value = typeof token === "string" ? token.trim() : "";
  if (!value) throw new BookingError("not_found", 404, "booking not found");
  const rows = await db.query<BookingRow>(
    `${PUBLIC_SELECT} where b.confirmation_token = $1`,
    [value],
  );
  const row = rows[0];
  if (!row) throw new BookingError("not_found", 404, "booking not found");
  return toPublic(row);
}

export async function getPublicHotel(db: TimeDb, hotelCode: string): Promise<PublicHotel> {
  const code = typeof hotelCode === "string" ? hotelCode.trim().toLowerCase() : "";
  if (!code) throw new BookingError("hotel_not_found", 404, "hotel not found");
  const rows = await db.query<{
    id: string;
    code: string;
    name: string;
    currency: string;
    status: string;
  }>(
    `select id, code, name, btrim(currency) as currency, status
       from hotels
      where lower(code) = $1`,
    [code],
  );
  const row = rows[0];
  if (!row) throw new BookingError("hotel_not_found", 404, "hotel not found");
  if (row.status !== "live") {
    throw new BookingError("hotel_not_live", 409, "hotel is not live");
  }
  const destinations = await db.query<{
    id: string;
    kind: PublicDestination["kind"];
    name: string;
    amount_minor: number;
    sort_order: number;
  }>(
    `select id, kind, name, amount_minor, sort_order
       from hotel_destinations
      where hotel_id = $1::uuid and active
      order by sort_order, name`,
    [row.id],
  );
  try {
    return {
      ...hotelIdentity(row),
      currency: row.currency,
      destinations: destinations.map((dest) => ({
        id: dest.id,
        kind: dest.kind,
        name: dest.name,
        amountMinor: Number(dest.amount_minor),
        sortOrder: Number(dest.sort_order),
      })),
    };
  } catch {
    throw new BookingError("hotel_not_found", 404, "hotel not found");
  }
}
