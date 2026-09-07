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
  unassignDriver,
  unassignVehicle,
} from "./inventory.ts";
import { createOperator } from "./ops-auth.ts";

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
  await pg.exec("insert into hotels (code, name) values ('gate', 'Gate Hotel')");
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
  const db: BookingDb = {
    query: async <T>(text: string, params?: unknown[]) => {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
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
  const operator = await createOperator(db, "desk", "correct-horse", {
    N: 16,
    r: 8,
    p: 1,
  });
  return {
    db,
    pg,
    vehicle1: v1.rows[0]!.id,
    vehicle2: v2.rows[0]!.id,
    driver1: d1.rows[0]!.id,
    driver2: d2.rows[0]!.id,
    operatorId: operator.id,
  };
}

async function book(
  db: BookingDb,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await createBooking(db, {
    hotelCode: "gate",
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
  });
  const rows = await db.query<{ id: string }>(
    "select id from bookings where confirmation_token = $1",
    [created.confirmationToken],
  );
  return rows[0]!.id;
}

async function expectCode(fn: () => Promise<unknown>, code: InventoryError["code"]) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof InventoryError, `expected InventoryError, got ${err}`);
    assert.equal(err.code, code);
    assert.doesNotMatch(err.message, /23P01|EXCLUDE|SQLSTATE|occupies/i);
    return err;
  }
  assert.fail(`expected ${code}`);
}

