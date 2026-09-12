/**
 * CP14.4 — hotel IANA timezone is conversion authority.
 * Occupancy schema, GiST EXCLUDE, 0003–0015 files, and CP14.3 provisioning
 * stay unchanged. Client cannot submit a timezone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  BookingError,
  createBooking,
  type BookingDb,
} from "./booking.ts";
import {
  CivilTimeError,
  civilInstant,
  occupancyBounds,
  type TimeDb,
} from "./time.ts";
import {
  provisionHotel,
  type ProvisionDb,
} from "./provision.ts";

const SQL_FILES = [
  "0002_foundation.sql",
  "0003_occupancy.sql",
  "0004_ops_auth.sql",
  "0005_time_domain.sql",
  "0006_booking_engine.sql",
  "0007_inventory.sql",
  "0008_guest_ux.sql",
  "0009_ops_desk.sql",
  "0010_hotel_white_label.sql",
  "0011_production_hardening.sql",
  "0012_cp12_tenancy.sql",
  "0013_cp12b_runtime_login.sql",
  "0014_cp13a_production_app_role.sql",
  "0015_cp14_hotel_configuration.sql",
  "0016_cp14_hotel_timezone.sql",
] as const;

const IMMUTABLE = {
  "0003_occupancy.sql":
    "23f7fe21c0ca60e92bfb85e77235574bf2a923753180650af300a4bc7df05266",
  "0005_time_domain.sql":
    "ebd4753b2ce7c503417dafee856bfd292257d67c189af25239d41692d530cb10",
  "0011_production_hardening.sql":
    "fbb2cd518f1f9b7795a5b4e4ec6577126218ece691ec249cee79484f9ef8a686",
  "0012_cp12_tenancy.sql":
    "b97d03c6c59dde476a5b5afa4b6b99cf71c5652c01a450f5051a565dc42151c3",
  "0013_cp12b_runtime_login.sql":
    "112995194d0933179cc5ad2ed6c29297b53c1cf371871c35f6c1a105c30775ad",
  "0014_cp13a_production_app_role.sql":
    "387ac532999f1eebf8041e3b43afa33b1a253b0a779265fe42d9300bbbc2f7d8",
  "0015_cp14_hotel_configuration.sql":
    "052ef58cbd728a4dc8435f3cbd0eb5769fdcb6debab02d97d2959d46b6bac02c",
} as const;

function readMigration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readAether(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

async function expectCivil(
  fn: () => Promise<unknown>,
  code: CivilTimeError["code"],
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof CivilTimeError, `expected CivilTimeError, got ${err}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

async function expectBooking(
  fn: () => Promise<unknown>,
  code: BookingError["code"],
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof BookingError, `expected BookingError, got ${err}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

async function openDb(): Promise<{ db: ProvisionDb & BookingDb & TimeDb; pg: PGlite }> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  try {
    await pg.exec("create database neondb");
  } catch {
    /* preview name may already exist */
  }
  for (const name of SQL_FILES) {
    await pg.exec(readMigration(name));
  }
  const db: ProvisionDb & BookingDb & TimeDb = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    async transaction<T>(fn: (inner: ProvisionDb & BookingDb & TimeDb) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner: ProvisionDb & BookingDb & TimeDb = {
          query: async <R>(text: string, params?: unknown[]) =>
            (await tx.query<R>(text, params)).rows,
          transaction: () => {
            throw new Error("nested");
          },
        };
        return fn(inner);
      });
    },
  };
  return { db, pg };
}

function hotelInput(
  code: string,
  ianaTimezone: string,
  extra: Record<string, string> = {},
) {
  return {
    code,
    name: `${code[0]!.toUpperCase()}${code.slice(1)} Hotel`,
    locality: "Test City",
    ianaTimezone,
    currency: "EUR",
    ...extra,
  };
}

async function liveHotel(
  db: ProvisionDb & BookingDb,
  code: string,
  ianaTimezone: string,
) {
  return provisionHotel(db, {
    hotel: hotelInput(code, ianaTimezone),
    destinations: [{ kind: "airport", name: "HUB", sortOrder: 10, amountMinor: 4500 }],
    provider: { code: "fleet", name: "Fleet Co" },
    goLive: true,
  });
}

