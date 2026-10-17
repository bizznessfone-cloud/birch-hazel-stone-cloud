import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = "0060_gate2_booking_lifecycle_schema.sql";

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.equal(errCode(err), code, err instanceof Error ? err.message : String(err));
    return;
  }
  assert.fail(`expected ${code}`);
}

async function openDb() {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  await pg.exec(readFileSync(new URL("../../../migrations/0002_foundation.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../../../migrations/0003_occupancy.sql", import.meta.url), "utf8"));
  await pg.exec("create role aether_app nologin");
  await pg.exec("create role aether_runtime nologin");
  await pg.exec(readFileSync(new URL("../../../migrations/0021_cp25_hotel_guest_payments.sql", import.meta.url), "utf8"));
  return pg;
}

async function seedHotel(pg: PGlite): Promise<string> {
  const rows = await pg.query<{ id: string }>(
    "insert into hotels (code, name) values ('gate', 'Gate Hotel') returning id",
  );
  return rows.rows[0]!.id;
}

async function insertBooking(pg: PGlite, hotelId: string, reference: string): Promise<string> {
  const rows = await pg.query<{ id: string }>(
    `insert into bookings (
       hotel_id, transfer_date, pickup_time, duration_minutes,
       guest_name, guest_phone, guest_email, pickup_text, destination_text,
       human_reference, confirmation_token
     ) values (
       $1::uuid, '2026-01-15', '09:00', 60,
       'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport',
       $2, $3
     ) returning id`,
    [hotelId, reference, `token-${reference}`],
  );
  return rows.rows[0]!.id;
}

test("0060 is source-only and is not in the production ledger", () => {
  const sql = readFileSync(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), "utf8");
  assert.match(sql, /legacy_unreconciled/);
  assert.match(sql, /received_after_expiry/);
  assert.doesNotMatch(sql, /create or replace function public\.aether_bookings_occupies_tg/);
  assert.doesNotMatch(sql, /exclude using gist/);
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  assert.equal(preflight.includes(MIGRATION), false);
  assert.match(preflight, /export const AUTHORISED_PENDING = \[\];/);
});

test("legacy bookings stay unconfirmed and keep their assignment", async () => {
  const pg = await openDb();
  const hotelId = await seedHotel(pg);
  const vehicle = await pg.query<{ id: string }>("insert into vehicles (name) values ('Van') returning id");
  const bookingId = await insertBooking(pg, hotelId, "PT-LEGACY");
  await pg.query("update bookings set vehicle_id = $1::uuid, status = 'assigned' where id = $2::uuid", [
    vehicle.rows[0]!.id,
    bookingId,
  ]);
  await pg.exec(readFileSync(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), "utf8"));
  const row = (
    await pg.query<{
      lifecycle_state: string;
      hold_expires_at: string | null;
      confirmed_paid_at: string | null;
      status: string;
      vehicle_id: string;
      cancelled_at: string | null;
    }>("select lifecycle_state, hold_expires_at, confirmed_paid_at, status, vehicle_id, cancelled_at from bookings")
  ).rows[0]!;
  assert.equal(row.lifecycle_state, "legacy_unreconciled");
  assert.equal(row.hold_expires_at, null);
  assert.equal(row.confirmed_paid_at, null);
  assert.equal(row.status, "assigned");
  assert.equal(row.vehicle_id, vehicle.rows[0]!.id);
  assert.equal(row.cancelled_at, null);
  await pg.close();
});

