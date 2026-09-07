import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const FOUNDATION_SQL = readFileSync(
  new URL("../../../migrations/0002_foundation.sql", import.meta.url),
  "utf8",
);
const OCCUPANCY_SQL = readFileSync(
  new URL("../../../migrations/0003_occupancy.sql", import.meta.url),
  "utf8",
);

type Pg = PGlite;

async function openDb(): Promise<Pg> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  await pg.exec(FOUNDATION_SQL);
  await pg.exec(OCCUPANCY_SQL);
  return pg;
}

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function expectReject(
  fn: () => Promise<unknown>,
  code: string,
  messagePattern?: RegExp,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.equal(errCode(err), code, `expected ${code}, got ${errCode(err)}: ${errMessage(err)}`);
    if (messagePattern) {
      assert.match(errMessage(err), messagePattern);
    }
    return;
  }
  assert.fail(`expected rejection with ${code}`);
}

async function seed(pg: Pg) {
  const hotel = await pg.query<{ id: string }>(
    "insert into hotels (code, name) values ('gate', 'Gate Hotel') returning id",
  );
  const v1 = await pg.query<{ id: string }>(
    "insert into vehicles (name) values ('Van 1') returning id",
  );
  const v2 = await pg.query<{ id: string }>(
    "insert into vehicles (name) values ('Van 2') returning id",
  );
  const d1 = await pg.query<{ id: string }>(
    "insert into drivers (name) values ('Driver 1') returning id",
  );
  const d2 = await pg.query<{ id: string }>(
    "insert into drivers (name) values ('Driver 2') returning id",
  );
  return {
    hotelId: hotel.rows[0]!.id,
    vehicle1: v1.rows[0]!.id,
    vehicle2: v2.rows[0]!.id,
    driver1: d1.rows[0]!.id,
    driver2: d2.rows[0]!.id,
  };
}

let refSeq = 0;
async function insertBooking(
  pg: Pg,
  args: {
    hotelId: string;
    date: string;
    time: string;
    duration: number;
    vehicleId?: string | null;
    driverId?: string | null;
    occupies?: string;
    cancelled?: boolean;
  },
) {
  refSeq += 1;
  const ref = `REF-${refSeq}`;
  const token = `tok-${refSeq}-${Math.random().toString(16).slice(2)}`;
  const occupiesSql = args.occupies
    ? `, occupies`
    : "";
  const occupiesVal = args.occupies ? `, $9::tstzrange` : "";
  const params: unknown[] = [
    args.hotelId,
    args.date,
    args.time,
    args.duration,
    args.vehicleId ?? null,
    args.driverId ?? null,
    ref,
    token,
  ];
  if (args.occupies) params.push(args.occupies);
  const cancelledSql = args.cancelled ? ", cancelled_at" : "";
  const cancelledVal = args.cancelled ? ", now()" : "";
  const { rows } = await pg.query<{
    id: string;
    occupies: string;
    vehicle_id: string | null;
    driver_id: string | null;
    cancelled_at: string | null;
  }>(
    `insert into bookings (
       hotel_id, transfer_date, pickup_time, duration_minutes,
       vehicle_id, driver_id,
       guest_name, guest_phone, guest_email,
       pickup_text, destination_text,
       human_reference, confirmation_token
       ${occupiesSql} ${cancelledSql}
     ) values (
       $1, $2::date, $3::time, $4,
       $5, $6,
       'Guest', '+30000000000', 'guest@example.com',
       'Hotel lobby', 'Airport',
       $7, $8
       ${occupiesVal} ${cancelledVal}
     )
     returning id, occupies::text as occupies, vehicle_id, driver_id, cancelled_at`,
    params,
  );
  return rows[0]!;
}