describe("Phase 5 inventory assignment", () => {
  test("vehicle and driver assign/unassign independently", async () => {
    const ctx = await openDb();
    const id = await book(ctx.db);
    const withVehicle = await assignVehicle(ctx.db, {
      bookingId: id,
      vehicleId: ctx.vehicle1,
      operatorId: ctx.operatorId,
    });
    assert.equal(withVehicle.vehicleId, ctx.vehicle1);
    assert.equal(withVehicle.driverId, null);

    const withBoth = await assignDriver(ctx.db, {
      bookingId: id,
      driverId: ctx.driver1,
      operatorId: ctx.operatorId,
    });
    assert.equal(withBoth.vehicleId, ctx.vehicle1);
    assert.equal(withBoth.driverId, ctx.driver1);

    const noVehicle = await unassignVehicle(ctx.db, {
      bookingId: id,
      operatorId: ctx.operatorId,
    });
    assert.equal(noVehicle.vehicleId, null);
    assert.equal(noVehicle.driverId, ctx.driver1);

    const none = await unassignDriver(ctx.db, {
      bookingId: id,
      operatorId: ctx.operatorId,
    });
    assert.equal(none.vehicleId, null);
    assert.equal(none.driverId, null);
    await ctx.pg.close();
  });

  test("inactive or missing resources are rejected", async () => {
    const ctx = await openDb();
    const id = await book(ctx.db);
    await ctx.pg.exec(`update vehicles set active = false where id = '${ctx.vehicle1}'`);
    await expectCode(
      () =>
        assignVehicle(ctx.db, {
          bookingId: id,
          vehicleId: ctx.vehicle1,
          operatorId: ctx.operatorId,
        }),
      "unusable",
    );
    await expectCode(
      () =>
        assignVehicle(ctx.db, {
          bookingId: id,
          vehicleId: "00000000-0000-4000-8000-000000000099",
          operatorId: ctx.operatorId,
        }),
      "not_found",
    );
    await ctx.pg.close();
  });

  test("vehicle overlap is unavailable; [) adjacency is allowed", async () => {
    const ctx = await openDb();
    const a = await book(ctx.db, { pickupTime: "09:00" });
    const adjacent = await book(ctx.db, { pickupTime: "10:00" });
    const overlap = await book(ctx.db, { pickupTime: "09:59" });
    await assignVehicle(ctx.db, {
      bookingId: a,
      vehicleId: ctx.vehicle1,
      operatorId: ctx.operatorId,
    });
    const ok = await assignVehicle(ctx.db, {
      bookingId: adjacent,
      vehicleId: ctx.vehicle1,
      operatorId: ctx.operatorId,
    });
    assert.equal(ok.vehicleId, ctx.vehicle1);
    const err = await expectCode(
      () =>
        assignVehicle(ctx.db, {
          bookingId: overlap,
          vehicleId: ctx.vehicle1,
          operatorId: ctx.operatorId,
        }),
      "unavailable",
    );
    assert.match(err.message, /vehicle is not available/i);
    const stillNull = await ctx.db.query<{ vehicle_id: string | null }>(
      "select vehicle_id from bookings where id = $1",
      [overlap],
    );
    assert.equal(stillNull[0]!.vehicle_id, null);
    await ctx.pg.close();
  });

  test("driver overlap is independent of vehicle", async () => {
    const ctx = await openDb();
    const a = await book(ctx.db, { pickupTime: "11:00" });
    const b = await book(ctx.db, { pickupTime: "11:00" });
    await assignDriver(ctx.db, {
      bookingId: a,
      driverId: ctx.driver1,
      operatorId: ctx.operatorId,
    });
    await assignVehicle(ctx.db, {
      bookingId: b,
      vehicleId: ctx.vehicle2,
      operatorId: ctx.operatorId,
    });
    const err = await expectCode(
      () =>
        assignDriver(ctx.db, {
          bookingId: b,
          driverId: ctx.driver1,
          operatorId: ctx.operatorId,
        }),
      "unavailable",
    );
    assert.match(err.message, /driver is not available/i);
    const row = await ctx.db.query<{ driver_id: string | null; vehicle_id: string | null }>(
      "select driver_id, vehicle_id from bookings where id = $1",
      [b],
    );
    assert.equal(row[0]!.driver_id, null);
    assert.equal(row[0]!.vehicle_id, ctx.vehicle2);
    await ctx.pg.close();
  });

  test("cancellation releases occupancy so the resource can be reused", async () => {
    const ctx = await openDb();
    const a = await book(ctx.db);
    const b = await book(ctx.db);
    await assignVehicle(ctx.db, {
      bookingId: a,
      vehicleId: ctx.vehicle1,
      operatorId: ctx.operatorId,
    });
    await assignDriver(ctx.db, {
      bookingId: a,
      driverId: ctx.driver1,
      operatorId: ctx.operatorId,
    });
    await expectCode(
      () =>
        assignVehicle(ctx.db, {
          bookingId: b,
          vehicleId: ctx.vehicle1,
          operatorId: ctx.operatorId,
        }),
      "unavailable",
    );
    const cancelled = await cancelBooking(ctx.db, {
      bookingId: a,
      operatorId: ctx.operatorId,
    });
    assert.equal(cancelled.cancelled, true);
    const empty = await ctx.db.query<{ empty: boolean }>(
      "select isempty(occupies) as empty from bookings where id = $1",
      [a],
    );
    assert.equal(empty[0]!.empty, true);
    const reused = await assignVehicle(ctx.db, {
      bookingId: b,
      vehicleId: ctx.vehicle1,
      operatorId: ctx.operatorId,
    });
    assert.equal(reused.vehicleId, ctx.vehicle1);
    await expectCode(
      () =>
        assignVehicle(ctx.db, {
          bookingId: a,
          vehicleId: ctx.vehicle2,
          operatorId: ctx.operatorId,
        }),
      "cancelled",
    );
    await ctx.pg.close();
  });

  test("unassignment releases only the unassigned resource", async () => {
    const ctx = await openDb();
    const a = await book(ctx.db);
    const b = await book(ctx.db);
    await assignVehicle(ctx.db, {
      bookingId: a,
      vehicleId: ctx.vehicle1,
      operatorId: ctx.operatorId,
    });
    await assignDriver(ctx.db, {
      bookingId: a,
      driverId: ctx.driver1,
      operatorId: ctx.operatorId,
    });
    await unassignVehicle(ctx.db, { bookingId: a, operatorId: ctx.operatorId });
    const reused = await assignVehicle(ctx.db, {
      bookingId: b,
      vehicleId: ctx.vehicle1,
      operatorId: ctx.operatorId,
    });
    assert.equal(reused.vehicleId, ctx.vehicle1);
    await expectCode(
      () =>
        assignDriver(ctx.db, {
          bookingId: b,
          driverId: ctx.driver1,
          operatorId: ctx.operatorId,
        }),
      "unavailable",
    );
    await ctx.pg.close();
  });

  test("status change is an operational label with an audit row", async () => {
    const ctx = await openDb();
    const id = await book(ctx.db);
    const updated = await setBookingStatus(ctx.db, {
      bookingId: id,
      status: "confirmed",
      operatorId: ctx.operatorId,
    });
    assert.equal(updated.status, "confirmed");
    const audit = await ctx.db.query<{ action: string; actor_type: string }>(
      "select action, actor_type from audit_events where booking_id = $1 order by at",
      [id],
    );
    assert.ok(audit.some((r) => r.action === "booking.create"));
    assert.ok(audit.some((r) => r.action === "booking.status" && r.actor_type === "operator"));
    await ctx.pg.close();
  });

  test("assignment mutations write operator audit events", async () => {
    const ctx = await openDb();
    const id = await book(ctx.db);
    await assignVehicle(ctx.db, {
      bookingId: id,
      vehicleId: ctx.vehicle1,
      operatorId: ctx.operatorId,
    });
    await unassignVehicle(ctx.db, { bookingId: id, operatorId: ctx.operatorId });
    await assignDriver(ctx.db, {
      bookingId: id,
      driverId: ctx.driver1,
      operatorId: ctx.operatorId,
    });
    await unassignDriver(ctx.db, { bookingId: id, operatorId: ctx.operatorId });
    const actions = await ctx.db.query<{ action: string }>(
      "select action from audit_events where booking_id = $1 and actor_type = 'operator'",
      [id],
    );
    const names = actions.map((r) => r.action).sort();
    assert.deepEqual(names, [
      "driver.assign",
      "driver.unassign",
      "vehicle.assign",
      "vehicle.unassign",
    ]);
    await ctx.pg.close();
  });

  test("PGLite (not Neon): overlapping assign rolls back; EXCLUDE remains authority", async () => {
    const ctx = await openDb();
    const a = await book(ctx.db, { pickupTime: "14:00" });
    const b = await book(ctx.db, { pickupTime: "14:00" });
    await assignVehicle(ctx.db, {
      bookingId: a,
      vehicleId: ctx.vehicle1,
      operatorId: ctx.operatorId,
    });
    await expectCode(
      () =>
        assignVehicle(ctx.db, {
          bookingId: b,
          vehicleId: ctx.vehicle1,
          operatorId: ctx.operatorId,
        }),
      "unavailable",
    );
    const occupies = await ctx.db.query<{ n: number }>(`
      select count(*)::int as n from pg_constraint
      where conname in ('bookings_vehicle_occupancy_excl','bookings_driver_occupancy_excl')
    `);
    assert.equal(occupies[0]!.n, 2);
    await ctx.pg.close();
  });

  test("ops inventory functions require requireOps; guest booking does not assign", async () => {
    const fns = readFileSync(new URL("./inventory-fns.ts", import.meta.url), "utf8");
    assert.match(fns, /requireOps/);
    assert.match(fns, /opsAssignVehicle/);
    assert.match(fns, /opsCancelBooking/);
    const server = readFileSync(new URL("./inventory.server.ts", import.meta.url), "utf8");
    assert.match(server, /requireOps\(\{ csrf: true \}\)/);
    const bookingFns = readFileSync(new URL("./booking-fns.ts", import.meta.url), "utf8");
    assert.doesNotMatch(bookingFns, /requireOps/);
    const engine = readFileSync(new URL("./inventory.ts", import.meta.url), "utf8");
    assert.doesNotMatch(engine, /set occupies/i);
    assert.match(engine, /23P01/);
  });
});
