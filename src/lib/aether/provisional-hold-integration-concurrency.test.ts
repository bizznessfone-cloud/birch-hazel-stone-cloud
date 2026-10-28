/**
 * G.2B concurrency gate. Local PostgreSQL only. Two sessions, one hold.
 * Fails closed when STAGE_G2B_PG_URL is unset. Refuses a non-local host.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";
import { createBooking, type BookingDb } from "./booking.ts";
import { applyCp14LiveCatalog } from "./cp14-fixture.ts";

const { Client } = pg;
const ADMIN_URL = process.env.STAGE_G2B_PG_URL;

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
];

function bookingDb(client: pg.Client): BookingDb {
  return {
    query: async <T>(text: string, params?: unknown[]) => {
      const result = await client.query(text, params);
      return result.rows as T[];
    },
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      await client.query("begin");
      const inner: BookingDb = {
        query: async <R>(text: string, params?: unknown[]) => {
          const result = await client.query(text, params);
          return result.rows as R[];
        },
        transaction() {
          throw new Error("nested");
        },
      };
      try {
        const result = await fn(inner);
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    },
  };
}

test("two local sessions create one awaiting_payment hold and the app role cannot extend it", async () => {
  if (!ADMIN_URL) assert.fail("CONCURRENCY GATE NOT PASSED: STAGE_G2B_PG_URL is unset");
  const adminUrl = new URL(ADMIN_URL);
  if (adminUrl.hostname !== "127.0.0.1" && adminUrl.hostname !== "localhost") {
    assert.fail(`CONCURRENCY GATE NOT PASSED: refusing non-local database host ${adminUrl.hostname}`);
  }
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = 'stage_g2b_hold' and pid <> pg_backend_pid()`,
  );
  await admin.query("drop database if exists stage_g2b_hold");
  await admin.query("create database stage_g2b_hold");
  await admin.end();

  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = "/stage_g2b_hold";
  const setup = new Client({ connectionString: dbUrl.toString() });
  await setup.connect();
  await setup.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'aether_app') then
        create role aether_app nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'aether_runtime') then
        create role aether_runtime nologin;
      end if;
    end $$;
  `);
  for (const name of CHAIN) {
    await setup.query(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  await applyCp14LiveCatalog({
    exec: async (sql) => {
      await setup.query(sql);
    },
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await setup.query(sql, params);
      return { rows: result.rows as T[] };
    },
  });
  await setup.query(readFileSync(new URL("../../../migrations/0060_gate2_booking_lifecycle_schema.sql", import.meta.url), "utf8"));
  await setup.query(readFileSync(new URL("../../../migrations/0061_gate2_provisional_hold_operations.sql", import.meta.url), "utf8"));
  const destination = (
    await setup.query<{ id: string }>(
      `select d.id
         from hotel_destinations d
         join hotels h on h.id = d.hotel_id
        where h.code = 'gate'
        limit 1`,
    )
  ).rows[0]!.id;
  await setup.query(
    `insert into bookings (
       hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
       guest_name, guest_phone, guest_email, pickup_text, destination_text,
       human_reference, confirmation_token, created_at
     )
     select h.id, a.provider_id, '2026-01-01', '08:00', 60,
            'Old Guest', '+302100000000', 'old@example.com', 'Desk', 'Port',
            'PT-OLDLEGACY', 'token-old-legacy', clock_timestamp() - interval '3 days'
       from hotels h
       join hotel_provider_agreements a on a.hotel_id = h.id
      where h.code = 'gate'
      limit 1`,
  );
  await setup.query(`
    grant usage on schema public to aether_app;
    grant select on table hotels, hotel_destinations, hotel_provider_agreements to aether_app;
    grant execute on function aether_civil_instant(date, time, text) to aether_app;
    grant execute on function aether_bookings_occupies_tg() to aether_app;
    grant execute on function aether_bookings_quote_immutable_tg() to aether_app;
    grant select on table bookings to aether_app;
    grant insert (
      hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
      guest_name, guest_phone, guest_email, passenger_count, luggage_count,
      pickup_text, destination_text, special_requirements, human_reference, confirmation_token,
      destination_id, quoted_amount_minor, quoted_currency
    ) on table bookings to aether_app;
    grant select on table idempotency_keys to aether_app;
    grant insert (scope, key, request_hash) on table idempotency_keys to aether_app;
    grant update (booking_id) on table idempotency_keys to aether_app;
    grant select, insert on table audit_events to aether_app;
  `);
  await setup.end();

  const request = {
    hotelCode: "gate",
    destinationId: destination,
    transferDate: "2026-06-20",
    pickupTime: "11:30",
    durationMinutes: 60,
    guestName: "Ada Guest",
    guestPhone: "+302101234567",
    guestEmail: "ada@example.com",
    passengerCount: 1,
    luggageCount: 0,
    pickupText: "Lobby",
    idempotencyKey: "g2b-concurrent",
  };
  const first = new Client({ connectionString: dbUrl.toString() });
  const second = new Client({ connectionString: dbUrl.toString() });
  await first.connect();
  await second.connect();
  await first.query("set role aether_app");
  await second.query("set role aether_app");
  try {
    const [left, right] = await Promise.all([
      createBooking(bookingDb(first), request),
      createBooking(bookingDb(second), request),
    ]);
    assert.equal(left.confirmationToken, right.confirmationToken);
    const again = await createBooking(bookingDb(first), request);
    assert.equal(again.confirmationToken, left.confirmationToken);
  } finally {
    await first.query("reset role");
    await second.query("reset role");
    await first.end();
    await second.end();
  }

  const check = new Client({ connectionString: dbUrl.toString() });
  await check.connect();
  const rows = (
    await check.query<{ token: string; lifecycle_state: string; hold: string | null; vehicle_id: string | null; delta: number | null }>(
      `select confirmation_token as token, lifecycle_state, hold_expires_at::text as hold, vehicle_id::text,
              extract(epoch from (hold_expires_at - clock_timestamp())) as delta
         from bookings
        order by created_at`,
    )
  ).rows;
  await check.end();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.token, "token-old-legacy");
  assert.equal(rows[0]!.lifecycle_state, "legacy_unreconciled");
  assert.equal(rows[0]!.hold, null);
  assert.equal(rows[1]!.lifecycle_state, "awaiting_payment");
  assert.equal(rows[1]!.vehicle_id, null);
  assert.ok(rows[1]!.delta !== null && rows[1]!.delta > 1700 && rows[1]!.delta < 1810);
});
