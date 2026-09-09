import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createBooking, type BookingDb } from "./booking.ts";
import {
  InventoryError,
  assignDriver,
  assignVehicle,
  cancelBooking,
  setBookingStatus,
  unassignVehicle,
} from "./inventory.ts";
import {
  OpsAuthError,
  createOperator,
  loginOperator,
  requireOps,
  type AuthEnv,
  type CookieJar,
  type CookieOpts,
} from "./ops-auth.ts";
import {
  OpsDeskError,
  getOpsBooking,
  listOpsBookings,
  listOpsDrivers,
  listOpsHotels,
  listOpsVehicles,
  loadTodayBoard,
  upsertDriver,
  upsertHotel,
  upsertVehicle,
} from "./ops-desk.ts";
import {
  grantHotelDesk,
  grantProviderDispatcher,
  type OpsScope,
} from "./tenancy.ts";

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

const FAST = { N: 16, r: 8, p: 1 };

type StoredCookie = { value: string; options: CookieOpts };

function memoryJar(): CookieJar & { store: Map<string, StoredCookie> } {
  const store = new Map<string, StoredCookie>();
  return {
    store,
    get: (name) => store.get(name)?.value,
    set: (name, value, options) => {
      store.set(name, { value, options });
    },
    delete: (name) => {
      store.delete(name);
    },
  };
}

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

function envFor(db: BookingDb, jar: CookieJar): AuthEnv {
  return {
    db,
    cookies: jar,
    headers: {
      get: (name) => (name.toLowerCase() === "x-aether-csrf" ? jar.get("aether_ops_csrf") ?? null : null),
    },
    cookieSecure: false,
  };
}

async function dispatcherScope(db: BookingDb, login: string, providerId: string): Promise<OpsScope> {
  const operator = await createOperator(db, login, "correct-horse", FAST);
  const membershipId = await grantProviderDispatcher(db, operator.id, providerId);
  return {
    operatorId: operator.id,
    login: operator.login,
    sessionId: "test-session",
    membershipId,
    accessClass: "provider_dispatcher",
    hotelId: null,
    providerId,
  };
}

async function deskScope(db: BookingDb, login: string, hotelId: string): Promise<OpsScope> {
  const operator = await createOperator(db, login, "correct-horse", FAST);
  const membershipId = await grantHotelDesk(db, operator.id, hotelId);
  return {
    operatorId: operator.id,
    login: operator.login,
    sessionId: "test-session",
    membershipId,
    accessClass: "hotel_desk",
    hotelId,
    providerId: null,
  };
}

const guest = {
  transferDate: "2026-03-10",
  pickupTime: "10:00",
  durationMinutes: 60,
  guestName: "Nikos",
  guestPhone: "+302101111111",
  guestEmail: "n@example.com",
  passengerCount: 1,
  luggageCount: 0,
  pickupText: "Hotel",
  destinationText: "ATH",
};

