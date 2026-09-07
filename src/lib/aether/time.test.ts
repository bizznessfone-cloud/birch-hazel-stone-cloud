import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  BUSINESS_TIMEZONE,
  CivilTimeError,
  athensDate,
  athensInstant,
  athensToday,
  occupancyBounds,
  type TimeDb,
} from "./time.ts";

const FOUNDATION_SQL = readFileSync(
  new URL("../../../migrations/0002_foundation.sql", import.meta.url),
  "utf8",
);
const OCCUPANCY_SQL = readFileSync(
  new URL("../../../migrations/0003_occupancy.sql", import.meta.url),
  "utf8",
);
const AUTH_SQL = readFileSync(
  new URL("../../../migrations/0004_ops_auth.sql", import.meta.url),
  "utf8",
);
const TIME_SQL = readFileSync(
  new URL("../../../migrations/0005_time_domain.sql", import.meta.url),
  "utf8",
);

async function openDb(): Promise<{ db: TimeDb; pg: PGlite }> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  await pg.exec(FOUNDATION_SQL);
  await pg.exec(OCCUPANCY_SQL);
  await pg.exec(AUTH_SQL);
  await pg.exec(TIME_SQL);
  const db: TimeDb = {
    async query<T>(text: string, params?: unknown[]) {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
  return { db, pg };
}

async function expectCivil(fn: () => Promise<unknown>, code: CivilTimeError["code"]) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof CivilTimeError, `expected CivilTimeError, got ${err}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

async function seedHotel(pg: PGlite) {
  const hotel = await pg.query<{ id: string }>(
    "insert into hotels (code, name) values ('time', 'Time Hotel') returning id",
  );
  const vehicle = await pg.query<{ id: string }>(
    "insert into vehicles (name) values ('Van T') returning id",
  );
  return { hotelId: hotel.rows[0]!.id, vehicleId: vehicle.rows[0]!.id };
}

let refSeq = 0;
async function insertBooking(
  pg: PGlite,
  args: {
    hotelId: string;
    date: string;
    time: string;
    duration: number;
    vehicleId?: string | null;
  },
) {
  refSeq += 1;
  const { rows } = await pg.query<{ occupies: string }>(
    `insert into bookings (
       hotel_id, transfer_date, pickup_time, duration_minutes,
       vehicle_id,
       guest_name, guest_phone, guest_email,
       pickup_text, destination_text,
       human_reference, confirmation_token
     ) values (
       $1, $2, $3, $4, $5,
       'Guest', '+300', 'g@x.test',
       'A', 'B',
       $6, $7
     ) returning occupies::text as occupies`,
    [
      args.hotelId,
      args.date,
      args.time,
      args.duration,
      args.vehicleId ?? null,
      `TREF-${refSeq}`,
      `ttok-${refSeq}`,
    ],
  );
  return rows[0]!.occupies;
}

describe("Phase 3 time domain", () => {
  test("Europe/Athens is the business timezone", () => {
    assert.equal(BUSINESS_TIMEZONE, "Europe/Athens");
  });

  test("winter conversion 09:00 → 07:00Z", async () => {
    const { db, pg } = await openDb();
    assert.equal(
      await athensInstant(db, "2026-01-15", "09:00"),
      "2026-01-15T07:00:00.000Z",
    );
    await pg.close();
  });

  test("summer conversion 09:00 → 06:00Z", async () => {
    const { db, pg } = await openDb();
    assert.equal(
      await athensInstant(db, "2026-07-15", "09:00"),
      "2026-07-15T06:00:00.000Z",
    );
    await pg.close();
  });

  test("valid 00:00 winter and summer", async () => {
    const { db, pg } = await openDb();
    assert.equal(
      await athensInstant(db, "2026-01-15", "00:00"),
      "2026-01-14T22:00:00.000Z",
    );
    assert.equal(
      await athensInstant(db, "2026-07-15", "00:00"),
      "2026-07-14T21:00:00.000Z",
    );
    await pg.close();
  });

  test("DST neighbors around the gap and fold remain valid", async () => {
    const { db, pg } = await openDb();
    assert.equal(
      await athensInstant(db, "2026-03-29", "02:59"),
      "2026-03-29T00:59:00.000Z",
    );
    assert.equal(
      await athensInstant(db, "2026-03-29", "04:00"),
      "2026-03-29T01:00:00.000Z",
    );
    assert.equal(
      await athensInstant(db, "2026-10-25", "02:59"),
      "2026-10-24T23:59:00.000Z",
    );
    assert.equal(
      await athensInstant(db, "2026-10-25", "04:00"),
      "2026-10-25T02:00:00.000Z",
    );
    await pg.close();
  });

  test("spring DST gap rejects", async () => {
    const { db, pg } = await openDb();
    await expectCivil(() => athensInstant(db, "2026-03-29", "03:00"), "nonexistent");
    await expectCivil(() => athensInstant(db, "2026-03-29", "03:30"), "nonexistent");
    await pg.close();
  });

  test("autumn DST fold rejects", async () => {
    const { db, pg } = await openDb();
    await expectCivil(() => athensInstant(db, "2026-10-25", "03:00"), "ambiguous");
    await expectCivil(() => athensInstant(db, "2026-10-25", "03:30"), "ambiguous");
    await pg.close();
  });

  test("24:00 rejects", async () => {
    const { db, pg } = await openDb();
    await expectCivil(() => athensInstant(db, "2026-01-15", "24:00"), "invalid_time");
    await expectCivil(() => athensInstant(db, "2026-01-15", "24:00:00"), "invalid_time");
    await pg.close();
  });

  test("duration 1 and 1440 succeed; 0 and >1440 reject", async () => {
    const { db, pg } = await openDb();
    const one = await occupancyBounds(db, "2026-01-15", "09:00", 1);
    assert.equal(one.start, "2026-01-15T07:00:00.000Z");
    assert.equal(one.end, "2026-01-15T07:01:00.000Z");
    const day = await occupancyBounds(db, "2026-01-15", "09:00", 1440);
    assert.equal(day.end, "2026-01-16T07:00:00.000Z");
    await expectCivil(
      () => occupancyBounds(db, "2026-01-15", "09:00", 0),
      "invalid_duration",
    );
    await expectCivil(
      () => occupancyBounds(db, "2026-01-15", "09:00", 1441),
      "invalid_duration",
    );
    await pg.close();
  });

  test("midnight crossing uses elapsed minutes, not the next civil date as pickup", async () => {
    const { db, pg } = await openDb();
    const bounds = await occupancyBounds(db, "2026-01-15", "23:30", 90);
    assert.equal(bounds.start, "2026-01-15T21:30:00.000Z");
    assert.equal(bounds.end, "2026-01-15T23:00:00.000Z");
    assert.equal(await athensDate(db, bounds.start), "2026-01-15");
    assert.equal(await athensDate(db, bounds.end), "2026-01-16");

    const ids = await seedHotel(pg);
    const occupies = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-15",
      time: "23:30",
      duration: 90,
      vehicleId: ids.vehicleId,
    });
    assert.match(occupies, /2026-01-15 21:30:00\+00/);
    assert.match(occupies, /2026-01-15 23:00:00\+00/);

    try {
      await insertBooking(pg, {
        hotelId: ids.hotelId,
        date: "2026-01-16",
        time: "00:00",
        duration: 30,
        vehicleId: ids.vehicleId,
      });
      assert.fail("expected midnight-crossing overlap");
    } catch (err) {
      assert.equal(errCode(err), "23P01");
    }

    const adjacent = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-16",
      time: "01:00",
      duration: 30,
      vehicleId: ids.vehicleId,
    });
    assert.match(adjacent, /2026-01-15 23:00:00\+00/);
    await pg.close();
  });

  test("DST-crossing elapsed duration is minutes on the timestamptz axis", async () => {
    const { db, pg } = await openDb();
    // 2026-03-29 01:00 EET exists. 180 elapsed minutes skip the missing 03:00 hour.
    const spring = await occupancyBounds(db, "2026-03-29", "01:00", 180);
    assert.equal(spring.start, "2026-03-28T23:00:00.000Z");
    assert.equal(spring.end, "2026-03-29T02:00:00.000Z");
    assert.equal(
      (Date.parse(spring.end) - Date.parse(spring.start)) / 60000,
      180,
    );
    assert.equal(await athensDate(db, spring.end), "2026-03-29");
    // Civil clock at end is 05:00 EEST, not 04:00.
    assert.equal(await athensInstant(db, "2026-03-29", "05:00"), spring.end);

    // 2026-10-25 01:00 EEST exists. 180 elapsed minutes include the repeated hour.
    const autumn = await occupancyBounds(db, "2026-10-25", "01:00", 180);
    assert.equal(autumn.start, "2026-10-24T22:00:00.000Z");
    assert.equal(autumn.end, "2026-10-25T01:00:00.000Z");
    assert.equal(
      (Date.parse(autumn.end) - Date.parse(autumn.start)) / 60000,
      180,
    );
    await pg.close();
  });

  test("session TimeZone does not change Athens instant or business date", async () => {
    const { db, pg } = await openDb();
    await pg.exec("set timezone to 'Pacific/Auckland'");
    assert.equal(
      await athensInstant(db, "2026-01-15", "09:00"),
      "2026-01-15T07:00:00.000Z",
    );
    assert.equal(
      await athensDate(db, "2026-01-15T21:30:00.000Z"),
      "2026-01-15",
    );
    assert.equal(
      await athensDate(db, "2026-01-15T22:30:00.000Z"),
      "2026-01-16",
    );
    await pg.exec("set timezone to 'UTC'");
    assert.equal(
      await athensInstant(db, "2026-07-15", "09:00"),
      "2026-07-15T06:00:00.000Z",
    );
    await pg.close();
  });

  test("occupancyBounds matches trigger-maintained occupies", async () => {
    const { db, pg } = await openDb();
    const ids = await seedHotel(pg);
    const preview = await occupancyBounds(db, "2026-07-15", "00:00", 60);
    const occupies = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-07-15",
      time: "00:00",
      duration: 60,
    });
    assert.equal(preview.start, "2026-07-14T21:00:00.000Z");
    assert.equal(preview.end, "2026-07-14T22:00:00.000Z");
    const parsed = await db.query<{ lo: unknown; hi: unknown }>(
      "select lower($1::tstzrange) as lo, upper($1::tstzrange) as hi",
      [occupies],
    );
    assert.equal(new Date(String(parsed[0]!.lo)).toISOString(), preview.start);
    assert.equal(new Date(String(parsed[0]!.hi)).toISOString(), preview.end);
    await pg.close();
  });

  test("athensToday matches Europe/Athens civil date of now()", async () => {
    const { db, pg } = await openDb();
    const today = await athensToday(db);
    const rows = await db.query<{ d: string }>(
      "select (now() at time zone 'Europe/Athens')::date::text as d",
    );
    assert.equal(today, rows[0]!.d);
    assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
    await pg.close();
  });

  test("application module never treats browser/local Date as authority; ICS is not implemented", () => {
    const src = readFileSync(new URL("./time.ts", import.meta.url), "utf8");
    assert.match(src, /aether_athens_instant/);
    assert.match(src, /aether_athens_date/);
    assert.match(src, /aether_athens_today/);
    assert.doesNotMatch(src, /new Date\(`\$\{/);
    assert.doesNotMatch(src, /getTimezoneOffset/);
    assert.doesNotMatch(src, /toLocaleString/);
    assert.doesNotMatch(src, /Intl\.DateTimeFormat/);
    assert.doesNotMatch(src, /BEGIN:VCALENDAR/);
    assert.doesNotMatch(src, /\bics\b/i);

    const occ = readFileSync(
      new URL("../../../migrations/0003_occupancy.sql", import.meta.url),
      "utf8",
    );
    assert.match(occ, /aether_athens_instant/);
    assert.match(occ, /tstzrange\(/);
    assert.match(occ, /'\[\)'/);
  });
});
