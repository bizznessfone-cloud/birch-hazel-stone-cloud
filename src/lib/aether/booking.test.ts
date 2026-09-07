import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  BookingError,
  HUMAN_REFERENCE_PREFIX,
  createBooking,
  getPublicBookingByToken,
  type BookingDb,
} from "./booking.ts";

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

async function openDb(): Promise<{ db: BookingDb; pg: PGlite; hotelCode: string }> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  await pg.exec(FOUNDATION_SQL);
  await pg.exec(OCCUPANCY_SQL);
  await pg.exec(AUTH_SQL);
  await pg.exec(TIME_SQL);
  await pg.exec(BOOKING_SQL);
  await pg.exec(
    "insert into hotels (code, name) values ('gate', 'Gate Hotel')",
  );

  const query = async <T>(text: string, params?: unknown[]) => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  };
  const db: BookingDb = {
    query,
    async transaction<T>(fn: (db: BookingDb) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => {
        const inner: BookingDb = {
          query: async <R>(text: string, params?: unknown[]) => {
            const result = await tx.query<R>(text, params);
            return result.rows;
          },
          transaction: () => {
            throw new Error("nested");
          },
        };
        return fn(inner);
      });
    },
  };
  return { db, pg, hotelCode: "gate" };
}

function validInput(hotelCode: string, extra: Record<string, unknown> = {}) {
  return {
    hotelCode,
    transferDate: "2026-01-15",
    pickupTime: "09:00",
    durationMinutes: 60,
    guestName: "Ada Guest",
    guestPhone: "+302101234567",
    guestEmail: "ada@example.com",
    passengerCount: 2,
    luggageCount: 1,
    pickupText: "Hotel lobby",
    destinationText: "ATH airport",
    ...extra,
  };
}

async function expectCode(fn: () => Promise<unknown>, code: BookingError["code"]) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof BookingError, `expected BookingError, got ${err}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected ${code}`);
}

