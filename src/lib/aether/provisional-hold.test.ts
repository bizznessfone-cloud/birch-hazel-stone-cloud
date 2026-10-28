import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  DEFAULT_PROVISIONAL_HOLD_TTL_SECONDS,
  expireProvisionalHolds,
  openProvisionalHold,
} from "./provisional-hold.ts";

const HOLD_SQL = readFileSync(
  new URL("../../../migrations/0061_gate2_provisional_hold_operations.sql", import.meta.url),
  "utf8",
);

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

async function expectMessage(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.equal(err instanceof Error ? err.message : String(err), message);
    return;
  }
  assert.fail(`expected ${message}`);
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
  await pg.exec(readFileSync(new URL("../../../migrations/0060_gate2_booking_lifecycle_schema.sql", import.meta.url), "utf8"));
  await pg.exec(HOLD_SQL);
  return pg;
}

function dbOf(pg: PGlite) {
  return {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
  };
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

test("0061 is source-only and does not schedule expiry or edit earlier migrations", () => {
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  assert.equal(preflight.includes("0061_gate2_provisional_hold_operations.sql"), false);
  assert.match(HOLD_SQL, /for update of b skip locked/);
  assert.match(HOLD_SQL, /clock_timestamp\(\)/);
  assert.doesNotMatch(HOLD_SQL, /pg_cron|cron\.schedule/);
  assert.doesNotMatch(HOLD_SQL, /exclude using gist/);
  assert.doesNotMatch(HOLD_SQL, /idempotency_keys/);
  assert.doesNotMatch(HOLD_SQL, /stripe_checkout/);
  const guest = readFileSync(new URL("./guest-create.ts", import.meta.url), "utf8");
  const fns = readFileSync(new URL("./booking-fns.ts", import.meta.url), "utf8");
  const booking = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
  assert.doesNotMatch(guest, /sbg_open_provisional_hold|sbg_expire_provisional_holds/);
  assert.doesNotMatch(fns, /openProvisionalHold/);
  assert.match(booking, /openFreshHold/);
  assert.doesNotMatch(booking, /expireProvisionalHolds|sbg_expire_provisional_holds/);
});

test("unsafe TTL values are rejected before a hold is stored", async () => {
  const pg = await openDb();
  const hotelId = await seedHotel(pg);
  const bookingId = await insertBooking(pg, hotelId, "PT-TTL");
  for (const ttl of [0, 59, 1801, 86_400, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expectMessage(() => openProvisionalHold(dbOf(pg), bookingId, ttl), "unsafe_hold_ttl");
  }
  const row = (await pg.query<{ lifecycle_state: string }>("select lifecycle_state from bookings")).rows[0]!;
  assert.equal(row.lifecycle_state, "legacy_unreconciled");
  await pg.close();
});

test("a new booking can be held once, and a second open is refused", async () => {
  const pg = await openDb();
  const hotelId = await seedHotel(pg);
  const bookingId = await insertBooking(pg, hotelId, "PT-OPEN");
  const opened = await openProvisionalHold(dbOf(pg), bookingId, 60);
  assert.equal(opened.lifecycleState, "awaiting_payment");
  const delta = new Date(opened.holdExpiresAt).getTime() - Date.now();
  assert.ok(delta > 50_000 && delta < 70_000, `hold delta ${delta}`);
  const stored = (
    await pg.query<{
      confirmation_token: string;
      duration_minutes: number;
      occupies: string;
      vehicle_id: string | null;
    }>("select confirmation_token, duration_minutes, occupies::text, vehicle_id from bookings")
  ).rows[0]!;
  assert.equal(stored.confirmation_token, "token-PT-OPEN");
  assert.equal(stored.duration_minutes, 60);
  assert.notEqual(stored.occupies, "empty");
  assert.equal(stored.vehicle_id, null);
  await expectMessage(() => openProvisionalHold(dbOf(pg), bookingId, 60), "duplicate_hold");
  const again = (
    await pg.query<{ hold_expires_at: string }>("select hold_expires_at from bookings")
  ).rows[0]!;
  assert.equal(new Date(again.hold_expires_at).toISOString(), opened.holdExpiresAt);
  assert.equal(DEFAULT_PROVISIONAL_HOLD_TTL_SECONDS, 1800);
  await pg.close();
});

test("legacy, assigned, and paid rows are not converted into holds", async () => {
  const pg = await openDb();
  const hotelId = await seedHotel(pg);
  const oldId = await insertBooking(pg, hotelId, "PT-OLD");
  await pg.query("update bookings set created_at = clock_timestamp() - interval '3 minutes' where id = $1::uuid", [
    oldId,
  ]);
  await expectMessage(() => openProvisionalHold(dbOf(pg), oldId, 60), "not_newly_created");

  const assignedId = await insertBooking(pg, hotelId, "PT-CAR");
  const vehicle = await pg.query<{ id: string }>("insert into vehicles (name) values ('Van') returning id");
  await pg.query("update bookings set vehicle_id = $1::uuid where id = $2::uuid", [vehicle.rows[0]!.id, assignedId]);
  await expectMessage(() => openProvisionalHold(dbOf(pg), assignedId, 60), "legacy_protected");
  const kept = (
    await pg.query<{ vehicle_id: string; lifecycle_state: string }>(
      "select vehicle_id, lifecycle_state from bookings where id = $1::uuid",
      [assignedId],
    )
  ).rows[0]!;
  assert.equal(kept.vehicle_id, vehicle.rows[0]!.id);
  assert.equal(kept.lifecycle_state, "legacy_unreconciled");

  const paidId = await insertBooking(pg, hotelId, "PT-PAID");
  await pg.query(
    "insert into sbg_booking_payments (booking_id, amount_minor, currency, status) values ($1::uuid, 4500, 'eur', 'paid')",
    [paidId],
  );
  await expectMessage(() => openProvisionalHold(dbOf(pg), paidId, 60), "legacy_protected");
  await pg.close();
});

test("expiry leaves a live hold, expires a due unpaid hold, and is idempotent", async () => {
  const pg = await openDb();
  const hotelId = await seedHotel(pg);
  const liveId = await insertBooking(pg, hotelId, "PT-LIVE");
  const dueId = await insertBooking(pg, hotelId, "PT-DUE");
  await openProvisionalHold(dbOf(pg), liveId, 1800);
  await openProvisionalHold(dbOf(pg), dueId, 60);
  assert.deepEqual(await expireProvisionalHolds(dbOf(pg)), []);
  await pg.query("update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid", [
    dueId,
  ]);
  const expired = await expireProvisionalHolds(dbOf(pg));
  assert.deepEqual(
    expired.map((row) => row.bookingId),
    [dueId],
  );
  assert.equal(expired[0]!.previousLifecycle, "awaiting_payment");
  const rows = (
    await pg.query<{ id: string; lifecycle_state: string }>("select id, lifecycle_state from bookings order by human_reference")
  ).rows;
  assert.equal(rows.find((row) => row.id === liveId)!.lifecycle_state, "awaiting_payment");
  assert.equal(rows.find((row) => row.id === dueId)!.lifecycle_state, "expired");
  const audits = await pg.query<{ n: number }>(
    "select count(*)::int as n from audit_events where action = 'hold_expired' and booking_id = $1::uuid",
    [dueId],
  );
  assert.equal(audits.rows[0]!.n, 1);
  assert.deepEqual(await expireProvisionalHolds(dbOf(pg)), []);
  const auditsAfter = await pg.query<{ n: number }>(
    "select count(*)::int as n from audit_events where action = 'hold_expired'",
  );
  assert.equal(auditsAfter.rows[0]!.n, 1);
  await pg.close();
});

test("expiry does not confirm, cancel checkout, or alter another booking's vehicle", async () => {
  const pg = await openDb();
  const hotelId = await seedHotel(pg);
  const dueId = await insertBooking(pg, hotelId, "PT-PEND");
  const otherId = await insertBooking(pg, hotelId, "PT-OTHER");
  const vehicle = await pg.query<{ id: string }>("insert into vehicles (name) values ('Other van') returning id");
  await pg.query("update bookings set vehicle_id = $1::uuid, lifecycle_state = 'legacy_unreconciled' where id = $2::uuid", [
    vehicle.rows[0]!.id,
    otherId,
  ]);
  await openProvisionalHold(dbOf(pg), dueId, 60);
  await pg.query(
    "insert into sbg_booking_payments (booking_id, amount_minor, currency, status) values ($1::uuid, 4500, 'eur', 'pending')",
    [dueId],
  );
  await pg.query("update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid", [
    dueId,
  ]);
  const expired = await expireProvisionalHolds(dbOf(pg));
  assert.equal(expired[0]!.paymentStatus, "pending");
  const payment = (
    await pg.query<{ status: string; stripe_checkout_session_id: string | null }>(
      "select status, stripe_checkout_session_id from sbg_booking_payments",
    )
  ).rows[0]!;
  assert.equal(payment.status, "pending");
  assert.equal(payment.stripe_checkout_session_id, null);
  const other = (
    await pg.query<{ vehicle_id: string; lifecycle_state: string }>(
      "select vehicle_id, lifecycle_state from bookings where id = $1::uuid",
      [otherId],
    )
  ).rows[0]!;
  assert.equal(other.vehicle_id, vehicle.rows[0]!.id);
  assert.equal(other.lifecycle_state, "legacy_unreconciled");

  const confirmed = await insertBooking(pg, hotelId, "PT-CONF");
  await pg.query(
    "update bookings set lifecycle_state = 'confirmed_paid', confirmed_paid_at = clock_timestamp(), hold_expires_at = clock_timestamp() - interval '1 hour' where id = $1::uuid",
    [confirmed],
  );
  assert.deepEqual(await expireProvisionalHolds(dbOf(pg)), []);
  const confirmedRow = (
    await pg.query<{ lifecycle_state: string }>("select lifecycle_state from bookings where id = $1::uuid", [confirmed])
  ).rows[0]!;
  assert.equal(confirmedRow.lifecycle_state, "confirmed_paid");
  await pg.close();
});

test("verified payment evidence blocks expiry and is not rewritten", async () => {
  const pg = await openDb();
  const hotelId = await seedHotel(pg);
  for (const status of ["paid", "received_after_expiry"]) {
    const bookingId = await insertBooking(pg, hotelId, `PT-${status}`);
    await openProvisionalHold(dbOf(pg), bookingId, 60);
    await pg.query(
      "insert into sbg_booking_payments (booking_id, amount_minor, currency, status) values ($1::uuid, 4500, 'eur', $2)",
      [bookingId, status],
    );
    await pg.query("update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid", [
      bookingId,
    ]);
  }
  assert.deepEqual(await expireProvisionalHolds(dbOf(pg)), []);
  const rows = (
    await pg.query<{ lifecycle_state: string; status: string }>(
      `select b.lifecycle_state, p.status
         from bookings b
         join sbg_booking_payments p on p.booking_id = b.id
        order by p.status`,
    )
  ).rows;
  assert.deepEqual(
    rows.map((row) => [row.lifecycle_state, row.status]),
    [
      ["awaiting_payment", "paid"],
      ["awaiting_payment", "received_after_expiry"],
    ],
  );
  await pg.close();
});

test("application execute is narrow and direct lifecycle writes stay denied", async () => {
  const pg = await openDb();
  const hotelId = await seedHotel(pg);
  const bookingId = await insertBooking(pg, hotelId, "PT-ROLE");
  await pg.exec("set role aether_runtime");
  await expectMessage(() => openProvisionalHold(dbOf(pg), bookingId, 60), "permission denied for function sbg_open_provisional_hold");
  await pg.exec("reset role");
  await pg.exec("grant select, update on table bookings to aether_app");
  await pg.exec("set role aether_app");
  const opened = await openProvisionalHold(dbOf(pg), bookingId, 60);
  assert.equal(opened.lifecycleState, "awaiting_payment");
  try {
    await pg.query("update bookings set lifecycle_state = 'expired' where id = $1::uuid", [bookingId]);
    assert.fail("direct update should fail");
  } catch (err) {
    assert.equal(errCode(err), "42501");
  }
  await pg.exec("reset role");
  await pg.close();
});

test("this file does not claim a multi-session expiry race", () => {
  assert.match(HOLD_SQL, /for update of b skip locked/);
  assert.match(HOLD_SQL, /Stage D's verified-payment transition must use the same/);
});