function bookInput(
  hotelCode: string,
  destinationId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    hotelCode,
    destinationId,
    transferDate: "2026-01-15",
    pickupTime: "09:00",
    durationMinutes: 60,
    guestName: "Ada Guest",
    guestPhone: "+302101234567",
    guestEmail: `${hotelCode}@example.com`,
    passengerCount: 1,
    luggageCount: 0,
    pickupText: "Lobby",
    quotedAmountMinor: 1,
    quotedCurrency: "USD",
    ...extra,
  };
}

async function occupiesIso(db: TimeDb, token: string) {
  const rows = await db.query<{ lo: string; hi: string; empty: boolean }>(
    `select lower(occupies)::text as lo, upper(occupies)::text as hi, isempty(occupies) as empty
       from bookings where confirmation_token = $1`,
    [token],
  );
  const row = rows[0];
  assert.ok(row);
  return {
    start: new Date(row.lo).toISOString(),
    end: new Date(row.hi).toISOString(),
    empty: row.empty,
  };
}

describe("CP14.4 hotel IANA timezone conversion", () => {
  test("0011–0015 remain byte-identical; 0003 occupancy tests stay 0003-only", () => {
    for (const [name, expected] of Object.entries(IMMUTABLE)) {
      assert.equal(sha256(readMigration(name)), expected, name);
    }
    const occTest = readAether("./occupancy.test.ts");
    assert.doesNotMatch(occTest, /0016_cp14_hotel_timezone/);
    assert.match(occTest, /0003_occupancy\.sql/);

    const m16 = readMigration("0016_cp14_hotel_timezone.sql");
    assert.match(m16, /aether_civil_instant/);
    assert.match(m16, /hotels\.iana_timezone|iana_timezone/);
    assert.doesNotMatch(m16, /drop trigger bookings_occupies_before/i);
    assert.doesNotMatch(m16, /drop function aether_athens/i);
    assert.doesNotMatch(m16, /drop constraint bookings_vehicle_occupancy_excl/i);
    assert.doesNotMatch(m16, /drop constraint bookings_driver_occupancy_excl/i);
    assert.doesNotMatch(m16, /Europe\/Athens'\s*;/);
    assert.match(m16, /p_tz/);
    assert.match(m16, /language plpgsql/);
    assert.doesNotMatch(m16, /security definer/i);

    const booking = readAether("./booking.ts");
    assert.match(booking, /civilInstant/);
    assert.doesNotMatch(booking, /athensInstant/);
    assert.match(booking, /btrim\(iana_timezone\)/);
    const inputBlock = booking.slice(
      booking.indexOf("export type CreateBookingInput"),
      booking.indexOf("export type PublicBooking"),
    );
    assert.doesNotMatch(inputBlock, /timezone|utcOffset|instant/i);
    const insert = booking.slice(booking.indexOf("insert into bookings"), booking.indexOf("returning id"));
    assert.doesNotMatch(insert, /occupies/);
    assert.doesNotMatch(booking, /Intl\.DateTimeFormat|date-fns-tz|luxon|Temporal/);

    const timeSrc = readAether("./time.ts");
    assert.match(timeSrc, /aether_civil_instant/);
    assert.match(timeSrc, /aether_athens_instant/);
    assert.doesNotMatch(timeSrc, /getTimezoneOffset/);
    assert.doesNotMatch(timeSrc, /Intl\.DateTimeFormat/);

    const ops = readAether("./ops-desk.ts");
    assert.match(ops, /lower\(b\.occupies\) >= now\(\)/);
    assert.doesNotMatch(ops, /aether_athens_instant\(b\.transfer_date/);
  });

  test("Europe/Athens winter booking occupies the Athens instant", async () => {
    const { db, pg } = await openDb();
    const live = await liveHotel(db, "quay", "Europe/Athens");
    assert.equal(
      await civilInstant(db, "2026-01-15", "09:00", "Europe/Athens"),
      "2026-01-15T07:00:00.000Z",
    );
    assert.equal(
      await civilInstant(db, "2026-07-15", "09:00", "Europe/Athens"),
      "2026-07-15T06:00:00.000Z",
    );
    await expectCivil(
      () => civilInstant(db, "2026-03-29", "03:30", "Europe/Athens"),
      "nonexistent",
    );
    await expectCivil(
      () => civilInstant(db, "2026-10-25", "03:30", "Europe/Athens"),
      "ambiguous",
    );
    await expectCivil(
      () => civilInstant(db, "2026-01-15", "24:00", "Europe/Athens"),
      "invalid_time",
    );

    const created = await createBooking(
      db,
      bookInput("quay", live.destinations[0]!.id),
    );
    assert.deepEqual(created.pricing, { priced: true, currency: "EUR", amountMinor: 4500 });
    const occ = await occupiesIso(db, created.confirmationToken);
    assert.equal(occ.start, "2026-01-15T07:00:00.000Z");
    assert.equal(occ.end, "2026-01-15T08:00:00.000Z");
    assert.equal(occ.empty, false);
    const bounds = await occupancyBounds(db, "2026-01-15", "09:00", 60, "Europe/Athens");
    assert.equal(bounds.start, occ.start);
    assert.equal(bounds.end, occ.end);
    await pg.close();
  });

  test("America/New_York DST gap and fold reject", async () => {
    const { db, pg } = await openDb();
    await expectCivil(
      () => civilInstant(db, "2026-03-08", "02:30", "America/New_York"),
      "nonexistent",
    );
    await expectCivil(
      () => civilInstant(db, "2026-11-01", "01:30", "America/New_York"),
      "ambiguous",
    );
    assert.equal(
      await civilInstant(db, "2026-01-15", "09:00", "America/New_York"),
      "2026-01-15T14:00:00.000Z",
    );
    assert.equal(
      await civilInstant(db, "2026-07-15", "09:00", "America/New_York"),
      "2026-07-15T13:00:00.000Z",
    );
    const live = await liveHotel(db, "harborny", "America/New_York");
    await expectBooking(
      () =>
        createBooking(
          db,
          bookInput("harborny", live.destinations[0]!.id, {
            transferDate: "2026-03-08",
            pickupTime: "02:30",
          }),
        ),
      "nonexistent",
    );
    await pg.close();
  });

  test("same civil time in Athens London and New York yields different instants", async () => {
    const { db, pg } = await openDb();
    const athens = await liveHotel(db, "quay", "Europe/Athens");
    const london = await liveHotel(db, "thames", "Europe/London");
    const york = await liveHotel(db, "hudson", "America/New_York");
    const dubai = await liveHotel(db, "creek", "Asia/Dubai");

    const a = await createBooking(db, bookInput("quay", athens.destinations[0]!.id));
    const l = await createBooking(db, bookInput("thames", london.destinations[0]!.id));
    const y = await createBooking(db, bookInput("hudson", york.destinations[0]!.id));
    const d = await createBooking(db, bookInput("creek", dubai.destinations[0]!.id));

    const ao = await occupiesIso(db, a.confirmationToken);
    const lo = await occupiesIso(db, l.confirmationToken);
    const yo = await occupiesIso(db, y.confirmationToken);
    const dob = await occupiesIso(db, d.confirmationToken);
    assert.equal(ao.start, "2026-01-15T07:00:00.000Z");
    assert.equal(lo.start, "2026-01-15T09:00:00.000Z");
    assert.equal(yo.start, "2026-01-15T14:00:00.000Z");
    assert.equal(dob.start, "2026-01-15T05:00:00.000Z");
    assert.equal(await civilInstant(db, "2026-01-15", "09:00", "UTC"), "2026-01-15T09:00:00.000Z");
    assert.notEqual(ao.start, lo.start);
    assert.notEqual(lo.start, yo.start);
    assert.notEqual(ao.start, yo.start);

    await pg.exec("set timezone to 'Pacific/Auckland'");
    assert.equal(
      await civilInstant(db, "2026-01-15", "09:00", "America/New_York"),
      "2026-01-15T14:00:00.000Z",
    );
    await pg.exec("set timezone to 'UTC'");
    assert.equal(
      await civilInstant(db, "2026-01-15", "09:00", "America/New_York"),
      "2026-01-15T14:00:00.000Z",
    );
    await pg.close();
  });

  test("invalid IANA timezone fails closed without Athens fallback", async () => {
    const { db, pg } = await openDb();
    await expectCivil(
      () => civilInstant(db, "2026-01-15", "09:00", "not/a-real-zone"),
      "invalid_time",
    );
    await expectCivil(() => civilInstant(db, "2026-01-15", "09:00", " "), "invalid_time");

    const live = await liveHotel(db, "bogus", "not/a-real-zone");
    await expectBooking(
      () => createBooking(db, bookInput("bogus", live.destinations[0]!.id)),
      "invalid_time",
    );
    const leftover = await db.query<{ n: number }>(
      "select count(*)::int as n from bookings b join hotels h on h.id = b.hotel_id where h.code = 'bogus'",
    );
    assert.equal(leftover[0]?.n, 0);

    const athens = await liveHotel(db, "quay", "Europe/Athens");
    const created = await createBooking(db, bookInput("quay", athens.destinations[0]!.id));
    const occ = await occupiesIso(db, created.confirmationToken);
    assert.equal(occ.start, "2026-01-15T07:00:00.000Z");
    await pg.close();
  });

  test("EXCLUDE compares absolute instants across hotel timezones", async () => {
    const { db, pg } = await openDb();
    const athens = await liveHotel(db, "quay", "Europe/Athens");
    const york = await liveHotel(db, "hudson", "America/New_York");
    const a = await createBooking(
      db,
      bookInput("quay", athens.destinations[0]!.id, { pickupTime: "16:00" }),
    );
    const y = await createBooking(
      db,
      bookInput("hudson", york.destinations[0]!.id, { pickupTime: "09:00" }),
    );
    const ao = await occupiesIso(db, a.confirmationToken);
    const yo = await occupiesIso(db, y.confirmationToken);
    assert.equal(ao.start, "2026-01-15T14:00:00.000Z");
    assert.equal(yo.start, "2026-01-15T14:00:00.000Z");

    const vehicle = await db.query<{ id: string }>(
      `insert into vehicles (name, owned_by_provider_id, operated_by_provider_id)
       values ('Share', $1::uuid, $1::uuid)
       returning id`,
      [athens.provider.id],
    );
    const vehicleId = vehicle[0]!.id;
    await db.query("update bookings set vehicle_id = $1::uuid where confirmation_token = $2", [
      vehicleId,
      a.confirmationToken,
    ]);
    await assert.rejects(
      () =>
        db.query("update bookings set vehicle_id = $1::uuid where confirmation_token = $2", [
          vehicleId,
          y.confirmationToken,
        ]),
      (err: unknown) => (err as { code?: string }).code === "23P01",
    );

    const adjacent = await createBooking(
      db,
      bookInput("hudson", york.destinations[0]!.id, {
        pickupTime: "10:00",
        guestEmail: "adj@example.com",
      }),
    );
    const adj = await occupiesIso(db, adjacent.confirmationToken);
    assert.equal(adj.start, "2026-01-15T15:00:00.000Z");
    await db.query("update bookings set vehicle_id = $1::uuid where confirmation_token = $2", [
      vehicleId,
      adjacent.confirmationToken,
    ]);
    await pg.close();
  });

  test("quote and idempotency remain server-authoritative after timezone conversion", async () => {
    const { db, pg } = await openDb();
    const live = await liveHotel(db, "quay", "Europe/London");
    const destId = live.destinations[0]!.id;
    const created = await createBooking(
      db,
      bookInput("quay", destId, {
        quotedAmountMinor: 99,
        quotedCurrency: "USD",
        idempotencyKey: "k1",
      }),
    );
    assert.deepEqual(created.pricing, { priced: true, currency: "EUR", amountMinor: 4500 });
    const again = await createBooking(
      db,
      bookInput("quay", destId, {
        quotedAmountMinor: 99,
        quotedCurrency: "USD",
        idempotencyKey: "k1",
      }),
    );
    assert.equal(again.confirmationToken, created.confirmationToken);
    await expectBooking(
      () =>
        createBooking(
          db,
          bookInput("quay", destId, {
            pickupTime: "10:00",
            quotedAmountMinor: 99,
            quotedCurrency: "USD",
            idempotencyKey: "k1",
          }),
        ),
      "idempotency_conflict",
    );
    const occ = await occupiesIso(db, created.confirmationToken);
    assert.equal(occ.start, "2026-01-15T09:00:00.000Z");
    await pg.close();
  });
});