describe("CP12 tenancy", () => {
  test("0012 backfills legacy provider, agreements, and fleet without inventing hotel ownership", async () => {
    const { db, pg } = await openDb();
    const meta = await db.query<{ value: string }>(
      "select value from aether_meta where key = 'schema_phase'",
    );
    assert.equal(meta[0]?.value, "12");
    const provider = await db.query<{ id: string; kind: string }>(
      "select id, kind from providers where code = 'legacy'",
    );
    assert.equal(provider[0]?.kind, "external");
    const agreements = await db.query<{ n: number }>(
      "select count(*)::int as n from hotel_provider_agreements where active",
    );
    assert.equal(agreements[0]?.n, 2);
    const vans = await db.query<{ owned_by_hotel_id: string | null; owned_by_provider_id: string }>(
      "select owned_by_hotel_id, owned_by_provider_id from vehicles",
    );
    assert.ok(vans.length >= 1);
    for (const van of vans) {
      assert.equal(van.owned_by_hotel_id, null);
      assert.equal(van.owned_by_provider_id, provider[0]!.id);
    }
    await pg.close();
  });

  test("public booking stamps executing_provider_id; hotel without agreement fails", async () => {
    const { db, pg } = await openDb();
    const created = await createBooking(db, { hotelCode: "gate", ...guest });
    const row = await db.query<{ executing_provider_id: string; hotel_code: string }>(
      `select b.executing_provider_id, h.code as hotel_code
         from bookings b join hotels h on h.id = b.hotel_id
        where b.confirmation_token = $1`,
      [created.confirmationToken],
    );
    const legacy = await db.query<{ id: string }>("select id from providers where code = 'legacy'");
    assert.equal(row[0]?.executing_provider_id, legacy[0]?.id);
    assert.equal(created.hotelCode, "gate");
    assert.equal("executingProviderId" in created, false);

    await db.query("insert into hotels (code, name) values ('orphan', 'Orphan Hotel')");
    await assert.rejects(
      () => createBooking(db, { hotelCode: "orphan", ...guest, guestEmail: "o@example.com" }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === "no_provider",
    );
    await pg.close();
  });

  test("hotel A desk cannot see hotel B PII or list fleet", async () => {
    const { db, pg } = await openDb();
    const hotels = await db.query<{ id: string; code: string }>("select id, code from hotels");
    const gate = hotels.find((h) => h.code === "gate")!;
    const a = await createBooking(db, { hotelCode: "gate", ...guest });
    const b = await createBooking(db, {
      hotelCode: "harbor",
      ...guest,
      guestName: "Harbor Guest",
      guestEmail: "harbor@example.com",
    });
    const aId = (
      await db.query<{ id: string }>("select id from bookings where confirmation_token = $1", [
        a.confirmationToken,
      ])
    )[0]!.id;
    const bId = (
      await db.query<{ id: string }>("select id from bookings where confirmation_token = $1", [
        b.confirmationToken,
      ])
    )[0]!.id;
    const deskA = await deskScope(db, "desk-a", gate.id);
    const listed = await listOpsBookings(db, deskA);
    assert.equal(listed.every((row) => row.hotelCode === "gate"), true);
    assert.equal(listed.some((row) => row.id === bId), false);
    const gotA = await getOpsBooking(db, deskA, aId);
    assert.equal(gotA.guestName, "Nikos");
    await assert.rejects(() => getOpsBooking(db, deskA, bId), (err: unknown) => {
      return err instanceof OpsDeskError && err.code === "not_found";
    });
    await assert.rejects(() => listOpsVehicles(db, deskA), (err: unknown) => {
      return err instanceof OpsDeskError && err.code === "forbidden";
    });
    await assert.rejects(() => listOpsDrivers(db, deskA), (err: unknown) => {
      return err instanceof OpsDeskError && err.code === "forbidden";
    });
    await assert.rejects(() => assignVehicle(db, { bookingId: aId, vehicleId: listed[0]?.vehicleId ?? aId, scope: deskA }), (err: unknown) => {
      return err instanceof InventoryError && err.code === "forbidden";
    });
    await assert.rejects(() => unassignVehicle(db, { bookingId: aId, scope: deskA }), (err: unknown) => {
      return err instanceof InventoryError && err.code === "forbidden";
    });
    await assert.rejects(() => assignDriver(db, { bookingId: aId, driverId: aId, scope: deskA }), (err: unknown) => {
      return err instanceof InventoryError && err.code === "forbidden";
    });
    const hotelsVisible = await listOpsHotels(db, deskA);
    assert.deepEqual(hotelsVisible.map((h) => h.code), ["gate"]);
    await pg.close();
  });

  test("provider X cannot use provider Y assets or see Y bookings", async () => {
    const { db, pg } = await openDb();
    const other = await db.query<{ id: string }>(
      "insert into providers (code, name, kind) values ('otherops', 'Other Ops', 'external') returning id",
    );
    const otherId = other[0]!.id;
    const yVehicle = await db.query<{ id: string }>(
      `insert into vehicles (name, owned_by_provider_id, operated_by_provider_id)
       values ('Y Van', $1::uuid, $1::uuid) returning id`,
      [otherId],
    );
    const yDriver = await db.query<{ id: string }>(
      `insert into drivers (name, employed_by_provider_id, dispatched_by_provider_id)
       values ('Y Driver', $1::uuid, $1::uuid) returning id`,
      [otherId],
    );
    const created = await createBooking(db, { hotelCode: "gate", ...guest, guestEmail: "xy@example.com" });
    const bookingId = (
      await db.query<{ id: string }>("select id from bookings where confirmation_token = $1", [
        created.confirmationToken,
      ])
    )[0]!.id;
    const legacy = (await db.query<{ id: string }>("select id from providers where code = 'legacy'"))[0]!.id;
    const x = await dispatcherScope(db, "disp-x", legacy);
    const y = await dispatcherScope(db, "disp-y", otherId);
    const xList = await listOpsBookings(db, x);
    assert.ok(xList.some((row) => row.id === bookingId));
    const yList = await listOpsBookings(db, y);
    assert.equal(yList.some((row) => row.id === bookingId), false);
    await assert.rejects(
      () => assignVehicle(db, { bookingId, vehicleId: yVehicle[0]!.id, scope: x }),
      (err: unknown) => err instanceof InventoryError && err.code === "not_found",
    );
    await assert.rejects(
      () => assignDriver(db, { bookingId, driverId: yDriver[0]!.id, scope: x }),
      (err: unknown) => err instanceof InventoryError && err.code === "not_found",
    );
    const yOwn = await upsertVehicle(db, y, { name: "Stolen", capacity: 4, active: true });
    assert.equal(yOwn.name, "Stolen");
    const xFleet = await listOpsVehicles(db, x);
    const yFleet = await listOpsVehicles(db, y);
    assert.equal(xFleet.some((row) => row.id === yVehicle[0]!.id), false);
    assert.ok(yFleet.some((row) => row.id === yVehicle[0]!.id));
    assert.ok(yFleet.some((row) => row.id === yOwn.id));
    assert.equal(yFleet.some((row) => xFleet.some((mine) => mine.id === row.id)), false);
    await assert.rejects(
      () => upsertVehicle(db, y, { id: xFleet[0]!.id, name: "Hijack", capacity: 4, active: true }),
      (err: unknown) => err instanceof OpsDeskError && err.code === "not_found",
    );
    const xDrivers = await listOpsDrivers(db, x);
    await assert.rejects(
      () => upsertDriver(db, y, { id: xDrivers[0]!.id, name: "Hijack", active: true }),
      (err: unknown) => err instanceof OpsDeskError && err.code === "not_found",
    );
    await pg.close();
  });

  test("one provider serving A/B still isolates hotel desks", async () => {
    const { db, pg } = await openDb();
    const hotels = await db.query<{ id: string; code: string }>("select id, code from hotels");
    const gate = hotels.find((h) => h.code === "gate")!;
    const harbor = hotels.find((h) => h.code === "harbor")!;
    await createBooking(db, { hotelCode: "gate", ...guest, guestEmail: "ga@example.com" });
    await createBooking(db, { hotelCode: "harbor", ...guest, guestEmail: "hb@example.com" });
    const legacy = (await db.query<{ id: string }>("select id from providers where code = 'legacy'"))[0]!.id;
    const dispatcher = await dispatcherScope(db, "shared-disp", legacy);
    const board = await loadTodayBoard(db, dispatcher);
    const all = await listOpsBookings(db, dispatcher);
    assert.ok(all.some((r) => r.hotelCode === "gate"));
    assert.ok(all.some((r) => r.hotelCode === "harbor"));
    assert.ok(board.feed.length >= 0);
    const deskA = await deskScope(db, "gate-desk", gate.id);
    const deskB = await deskScope(db, "harbor-desk", harbor.id);
    const aOnly = await listOpsBookings(db, deskA);
    const bOnly = await listOpsBookings(db, deskB);
    assert.equal(aOnly.every((r) => r.hotelCode === "gate"), true);
    assert.equal(bOnly.every((r) => r.hotelCode === "harbor"), true);
    await pg.close();
  });

  test("ownership models 1–3 allow dispatch only for the operating provider", async () => {
    const { db, pg } = await openDb();
    const hotel = (await db.query<{ id: string }>("select id from hotels where code = 'gate'"))[0]!;
    const inHouse = (
      await db.query<{ id: string }>(
        "insert into providers (code, name, kind) values ('gate-ops', 'Gate Ops', 'in_house') returning id",
      )
    )[0]!;
    const external = (
      await db.query<{ id: string }>(
        "insert into providers (code, name, kind) values ('ext-ops', 'Ext Ops', 'external') returning id",
      )
    )[0]!;
    await db.query("update hotel_provider_agreements set active = false where hotel_id = $1::uuid", [
      hotel.id,
    ]);
    await db.query(
      "insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)",
      [hotel.id, inHouse.id],
    );
    const v1 = (
      await db.query<{ id: string }>(
        `insert into vehicles (name, owned_by_hotel_id, operated_by_provider_id)
         values ('M1', $1::uuid, $2::uuid) returning id`,
        [hotel.id, inHouse.id],
      )
    )[0]!;
    const v2 = (
      await db.query<{ id: string }>(
        `insert into vehicles (name, owned_by_hotel_id, operated_by_provider_id)
         values ('M2', $1::uuid, $2::uuid) returning id`,
        [hotel.id, external.id],
      )
    )[0]!;
    const v3 = (
      await db.query<{ id: string }>(
        `insert into vehicles (name, owned_by_provider_id, operated_by_provider_id)
         values ('M3', $1::uuid, $1::uuid) returning id`,
        [external.id],
      )
    )[0]!;
    const d1 = (
      await db.query<{ id: string }>(
        `insert into drivers (name, employed_by_hotel_id, dispatched_by_provider_id)
         values ('D1', $1::uuid, $2::uuid) returning id`,
        [hotel.id, inHouse.id],
      )
    )[0]!;
    const d2 = (
      await db.query<{ id: string }>(
        `insert into drivers (name, employed_by_hotel_id, dispatched_by_provider_id)
         values ('D2', $1::uuid, $2::uuid) returning id`,
        [hotel.id, external.id],
      )
    )[0]!;
    const d3 = (
      await db.query<{ id: string }>(
        `insert into drivers (name, employed_by_provider_id, dispatched_by_provider_id)
         values ('D3', $1::uuid, $1::uuid) returning id`,
        [external.id],
      )
    )[0]!;
    const created = await createBooking(db, { hotelCode: "gate", ...guest, guestEmail: "m@example.com" });
    const bookingId = (
      await db.query<{ id: string }>("select id from bookings where confirmation_token = $1", [
        created.confirmationToken,
      ])
    )[0]!.id;
    const inHouseDisp = await dispatcherScope(db, "inhouse", inHouse.id);
    await assignVehicle(db, { bookingId, vehicleId: v1.id, scope: inHouseDisp });
    await assignDriver(db, { bookingId, driverId: d1.id, scope: inHouseDisp });
    await assert.rejects(
      () => assignVehicle(db, { bookingId, vehicleId: v2.id, scope: inHouseDisp }),
      (err: unknown) => err instanceof InventoryError && err.code === "not_found",
    );
    await assert.rejects(
      () => assignVehicle(db, { bookingId, vehicleId: v3.id, scope: inHouseDisp }),
      (err: unknown) => err instanceof InventoryError && err.code === "not_found",
    );

    await db.query("update hotel_provider_agreements set active = false where hotel_id = $1::uuid", [
      hotel.id,
    ]);
    await db.query(
      "insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)",
      [hotel.id, external.id],
    );
    const created2 = await createBooking(db, {
      hotelCode: "gate",
      ...guest,
      guestEmail: "m2@example.com",
      pickupTime: "12:00",
    });
    const bookingId2 = (
      await db.query<{ id: string }>("select id from bookings where confirmation_token = $1", [
        created2.confirmationToken,
      ])
    )[0]!.id;
    const extDisp = await dispatcherScope(db, "external", external.id);
    await assignVehicle(db, { bookingId: bookingId2, vehicleId: v2.id, scope: extDisp });
    await unassignVehicle(db, { bookingId: bookingId2, scope: extDisp });
    await assignVehicle(db, { bookingId: bookingId2, vehicleId: v3.id, scope: extDisp });
    await assignDriver(db, { bookingId: bookingId2, driverId: d2.id, scope: extDisp });
    await assignDriver(db, { bookingId: bookingId2, driverId: d3.id, scope: extDisp });
    await assert.rejects(
      () => assignVehicle(db, { bookingId: bookingId2, vehicleId: v1.id, scope: extDisp }),
      (err: unknown) => err instanceof InventoryError && err.code === "not_found",
    );
    await assert.rejects(
      () => assignDriver(db, { bookingId: bookingId2, driverId: d1.id, scope: extDisp }),
      (err: unknown) => err instanceof InventoryError && err.code === "not_found",
    );
    await pg.close();
  });

  test("provider may assign operated assets but may only modify owned/employed ones", async () => {
    const { db, pg } = await openDb();
    const hotel = (await db.query<{ id: string }>("select id from hotels where code = 'gate'"))[0]!;
    const operator = (
      await db.query<{ id: string }>(
        "insert into providers (code, name, kind) values ('own-ops', 'Own Ops', 'external') returning id",
      )
    )[0]!;
    const other = (
      await db.query<{ id: string }>(
        "insert into providers (code, name, kind) values ('other-own', 'Other Own', 'external') returning id",
      )
    )[0]!;
    await db.query("update hotel_provider_agreements set active = false where hotel_id = $1::uuid", [
      hotel.id,
    ]);
    await db.query(
      "insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)",
      [hotel.id, operator.id],
    );
    const hotelVan = (
      await db.query<{ id: string }>(
        `insert into vehicles (name, owned_by_hotel_id, operated_by_provider_id)
         values ('Hotel Van', $1::uuid, $2::uuid) returning id`,
        [hotel.id, operator.id],
      )
    )[0]!;
    const hotelDriver = (
      await db.query<{ id: string }>(
        `insert into drivers (name, employed_by_hotel_id, dispatched_by_provider_id)
         values ('Hotel Driver', $1::uuid, $2::uuid) returning id`,
        [hotel.id, operator.id],
      )
    )[0]!;
    const disp = await dispatcherScope(db, "own-disp", operator.id);
    const otherDisp = await dispatcherScope(db, "other-disp", other.id);

    const ownedVan = await upsertVehicle(db, disp, { name: "Ops Van", capacity: 8, active: true });
    const renamedVan = await upsertVehicle(db, disp, {
      id: ownedVan.id,
      name: "Ops Van Mk2",
      capacity: 9,
      active: true,
    });
    assert.equal(renamedVan.name, "Ops Van Mk2");
    assert.equal(renamedVan.capacity, 9);

    const ownedDriver = await upsertDriver(db, disp, { name: "Ops Driver", active: true });
    const renamedDriver = await upsertDriver(db, disp, {
      id: ownedDriver.id,
      name: "Ops Driver Mk2",
      active: false,
    });
    assert.equal(renamedDriver.name, "Ops Driver Mk2");
    assert.equal(renamedDriver.active, false);
    await upsertDriver(db, disp, { id: ownedDriver.id, name: "Ops Driver Mk2", active: true });

    const fleet = await listOpsVehicles(db, disp);
    const roster = await listOpsDrivers(db, disp);
    assert.ok(fleet.some((row) => row.id === hotelVan.id));
    assert.ok(fleet.some((row) => row.id === ownedVan.id));
    assert.ok(roster.some((row) => row.id === hotelDriver.id));
    assert.ok(roster.some((row) => row.id === ownedDriver.id));

    await assert.rejects(
      () => upsertVehicle(db, disp, { id: hotelVan.id, name: "Hijack Van", capacity: 4, active: false }),
      (err: unknown) => err instanceof OpsDeskError && err.code === "not_found",
    );
    await assert.rejects(
      () => upsertDriver(db, disp, { id: hotelDriver.id, name: "Hijack Driver", active: false }),
      (err: unknown) => err instanceof OpsDeskError && err.code === "not_found",
    );
    const vanAfter = await db.query<{ name: string; active: boolean }>(
      "select name, active from vehicles where id = $1::uuid",
      [hotelVan.id],
    );
    const driverAfter = await db.query<{ name: string; active: boolean }>(
      "select name, active from drivers where id = $1::uuid",
      [hotelDriver.id],
    );
    assert.equal(vanAfter[0]?.name, "Hotel Van");
    assert.equal(vanAfter[0]?.active, true);
    assert.equal(driverAfter[0]?.name, "Hotel Driver");
    assert.equal(driverAfter[0]?.active, true);

    const created = await createBooking(db, { hotelCode: "gate", ...guest, guestEmail: "own@example.com" });
    const bookingId = (
      await db.query<{ id: string }>("select id from bookings where confirmation_token = $1", [
        created.confirmationToken,
      ])
    )[0]!.id;
    await assignVehicle(db, { bookingId, vehicleId: hotelVan.id, scope: disp });
    await assignDriver(db, { bookingId, driverId: hotelDriver.id, scope: disp });

    await assert.rejects(
      () => upsertVehicle(db, otherDisp, { id: ownedVan.id, name: "Steal", capacity: 4, active: true }),
      (err: unknown) => err instanceof OpsDeskError && err.code === "not_found",
    );
    await assert.rejects(
      () => upsertDriver(db, otherDisp, { id: ownedDriver.id, name: "Steal", active: true }),
      (err: unknown) => err instanceof OpsDeskError && err.code === "not_found",
    );
    await assert.rejects(
      () => upsertVehicle(db, otherDisp, { id: hotelVan.id, name: "Steal Hotel", capacity: 4, active: true }),
      (err: unknown) => err instanceof OpsDeskError && err.code === "not_found",
    );
    await assert.rejects(
      () => assignVehicle(db, { bookingId, vehicleId: hotelVan.id, scope: otherDisp }),
      (err: unknown) => err instanceof InventoryError && err.code === "forbidden",
    );
    await assert.rejects(
      () => assignDriver(db, { bookingId, driverId: hotelDriver.id, scope: otherDisp }),
      (err: unknown) => err instanceof InventoryError && err.code === "forbidden",
    );
    const otherVan = await upsertVehicle(db, otherDisp, { name: "Other Van", capacity: 4, active: true });
    await assert.rejects(
      () => assignVehicle(db, { bookingId, vehicleId: otherVan.id, scope: otherDisp }),
      (err: unknown) => err instanceof InventoryError && err.code === "forbidden",
    );
    await assert.rejects(
      () => assignVehicle(db, { bookingId, vehicleId: otherVan.id, scope: disp }),
      (err: unknown) => err instanceof InventoryError && err.code === "not_found",
    );
    await pg.close();
  });

  test("membership failures: missing, inactive, wrong class, ambiguous login", async () => {
    const { db, pg } = await openDb();
    const operator = await createOperator(db, "nomem", "correct-horse", FAST);
    const jar = memoryJar();
    await assert.rejects(
      () => loginOperator(envFor(db, jar), "nomem", "correct-horse"),
      (err: unknown) => err instanceof OpsAuthError && err.code === "no_membership",
    );
    const hotel = (await db.query<{ id: string }>("select id from hotels where code = 'gate'"))[0]!;
    const membershipId = await grantHotelDesk(db, operator.id, hotel.id);
    await db.query("update operator_memberships set active = false where id = $1::uuid", [membershipId]);
    await assert.rejects(
      () => loginOperator(envFor(db, jar), "nomem", "correct-horse"),
      (err: unknown) => err instanceof OpsAuthError && err.code === "no_membership",
    );
    await db.query("update operator_memberships set active = true where id = $1::uuid", [membershipId]);
    const legacy = (await db.query<{ id: string }>("select id from providers where code = 'legacy'"))[0]!;
    await grantProviderDispatcher(db, operator.id, legacy.id);
    await assert.rejects(
      () => loginOperator(envFor(db, jar), "nomem", "correct-horse"),
      (err: unknown) => err instanceof OpsAuthError && err.code === "ambiguous_membership",
    );
    const desk = await deskScope(db, "status-desk", hotel.id);
    const created = await createBooking(db, { hotelCode: "gate", ...guest, guestEmail: "st@example.com" });
    const bookingId = (
      await db.query<{ id: string }>("select id from bookings where confirmation_token = $1", [
        created.confirmationToken,
      ])
    )[0]!.id;
    await assert.rejects(
      () => setBookingStatus(db, { bookingId, status: "rolling", scope: desk }),
      (err: unknown) => err instanceof InventoryError && err.code === "forbidden",
    );
    await upsertHotel(db, desk, { code: "nope", name: "Nope" }).then(
      () => assert.fail("upsertHotel should 403"),
      (err: unknown) => {
        assert.ok(err instanceof OpsDeskError && err.code === "forbidden");
      },
    );
    await pg.close();
  });

  test("hotel desk can cancel own booking; occupancy still releases; login binds single membership", async () => {
    const { db, pg } = await openDb();
    const hotel = (await db.query<{ id: string }>("select id from hotels where code = 'gate'"))[0]!;
    const created = await createBooking(db, { hotelCode: "gate", ...guest, guestEmail: "cx@example.com" });
    const bookingId = (
      await db.query<{ id: string }>("select id from bookings where confirmation_token = $1", [
        created.confirmationToken,
      ])
    )[0]!.id;
    const desk = await deskScope(db, "cancel-desk", hotel.id);
    await cancelBooking(db, { bookingId, scope: desk });
    const occ = await db.query<{ empty: boolean }>(
      "select isempty(occupies) as empty from bookings where id = $1",
      [bookingId],
    );
    assert.equal(occ[0]?.empty, true);
    const operator = await createOperator(db, "single", "correct-horse", FAST);
    const legacy = (await db.query<{ id: string }>("select id from providers where code = 'legacy'"))[0]!;
    await grantProviderDispatcher(db, operator.id, legacy.id);
    const jar = memoryJar();
    await loginOperator(envFor(db, jar), "single", "correct-horse");
    const ctx = await requireOps(envFor(db, jar), { csrf: true });
    assert.equal(ctx.accessClass, "provider_dispatcher");
    assert.equal(ctx.providerId, legacy.id);
    await pg.close();
  });

  test("occupancy EXCLUDE still rejects overlapping dispatch on same vehicle", async () => {
    const { db, pg } = await openDb();
    const legacy = (await db.query<{ id: string }>("select id from providers where code = 'legacy'"))[0]!;
    const van = (await db.query<{ id: string }>("select id from vehicles limit 1"))[0]!;
    const a = await createBooking(db, { hotelCode: "gate", ...guest, guestEmail: "oa@example.com" });
    const b = await createBooking(db, {
      hotelCode: "gate",
      ...guest,
      guestEmail: "ob@example.com",
      pickupTime: "10:30",
    });
    const idA = (
      await db.query<{ id: string }>("select id from bookings where confirmation_token = $1", [
        a.confirmationToken,
      ])
    )[0]!.id;
    const idB = (
      await db.query<{ id: string }>("select id from bookings where confirmation_token = $1", [
        b.confirmationToken,
      ])
    )[0]!.id;
    const disp = await dispatcherScope(db, "occ-disp", legacy.id);
    await assignVehicle(db, { bookingId: idA, vehicleId: van.id, scope: disp });
    await assert.rejects(
      () => assignVehicle(db, { bookingId: idB, vehicleId: van.id, scope: disp }),
      (err: unknown) => err instanceof InventoryError && err.code === "unavailable",
    );
    await pg.close();
  });

  test("0012 preserves existing booking identity and stamps executing_provider_id", async () => {
    const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
    const pg = new PGlite({ extensions: { btree_gist } });
    await pg.waitReady;
    for (const name of SQL_FILES) {
      if (name === "0012_cp12_tenancy.sql") continue;
      await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
    }
    const before = await pg.query<{
      id: string;
      human_reference: string;
      confirmation_token: string;
      hotel_id: string;
      vehicle_id: string | null;
      driver_id: string | null;
      occupies: string;
    }>(
      `insert into bookings (
         hotel_id, transfer_date, pickup_time, duration_minutes,
         vehicle_id, driver_id,
         guest_name, guest_phone, guest_email,
         pickup_text, destination_text,
         human_reference, confirmation_token
       )
       select h.id, date '2026-03-01', time '12:00', 60, v.id, d.id,
              'Keep', '+302101111111', 'keep@example.com',
              'Hotel', 'ATH', 'PT-KEEPTEST01', 'keep-token-cp12-preserve'
         from hotels h, vehicles v, drivers d
        where h.code = 'gate'
        limit 1
       returning id, human_reference, confirmation_token, hotel_id, vehicle_id, driver_id,
                 occupies::text as occupies`,
    );
    const snap = before.rows[0]!;
    assert.ok(snap.id);
    await pg.exec(
      readFileSync(new URL("../../../migrations/0012_cp12_tenancy.sql", import.meta.url), "utf8"),
    );
    const after = await pg.query<{
      id: string;
      human_reference: string;
      confirmation_token: string;
      hotel_id: string;
      vehicle_id: string | null;
      driver_id: string | null;
      occupies: string;
      executing_provider_id: string;
    }>(
      `select id, human_reference, confirmation_token, hotel_id, vehicle_id, driver_id,
              occupies::text as occupies, executing_provider_id
         from bookings where id = $1`,
      [snap.id],
    );
    const row = after.rows[0]!;
    assert.equal(row.id, snap.id);
    assert.equal(row.human_reference, snap.human_reference);
    assert.equal(row.confirmation_token, snap.confirmation_token);
    assert.equal(row.hotel_id, snap.hotel_id);
    assert.equal(row.vehicle_id, snap.vehicle_id);
    assert.equal(row.driver_id, snap.driver_id);
    assert.equal(row.occupies, snap.occupies);
    const legacy = await pg.query<{ id: string }>("select id from providers where code = 'legacy'");
    assert.equal(row.executing_provider_id, legacy.rows[0]!.id);
    await pg.close();
  });

  test("dual-hat schema is allowed; login still fails closed when two hats are active", async () => {
    const { db, pg } = await openDb();
    const operator = await createOperator(db, "dual", "correct-horse", FAST);
    const hotel = (await db.query<{ id: string }>("select id from hotels where code = 'gate'"))[0]!;
    const legacy = (await db.query<{ id: string }>("select id from providers where code = 'legacy'"))[0]!;
    const deskId = await grantHotelDesk(db, operator.id, hotel.id);
    const dispId = await grantProviderDispatcher(db, operator.id, legacy.id);
    assert.notEqual(deskId, dispId);
    const hats = await db.query<{ n: number }>(
      "select count(*)::int as n from operator_memberships where operator_id = $1::uuid and active",
      [operator.id],
    );
    assert.equal(hats[0]?.n, 2);
    const jar = memoryJar();
    await assert.rejects(
      () => loginOperator(envFor(db, jar), "dual", "correct-horse"),
      (err: unknown) => err instanceof OpsAuthError && err.code === "ambiguous_membership",
    );
    await pg.close();
  });
});
