/**
 * Application time domain. Civil date+time is converted only by PostgreSQL.
 * Hotel booking conversion uses aether_civil_instant(date, time, iana_timezone).
 * Never use the browser timezone or the PostgreSQL session TimeZone as the
 * business-time authority. Occupies remains trigger-maintained.
 */
import {
  BUSINESS_TIMEZONE,
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
} from "./constants.ts";

export { BUSINESS_TIMEZONE, MAX_DURATION_MINUTES, MIN_DURATION_MINUTES };

export type TimeDb = {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
};

export type OccupancyBounds = {
  start: string;
  end: string;
};

export type CivilTimeCode =
  | "invalid_time"
  | "invalid_duration"
  | "nonexistent"
  | "ambiguous";

export class CivilTimeError extends Error {
  readonly code: CivilTimeCode;
  constructor(code: CivilTimeCode, message: string) {
    super(message);
    this.name = "CivilTimeError";
    this.code = code;
  }
}

export function assertDurationMinutes(duration: number): void {
  if (
    !Number.isInteger(duration) ||
    duration < MIN_DURATION_MINUTES ||
    duration > MAX_DURATION_MINUTES
  ) {
    throw new CivilTimeError("invalid_duration", "duration must be 1–1440 minutes");
  }
}

function toIsoUtc(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("expected timestamptz");
}

function toDateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  throw new Error("expected date");
}

function wrapSqlError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/24:00/i.test(message)) {
    throw new CivilTimeError("invalid_time", "24:00 is not a valid time");
  }
  if (/does not exist/i.test(message)) {
    throw new CivilTimeError("nonexistent", "time does not exist");
  }
  if (/ambiguous/i.test(message)) {
    throw new CivilTimeError("ambiguous", "time is ambiguous");
  }
  if (/civil time required/i.test(message)) {
    throw new CivilTimeError("invalid_time", "civil time required");
  }
  if (/time zone is invalid|hotel timezone is invalid|not recognized/i.test(message)) {
    throw new CivilTimeError("invalid_time", "time zone is invalid");
  }
  throw err;
}

function requireTimezone(ianaTimezone: unknown): string {
  if (typeof ianaTimezone !== "string") {
    throw new CivilTimeError("invalid_time", "time zone is invalid");
  }
  const tz = ianaTimezone.trim();
  if (!tz) throw new CivilTimeError("invalid_time", "time zone is invalid");
  return tz;
}

/**
 * Absolute UTC instant for a hotel-local civil date+time.
 * SQL aether_civil_instant is the authority. No Athens fallback.
 */
export async function civilInstant(
  db: TimeDb,
  transferDate: string,
  pickupTime: string,
  ianaTimezone: string,
): Promise<string> {
  const tz = requireTimezone(ianaTimezone);
  try {
    const rows = await db.query<{ instant: unknown }>(
      "select aether_civil_instant($1::date, $2::time, $3::text) as instant",
      [transferDate, pickupTime, tz],
    );
    const value = rows[0]?.instant;
    if (value == null) throw new CivilTimeError("invalid_time", "civil time required");
    return toIsoUtc(value);
  } catch (err) {
    if (err instanceof CivilTimeError) throw err;
    wrapSqlError(err);
  }
}

/** Absolute UTC instant for an Athens civil date+time. SQL is the authority. */
export async function athensInstant(
  db: TimeDb,
  transferDate: string,
  pickupTime: string,
): Promise<string> {
  try {
    const rows = await db.query<{ instant: unknown }>(
      "select aether_athens_instant($1::date, $2::time) as instant",
      [transferDate, pickupTime],
    );
    const value = rows[0]?.instant;
    if (value == null) throw new CivilTimeError("invalid_time", "civil time required");
    return toIsoUtc(value);
  } catch (err) {
    if (err instanceof CivilTimeError) throw err;
    wrapSqlError(err);
  }
}

/**
 * Occupancy bounds matching the trigger formula:
 * tstzrange(instant, instant + make_interval(mins => duration), '[)')
 * Does not write bookings.occupies.
 * Pass ianaTimezone for hotel conversion; omit for the Athens 2-arg entry.
 */
export async function occupancyBounds(
  db: TimeDb,
  transferDate: string,
  pickupTime: string,
  durationMinutes: number,
  ianaTimezone?: string,
): Promise<OccupancyBounds> {
  assertDurationMinutes(durationMinutes);
  const tz = ianaTimezone != null ? requireTimezone(ianaTimezone) : null;
  try {
    const rows = tz
      ? await db.query<{ start: unknown; end_at: unknown }>(
          `select
             aether_civil_instant($1::date, $2::time, $4::text) as start,
             aether_civil_instant($1::date, $2::time, $4::text)
               + make_interval(mins => $3::int) as end_at`,
          [transferDate, pickupTime, durationMinutes, tz],
        )
      : await db.query<{ start: unknown; end_at: unknown }>(
          `select
             aether_athens_instant($1::date, $2::time) as start,
             aether_athens_instant($1::date, $2::time)
               + make_interval(mins => $3::int) as end_at`,
          [transferDate, pickupTime, durationMinutes],
        );
    const row = rows[0];
    if (!row) throw new CivilTimeError("invalid_time", "civil time required");
    return { start: toIsoUtc(row.start), end: toIsoUtc(row.end_at) };
  } catch (err) {
    if (err instanceof CivilTimeError) throw err;
    wrapSqlError(err);
  }
}

/** Europe/Athens civil date of an absolute instant. */
export async function athensDate(db: TimeDb, instantIso: string): Promise<string> {
  const rows = await db.query<{ d: unknown }>(
    "select aether_athens_date($1::timestamptz)::text as d",
    [instantIso],
  );
  return toDateText(rows[0]?.d);
}

/** Dashboard Today: Europe/Athens business date of now(). */
export async function athensToday(db: TimeDb): Promise<string> {
  const rows = await db.query<{ d: unknown }>("select aether_athens_today()::text as d");
  return toDateText(rows[0]?.d);
}
