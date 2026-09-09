import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  BookingError,
  createBooking,
  getPublicBookingByToken,
  getPublicHotel,
  type BookingDb,
} from "./booking.ts";
import { hotelBookingPath, hotelIdentity, hotelMarkLetters, normalizeHotelCode } from "./hotel.ts";
import { listOpsBookings, listOpsHotels, upsertHotel } from "./ops-desk.ts";
import { createOperator } from "./ops-auth.ts";
import { legacyDispatcherScope } from "./tenancy.ts";

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
];

async function openDb() {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  for (const name of SQL_FILES) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  const db: BookingDb = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner: BookingDb = {
          query: async <R>(text: string, params?: unknown[]) => (await tx.query<R>(text, params)).rows,
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

function bookingInput(hotelCode: string, guestName: string) {
  return {
    hotelCode,
    transferDate: "2026-01-15",
    pickupTime: "09:00",
    durationMinutes: 60,
    guestName,
    guestPhone: "+302101234567",
    guestEmail: `${guestName.replace(/\s+/g, ".").toLowerCase()}@example.com`,
    passengerCount: 1,
    luggageCount: 0,
    pickupText: `${guestName} pickup`,
    destinationText: "ATH",
  };
}

describe("Phase 8 hotel white label", () => {
  test("valid hotel code resolves with generated HotelMark and QR-ready path", async () => {
    const { db, pg } = await openDb();
    const hotel = await getPublicHotel(db, "GATE");
    assert.equal(hotel.code, "gate");
    assert.equal(hotel.name, "Gate Hotel");
    assert.equal(hotel.mark, "GH");
    assert.equal(hotel.bookingPath, "/book/gate");
    assert.equal(hotelBookingPath("Gate"), "/book/gate");
    const harbor = await getPublicHotel(db, "harbor");
    assert.equal(harbor.name, "Harbor Hotel");
    assert.equal(harbor.mark, "HH");
    assert.equal(harbor.bookingPath, "/book/harbor");
    await pg.close();
  });

  test("HotelMark letters are a generated monogram", () => {
    assert.equal(hotelMarkLetters("Gate Hotel"), "GH");
    assert.equal(hotelMarkLetters("Harbor Hotel"), "HH");
    assert.equal(hotelMarkLetters("Acropolis"), "AC");
    assert.equal(hotelMarkLetters("  Grand  Palais  Suites "), "GP");
    assert.equal(hotelMarkLetters(""), "AT");
    const identity = hotelIdentity({ code: "grand-palais", name: "Grand Palais" });
    assert.equal(identity.mark, "GP");
    assert.equal(identity.bookingPath, "/book/grand-palais");
    assert.equal(normalizeHotelCode("Grand-Palais"), "grand-palais");
    assert.equal(normalizeHotelCode("-lead"), null);
    assert.equal(normalizeHotelCode("trail-"), null);
    assert.equal(normalizeHotelCode("x"), null);
  });

  test("booking is attributed to the hotel from the booking code", async () => {
    const { db, pg } = await openDb();
    const created = await createBooking(db, bookingInput("gate", "Nikos Gate"));
    assert.equal(created.hotelCode, "gate");
    assert.equal(created.hotelName, "Gate Hotel");
    const rows = await db.query<{ hotel_code: string; hotel_name: string }>(
      `select h.code as hotel_code, h.name as hotel_name
       from bookings b
       join hotels h on h.id = b.hotel_id
       where b.human_reference = $1`,
      [created.humanReference],
    );
    assert.equal(rows[0]?.hotel_code, "gate");
    assert.equal(rows[0]?.hotel_name, "Gate Hotel");
    const publicView = await getPublicBookingByToken(db, created.confirmationToken);
    assert.equal(publicView.hotelCode, "gate");
    assert.equal(publicView.hotelName, "Gate Hotel");
    await pg.close();
  });

  test("unknown hotel remains non-disclosing", async () => {
    const { db, pg } = await openDb();
    try {
      await getPublicHotel(db, "missing-hotel");
      assert.fail("expected missing hotel to fail");
    } catch (err) {
      assert.ok(err instanceof BookingError);
      assert.equal(err.code, "hotel_not_found");
      assert.doesNotMatch(err.message, /gate|harbor|list|sql|select/i);
    }
    try {
      await createBooking(db, bookingInput("missing-hotel", "Ghost Guest"));
      assert.fail("expected missing hotel create to fail");
    } catch (err) {
      assert.ok(err instanceof BookingError);
      assert.equal(err.code, "hotel_not_found");
      assert.doesNotMatch(err.message, /gate|harbor/i);
    }
    await pg.close();
  });

  test("two hotel codes remain isolated at booking-attribution level", async () => {
    const { db, pg } = await openDb();
    const gate = await createBooking(db, bookingInput("gate", "Ada Gate"));
    const harbor = await createBooking(db, bookingInput("harbor", "Ben Harbor"));
    assert.equal(gate.hotelCode, "gate");
    assert.equal(gate.hotelName, "Gate Hotel");
    assert.equal(harbor.hotelCode, "harbor");
    assert.equal(harbor.hotelName, "Harbor Hotel");
    assert.notEqual(gate.confirmationToken, harbor.confirmationToken);
    const payload = JSON.stringify(gate);
    assert.doesNotMatch(payload, /harbor|Harbor Hotel/i);
    const other = JSON.stringify(harbor);
    assert.doesNotMatch(other, /"hotelCode":"gate"|Gate Hotel/);

    const ids = await db.query<{ hotel_id: string; code: string }>(
      `select b.hotel_id, h.code
       from bookings b
       join hotels h on h.id = b.hotel_id
       where b.human_reference in ($1, $2)
       order by h.code`,
      [gate.humanReference, harbor.humanReference],
    );
    assert.equal(ids.length, 2);
    assert.equal(ids[0]?.code, "gate");
    assert.equal(ids[1]?.code, "harbor");
    assert.notEqual(ids[0]?.hotel_id, ids[1]?.hotel_id);

    const operator = await createOperator(db, "desk", "desk-pass", { N: 16, r: 8, p: 1 });
    const scope = await legacyDispatcherScope(db, operator.id, operator.login);
    const desk = await listOpsBookings(db, scope);
    assert.equal(desk.filter((row) => row.hotelCode === "gate").length, 1);
    assert.equal(desk.filter((row) => row.hotelCode === "harbor").length, 1);
    const hotels = await listOpsHotels(db, scope);
    assert.ok(hotels.some((item) => item.code === "gate" && item.bookingPath === "/book/gate"));
    assert.ok(hotels.some((item) => item.code === "harbor" && item.bookingPath === "/book/harbor"));
    await pg.close();
  });

  test("hotels have no colour, logo, or skin columns; identity is attribution not RLS", async () => {
    const { db, pg } = await openDb();
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'hotels' order by column_name`,
    );
    const names = cols.map((row) => row.column_name);
    assert.deepEqual(names, ["code", "created_at", "id", "name"]);
    assert.ok(!names.includes("color"));
    assert.ok(!names.includes("logo"));
    assert.ok(!names.includes("accent"));
    const rls = await db.query<{ rls: boolean }>(
      `select relrowsecurity as rls from pg_class where relname = 'hotels'`,
    );
    assert.equal(rls[0]?.rls, false);
    await pg.close();
  });

  test("database enforces hotel code format and uniqueness", async () => {
    const { db, pg } = await openDb();
    await db.query("insert into hotels (code, name) values ('quay', 'Quay Hotel')");
    const identity = await getPublicHotel(db, "quay");
    assert.equal(identity.bookingPath, "/book/quay");
    assert.equal(identity.mark, "QH");
    const operator = await createOperator(db, "desk", "desk-pass", { N: 16, r: 8, p: 1 });
    const scope = await legacyDispatcherScope(db, operator.id, operator.login);
    try {
      await upsertHotel(db, scope, { code: "gate", name: "Duplicate" });
      assert.fail("expected hotel upsert forbidden");
    } catch (err) {
      assert.equal((err as { code: string }).code, "forbidden");
    }
    try {
      await db.query("insert into hotels (code, name) values ($1, $2)", ["Nope!", "Bad"]);
      assert.fail("expected database format reject");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "23514");
    }
    await pg.close();
  });

  test("guest UI stays monochrome, public, and free of ops controls", () => {
    const files = [
      "../../routes/book.$hotelCode.tsx",
      "../../routes/confirmed.$token.tsx",
      "../../components/aether/guest-book.tsx",
      "../../components/aether/guest-header.tsx",
      "../../components/aether/hotel-mark.tsx",
    ];
    for (const rel of files) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      assert.doesNotMatch(src, /requireOps/);
      assert.doesNotMatch(src, /ops-desk/);
      assert.doesNotMatch(src, /\/ops/);
      assert.doesNotMatch(src, /type=["']file["']/);
      assert.doesNotMatch(src, /logo upload|color picker|accentColor|hotelColor/i);
      assert.doesNotMatch(src, /bg-(red|blue|green|yellow|purple|orange|pink|teal)-/);
      assert.doesNotMatch(src, /localStorage.*session|sessionStorage/);
    }
    const hotelsPage = readFileSync(new URL("../../routes/ops.hotels.tsx", import.meta.url), "utf8");
    assert.match(hotelsPage, /QR-ready booking URL/);
    assert.match(hotelsPage, /Open booking page/);
    assert.match(hotelsPage, /to="\/book\/\$hotelCode"/);
    assert.doesNotMatch(hotelsPage, /type=["']file["']/);
    assert.doesNotMatch(hotelsPage, /color picker|logo upload/i);
    const occupancy = readFileSync(
      new URL("../../../migrations/0003_occupancy.sql", import.meta.url),
      "utf8",
    );
    const whiteLabel = readFileSync(
      new URL("../../../migrations/0010_hotel_white_label.sql", import.meta.url),
      "utf8",
    );
    assert.match(occupancy, /aether_bookings_occupies_tg/);
    assert.doesNotMatch(whiteLabel, /drop trigger|alter function aether_athens|drop constraint bookings_/i);
  });
});