describe("Phase 4 booking engine", () => {
  test("unknown hotel is rejected", async () => {
    const { db, pg } = await openDb();
    await expectCode(() => createBooking(db, validInput("missing")), "hotel_not_found");
    await pg.close();
  });

  test("valid booking persists with PT- reference and high-entropy token", async () => {
    const { db, pg, hotelCode } = await openDb();
    const created = await createBooking(db, validInput(hotelCode));
    assert.match(created.humanReference, /^PT-[A-Z2-9]{10}$/);
    assert.ok(created.confirmationToken.length >= 40);
    assert.equal(created.hotelCode, "gate");
    assert.equal(created.hotelName, "Gate Hotel");
    assert.equal(created.transferDate, "2026-01-15");
    assert.equal(created.pickupTime, "09:00");
    assert.equal(created.durationMinutes, 60);
    assert.equal(created.cancelled, false);
    assert.equal(created.pricing.priced, false);
    assert.equal(created.pricing.currency, null);
    assert.equal(created.pricing.amount, null);
    assert.equal("occupies" in created, false);
    assert.equal("vehicleId" in created, false);
    assert.equal("driverId" in created, false);
    assert.equal("internalNotes" in created, false);
    assert.equal("id" in created, false);

    const rows = await db.query<{
      vehicle_id: string | null;
      driver_id: string | null;
      internal_notes: string | null;
      lo: string;
      hi: string;
    }>(
      `select vehicle_id, driver_id, internal_notes,
              lower(occupies)::text as lo, upper(occupies)::text as hi
       from bookings where confirmation_token = $1`,
      [created.confirmationToken],
    );
    assert.equal(rows[0]!.vehicle_id, null);
    assert.equal(rows[0]!.driver_id, null);
    assert.equal(rows[0]!.internal_notes, null);
    assert.equal(new Date(rows[0]!.lo).toISOString(), "2026-01-15T07:00:00.000Z");
    assert.equal(new Date(rows[0]!.hi).toISOString(), "2026-01-15T08:00:00.000Z");
    await pg.close();
  });

  test("application insert does not supply occupies; trigger still fills it", async () => {
    const src = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
    const insert = src.slice(src.indexOf("insert into bookings"), src.indexOf("returning id"));
    assert.match(insert, /insert into bookings/);
    assert.doesNotMatch(insert, /occupies/);
    assert.doesNotMatch(insert, /vehicle_id/);
    assert.doesNotMatch(insert, /driver_id/);
    await Promise.resolve();
  });

  test("Athens civil-time validation uses the existing time domain", async () => {
    const { db, pg, hotelCode } = await openDb();
    await expectCode(
      () => createBooking(db, validInput(hotelCode, { pickupTime: "24:00" })),
      "invalid_time",
    );
    await expectCode(
      () =>
        createBooking(
          db,
          validInput(hotelCode, { transferDate: "2026-03-29", pickupTime: "03:30" }),
        ),
      "nonexistent",
    );
    await expectCode(
      () =>
        createBooking(
          db,
          validInput(hotelCode, { transferDate: "2026-10-25", pickupTime: "03:30" }),
        ),
      "ambiguous",
    );
    await pg.close();
  });

  test("duration 0 and >1440 reject; passenger/luggage/contact/location reject", async () => {
    const { db, pg, hotelCode } = await openDb();
    await expectCode(
      () => createBooking(db, validInput(hotelCode, { durationMinutes: 0 })),
      "invalid_duration",
    );
    await expectCode(
      () => createBooking(db, validInput(hotelCode, { durationMinutes: 1441 })),
      "invalid_duration",
    );
    await expectCode(
      () => createBooking(db, validInput(hotelCode, { passengerCount: 0 })),
      "invalid_party",
    );
    await expectCode(
      () => createBooking(db, validInput(hotelCode, { luggageCount: -1 })),
      "invalid_party",
    );
    await expectCode(
      () => createBooking(db, validInput(hotelCode, { guestEmail: "not-an-email" })),
      "invalid_contact",
    );
    await expectCode(
      () => createBooking(db, validInput(hotelCode, { guestPhone: "abc" })),
      "invalid_contact",
    );
    await expectCode(
      () => createBooking(db, validInput(hotelCode, { pickupText: "  " })),
      "invalid_location",
    );
    await expectCode(
      () => createBooking(db, validInput(hotelCode, { destinationText: "" })),
      "invalid_location",
    );
    await pg.close();
  });

  test("public lookup is token-only; reference-only lookup fails", async () => {
    const { db, pg, hotelCode } = await openDb();
    const created = await createBooking(db, validInput(hotelCode));
    const found = await getPublicBookingByToken(db, created.confirmationToken);
    assert.equal(found.humanReference, created.humanReference);
    assert.equal(found.confirmationToken, created.confirmationToken);

    await expectCode(
      () => getPublicBookingByToken(db, created.humanReference),
      "not_found",
    );
    await expectCode(() => getPublicBookingByToken(db, "nope"), "not_found");
    await pg.close();
  });

  test("idempotent create returns the same booking and does not duplicate", async () => {
    const { db, pg, hotelCode } = await openDb();
    const input = validInput(hotelCode, { idempotencyKey: "guest-key-1" });
    const first = await createBooking(db, input);
    const second = await createBooking(db, input);
    assert.equal(second.confirmationToken, first.confirmationToken);
    assert.equal(second.humanReference, first.humanReference);
    const count = await db.query<{ n: number }>("select count(*)::int as n from bookings");
    assert.equal(count[0]!.n, 1);

    await expectCode(
      () =>
        createBooking(
          db,
          validInput(hotelCode, {
            idempotencyKey: "guest-key-1",
            pickupTime: "10:00",
          }),
        ),
      "idempotency_conflict",
    );
    const still = await db.query<{ n: number }>("select count(*)::int as n from bookings");
    assert.equal(still[0]!.n, 1);
    await pg.close();
  });

  test("two creates without a key are distinct; tokens unique", async () => {
    const { db, pg, hotelCode } = await openDb();
    const a = await createBooking(db, validInput(hotelCode));
    const b = await createBooking(db, validInput(hotelCode));
    assert.notEqual(a.confirmationToken, b.confirmationToken);
    assert.notEqual(a.humanReference, b.humanReference);
    assert.ok(a.humanReference.startsWith(HUMAN_REFERENCE_PREFIX));
    const count = await db.query<{ n: number }>("select count(*)::int as n from bookings");
    assert.equal(count[0]!.n, 2);
    await pg.close();
  });

  test("public functions stay unauthenticated and omit assignment/payment", async () => {
    const fns = readFileSync(new URL("./booking-fns.ts", import.meta.url), "utf8");
    assert.doesNotMatch(fns, /requireOps/);
    assert.match(fns, /createPublicBooking/);
    assert.match(fns, /getPublicBooking/);
    const engine = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
    assert.doesNotMatch(engine, /vehicle_id/);
    assert.doesNotMatch(engine, /driver_id/);
    assert.doesNotMatch(engine, /localStorage/);
  });
});
