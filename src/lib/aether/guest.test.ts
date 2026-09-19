import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  createBooking,
  getPublicBookingByToken,
  getPublicHotel,
  type BookingDb,
} from "./booking.ts";
import {
  applyDirection,
  emptyDraft,
  hotelMarkLetters,
  touristMessage,
  vehicleHint,
} from "./guest.ts";
import { applyCp14LiveCatalog } from "./cp14-fixture.ts";

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
const BOOKING_SQL = readFileSync(
  new URL("../../../migrations/0006_booking_engine.sql", import.meta.url),
  "utf8",
);
const INVENTORY_SQL = readFileSync(
  new URL("../../../migrations/0007_inventory.sql", import.meta.url),
  "utf8",
);
const GUEST_SQL = readFileSync(
  new URL("../../../migrations/0008_guest_ux.sql", import.meta.url),
  "utf8",
);
const WHITE_LABEL_SQL = readFileSync(
  new URL("../../../migrations/0010_hotel_white_label.sql", import.meta.url),
  "utf8",
);
const TENANCY_SQL = readFileSync(
  new URL("../../../migrations/0012_cp12_tenancy.sql", import.meta.url),
  "utf8",
);

async function openDb() {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  await pg.exec(FOUNDATION_SQL);
  await pg.exec(OCCUPANCY_SQL);
  await pg.exec(AUTH_SQL);
  await pg.exec(TIME_SQL);
  await pg.exec(BOOKING_SQL);
  await pg.exec(INVENTORY_SQL);
  await pg.exec(GUEST_SQL);
  await pg.exec(WHITE_LABEL_SQL);
  await pg.exec(TENANCY_SQL);
  const destinations = await applyCp14LiveCatalog(pg);
  await pg.exec(
    readFileSync(new URL("../../../migrations/0019_cp23_public_hotel_slug.sql", import.meta.url), "utf8"),
  );
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
  return { db, pg, destinations };
}

describe("Phase 6 guest UX helpers", () => {
  test("seeded hotel is public; unknown hotel does not leak other hotels", async () => {
    const { db, pg } = await openDb();
    const hotel = await getPublicHotel(db, "GATE");
    assert.equal(hotel.code, "gate");
    assert.equal(hotel.name, "Gate Hotel");
    try {
      await getPublicHotel(db, "missing-hotel");
      assert.fail("expected missing hotel to fail");
    } catch (err) {
      assert.equal((err as { code: string }).code, "hotel_not_found");
      assert.doesNotMatch((err as Error).message, /gate|list|sql/i);
    }
    await pg.close();
  });

  test("token lookup works and reference-only lookup fails", async () => {
    const { db, pg, destinations } = await openDb();
    const created = await createBooking(db, {
      hotelCode: "gate",
      destinationId: destinations.gate!,
      transferDate: "2026-01-15",
      pickupTime: "09:00",
      durationMinutes: 60,
      guestName: "Ada Guest",
      guestPhone: "+302101234567",
      guestEmail: "ada@example.com",
      passengerCount: 2,
      luggageCount: 1,
      pickupText: "Gate Hotel",
      destinationText: "ATH airport",
    });
    const found = await getPublicBookingByToken(db, created.confirmationToken);
    assert.equal(found.humanReference, created.humanReference);
    assert.equal("occupies" in found, false);
    try {
      await getPublicBookingByToken(db, created.humanReference);
      assert.fail("reference lookup must fail");
    } catch (err) {
      assert.equal((err as { code: string }).code, "not_found");
    }
    await pg.close();
  });

  test("HotelMark, tourist copy, informational vehicle hint", () => {
    assert.equal(hotelMarkLetters("Gate Hotel"), "GH");
    assert.match(touristMessage("hotel_not_found"), /could not find this booking page/i);
    assert.match(touristMessage("hotel_not_live"), /not available for this hotel yet/i);
    assert.match(touristMessage("invalid_destination"), /choose a destination from the list/i);
    assert.equal(vehicleHint(1, 0).title, "Saloon");
    assert.equal(vehicleHint(4, 2).title, "Estate");
    assert.equal(vehicleHint(6, 1).title, "Minivan");
    assert.match(vehicleHint(1, 0).note, /not a reserved vehicle|assigns the actual car/i);
    const draft = emptyDraft("Gate Hotel");
    assert.equal(draft.pickupText, "Gate Hotel");
    assert.equal(applyDirection(draft, "to_hotel", "Gate Hotel").destinationText, "Gate Hotel");
  });

  test("guest routes stay public and do not include ops controls", () => {
    const book = readFileSync(new URL("../../routes/book.$hotelCode.tsx", import.meta.url), "utf8");
    const confirmed = readFileSync(
      new URL("../../routes/confirmed.$token.tsx", import.meta.url),
      "utf8",
    );
    const wizard = readFileSync(new URL("../../components/aether/guest-book.tsx", import.meta.url), "utf8");
    for (const src of [book, confirmed, wizard]) {
      assert.doesNotMatch(src, /requireOps/);
      assert.doesNotMatch(src, /\/ops/);
      assert.doesNotMatch(src, /localStorage.*session/);
    }
    assert.match(wizard, /createPublicBooking/);
    assert.match(wizard, /getPublicBooking/);
    assert.match(wizard, /Book transfer/);
    assert.match(wizard, /View my booking/);
    assert.match(wizard, /Comfort guide/);
    assert.match(wizard, /destinationId/);
    assert.match(wizard, /formatQuotedPrice/);
    assert.match(wizard, /Quoted price/);
    assert.doesNotMatch(wizard, /<Field label="Destination">[\s\S]*<input/);
  });
});
