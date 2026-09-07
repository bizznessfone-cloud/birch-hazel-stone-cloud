/**
 * Hotel identity. Attribution and guest URL isolation only.
 * Not an authorisation system: no hotel accounts, no RLS, no skins.
 * HotelMark is generated from the name. It is not stored and not a logo.
 */
export const HOTEL_CODE_MIN = 2;
export const HOTEL_CODE_MAX = 32;

/** Lowercase letters, numbers, internal dashes. Leading/trailing dashes rejected. */
export const HOTEL_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export type HotelIdentity = {
  code: string;
  name: string;
  mark: string;
  bookingPath: string;
};

export function normalizeHotelCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toLowerCase();
  if (code.length < HOTEL_CODE_MIN || code.length > HOTEL_CODE_MAX) return null;
  if (!HOTEL_CODE_RE.test(code)) return null;
  return code;
}

export function hotelBookingPath(code: string): string {
  const normalized = normalizeHotelCode(code);
  if (!normalized) {
    throw new Error("invalid hotel code");
  }
  return `/book/${normalized}`;
}

/**
 * Generated monogram. UNKNOWN historical algorithm.
 * One word → first two letters. Two or more words → first letters of the first two.
 * Fallback AT is the product, not a recovered brand.
 */
export function hotelMarkLetters(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "AT";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

export function hotelIdentity(input: { code: string; name: string }): HotelIdentity {
  const code = normalizeHotelCode(input.code);
  if (!code) {
    throw new Error("invalid hotel code");
  }
  const name = input.name.trim();
  if (!name) {
    throw new Error("invalid hotel name");
  }
  return {
    code,
    name,
    mark: hotelMarkLetters(name),
    bookingPath: hotelBookingPath(code),
  };
}
