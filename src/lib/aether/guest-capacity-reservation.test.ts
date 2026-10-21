/**
 * Gate 2 Stage 6B. Guest create calls sbg_reserve_capacity.
 * Disposable PostgreSQL. Fails closed when STAGE_G2S5_PG_URL is unset.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";
import { BookingError, createBooking, getPublicBookingByToken, type BookingDb } from "./booking.ts";

const ADMIN_URL = process.env.STAGE_G2S5_PG_URL;
const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
}

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

async function resetCluster(adminUrl: URL): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const databases = await admin.query<{ datname: string }>(
      `select datname from pg_database
        where datallowconn and datname not in ('postgres', 'template0', 'template1')`,
    );
    for (const row of databases.rows) {
      if (!/^[a-z0-9_]+$/.test(row.datname)) continue;
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()`,
        [row.datname],
      );
      await admin.query(`drop database if exists ${row.datname}`);
    }
    for (const role of [
      "sbg_fleet_writer",
      "aether_payment_gateway",
      "aether_expiry_runner",
      "aether_expiry",
      "aether_app",
      "aether_runtime",
      "aether_webhook",
      "aether_mailer",
      "sbg_capacity_writer",
    ]) {
      const exists = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
      if (exists.rowCount === 0) continue;
      await admin.query(`drop owned by ${role}`);
      await admin.query(`revoke ${role} from postgres`).catch((err: { code?: string }) => {
        if (err.code !== "42704" && err.code !== "0LP01") throw err;
      });
      await admin.query(`drop role ${role}`);
    }
    await admin.query("create database neondb");
  } finally {
    await admin.end();
  }
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = "/neondb";
  return dbUrl.toString();
}

test("stage 6B source binds catalogue ids and does not open checkout", () => {
  const files = migrationFiles();
  assert.equal(files.at(-1), "0079_gate2_bound_payee_test_mode.sql");
  const sql = readFileSync(new URL("0076_gate2_provider_reservation_mode.sql", MIGRATIONS), "utf8");
  const booking = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../../routes/api/stripe/webhook.ts", import.meta.url), "utf8");
  assert.equal(preflight.includes("0075_gate2_guest_destination_binding.sql"), false);
  assert.equal(preflight.includes("0076_gate2_provider_reservation_mode.sql"), false);
  assert.equal(preflight.includes("0077_gate2_capacity_guest_payment.sql"), false);
  assert.equal(preflight.includes("0078_gate2_capacity_checkout_claim_generation.sql"), false);
  assert.equal(preflight.includes("0079_gate2_bound_payee_test_mode.sql"), false);
  assert.equal(preflight.includes("AUTHORISED_PENDING = []"), true);
  assert.match(sql, /reservation_mode/);
  assert.match(sql, /'legacy'/);
  assert.doesNotMatch(sql, /count\(\*\).*sbg_fleet_locations/);
  assert.match(booking, /reservation mode is not configured/);
  assert.match(booking, /sbg_reserve_capacity/);
  assert.match(booking, /openFreshHold/);
  assert.match(booking, /capacity_lock_retry/);
  assert.doesNotMatch(booking, /payment_processing/);
  assert.doesNotMatch(booking, /checkout\.sessions/);
  assert.doesNotMatch(webhook, /sbg_accept_verified_payment_event/);
});

test("guest create reserves one vehicle and rolls back a loser", { timeout: 180_000 }, async () => {
  if (!ADMIN_URL) assert.fail("BLOCKED — LOCAL POSTGRESQL TEST NOT RUN");
  const adminUrl = new URL(ADMIN_URL);
  if (adminUrl.hostname !== "127.0.0.1" && adminUrl.hostname !== "localhost") {
    assert.fail(`BLOCKED — refusing non-local host ${adminUrl.hostname}`);
  }
  adminUrl.pathname = "/postgres";
  const dbUrl = await resetCluster(adminUrl);
  const root = new pg.Client({ connectionString: dbUrl });
  const left = new pg.Client({ connectionString: dbUrl });
  const right = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await left.connect();
  await right.connect();
  try {
    for (const name of migrationFiles()) {
      await root.query(readFileSync(new URL(name, MIGRATIONS), "utf8"));
    }
    await root.query(
      `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
       values ('user-1','Ada','ada@example.com',true,now(),now())`,
    );
    const hotelOrg = (await root.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Hotel', 'user-1', 'hotel') returning id`,
    )).rows[0]!.id;
    const hotel = (await root.query<{ id: string }>(
      `insert into hotels (code, name, iana_timezone, organisation_id, status, currency)
       values ('s6b', 'Door Hotel', 'Europe/Athens', $1::uuid, 'live', 'EUR') returning id`,
      [hotelOrg],
    )).rows[0]!.id;
    const provider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s6bp', 'Door Provider', 'in_house') returning id`,
    )).rows[0]!.id;
    await root.query(
      `update providers set reservation_mode = 'capacity' where id = $1::uuid`,
      [provider],
    );
    const other = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s6bo', 'Other Provider', 'external') returning id`,
    )).rows[0]!.id;
    await root.query(
      `insert into hotel_provider_agreements (hotel_id, provider_id, active)
       values ($1::uuid, $2::uuid, true)`,
      [hotel, provider],
    );
    const destination = (await root.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, active, amount_minor)
       values ($1::uuid, 'airport', 'Athens Airport', true, 4500) returning id`,
      [hotel],
    )).rows[0]!.id;
    const unbound = (await root.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, active, amount_minor)
       values ($1::uuid, 'port', 'Piraeus', true, 3200) returning id`,
      [hotel],
    )).rows[0]!.id;
    const crossed = (await root.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, active, amount_minor)
       values ($1::uuid, 'airport', 'Other Airport', true, 2800) returning id`,
      [hotel],
    )).rows[0]!.id;
    const door = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
       values ($1::uuid, 'hotel', $2::uuid, 'door', 'Door') returning id`,
      [provider, hotel],
    )).rows[0]!.id;
    const airport = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, code, name)
       values ($1::uuid, 'airport', 'ath', 'Athens Airport') returning id`,
      [provider],
    )).rows[0]!.id;
    const foreignAirport = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, code, name)
       values ($1::uuid, 'airport', 'oth', 'Other Airport') returning id`,
      [other],
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 45), ($1::uuid, $3::uuid, $2::uuid, 70)`,
      [provider, door, airport],
    );
    await root.query(
      `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 20), ($1::uuid, $3::uuid, $2::uuid, 20)`,
      [provider, door, airport],
    );
    for (let isodow = 1; isodow <= 7; isodow += 1) {
      await root.query(
        `insert into sbg_provider_hours (provider_id, isodow, opens_local, closes_local)
         values ($1::uuid, $2, '08:00', '20:00')`,
        [provider, isodow],
      );
    }
    await root.query(
      `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Door Van', 6, 4, true, $1::uuid, $1::uuid)`,
      [provider],
    );
    await root.query(
      `insert into sbg_guest_destination_bindings (hotel_destination_id, hotel_id, provider_id, fleet_location_id)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [destination, hotel, provider, airport],
    );
    await root.query(
      `insert into sbg_guest_destination_bindings (hotel_destination_id, hotel_id, provider_id, fleet_location_id)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [crossed, hotel, other, foreignAirport],
    );

    const db = bookingDb(root);
    function input(date: string, destinationId: string, direction: "from_hotel" | "to_hotel" = "from_hotel") {
      return {
        hotelCode: "s6b",
        destinationId,
        transferDate: date,
        pickupTime: "10:00",
        durationMinutes: 60,
        guestName: "Ada Guest",
        guestPhone: "+302100000000",
        guestEmail: "ada@example.com",
        passengerCount: 2,
        luggageCount: 1,
        pickupText: direction === "from_hotel" ? "Door Hotel" : "Athens Airport",
        direction,
      };
    }

    const outbound = await createBooking(db, input("2026-07-08", destination, "from_hotel"));
    assert.equal(outbound.pricing.priced, true);
    if (outbound.pricing.priced) assert.equal(outbound.pricing.amountMinor, 4500);
    assert.equal(outbound.durationMinutes, 45);
    const found = await getPublicBookingByToken(db, outbound.confirmationToken);
    assert.equal(found.humanReference, outbound.humanReference);
    await assert.rejects(() => getPublicBookingByToken(db, "not-the-token"), (err: unknown) => {
      return err instanceof BookingError && err.code === "not_found";
    });
    const stored = await root.query<{
      capacity_managed: boolean;
      vehicle_id: string | null;
      lifecycle_state: string;
      quoted_amount_minor: number;
      duration_minutes: number;
      occupies: string;
    }>(
      `select capacity_managed, vehicle_id::text, lifecycle_state, quoted_amount_minor,
              duration_minutes, occupies::text
         from bookings where human_reference = $1`,
      [outbound.humanReference],
    );
    assert.equal(stored.rows[0]!.capacity_managed, true);
    assert.ok(stored.rows[0]!.vehicle_id);
    assert.equal(stored.rows[0]!.lifecycle_state, "awaiting_payment");
    assert.equal(stored.rows[0]!.quoted_amount_minor, 4500);
    assert.equal(stored.rows[0]!.duration_minutes, 45);
    assert.match(stored.rows[0]!.occupies, /2026-07-08 07:00:00\+00/);
    assert.match(stored.rows[0]!.occupies, /2026-07-08 07:45:00\+00/);
    const itin = await root.query<{ origin_location_id: string; destination_location_id: string }>(
      `select i.origin_location_id::text, i.destination_location_id::text
         from sbg_booking_itinerary i
         join bookings b on b.id = i.booking_id
        where b.human_reference = $1`,
      [outbound.humanReference],
    );
    assert.equal(itin.rows[0]!.origin_location_id, door);
    assert.equal(itin.rows[0]!.destination_location_id, airport);
    const audits = await root.query<{ action: string }>(
      `select action from audit_events where booking_id = (
         select id from bookings where human_reference = $1
       )`,
      [outbound.humanReference],
    );
    assert.equal(audits.rows.some((row) => row.action === "hold_opened"), false);
    assert.equal(audits.rows.some((row) => row.action === "capacity_reserved"), true);
    const payments = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_booking_payments`,
    );
    assert.equal(payments.rows[0]!.n, 0);

    const inbound = await createBooking(db, input("2026-07-09", destination, "to_hotel"));
    assert.equal(inbound.durationMinutes, 70);
    const inboundItin = await root.query<{ origin_location_id: string; destination_location_id: string }>(
      `select i.origin_location_id::text, i.destination_location_id::text
         from sbg_booking_itinerary i
         join bookings b on b.id = i.booking_id
        where b.human_reference = $1`,
      [inbound.humanReference],
    );
    assert.equal(inboundItin.rows[0]!.origin_location_id, airport);
    assert.equal(inboundItin.rows[0]!.destination_location_id, door);

    const beforeMissing = await root.query<{ n: number }>(`select count(*)::int as n from bookings`);
    await assert.rejects(() => createBooking(db, input("2026-07-10", unbound)), (err: unknown) => {
      return err instanceof BookingError && err.code === "invalid_destination";
    });
    await assert.rejects(() => createBooking(db, input("2026-07-10", crossed)), (err: unknown) => {
      return err instanceof BookingError && err.code === "invalid_destination";
    });
    await root.query(`update sbg_fleet_locations set active = false where id = $1::uuid`, [airport]);
    await assert.rejects(() => createBooking(db, input("2026-07-11", destination)), (err: unknown) => {
      return err instanceof BookingError && err.code === "invalid_destination";
    });
    await root.query(`update sbg_fleet_locations set active = true where id = $1::uuid`, [airport]);
    const afterMissing = await root.query<{ n: number }>(`select count(*)::int as n from bookings`);
    assert.equal(afterMissing.rows[0]!.n, beforeMissing.rows[0]!.n);

    await assert.rejects(() => createBooking(db, input("2026-07-08", destination)), (err: unknown) => {
      return err instanceof BookingError && err.code === "unavailable";
    });
    const stillOneSlot = await root.query<{ n: number }>(
      `select count(*)::int as n from bookings where transfer_date = '2026-07-08'`,
    );
    assert.equal(stillOneSlot.rows[0]!.n, 1);

    const raceDate = "2026-07-15";
    const raced = await Promise.allSettled([
      createBooking(bookingDb(left), input(raceDate, destination)),
      createBooking(bookingDb(right), input(raceDate, destination)),
    ]);
    const won = raced.filter((row) => row.status === "fulfilled");
    const lost = raced.filter((row) => row.status === "rejected");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.equal((lost[0] as PromiseRejectedResult).reason instanceof BookingError, true);
    assert.equal((lost[0] as PromiseRejectedResult).reason.code, "unavailable");
    const raceRows = await root.query<{ n: number }>(
      `select count(*)::int as n from bookings where transfer_date = $1::date`,
      [raceDate],
    );
    assert.equal(raceRows.rows[0]!.n, 1);

    await assert.rejects(
      () => createBooking(db, { ...input("2026-03-29", destination), pickupTime: "03:30" }),
      (err: unknown) => err instanceof BookingError && err.code === "nonexistent",
    );
    const gapRows = await root.query<{ n: number }>(
      `select count(*)::int as n from bookings where transfer_date = '2026-03-29'`,
    );
    assert.equal(gapRows.rows[0]!.n, 0);

    const heldId = (await root.query<{ id: string }>(
      `select id from bookings where human_reference = $1`,
      [outbound.humanReference],
    )).rows[0]!.id;
    await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
    try {
      await root.query(
        `update bookings set hold_expires_at = clock_timestamp() - interval '1 minute' where id = $1::uuid`,
        [heldId],
      );
    } finally {
      await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    }
    const expired = await root.query<{ expired_booking_id: string }>(
      `select expired_booking_id from public.sbg_expire_provisional_holds(10)`,
    );
    assert.equal(expired.rows.some((row) => row.expired_booking_id === heldId), true);
    const released = await root.query<{ lifecycle_state: string; vehicle_id: string | null }>(
      `select lifecycle_state, vehicle_id::text from bookings where id = $1::uuid`,
      [heldId],
    );
    assert.equal(released.rows[0]!.lifecycle_state, "expired");
    assert.equal(released.rows[0]!.vehicle_id, null);
    const again = await createBooking(db, input("2026-07-08", destination));
    assert.equal(again.durationMinutes, 45);

    const legacyHotel = (await root.query<{ id: string }>(
      `insert into hotels (code, name, iana_timezone, organisation_id, status, currency)
       values ('s6bl', 'Legacy Door', 'Europe/Athens', $1::uuid, 'live', 'EUR') returning id`,
      [hotelOrg],
    )).rows[0]!.id;
    const legacyProvider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s6blp', 'Legacy Provider', 'external') returning id`,
    )).rows[0]!.id;
    await root.query(`update providers set reservation_mode = 'legacy' where id = $1::uuid`, [legacyProvider]);
    await root.query(
      `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
      [legacyHotel, legacyProvider],
    );
    const legacyDestination = (await root.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, active, amount_minor)
       values ($1::uuid, 'airport', 'Legacy Airport', true, 2100) returning id`,
      [legacyHotel],
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
       values ($1::uuid, 'hotel', $2::uuid, 'legacy-door', 'Legacy Door')`,
      [legacyProvider, legacyHotel],
    );
    const legacyBooking = await createBooking(db, {
      hotelCode: "s6bl",
      destinationId: legacyDestination,
      transferDate: "2026-07-08",
      pickupTime: "10:00",
      durationMinutes: 60,
      guestName: "Legacy Guest",
      guestPhone: "+302100000001",
      guestEmail: "legacy@example.com",
      passengerCount: 1,
      luggageCount: 0,
      pickupText: "Legacy Door",
    });
    assert.equal(legacyBooking.pricing.priced && legacyBooking.pricing.amountMinor, 2100);
    assert.equal(legacyBooking.durationMinutes, 60);
    const legacyRow = await root.query<{ capacity_managed: boolean; vehicle_id: string | null; lifecycle_state: string }>(
      `select capacity_managed, vehicle_id::text, lifecycle_state from bookings where human_reference = $1`,
      [legacyBooking.humanReference],
    );
    assert.equal(legacyRow.rows[0]!.capacity_managed, false);
    assert.equal(legacyRow.rows[0]!.vehicle_id, null);
    assert.equal(legacyRow.rows[0]!.lifecycle_state, "awaiting_payment");

    const bareHotel = (await root.query<{ id: string }>(
      `insert into hotels (code, name, iana_timezone, organisation_id, status, currency)
       values ('s6bb', 'Bare Door', 'Europe/Athens', $1::uuid, 'live', 'EUR') returning id`,
      [hotelOrg],
    )).rows[0]!.id;
    const bareProvider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s6bbp', 'Bare Provider', 'external') returning id`,
    )).rows[0]!.id;
    await root.query(`update providers set reservation_mode = 'capacity' where id = $1::uuid`, [bareProvider]);
    await root.query(
      `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
      [bareHotel, bareProvider],
    );
    const bareDestination = (await root.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, active, amount_minor)
       values ($1::uuid, 'airport', 'Bare Airport', true, 1800) returning id`,
      [bareHotel],
    )).rows[0]!.id;
    const beforeBare = (await root.query<{ n: number }>(`select count(*)::int as n from bookings`)).rows[0]!.n;
    await assert.rejects(
      () => createBooking(db, {
        hotelCode: "s6bb",
        destinationId: bareDestination,
        transferDate: "2026-07-12",
        pickupTime: "10:00",
        durationMinutes: 60,
        guestName: "Bare Guest",
        guestPhone: "+302100000002",
        guestEmail: "bare@example.com",
        passengerCount: 1,
        luggageCount: 0,
        pickupText: "Bare Door",
        direction: "from_hotel",
      }),
      (err: unknown) => err instanceof BookingError && err.code === "invalid_destination",
    );

    const unsetHotel = (await root.query<{ id: string }>(
      `insert into hotels (code, name, iana_timezone, organisation_id, status, currency)
       values ('s6bu', 'Unset Door', 'Europe/Athens', $1::uuid, 'live', 'EUR') returning id`,
      [hotelOrg],
    )).rows[0]!.id;
    const unsetProvider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s6bup', 'Unset Provider', 'external') returning id`,
    )).rows[0]!.id;
    const unsetMode = await root.query<{ reservation_mode: string | null }>(
      `select reservation_mode from providers where id = $1::uuid`,
      [unsetProvider],
    );
    assert.equal(unsetMode.rows[0]!.reservation_mode, null);
    await root.query(
      `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
      [unsetHotel, unsetProvider],
    );
    const unsetDestination = (await root.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, active, amount_minor)
       values ($1::uuid, 'airport', 'Unset Airport', true, 1900) returning id`,
      [unsetHotel],
    )).rows[0]!.id;
    await assert.rejects(
      () => createBooking(db, {
        hotelCode: "s6bu",
        destinationId: unsetDestination,
        transferDate: "2026-07-12",
        pickupTime: "10:00",
        durationMinutes: 60,
        guestName: "Unset Guest",
        guestPhone: "+302100000003",
        guestEmail: "unset@example.com",
        passengerCount: 1,
        luggageCount: 0,
        pickupText: "Unset Door",
        direction: "from_hotel",
      }),
      (err: unknown) => err instanceof BookingError && err.code === "unavailable" && err.message.includes("reservation mode"),
    );
    await assert.rejects(
      () => root.query(`update providers set reservation_mode = 'both' where id = $1::uuid`, [unsetProvider]),
      (err: { code?: string }) => err.code === "23514",
    );
    const afterModes = (await root.query<{ n: number }>(`select count(*)::int as n from bookings`)).rows[0]!.n;
    assert.equal(afterModes, beforeBare);

    await root.query("begin");
    await root.query("set local role aether_app");
    await assert.rejects(
      () => root.query(
        `insert into sbg_guest_destination_bindings (hotel_destination_id, hotel_id, provider_id, fleet_location_id)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        [unbound, hotel, provider, airport],
      ),
      (err: { code?: string }) => err.code === "42501",
    );
    await root.query("rollback");
    await root.query("begin");
    await root.query("set local role aether_runtime");
    await assert.rejects(
      () => root.query(`update providers set reservation_mode = 'legacy' where id = $1::uuid`, [provider]),
      (err: { code?: string }) => err.code === "42501",
    );
    await root.query("rollback");
  } finally {
    await left.end().catch(() => undefined);
    await right.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
});
