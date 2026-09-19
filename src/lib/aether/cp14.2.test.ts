/**
 * CP14.2 — LIVE public booking quote path and hotel-scoped destination catalogue.
 * Schema is CP14.1. Occupancy, RLS, tenants, timezone conversion are out of scope.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  BookingError,
  createBooking,
  getPublicBookingByToken,
  getPublicHotel,
  type BookingDb,
} from "./booking.ts";
import {
  CP14_DEFAULT_AMOUNT_MINOR,
  CP14_DEFAULT_DESTINATION_NAME,
  applyCp14LiveCatalog,
} from "./cp14-fixture.ts";

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
  "0019_cp23_public_hotel_slug.sql",
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
} as const;

function readMigration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

async function openDb(): Promise<{ db: BookingDb; pg: PGlite }> {
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
  const db: BookingDb = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner: BookingDb = {
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

async function openLive() {
  const ctx = await openDb();
  const destinations = await applyCp14LiveCatalog(ctx.pg);
  return { ...ctx, destinations };
}

function guestInput(
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
    guestEmail: "ada@example.com",
    passengerCount: 2,
    luggageCount: 1,
    pickupText: "Gate Hotel",
    destinationText: "client-supplied name",
    ...extra,
  };
}

describe("CP14.2 booking quote path", () => {
  test("LIVE hotel + active destination creates a quoted booking", async () => {
    const { db, pg, destinations } = await openLive();
    const created = await createBooking(db, guestInput("gate", destinations.gate!));
    assert.equal(created.destinationId, destinations.gate);
    assert.equal(created.destinationText, CP14_DEFAULT_DESTINATION_NAME);
    assert.equal(created.pricing.priced, true);
    assert.deepEqual(created.pricing, {
      priced: true,
      currency: "EUR",
      amountMinor: CP14_DEFAULT_AMOUNT_MINOR,
    });
    const hotel = await getPublicHotel(db, "gate");
    assert.equal(hotel.currency, "EUR");
    assert.ok(hotel.destinations.some((item) => item.id === destinations.gate));
    assert.equal("occupies" in created, false);
    await pg.close();
  });

  test("client cannot spoof amount or currency", async () => {
    const { db, pg, destinations } = await openLive();
    const created = await createBooking(
      db,
      guestInput("gate", destinations.gate!, {
        quotedAmountMinor: 1,
        quotedCurrency: "USD",
        amountMinor: 99,
        currency: "USD",
        amount: 12.34,
        destinationText: "HACKED",
      }),
    );
    assert.equal(created.destinationText, CP14_DEFAULT_DESTINATION_NAME);
    assert.deepEqual(created.pricing, {
      priced: true,
      currency: "EUR",
      amountMinor: CP14_DEFAULT_AMOUNT_MINOR,
    });
    const row = await db.query<{
      quoted_amount_minor: number;
      quoted_currency: string;
      destination_text: string;
    }>(
      `select quoted_amount_minor, btrim(quoted_currency) as quoted_currency, destination_text
         from bookings where confirmation_token = $1`,
      [created.confirmationToken],
    );
    assert.equal(Number(row[0]!.quoted_amount_minor), CP14_DEFAULT_AMOUNT_MINOR);
    assert.equal(row[0]!.quoted_currency, "EUR");
    assert.equal(row[0]!.destination_text, CP14_DEFAULT_DESTINATION_NAME);
    await pg.close();
  });

  test("destination is hotel-scoped; inactive and foreign destinations reject", async () => {
    const { db, pg, destinations } = await openLive();
    await expectCode(
      () => createBooking(db, guestInput("gate", destinations.harbor!)),
      "invalid_destination",
    );

    const inactive = await db.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, sort_order, amount_minor, active)
       select id, 'port', 'Inactive Port', 20, 2200, false
         from hotels where code = 'gate'
       returning id`,
    );
    await expectCode(
      () => createBooking(db, guestInput("gate", inactive[0]!.id)),
      "invalid_destination",
    );

    const publicHotel = await getPublicHotel(db, "gate");
    assert.equal(
      publicHotel.destinations.some((item) => item.id === inactive[0]!.id),
      false,
    );
    await pg.close();
  });

  test("non-LIVE hotel cannot create a public booking", async () => {
    const { db, pg } = await openDb();
    await expectCode(() => getPublicHotel(db, "gate"), "hotel_not_live");

    const destinations = await applyCp14LiveCatalog(pg);
    await db.query("update hotels set status = 'configured' where code = 'gate'");
    await expectCode(
      () => createBooking(db, guestInput("gate", destinations.gate!)),
      "hotel_not_live",
    );
    await expectCode(() => getPublicHotel(db, "gate"), "hotel_not_live");

    await db.query("update hotels set status = 'unconfigured' where code = 'gate'");
    await expectCode(
      () => createBooking(db, guestInput("gate", destinations.gate!)),
      "hotel_not_live",
    );
    await pg.close();
  });

  test("idempotency distinguishes destination and quote changes", async () => {
    const { db, pg, destinations } = await openLive();
    const extra = await db.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, sort_order, amount_minor)
       select id, 'port', 'Piraeus', 20, 7800
         from hotels where code = 'gate'
       returning id`,
    );
    const key = "cp14-2-guest-key";
    const first = await createBooking(
      db,
      guestInput("gate", destinations.gate!, { idempotencyKey: key }),
    );
    const replay = await createBooking(
      db,
      guestInput("gate", destinations.gate!, { idempotencyKey: key }),
    );
    assert.equal(replay.confirmationToken, first.confirmationToken);

    await expectCode(
      () =>
        createBooking(
          db,
          guestInput("gate", extra[0]!.id, { idempotencyKey: key }),
        ),
      "idempotency_conflict",
    );

    await db.query("update hotel_destinations set amount_minor = 9900 where id = $1::uuid", [
      destinations.gate,
    ]);
    await expectCode(
      () =>
        createBooking(
          db,
          guestInput("gate", destinations.gate!, { idempotencyKey: key }),
        ),
      "idempotency_conflict",
    );
    const count = await db.query<{ n: number }>("select count(*)::int as n from bookings");
    assert.equal(count[0]!.n, 1);
    await pg.close();
  });

  test("confirmation DTO exposes price; legacy unquoted lookup remains valid", async () => {
    const { db, pg, destinations } = await openLive();
    const created = await createBooking(db, guestInput("gate", destinations.gate!));
    const found = await getPublicBookingByToken(db, created.confirmationToken);
    assert.equal(found.destinationId, destinations.gate);
    assert.deepEqual(found.pricing, {
      priced: true,
      currency: "EUR",
      amountMinor: CP14_DEFAULT_AMOUNT_MINOR,
    });
    assert.equal("confirmationToken" in found, false);
    assert.equal("guestPhone" in found, false);
    assert.equal("quoted_amount_minor" in found, false);

    await db.query(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, pickup_text, destination_text,
         human_reference, confirmation_token
       ) values (
         (select id from hotels where code = 'gate'),
         (select id from providers where code = 'legacy'),
         '2026-02-01', '11:00', 60,
         'Legacy Guest', '+302109999999', 'legacy@example.com',
         'Lobby', 'ATH airport',
         'PT-LEGACY0001', 'legacy-unquoted-token-cp14-2-aaaa'
       )`,
    );
    const legacy = await getPublicBookingByToken(db, "legacy-unquoted-token-cp14-2-aaaa");
    assert.equal(legacy.destinationId, null);
    assert.equal(legacy.destinationText, "ATH airport");
    assert.deepEqual(legacy.pricing, {
      priced: false,
      currency: null,
      amountMinor: null,
    });
    assert.equal(legacy.guestName, "Legacy Guest");
    await pg.close();
  });

  test("0011–0014 remain byte-identical; booking insert still does not write occupies", () => {
    for (const [name, expected] of Object.entries(IMMUTABLE)) {
      assert.equal(sha256(readMigration(name)), expected, name);
    }
    const engine = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
    const insert = engine.slice(engine.indexOf("insert into bookings"), engine.indexOf("returning id"));
    assert.match(insert, /destination_id/);
    assert.match(insert, /quoted_amount_minor/);
    assert.match(insert, /quoted_currency/);
    assert.doesNotMatch(insert, /occupies/);
    assert.doesNotMatch(insert, /vehicle_id/);
    assert.doesNotMatch(insert, /driver_id/);
    const wizard = readFileSync(
      new URL("../../components/aether/guest-book.tsx", import.meta.url),
      "utf8",
    );
    assert.match(wizard, /destinationId/);
    assert.match(wizard, /formatQuotedPrice/);
    assert.doesNotMatch(wizard, /create table tenants/i);
  });
});
