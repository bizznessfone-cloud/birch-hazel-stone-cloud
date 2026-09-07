import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createBooking, type BookingDb } from "./booking.ts";
import { assignVehicle, cancelBooking } from "./inventory.ts";
import { createOperator } from "./ops-auth.ts";
import {
  OpsDeskError,
  listOpsHotels,
  listOpsVehicles,
  loadTodayBoard,
  upsertHotel,
  upsertVehicle,
} from "./ops-desk.ts";
import { athensToday } from "./time.ts";

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

describe("Phase 7 operations desk", () => {
  test("Today board is Athens date, chronological, with attention flags", async () => {
    const { db, pg } = await openDb();
    const today = await athensToday(db);
    await createBooking(db, {
      hotelCode: "gate",
      transferDate: today,
      pickupTime: "18:00",
      durationMinutes: 60,
      guestName: "Later Guest",
      guestPhone: "+302101234567",
      guestEmail: "later@example.com",
      passengerCount: 1,
      luggageCount: 0,
      pickupText: "Gate Hotel",
      destinationText: "ATH",
    });
    await createBooking(db, {
      hotelCode: "gate",
      transferDate: today,
      pickupTime: "08:00",
      durationMinutes: 45,
      guestName: "Early Guest",
      guestPhone: "+302101234568",
      guestEmail: "early@example.com",
      passengerCount: 2,
      luggageCount: 1,
      pickupText: "Gate Hotel",
      destinationText: "Piraeus",
    });
    const board = await loadTodayBoard(db);
    assert.equal(board.athensDate, today);
    assert.equal(board.feed.length, 2);
    assert.equal(board.feed[0]!.pickupTime, "08:00");
    assert.equal(board.feed[1]!.pickupTime, "18:00");
    assert.equal(board.attention.unassignedVehicle, 2);
    assert.equal(board.attention.unassignedDriver, 2);
    assert.ok(board.feed[0]!.needsVehicle);
    await pg.close();
  });

  test("Today board reflects assignment and cancellation", async () => {
    const { db, pg } = await openDb();
    const today = await athensToday(db);
    await createBooking(db, {
      hotelCode: "gate",
      transferDate: today,
      pickupTime: "18:00",
      durationMinutes: 60,
      guestName: "Board Guest",
      guestPhone: "+302101234569",
      guestEmail: "board@example.com",
      passengerCount: 1,
      luggageCount: 0,
      pickupText: "Gate Hotel",
      destinationText: "ATH",
    });
    const before = await loadTodayBoard(db);
    assert.equal(before.attention.unassignedVehicle, 1);
    assert.equal(before.attention.cancelled, 0);
    const vehicle = (await listOpsVehicles(db))[0];
    assert.ok(vehicle);
    const operator = await createOperator(db, "desk", "desk-pass", { N: 16, r: 8, p: 1 });
    await assignVehicle(db, {
      bookingId: before.feed[0]!.id,
      vehicleId: vehicle.id,
      operatorId: operator.id,
    });
    const assigned = await loadTodayBoard(db);
    assert.equal(assigned.attention.unassignedVehicle, 0);
    assert.equal(assigned.feed[0]!.vehicleName, vehicle.name);
    await cancelBooking(db, {
      bookingId: before.feed[0]!.id,
      operatorId: operator.id,
    });
    const cancelled = await loadTodayBoard(db);
    assert.equal(cancelled.attention.cancelled, 1);
    assert.equal(cancelled.attention.unassignedVehicle, 0);
    assert.equal(cancelled.attention.unassignedDriver, 0);
    assert.ok(cancelled.feed[0]!.cancelled);
    await pg.close();
  });

  test("vehicle capacity and hotel unique code are validated", async () => {
    const { db, pg } = await openDb();
    const vehicle = await upsertVehicle(db, { name: "Coach", capacity: 12, active: true });
    assert.equal(vehicle.capacity, 12);
    try {
      await upsertVehicle(db, { name: "Too big", capacity: 99, active: true });
      assert.fail("expected capacity reject");
    } catch (err) {
      assert.ok(err instanceof OpsDeskError);
      assert.equal(err.code, "invalid");
    }
    const hotel = await upsertHotel(db, { code: "Quay", name: "Quay Hotel" });
    assert.equal(hotel.code, "quay");
    assert.equal(hotel.bookingPath, "/book/quay");
    try {
      await upsertHotel(db, { code: "gate", name: "Duplicate" });
      assert.fail("expected unique code reject");
    } catch (err) {
      assert.ok(err instanceof OpsDeskError);
      assert.equal(err.code, "conflict");
    }
    const hotels = await listOpsHotels(db);
    assert.ok(hotels.some((item) => item.code === "gate"));
    await pg.close();
  });

  test("ops desk HTTP is privileged; guest UI does not import it", () => {
    const deskFns = readFileSync(new URL("./ops-desk-fns.ts", import.meta.url), "utf8");
    const deskServer = readFileSync(new URL("./ops-desk.server.ts", import.meta.url), "utf8");
    const guestBook = readFileSync(
      new URL("../../components/aether/guest-book.tsx", import.meta.url),
      "utf8",
    );
    const bookRoute = readFileSync(new URL("../../routes/book.$hotelCode.tsx", import.meta.url), "utf8");
    const bookingsIndex = readFileSync(
      new URL("../../routes/ops.bookings.index.tsx", import.meta.url),
      "utf8",
    );
    const csrf = readFileSync(new URL("./csrf-client.ts", import.meta.url), "utf8");
    assert.match(deskServer, /requireOps/);
    assert.match(deskFns, /opsTodayBoard/);
    assert.match(bookingsIndex, /createFileRoute\("\/ops\/bookings\/"\)/);
    assert.doesNotMatch(guestBook, /ops-desk/);
    assert.doesNotMatch(bookRoute, /ops-desk|requireOps/);
    assert.doesNotMatch(deskFns, /sessionToken|localStorage/);
    assert.doesNotMatch(csrf, /^\s*import /m);
    assert.match(csrf, /aether_ops_csrf/);
    assert.match(csrf, /x-aether-csrf/);
  });
});