test("lifecycle values, absolute holds, and payment statuses follow the schema", async () => {
  const pg = await openDb();
  await pg.exec(readFileSync(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), "utf8"));
  const hotelId = await seedHotel(pg);
  const omitted = await insertBooking(pg, hotelId, "PT-NEW");
  const created = (
    await pg.query<{ lifecycle_state: string; confirmed_paid_at: string | null }>(
      "select lifecycle_state, confirmed_paid_at from bookings where id = $1::uuid",
      [omitted],
    )
  ).rows[0]!;
  assert.equal(created.lifecycle_state, "legacy_unreconciled");
  assert.equal(created.confirmed_paid_at, null);

  const hold = "2026-03-29T01:00:00.000Z";
  const open = await pg.query<{ hold_expires_at: string }>(
    `insert into bookings (
       hotel_id, transfer_date, pickup_time, duration_minutes,
       guest_name, guest_phone, guest_email, pickup_text, destination_text,
       human_reference, confirmation_token, lifecycle_state, hold_expires_at
     ) values (
       $1::uuid, '2026-01-15', '10:00', 60,
       'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport',
       'PT-HOLD', 'token-hold', 'awaiting_payment', $2::timestamptz
     ) returning hold_expires_at`,
    [hotelId, hold],
  );
  assert.equal(new Date(open.rows[0]!.hold_expires_at).toISOString(), hold);

  await expectCode(
    () =>
      pg.query(
        `insert into bookings (
           hotel_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, pickup_text, destination_text,
           human_reference, confirmation_token, lifecycle_state
         ) values (
           $1::uuid, '2026-01-15', '11:00', 60,
           'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport',
           'PT-BAD', 'token-bad', 'not-a-state'
         )`,
        [hotelId],
      ),
    "23514",
  );
  await expectCode(
    () =>
      pg.query(
        `insert into bookings (
           hotel_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, pickup_text, destination_text,
           human_reference, confirmation_token, lifecycle_state
         ) values (
           $1::uuid, '2026-01-15', '11:00', 60,
           'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport',
           'PT-NOHOLD', 'token-nohold', 'payment_processing'
         )`,
        [hotelId],
      ),
    "23514",
  );
  await expectCode(
    () =>
      pg.query(
        `insert into bookings (
           hotel_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, pickup_text, destination_text,
           human_reference, confirmation_token, lifecycle_state, hold_expires_at
         ) values (
           $1::uuid, '2026-01-15', '11:00', 60,
           'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport',
           'PT-INF', 'token-inf', 'awaiting_payment', 'infinity'
         )`,
        [hotelId],
      ),
    "23514",
  );
  await expectCode(
    () => pg.query("update bookings set confirmed_paid_at = now() where id = $1::uuid", [omitted]),
    "23514",
  );
  await expectCode(
    () =>
      pg.query(
        `insert into bookings (
           hotel_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, pickup_text, destination_text,
           human_reference, confirmation_token, lifecycle_state
         ) values (
           $1::uuid, '2026-01-15', '12:00', 60,
           'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport',
           'PT-NOPAY', 'token-nopay', 'confirmed_paid'
         )`,
        [hotelId],
      ),
    "23514",
  );

  const confirmed = await pg.query<{ id: string }>(
    `insert into bookings (
       hotel_id, transfer_date, pickup_time, duration_minutes,
       guest_name, guest_phone, guest_email, pickup_text, destination_text,
       human_reference, confirmation_token, lifecycle_state, confirmed_paid_at
     ) values (
       $1::uuid, '2026-01-15', '13:00', 60,
       'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport',
       'PT-CONF', 'token-conf', 'confirmed_paid', '2026-01-15T08:00:00.000Z'
     ) returning id`,
    [hotelId],
  );
  const payments = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_booking_payments where booking_id = $1::uuid",
    [confirmed.rows[0]!.id],
  );
  assert.equal(payments.rows[0]!.n, 0);

  for (const status of ["pending", "paid", "failed", "expired", "canceled"]) {
    await pg.query("delete from sbg_booking_payments");
    await pg.query(
      "insert into sbg_booking_payments (booking_id, amount_minor, currency, status) values ($1::uuid, 4500, 'eur', $2)",
      [omitted, status],
    );
  }
  await pg.query("delete from sbg_booking_payments");
  await pg.query(
    "insert into sbg_booking_payments (booking_id, amount_minor, currency, status) values ($1::uuid, 4500, 'eur', 'received_after_expiry')",
    [omitted],
  );
  const still = (
    await pg.query<{ lifecycle_state: string; confirmed_paid_at: string | null }>(
      "select lifecycle_state, confirmed_paid_at from bookings where id = $1::uuid",
      [omitted],
    )
  ).rows[0]!;
  assert.equal(still.lifecycle_state, "legacy_unreconciled");
  assert.equal(still.confirmed_paid_at, null);
  await expectCode(
    () =>
      pg.query(
        "insert into sbg_booking_payments (booking_id, amount_minor, currency, status) values ($1::uuid, 4500, 'eur', 'confirmed')",
        [confirmed.rows[0]!.id],
      ),
    "23514",
  );
  await pg.close();
});

test("application roles cannot write lifecycle fields directly", async () => {
  const pg = await openDb();
  await pg.exec("grant usage on schema public to aether_runtime");
  await pg.exec("grant select, insert, update on table bookings to aether_runtime");
  await pg.exec(readFileSync(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), "utf8"));
  await pg.exec("grant select, insert, update on table bookings to aether_runtime");
  const hotelId = await seedHotel(pg);
  const bookingId = await insertBooking(pg, hotelId, "PT-ROLE");
  await pg.exec("set role aether_runtime");
  await expectCode(
    () =>
      pg.query("update bookings set lifecycle_state = 'confirmed_paid', confirmed_paid_at = now() where id = $1::uuid", [
        bookingId,
      ]),
    "42501",
  );
  await pg.exec("reset role");
  const row = (
    await pg.query<{ lifecycle_state: string }>("select lifecycle_state from bookings where id = $1::uuid", [bookingId])
  ).rows[0]!;
  assert.equal(row.lifecycle_state, "legacy_unreconciled");
  await pg.close();
});
