/**
 * G.2B — fresh guest creates open one provisional hold in the same transaction.
 * Checkout stays closed. A hold does not assign a vehicle.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { BookingError, createBooking, type BookingDb } from "./booking.ts";
import { applyCp14LiveCatalog } from "./cp14-fixture.ts";

const CHAIN = [
  "0002_foundation.sql",
  "0003_occupancy.sql",
  "0004_ops_auth.sql",
  "0005_time_domain.sql",
  "0006_booking_engine.sql",
  "0008_guest_ux.sql",
  "0010_hotel_white_label.sql",
  "0012_cp12_tenancy.sql",
  "0021_cp25_hotel_guest_payments.sql",
  "0060_gate2_booking_lifecycle_schema.sql",
  "0061_gate2_provisional_hold_operations.sql",
];

function readMigration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
}

async function openDb(withHold: boolean) {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  if (withHold) {
    await pg.exec("create role aether_app nologin");
    await pg.exec("create role aether_runtime nologin");
  }
  const names = withHold ? CHAIN : CHAIN.filter((name) => !name.startsWith("0021") && !name.startsWith("006"));
  for (const name of names) await pg.exec(readMigration(name));
  const destinationIdByCode = await applyCp14LiveCatalog(pg);
  const db: BookingDb = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner: BookingDb = {
          query: async <R>(text: string, params?: unknown[]) => (await tx.query<R>(text, params)).rows,
          transaction() {
            throw new Error("nested");
          },
        };
        return fn(inner);
      });
    },
  };
  return { pg, db, destinationId: destinationIdByCode.gate! };
}

function input(destinationId: string, extra: Record<string, unknown> = {}) {
  return {
    hotelCode: "gate",
    destinationId,
    transferDate: "2026-06-20",
    pickupTime: "09:00",
    durationMinutes: 60,
    guestName: "Ada Guest",
    guestPhone: "+302101234567",
    guestEmail: "ada@example.com",
    passengerCount: 1,
    luggageCount: 0,
    pickupText: "Lobby",
    ...extra,
  };
}

test("guest checkout stays closed and a hold is not a vehicle reservation", () => {
  const booking = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
  const payment = readFileSync(new URL("./guest-payment-fns.ts", import.meta.url), "utf8");
  assert.match(booking, /openFreshHold/);
  assert.doesNotMatch(booking, /expireProvisionalHolds|createGuestTransferCheckout|sbg_prepare_booking_payment/);
  assert.match(payment, /throw new GuestCheckoutClosed\(\)/);
  assert.match(payment, /SBG_GUEST_PAYMENT_TEST/);
  assert.doesNotMatch(payment, /sbg_prepare_booking_payment|SBG_SAAS_COMMERCE|SBG_DOMAIN_B_LIVE_CHECKOUT/);
});

test("a new booking enters awaiting_payment and a retry does not extend the hold", async () => {
  const { pg, db, destinationId } = await openDb(true);
  try {
    const first = await createBooking(db, input(destinationId, { idempotencyKey: "hold-once" }));
    const row = (
      await pg.query<{
        lifecycle_state: string;
        hold_expires_at: string;
        vehicle_id: string | null;
        driver_id: string | null;
        delta: number;
      }>(
        `select lifecycle_state, hold_expires_at::text, vehicle_id::text, driver_id::text,
                extract(epoch from (hold_expires_at - clock_timestamp())) as delta
           from bookings
          where confirmation_token = $1`,
        [first.confirmationToken],
      )
    ).rows[0]!;
    assert.equal(row.lifecycle_state, "awaiting_payment");
    assert.equal(row.vehicle_id, null);
    assert.equal(row.driver_id, null);
    assert.ok(row.delta > 1700 && row.delta < 1810, `hold delta ${row.delta}`);
    const second = await createBooking(db, input(destinationId, { idempotencyKey: "hold-once" }));
    assert.equal(second.confirmationToken, first.confirmationToken);
    const after = await pg.query<{ n: number; hold: string }>(
      `select count(*)::int as n, min(hold_expires_at)::text as hold from bookings`,
    );
    assert.equal(after.rows[0]!.n, 1);
    assert.equal(after.rows[0]!.hold, row.hold_expires_at);
  } finally {
    await pg.close();
  }
});

test("a failed hold rolls back the booking and an invalid hotel opens nothing", async () => {
  const { pg, db, destinationId } = await openDb(true);
  try {
    await pg.exec(`
      create or replace function public.sbg_open_provisional_hold(p_booking_id uuid, p_ttl_seconds integer)
      returns table (opened_booking_id uuid, opened_lifecycle_state text, opened_hold_expires_at timestamptz)
      language plpgsql as $broken$
      begin
        raise exception 'forced_hold_failure' using errcode = 'P0001';
      end;
      $broken$;
    `);
    await assert.rejects(
      () => createBooking(db, input(destinationId, { idempotencyKey: "hold-rollback" })),
      /forced_hold_failure/,
    );
    const rolled = await pg.query<{ bookings: number; keys: number }>(
      `select (select count(*)::int from bookings) as bookings,
              (select count(*)::int from idempotency_keys) as keys`,
    );
    assert.equal(rolled.rows[0]!.bookings, 0);
    assert.equal(rolled.rows[0]!.keys, 0);
    await pg.exec(readMigration("0061_gate2_provisional_hold_operations.sql"));

    await assert.rejects(
      () => createBooking(db, input(destinationId, { hotelCode: "missing" })),
      (err: unknown) => err instanceof BookingError && err.code === "hotel_not_found",
    );
    await pg.query("update hotels set status = 'configured' where code = 'gate'");
    await assert.rejects(
      () => createBooking(db, input(destinationId, { idempotencyKey: "not-live" })),
      (err: unknown) => err instanceof BookingError && err.code === "hotel_not_live",
    );
    const still = await pg.query<{ n: number }>("select count(*)::int as n from bookings");
    assert.equal(still.rows[0]!.n, 0);
  } finally {
    await pg.close();
  }
});

test("a historical legacy row stays legacy and a schema without the hold function still creates", async () => {
  const held = await openDb(true);
  try {
    const hotel = await held.pg.query<{ id: string; provider: string }>(
      `select h.id, a.provider_id as provider
         from hotels h
         join hotel_provider_agreements a on a.hotel_id = h.id
        where h.code = 'gate'
        limit 1`,
    );
    await held.pg.query(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, pickup_text, destination_text,
         human_reference, confirmation_token, created_at
       ) values (
         $1::uuid, $2::uuid, '2026-01-01', '08:00', 60,
         'Old Guest', '+302100000000', 'old@example.com', 'Desk', 'Port',
         'PT-OLDLEGACY', 'token-old-legacy', clock_timestamp() - interval '3 days'
       )`,
      [hotel.rows[0]!.id, hotel.rows[0]!.provider],
    );
    await createBooking(held.db, input(held.destinationId, { idempotencyKey: "new-beside-legacy", pickupTime: "10:00" }));
    const rows = await held.pg.query<{ token: string; lifecycle_state: string; hold: string | null }>(
      `select confirmation_token as token, lifecycle_state, hold_expires_at::text as hold
         from bookings
        order by created_at`,
    );
    assert.equal(rows.rows[0]!.token, "token-old-legacy");
    assert.equal(rows.rows[0]!.lifecycle_state, "legacy_unreconciled");
    assert.equal(rows.rows[0]!.hold, null);
    assert.equal(rows.rows[1]!.lifecycle_state, "awaiting_payment");
    assert.ok(rows.rows[1]!.hold);
  } finally {
    await held.pg.close();
  }

  const plain = await openDb(false);
  try {
    const created = await createBooking(plain.db, input(plain.destinationId));
    assert.ok(created.confirmationToken);
    const column = await plain.pg.query<{ n: number }>(
      `select count(*)::int as n
         from information_schema.columns
        where table_name = 'bookings' and column_name = 'lifecycle_state'`,
    );
    assert.equal(column.rows[0]!.n, 0);
    const count = await plain.pg.query<{ n: number }>("select count(*)::int as n from bookings");
    assert.equal(count.rows[0]!.n, 1);
  } finally {
    await plain.pg.close();
  }
});
