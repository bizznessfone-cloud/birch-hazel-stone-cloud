/**
 * CP17 — hotel-local Ops Today for hotel_desk.
 * Dispatcher Today remains Athens-global. Feed stays transfer_date equality.
 * Occupancy, CP15 auth, and 0011–0017 are unchanged. No migration 0018.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AETHER_APP_ROLE } from "./runtime-role.ts";
import { createBooking, type BookingDb } from "./booking.ts";
import { cancelBooking } from "./inventory.ts";
import { createOperator } from "./ops-auth.ts";
import { OpsDeskError, loadTodayBoard } from "./ops-desk.ts";
import {
  grantHotelDesk,
  grantProviderDispatcher,
  type OpsScope,
} from "./tenancy.ts";
import { CivilTimeError, civilToday, type TimeDb } from "./time.ts";
import { provisionHotel, type ProvisionDb } from "./provision.ts";

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
  "0017_cp16_runtime_privilege_hardening.sql",
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
  "0016_cp14_hotel_timezone.sql":
    "a227cb4c40d261ef55d4e6ce11e23f5fc6cb6611259316a768ec277d3ae045ca",
  "0017_cp16_runtime_privilege_hardening.sql":
    "98f5ab213ca214d6bbade354544b15c0c1bd30c81cf7e54a582257a86313a0bb",
} as const;

const FAST = { N: 16, r: 8, p: 1 };

type SqlDb = BookingDb & TimeDb & ProvisionDb;

function readMigration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readAether(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

async function openDb(): Promise<{ db: SqlDb; pg: PGlite }> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  try {
    await pg.exec("create database neondb");
  } catch {
    /* already exists */
  }
  for (const name of SQL_FILES) {
    await pg.exec(readMigration(name));
  }
  const db: SqlDb = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    async transaction<T>(fn: (inner: SqlDb) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner: SqlDb = {
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

async function asApp<T>(pg: PGlite, fn: () => Promise<T>): Promise<T> {
  await pg.exec(`set role ${AETHER_APP_ROLE}`);
  try {
    return await fn();
  } finally {
    await pg.exec("reset role");
  }
}

async function seedLive(
  db: SqlDb,
  code: string,
  ianaTimezone: string,
  providerCode = `${code}-ops`,
) {
  return provisionHotel(db, {
    hotel: {
      code,
      name: `${code[0]!.toUpperCase()}${code.slice(1)} Hotel`,
      locality: "Test City",
      ianaTimezone,
      currency: "EUR",
    },
    destinations: [{ kind: "airport", name: "HUB", sortOrder: 10, amountMinor: 4500 }],
    provider: { code: providerCode, name: `${providerCode} Fleet` },
    goLive: true,
  });
}

async function deskScope(db: SqlDb, login: string, hotelId: string): Promise<OpsScope> {
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

async function dispatcherScope(db: SqlDb, login: string, providerId: string): Promise<OpsScope> {
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

function bookInput(hotelCode: string, destinationId: string, extra: Record<string, unknown> = {}) {
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

async function sqlCivilToday(db: SqlDb, tz: string): Promise<string> {
  const rows = await db.query<{ d: string }>(
    "select (now() at time zone $1::text)::date::text as d",
    [tz],
  );
  return String(rows[0]!.d).slice(0, 10);
}

async function sqlCivilAt(db: SqlDb, instant: string, tz: string): Promise<string> {
  const rows = await db.query<{ d: string }>(
    "select ($1::timestamptz at time zone $2::text)::date::text as d",
    [instant, tz],
  );
  return String(rows[0]!.d).slice(0, 10);
}

async function sqlAthensToday(db: SqlDb): Promise<string> {
  const rows = await db.query<{ d: string }>("select aether_athens_today()::text as d");
  return String(rows[0]!.d).slice(0, 10);
}

async function sqlUtcDate(db: SqlDb): Promise<string> {
  const rows = await db.query<{ d: string }>("select (now() at time zone 'UTC')::date::text as d");
  return String(rows[0]!.d).slice(0, 10);
}

async function dayBefore(db: SqlDb, date: string): Promise<string> {
  const rows = await db.query<{ d: string }>("select ($1::date - 1)::text as d", [date]);
  return String(rows[0]!.d).slice(0, 10);
}

async function expectOps(
  fn: () => Promise<unknown>,
  code: OpsDeskError["code"],
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof OpsDeskError, `expected OpsDeskError, got ${err}`);
    assert.equal(err.code, code);
    assert.doesNotMatch(err.message, /not recognized|SQLSTATE|at time zone/i);
    return;
  }
  assert.fail(`expected ${code}`);
}

describe("CP17 hotel-local Ops Today", () => {
  test("0011–0017 remain byte-identical; CP17 adds no migration", () => {
    for (const [name, expected] of Object.entries(IMMUTABLE)) {
      assert.equal(sha256(readMigration(name)), expected, name);
    }
    const m17 = readMigration("0017_cp16_runtime_privilege_hardening.sql");
    assert.match(m17, /schema_phase', '16'/);
    assert.doesNotMatch(m17, /schema_phase', '17'/);
    assert.doesNotMatch(m17, /drop trigger bookings_occupies_before/i);
    const desk = readAether("./ops-desk.ts");
    assert.match(desk, /civilToday/);
    assert.match(desk, /athensToday/);
    assert.match(desk, /btrim\(iana_timezone\)/);
    assert.match(desk, /boardDate/);
    assert.doesNotMatch(desk, /athensDate/);
    assert.match(desk, /b\.transfer_date = \$1::date/);
    assert.match(desk, /lower\(b\.occupies\) >= now\(\)/);
    assert.doesNotMatch(desk, /occupies &&|overlap|tstzrange\(now/);
    const time = readAether("./time.ts");
    assert.match(time, /now\(\) at time zone \$1::text/);
    assert.match(time, /aether_athens_today/);
    const server = readAether("./time.server.ts");
    assert.doesNotMatch(server, /civilToday/);
    const migrationNames = readdirSync(new URL("../../../migrations", import.meta.url));
    assert.equal(migrationNames.some((name) => /^0018/.test(name)), false, "NO 0018");
  });

  test("hotel A desk sees A bookings and does not see B bookings", async () => {
    const { db, pg } = await openDb();
    const a = await seedLive(db, "quay", "Europe/Athens");
    const b = await seedLive(db, "lon", "Europe/London");
    const dateA = await sqlCivilToday(db, "Europe/Athens");
    const dateB = await sqlCivilToday(db, "Europe/London");
    await createBooking(
      db,
      bookInput("quay", a.destinations[0]!.id, {
        transferDate: dateA,
        guestEmail: "a-iso@example.com",
        guestName: "Hotel A Guest",
      }),
    );
    await createBooking(
      db,
      bookInput("lon", b.destinations[0]!.id, {
        transferDate: dateB,
        guestEmail: "b-iso@example.com",
        guestName: "Hotel B Guest",
      }),
    );
    const deskA = await deskScope(db, "desk-a", a.hotel.id);
    const board = await asApp(pg, () => loadTodayBoard(db, deskA));
    assert.equal(board.boardDate, dateA);
    assert.ok(board.feed.some((row) => row.hotelCode === "quay"));
    assert.equal(board.feed.some((row) => row.hotelCode === "lon"), false);
    assert.equal(board.feed.every((row) => row.hotelCode === "quay"), true);
    await pg.close();
  });

  test("hotel B desk sees B bookings and does not see A bookings", async () => {
    const { db, pg } = await openDb();
    const a = await seedLive(db, "quay", "Europe/Athens");
    const b = await seedLive(db, "lon", "Europe/London");
    const dateA = await sqlCivilToday(db, "Europe/Athens");
    const dateB = await sqlCivilToday(db, "Europe/London");
    await createBooking(
      db,
      bookInput("quay", a.destinations[0]!.id, {
        transferDate: dateA,
        guestEmail: "a2-iso@example.com",
        guestName: "Hotel A Guest",
      }),
    );
    await createBooking(
      db,
      bookInput("lon", b.destinations[0]!.id, {
        transferDate: dateB,
        guestEmail: "b2-iso@example.com",
        guestName: "Hotel B Guest",
      }),
    );
    const deskB = await deskScope(db, "desk-b", b.hotel.id);
    const board = await asApp(pg, () => loadTodayBoard(db, deskB));
    assert.equal(board.boardDate, dateB);
    assert.ok(board.feed.some((row) => row.hotelCode === "lon"));
    assert.equal(board.feed.some((row) => row.hotelCode === "quay"), false);
    assert.equal(board.feed.every((row) => row.hotelCode === "lon"), true);
    await pg.close();
  });

  test("Athens hotel desk board date matches Europe/Athens civil date", async () => {
    const { db, pg } = await openDb();
    const live = await seedLive(db, "quay", "Europe/Athens");
    const expected = await sqlCivilToday(db, "Europe/Athens");
    const athens = await sqlAthensToday(db);
    const viaHelper = await asApp(pg, () => civilToday(db, "Europe/Athens"));
    const desk = await deskScope(db, "athens-desk", live.hotel.id);
    await createBooking(
      db,
      bookInput("quay", live.destinations[0]!.id, {
        transferDate: expected,
        guestEmail: "ath-today@example.com",
      }),
    );
    const yday = await dayBefore(db, expected);
    await createBooking(
      db,
      bookInput("quay", live.destinations[0]!.id, {
        transferDate: yday,
        pickupTime: "11:00",
        guestEmail: "ath-yday@example.com",
      }),
    );
    const board = await asApp(pg, () => loadTodayBoard(db, desk));
    assert.equal(board.boardDate, expected);
    assert.equal(board.boardDate, athens);
    assert.equal(viaHelper, expected);
    assert.equal(board.feed.some((row) => row.transferDate === expected), true);
    assert.equal(board.feed.some((row) => row.transferDate === yday), false);
    await pg.close();
  });

  test("London hotel desk board date follows Europe/London independently of Athens", async () => {
    const { db, pg } = await openDb();
    const live = await seedLive(db, "lon", "Europe/London");
    const london = await sqlCivilToday(db, "Europe/London");
    const athens = await sqlAthensToday(db);
    const desk = await deskScope(db, "lon-desk", live.hotel.id);
    await createBooking(
      db,
      bookInput("lon", live.destinations[0]!.id, {
        transferDate: london,
        guestEmail: "lon-today@example.com",
      }),
    );
    if (london !== athens) {
      await createBooking(
        db,
        bookInput("lon", live.destinations[0]!.id, {
          transferDate: athens,
          pickupTime: "12:00",
          guestEmail: "lon-athens@example.com",
        }),
      );
    }
    const board = await asApp(pg, () => loadTodayBoard(db, desk));
    assert.equal(board.boardDate, london);
    assert.equal(board.feed.every((row) => row.transferDate === london), true);
    if (london !== athens) {
      assert.notEqual(board.boardDate, athens);
      assert.equal(board.feed.some((row) => row.transferDate === athens), false);
    }
    const frozenLondon = await sqlCivilAt(db, "2026-09-13T22:30:00.000Z", "Europe/London");
    const frozenAthens = await sqlCivilAt(db, "2026-09-13T22:30:00.000Z", "Europe/Athens");
    assert.equal(frozenLondon, "2026-09-13");
    assert.equal(frozenAthens, "2026-09-14");
    await pg.close();
  });

  test("New York hotel desk board date follows America/New_York", async () => {
    const { db, pg } = await openDb();
    const live = await seedLive(db, "york", "America/New_York");
    const ny = await sqlCivilToday(db, "America/New_York");
    const athens = await sqlAthensToday(db);
    const utc = await sqlUtcDate(db);
    const desk = await deskScope(db, "york-desk", live.hotel.id);
    await createBooking(
      db,
      bookInput("york", live.destinations[0]!.id, {
        transferDate: ny,
        guestEmail: "ny-today@example.com",
      }),
    );
    const yday = await dayBefore(db, ny);
    await createBooking(
      db,
      bookInput("york", live.destinations[0]!.id, {
        transferDate: yday,
        pickupTime: "08:00",
        guestEmail: "ny-yday@example.com",
      }),
    );
    const board = await asApp(pg, () => loadTodayBoard(db, desk));
    assert.equal(board.boardDate, ny);
    assert.equal(board.feed.some((row) => row.transferDate === ny), true);
    assert.equal(board.feed.some((row) => row.transferDate === yday), false);
    if (ny !== athens) assert.notEqual(board.boardDate, athens);
    if (ny !== utc) assert.notEqual(board.boardDate, utc);
    await pg.close();
  });

  test("Dubai hotel desk board date follows Asia/Dubai", async () => {
    const { db, pg } = await openDb();
    const live = await seedLive(db, "dxb", "Asia/Dubai");
    const dubai = await sqlCivilToday(db, "Asia/Dubai");
    const athens = await sqlAthensToday(db);
    const desk = await deskScope(db, "dxb-desk", live.hotel.id);
    await createBooking(
      db,
      bookInput("dxb", live.destinations[0]!.id, {
        transferDate: dubai,
        guestEmail: "dxb-today@example.com",
      }),
    );
    const board = await asApp(pg, () => loadTodayBoard(db, desk));
    assert.equal(board.boardDate, dubai);
    assert.equal(board.feed.every((row) => row.transferDate === dubai), true);
    if (dubai !== athens) assert.notEqual(board.boardDate, athens);
    const frozenDubai = await sqlCivilAt(db, "2026-09-13T21:30:00.000Z", "Asia/Dubai");
    const frozenUtc = await sqlCivilAt(db, "2026-09-13T21:30:00.000Z", "UTC");
    assert.equal(frozenDubai, "2026-09-14");
    assert.equal(frozenUtc, "2026-09-13");
    await pg.close();
  });

  test("UTC-midnight divergence uses hotel civil date not UTC", async () => {
    const { db, pg } = await openDb();
    const west = await seedLive(db, "hnl", "Pacific/Honolulu");
    const east = await seedLive(db, "lnt", "Pacific/Kiritimati");
    const utc = await sqlUtcDate(db);
    const hnl = await sqlCivilToday(db, "Pacific/Honolulu");
    const lnt = await sqlCivilToday(db, "Pacific/Kiritimati");
    assert.ok(
      hnl !== utc || lnt !== utc,
      "Honolulu or Kiritimati civil date must differ from UTC",
    );

    async function prove(live: typeof west, code: string, hotelDate: string) {
      const desk = await deskScope(db, `${code}-desk`, live.hotel.id);
      await createBooking(
        db,
        bookInput(code, live.destinations[0]!.id, {
          transferDate: hotelDate,
          guestEmail: `${code}-today@example.com`,
        }),
      );
      if (hotelDate !== utc) {
        await createBooking(
          db,
          bookInput(code, live.destinations[0]!.id, {
            transferDate: utc,
            pickupTime: "10:00",
            guestEmail: `${code}-utc@example.com`,
          }),
        );
      }
      const yday = await dayBefore(db, hotelDate);
      await createBooking(
        db,
        bookInput(code, live.destinations[0]!.id, {
          transferDate: yday,
          pickupTime: "11:00",
          guestEmail: `${code}-yday@example.com`,
        }),
      );
      const board = await asApp(pg, () => loadTodayBoard(db, desk));
      assert.equal(board.boardDate, hotelDate);
      assert.equal(board.feed.some((row) => row.transferDate === hotelDate), true);
      assert.equal(board.feed.some((row) => row.transferDate === yday), false);
      if (hotelDate !== utc) {
        assert.notEqual(board.boardDate, utc);
        assert.equal(board.feed.some((row) => row.transferDate === utc), false);
      }
    }

    await prove(west, "hnl", hnl);
    await prove(east, "lnt", lnt);

    assert.equal(await sqlCivilAt(db, "2026-09-13T03:00:00.000Z", "UTC"), "2026-09-13");
    assert.equal(await sqlCivilAt(db, "2026-09-13T03:00:00.000Z", "America/New_York"), "2026-09-12");
    assert.equal(await sqlCivilAt(db, "2026-09-13T03:00:00.000Z", "Pacific/Honolulu"), "2026-09-12");
    assert.equal(await sqlCivilAt(db, "2026-09-13T03:00:00.000Z", "Asia/Dubai"), "2026-09-13");
    assert.equal(await sqlCivilAt(db, "2026-09-13T14:00:00.000Z", "Pacific/Kiritimati"), "2026-09-14");
    await pg.close();
  });

  test("DST civil date calculation remains correct for New York and London", async () => {
    const { db, pg } = await openDb();
    assert.equal(await sqlCivilAt(db, "2026-03-08T04:30:00.000Z", "America/New_York"), "2026-03-07");
    assert.equal(await sqlCivilAt(db, "2026-03-08T05:30:00.000Z", "America/New_York"), "2026-03-08");
    assert.equal(await sqlCivilAt(db, "2026-03-08T07:30:00.000Z", "America/New_York"), "2026-03-08");
    assert.equal(await sqlCivilAt(db, "2026-11-01T03:30:00.000Z", "America/New_York"), "2026-10-31");
    assert.equal(await sqlCivilAt(db, "2026-11-01T04:30:00.000Z", "America/New_York"), "2026-11-01");
    assert.equal(await sqlCivilAt(db, "2026-03-28T23:30:00.000Z", "Europe/London"), "2026-03-28");
    assert.equal(await sqlCivilAt(db, "2026-03-29T00:30:00.000Z", "Europe/London"), "2026-03-29");
    assert.equal(await sqlCivilAt(db, "2026-03-29T01:30:00.000Z", "Europe/London"), "2026-03-29");
    assert.equal(await sqlCivilAt(db, "2026-10-24T23:30:00.000Z", "Europe/London"), "2026-10-25");
    assert.equal(await sqlCivilAt(db, "2026-10-25T01:30:00.000Z", "Europe/London"), "2026-10-25");
    const live = await seedLive(db, "york", "America/New_York");
    const ny = await sqlCivilToday(db, "America/New_York");
    const desk = await deskScope(db, "dst-desk", live.hotel.id);
    const board = await asApp(pg, () => loadTodayBoard(db, desk));
    assert.equal(board.boardDate, ny);
    const helper = await asApp(pg, () => civilToday(db, "America/New_York"));
    assert.equal(helper, ny);
    await pg.close();
  });

  test("invalid and empty hotel timezone fail closed without Athens fallback", async () => {
    const { db, pg } = await openDb();
    const athens = await sqlAthensToday(db);
    await assert.rejects(
      () => civilToday(db, ""),
      (err: unknown) => err instanceof CivilTimeError && err.code === "invalid_time",
    );
    await assert.rejects(
      () => civilToday(db, "   "),
      (err: unknown) => err instanceof CivilTimeError && err.code === "invalid_time",
    );
    await assert.rejects(
      () => civilToday(db, "Not/A_Zone"),
      (err: unknown) => err instanceof CivilTimeError && err.code === "invalid_time",
    );

    const bogus = await seedLive(db, "bogus", "not/a-real-zone");
    const deskBogus = await deskScope(db, "bogus-desk", bogus.hotel.id);
    await expectOps(() => asApp(pg, () => loadTodayBoard(db, deskBogus)), "invalid");

    const blank = await seedLive(db, "blank", "Europe/Athens");
    await pg.exec("alter table hotels drop constraint hotels_timezone_present");
    await db.query("update hotels set iana_timezone = $1 where id = $2::uuid", ["   ", blank.hotel.id]);
    const deskBlank = await deskScope(db, "blank-desk", blank.hotel.id);
    await expectOps(() => asApp(pg, () => loadTodayBoard(db, deskBlank)), "invalid");

    const missing: OpsScope = {
      operatorId: "00000000-0000-4000-8000-000000000001",
      login: "ghost",
      sessionId: "test-session",
      membershipId: "00000000-0000-4000-8000-000000000002",
      accessClass: "hotel_desk",
      hotelId: "00000000-0000-4000-8000-000000000099",
      providerId: null,
    };
    await expectOps(() => asApp(pg, () => loadTodayBoard(db, missing)), "not_found");

    const quay = await seedLive(db, "quay", "Europe/Athens");
    const deskOk = await deskScope(db, "ok-desk", quay.hotel.id);
    const ok = await asApp(pg, () => loadTodayBoard(db, deskOk));
    assert.equal(ok.boardDate, athens);
    const deskSrc = readAether("./ops-desk.ts");
    assert.doesNotMatch(deskSrc, /Europe\/Athens/);
    assert.match(deskSrc, /Hotel timezone is invalid/);
    await pg.close();
  });

  test("next remains lower(occupies) >= now() with existing ordering", async () => {
    const { db, pg } = await openDb();
    const live = await seedLive(db, "quay", "Europe/Athens");
    const today = await sqlCivilToday(db, "Europe/Athens");
    const desk = await deskScope(db, "next-desk", live.hotel.id);
    await createBooking(
      db,
      bookInput("quay", live.destinations[0]!.id, {
        transferDate: today,
        pickupTime: "23:50",
        guestEmail: "next-late@example.com",
        guestName: "Late Guest",
      }),
    );
    await createBooking(
      db,
      bookInput("quay", live.destinations[0]!.id, {
        transferDate: today,
        pickupTime: "00:05",
        guestEmail: "next-early@example.com",
        guestName: "Early Guest",
      }),
    );
    await createBooking(
      db,
      bookInput("quay", live.destinations[0]!.id, {
        transferDate: today,
        pickupTime: "23:40",
        guestEmail: "next-cancel@example.com",
        guestName: "Cancel Guest",
      }),
    );
    const cancelRow = await db.query<{ id: string }>(
      "select id from bookings where guest_email = $1",
      ["next-cancel@example.com"],
    );
    await cancelBooking(db, { bookingId: cancelRow[0]!.id, scope: desk });

    const oracle = await asApp(pg, () =>
      db.query<{ id: string }>(
        `select b.id
           from bookings b
          where b.hotel_id = $1::uuid
            and b.transfer_date = $2::date
            and b.cancelled_at is null
            and lower(b.occupies) >= now()
          order by b.pickup_time, b.created_at
          limit 1`,
        [live.hotel.id, today],
      ),
    );
    const board = await asApp(pg, () => loadTodayBoard(db, desk));
    assert.equal(board.next?.id ?? null, oracle[0]?.id ?? null);
    if (board.next) {
      assert.equal(board.next.cancelled, false);
    }
    assert.equal(board.feed.length, 3);
    assert.equal(board.feed[0]!.pickupTime, "00:05");
    assert.equal(board.feed[1]!.pickupTime, "23:40");
    assert.equal(board.feed[2]!.pickupTime, "23:50");
    const src = readAether("./ops-desk.ts");
    assert.match(src, /lower\(b\.occupies\) >= now\(\)/);
    assert.match(src, /order by b\.pickup_time, b\.created_at/);
    assert.doesNotMatch(src, /transfer_date >=/);
    await pg.close();
  });

  test("provider dispatcher Today remains Athens-global and provider-scoped", async () => {
    const { db, pg } = await openDb();
    const a = await seedLive(db, "quay", "Europe/Athens", "fleet");
    const b = await seedLive(db, "lon", "Europe/London", "fleet");
    const other = await seedLive(db, "dxb", "Asia/Dubai", "other-ops");
    const athens = await sqlAthensToday(db);
    await createBooking(
      db,
      bookInput("quay", a.destinations[0]!.id, {
        transferDate: athens,
        guestEmail: "disp-a@example.com",
      }),
    );
    await createBooking(
      db,
      bookInput("lon", b.destinations[0]!.id, {
        transferDate: athens,
        guestEmail: "disp-b@example.com",
        guestName: "London Guest",
      }),
    );
    await createBooking(
      db,
      bookInput("dxb", other.destinations[0]!.id, {
        transferDate: athens,
        guestEmail: "disp-other@example.com",
        guestName: "Other Guest",
      }),
    );
    const yday = await dayBefore(db, athens);
    await createBooking(
      db,
      bookInput("quay", a.destinations[0]!.id, {
        transferDate: yday,
        pickupTime: "12:00",
        guestEmail: "disp-yday@example.com",
      }),
    );
    const dispatcher = await dispatcherScope(db, "fleet-disp", a.provider.id);
    const board = await asApp(pg, () => loadTodayBoard(db, dispatcher));
    assert.equal(board.boardDate, athens);
    assert.ok(board.feed.some((row) => row.hotelCode === "quay"));
    assert.ok(board.feed.some((row) => row.hotelCode === "lon"));
    assert.equal(board.feed.some((row) => row.hotelCode === "dxb"), false);
    assert.equal(board.feed.some((row) => row.transferDate === yday), false);
    const src = readAether("./ops-desk.ts");
    assert.match(src, /athensToday/);
    assert.match(src, /isProviderDispatcher/);
    const time = readAether("./time.ts");
    assert.match(time, /select aether_athens_today\(\)::text as d/);
    const cp15 = readAether("./cp15.test.ts");
    assert.match(cp15, /assert\.match\(today, \/athensToday\/\)/);
    await pg.close();
  });

  test("Today path has no client timezone authority", () => {
    const fns = readAether("./ops-desk-fns.ts");
    const todayFn = fns.slice(fns.indexOf("opsTodayBoard"), fns.indexOf("opsListBookings"));
    assert.match(todayFn, /createServerFn\(\{ method: "GET" \}\)/);
    assert.doesNotMatch(todayFn, /validator/);
    assert.doesNotMatch(todayFn, /timezone|timeZone|tz\b|iana/i);
    const server = readAether("./ops-desk.server.ts");
    assert.match(server, /todayBoardFromRequest\(\)/);
    assert.doesNotMatch(server, /timezone|timeZone|iana_timezone|localStorage|sessionStorage/);
    const desk = readAether("./ops-desk.ts");
    assert.match(desk, /export async function loadTodayBoard\(db: OpsDeskDb, scope: OpsScope\)/);
    assert.doesNotMatch(desk, /localStorage|sessionStorage|Intl\.DateTimeFormat|date-fns-tz|luxon|Temporal/);
    const ui = readAether("../../routes/ops.index.tsx");
    assert.match(ui, />Today</);
    assert.match(ui, /board\.boardDate/);
    assert.doesNotMatch(ui, /Athens today/);
    assert.doesNotMatch(ui, /localStorage|sessionStorage|timeZone|timezone|Intl\.DateTimeFormat/);
    const routes = readAether("../../routes/ops.tsx");
    assert.doesNotMatch(routes, /timezone|timeZone/);
  });

  test("CP14.4 occupancy objects remain untouched", () => {
    for (const name of [
      "0003_occupancy.sql",
      "0005_time_domain.sql",
      "0016_cp14_hotel_timezone.sql",
    ] as const) {
      assert.equal(sha256(readMigration(name)), IMMUTABLE[name], name);
    }
    const occ = readAether("./occupancy.test.ts");
    assert.doesNotMatch(occ, /0016_cp14_hotel_timezone/);
    assert.match(occ, /0003_occupancy\.sql/);
    const m16 = readMigration("0016_cp14_hotel_timezone.sql");
    assert.match(m16, /aether_civil_instant/);
    assert.match(m16, /aether_bookings_occupies_tg/);
    assert.doesNotMatch(m16, /drop trigger bookings_occupies_before/i);
    const desk = readAether("./ops-desk.ts");
    assert.doesNotMatch(desk, /insert into bookings[\s\S]*occupies/i);
    const time = readAether("./time.ts");
    assert.match(time, /aether_civil_instant/);
    assert.match(time, /aether_athens_instant/);
    assert.match(time, /select \(now\(\) at time zone \$1::text\)::date::text as d/);
    assert.doesNotMatch(time, /getTimezoneOffset/);
  });
});