describe("Phase 1 occupancy engine", () => {
  test("canonical schema and occupancy objects exist", async () => {
    const pg = await openDb();
    const tables = await pg.query<{ n: number }>(`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'hotels','vehicles','drivers','operators','sessions',
          'bookings','audit_events','idempotency_keys'
        )
    `);
    assert.equal(tables.rows[0]?.n, 8);

    const fn = await pg.query<{ n: number }>(`
      select count(*)::int as n from pg_proc
      where proname = 'aether_athens_instant'
    `);
    assert.equal(fn.rows[0]?.n, 1);

    const tg = await pg.query<{ n: number }>(`
      select count(*)::int as n from pg_trigger
      where tgname = 'bookings_occupies_before' and not tgisinternal
    `);
    assert.equal(tg.rows[0]?.n, 1);

    const excl = await pg.query<{ n: number }>(`
      select count(*)::int as n from pg_constraint
      where conname in (
        'bookings_vehicle_occupancy_excl',
        'bookings_driver_occupancy_excl'
      )
    `);
    assert.equal(excl.rows[0]?.n, 2);

    const meta = await pg.query<{ value: string }>(
      "select value from aether_meta where key = 'schema_phase'",
    );
    assert.equal(meta.rows[0]?.value, "1");
    await pg.close();
  });

  test("valid Athens winter time persists as absolute instant", async () => {
    const pg = await openDb();
    const { rows } = await pg.query<{ t: string }>(
      "select aether_athens_instant(date '2026-01-15', time '09:00') as t",
    );
    assert.equal(new Date(rows[0]!.t).toISOString(), "2026-01-15T07:00:00.000Z");
    await pg.close();
  });

  test("valid Athens summer time persists as absolute instant", async () => {
    const pg = await openDb();
    const { rows } = await pg.query<{ t: string }>(
      "select aether_athens_instant(date '2026-07-15', time '09:00') as t",
    );
    assert.equal(new Date(rows[0]!.t).toISOString(), "2026-07-15T06:00:00.000Z");
    await pg.close();
  });

  test("session TimeZone does not change Athens instant", async () => {
    const pg = await openDb();
    await pg.exec("set timezone to 'America/New_York'");
    const ny = await pg.query<{ t: string }>(
      "select aether_athens_instant(date '2026-01-15', time '09:00') as t",
    );
    await pg.exec("set timezone to 'UTC'");
    const utc = await pg.query<{ t: string }>(
      "select aether_athens_instant(date '2026-01-15', time '09:00') as t",
    );
    assert.equal(new Date(ny.rows[0]!.t).toISOString(), "2026-01-15T07:00:00.000Z");
    assert.equal(new Date(utc.rows[0]!.t).toISOString(), "2026-01-15T07:00:00.000Z");
    await pg.close();
  });

  test("spring DST gap rejects: time does not exist", async () => {
    const pg = await openDb();
    await expectReject(
      () =>
        pg.query(
          "select aether_athens_instant(date '2026-03-29', time '03:30') as t",
        ),
      "22008",
      /time does not exist/i,
    );
    const ids = await seed(pg);
    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-03-29",
          time: "03:00",
          duration: 60,
        }),
      "22008",
      /time does not exist/i,
    );
    await pg.close();
  });

  test("autumn DST fold rejects: time is ambiguous", async () => {
    const pg = await openDb();
    await expectReject(
      () =>
        pg.query(
          "select aether_athens_instant(date '2026-10-25', time '03:30') as t",
        ),
      "22008",
      /time is ambiguous/i,
    );
    const ids = await seed(pg);
    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-10-25",
          time: "03:00",
          duration: 60,
        }),
      "22008",
      /time is ambiguous/i,
    );
    await pg.close();
  });

  test("24:00 rejects", async () => {
    const pg = await openDb();
    await expectReject(
      () =>
        pg.query(
          "select aether_athens_instant(date '2026-01-15', time '24:00') as t",
        ),
      "22008",
      /24:00/,
    );
    const ids = await seed(pg);
    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-15",
          time: "24:00",
          duration: 60,
        }),
      "22008",
      /24:00/,
    );
    await pg.close();
  });

  test("duration 0 rejects", async () => {
    const pg = await openDb();
    const ids = await seed(pg);
    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-15",
          time: "09:00",
          duration: 0,
        }),
      "23514",
    );
    await pg.close();
  });

  test("duration >1440 rejects", async () => {
    const pg = await openDb();
    const ids = await seed(pg);
    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-15",
          time: "09:00",
          duration: 1441,
        }),
      "23514",
    );
    await pg.close();
  });

  test("trigger maintains occupies; application-supplied value is discarded", async () => {
    const pg = await openDb();
    const ids = await seed(pg);
    const row = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-15",
      time: "09:00",
      duration: 90,
      occupies: '["1999-06-01 00:00:00+00","1999-06-01 03:00:00+00")',
    });
    assert.equal(row.occupies.includes("1999"), false);
    assert.match(row.occupies, /^\[/);
    const bounds = await pg.query<{ lo: string; hi: string; empty: boolean }>(
      `select lower(occupies) as lo, upper(occupies) as hi, isempty(occupies) as empty
       from bookings where id = $1`,
      [row.id],
    );
    assert.equal(new Date(bounds.rows[0]!.lo).toISOString(), "2026-01-15T07:00:00.000Z");
    assert.equal(new Date(bounds.rows[0]!.hi).toISOString(), "2026-01-15T08:30:00.000Z");
    assert.equal(bounds.rows[0]!.empty, false);

    await pg.query(
      `update bookings
       set occupies = tstzrange('1999-01-01 00:00:00+00', '1999-01-01 01:00:00+00', '[)')
       where id = $1`,
      [row.id],
    );
    const after = await pg.query<{ lo: string }>(
      "select lower(occupies) as lo from bookings where id = $1",
      [row.id],
    );
    assert.equal(new Date(after.rows[0]!.lo).toISOString(), "2026-01-15T07:00:00.000Z");
    await pg.close();
  });

  test("[) adjacency succeeds; one-minute overlap fails with 23P01", async () => {
    const pg = await openDb();
    const ids = await seed(pg);
    await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-15",
      time: "09:00",
      duration: 60,
      vehicleId: ids.vehicle1,
    });
    const adjacent = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-15",
      time: "10:00",
      duration: 60,
      vehicleId: ids.vehicle1,
    });
    assert.ok(adjacent.id);

    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-15",
          time: "09:59",
          duration: 60,
          vehicleId: ids.vehicle1,
        }),
      "23P01",
    );
    await pg.close();
  });

  test("vehicle EXCLUDE works independently of driver", async () => {
    const pg = await openDb();
    const ids = await seed(pg);
    await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-15",
      time: "09:00",
      duration: 60,
      vehicleId: ids.vehicle1,
      driverId: ids.driver1,
    });
    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-15",
          time: "09:00",
          duration: 60,
          vehicleId: ids.vehicle1,
          driverId: ids.driver2,
        }),
      "23P01",
    );
    const otherVehicle = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-15",
      time: "09:00",
      duration: 60,
      vehicleId: ids.vehicle2,
      driverId: ids.driver2,
    });
    assert.ok(otherVehicle.id);
    await pg.close();
  });

  test("driver EXCLUDE works independently of vehicle", async () => {
    const pg = await openDb();
    const ids = await seed(pg);
    await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-15",
      time: "11:00",
      duration: 60,
      vehicleId: ids.vehicle1,
      driverId: ids.driver1,
    });
    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-15",
          time: "11:00",
          duration: 60,
          vehicleId: ids.vehicle2,
          driverId: ids.driver1,
        }),
      "23P01",
    );
    await pg.close();
  });

  test("vehicle-only and driver-only bookings occupy independently", async () => {
    const pg = await openDb();
    const ids = await seed(pg);
    const vehicleOnly = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-15",
      time: "12:00",
      duration: 60,
      vehicleId: ids.vehicle1,
    });
    const driverOnly = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-15",
      time: "12:00",
      duration: 60,
      driverId: ids.driver1,
    });
    assert.equal(vehicleOnly.vehicle_id, ids.vehicle1);
    assert.equal(vehicleOnly.driver_id, null);
    assert.equal(driverOnly.vehicle_id, null);
    assert.equal(driverOnly.driver_id, ids.driver1);

    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-15",
          time: "12:00",
          duration: 60,
          vehicleId: ids.vehicle1,
        }),
      "23P01",
    );
    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-15",
          time: "12:00",
          duration: 60,
          driverId: ids.driver1,
        }),
      "23P01",
    );
    await pg.close();
  });

  test("cancellation releases occupancy", async () => {
    const pg = await openDb();
    const ids = await seed(pg);
    const first = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-16",
      time: "09:00",
      duration: 60,
      vehicleId: ids.vehicle1,
      driverId: ids.driver1,
    });
    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-16",
          time: "09:00",
          duration: 60,
          vehicleId: ids.vehicle1,
        }),
      "23P01",
    );

    await pg.query("update bookings set cancelled_at = now() where id = $1", [
      first.id,
    ]);
    const emptied = await pg.query<{ empty: boolean }>(
      "select isempty(occupies) as empty from bookings where id = $1",
      [first.id],
    );
    assert.equal(emptied.rows[0]!.empty, true);

    const reuse = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-16",
      time: "09:00",
      duration: 60,
      vehicleId: ids.vehicle1,
      driverId: ids.driver1,
    });
    assert.ok(reuse.id);
    await pg.close();
  });

  test("unassignment releases the unassigned resource", async () => {
    const pg = await openDb();
    const ids = await seed(pg);
    const first = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-17",
      time: "09:00",
      duration: 60,
      vehicleId: ids.vehicle1,
      driverId: ids.driver1,
    });
    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-17",
          time: "09:00",
          duration: 60,
          vehicleId: ids.vehicle1,
        }),
      "23P01",
    );

    await pg.query("update bookings set vehicle_id = null where id = $1", [
      first.id,
    ]);
    const stillOccupies = await pg.query<{ empty: boolean }>(
      "select isempty(occupies) as empty from bookings where id = $1",
      [first.id],
    );
    assert.equal(stillOccupies.rows[0]!.empty, false);

    const reusedVehicle = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-17",
      time: "09:00",
      duration: 60,
      vehicleId: ids.vehicle1,
    });
    assert.ok(reusedVehicle.id);

    await expectReject(
      () =>
        insertBooking(pg, {
          hotelId: ids.hotelId,
          date: "2026-01-17",
          time: "09:00",
          duration: 60,
          driverId: ids.driver1,
        }),
      "23P01",
    );

    await pg.query("update bookings set driver_id = null where id = $1", [
      first.id,
    ]);
    const reusedDriver = await insertBooking(pg, {
      hotelId: ids.hotelId,
      date: "2026-01-17",
      time: "09:00",
      duration: 60,
      driverId: ids.driver1,
    });
    assert.ok(reusedDriver.id);
    await pg.close();
  });

  test("idempotency_keys unique (scope, key)", async () => {
    const pg = await openDb();
    await pg.exec(`
      insert into idempotency_keys (scope, key, request_hash)
      values ('booking.create', 'abc', 'hash-1')
    `);
    await expectReject(
      () =>
        pg.exec(`
          insert into idempotency_keys (scope, key, request_hash)
          values ('booking.create', 'abc', 'hash-2')
        `),
      "23505",
    );
    await pg.exec(`
      insert into idempotency_keys (scope, key, request_hash)
      values ('booking.create', 'other', 'hash-3')
    `);
    await pg.close();
  });
});
