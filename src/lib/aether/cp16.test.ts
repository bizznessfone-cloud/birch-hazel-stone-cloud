/**
 * CP16 — aether_app least-privilege production runtime.
 * 0011–0016 are immutable. Occupancy, CP15 auth, and preview aether_runtime stay.
 *
 * DEFERRED FLEET OWNERSHIP STAMPER ARCHITECTURE:
 * HTTP derives owned_by_provider_id / operated_by_provider_id from
 * requireOps().providerId. Raw aether_app SQL can still supply arbitrary
 * provider UUIDs because PostgreSQL column grants cannot bind values.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AETHER_APP_ROLE, AETHER_RUNTIME_ROLE } from "./runtime-role.ts";
import {
  createBooking,
  getPublicBookingByToken,
  type BookingDb,
} from "./booking.ts";
import { civilInstant, type TimeDb } from "./time.ts";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  ensureOperatorFromEnv,
  loginOperator,
  logoutOperator,
  requireOps,
  type AuthEnv,
  type CookieJar,
  type CookieOpts,
} from "./ops-auth.ts";
import { grantHotelDesk } from "./tenancy.ts";
import { provisionHotel, type ProvisionDb } from "./provision.ts";
import { assertGuestCreateRateLimit } from "./guest-rate-limit.ts";
import { cancelBooking } from "./inventory.ts";
import { getOpsBooking } from "./ops-desk.ts";

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
} as const;

type SqlDb = BookingDb & TimeDb & ProvisionDb;

function readMigration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function errCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
}

async function expectDenied(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const code = errCode(err);
    assert.ok(code === "42501" || code === "0A000", `expected 42501/0A000, got ${code}: ${err}`);
    return;
  }
  assert.fail("expected privilege denial");
}

function memoryJar(): CookieJar & { store: Map<string, { value: string; options: CookieOpts }> } {
  const store = new Map<string, { value: string; options: CookieOpts }>();
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
    provider: { code: `${code}-ops`, name: `${code} Ops` },
    goLive: true,
  });
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

describe("CP16 runtime privilege hardening", () => {
  test("0011–0016 remain byte-identical; 0017 is privilege-only", () => {
    for (const [name, expected] of Object.entries(IMMUTABLE)) {
      assert.equal(sha256(readMigration(name)), expected, name);
    }
    const m17 = readMigration("0017_cp16_runtime_privilege_hardening.sql");
    assert.match(m17, /schema_phase', '16'/);
    assert.match(m17, /checkpoint', '16'/);
    assert.doesNotMatch(m17, /schema_phase', '17'/);
    assert.doesNotMatch(m17, /drop trigger bookings_occupies_before/i);
    assert.doesNotMatch(m17, /drop function aether_athens/i);
    assert.doesNotMatch(m17, /drop constraint bookings_vehicle_occupancy_excl/i);
    assert.doesNotMatch(m17, /security definer/i);
    assert.doesNotMatch(m17, /create role/i);
    assert.doesNotMatch(m17, /enable row level security/i);
    assert.doesNotMatch(m17, /grant aether_app to current_user/i);
    assert.match(m17, /DEFERRED FLEET OWNERSHIP STAMPER/);
    assert.match(m17, /LEGACY_RUNTIME/);
    assert.doesNotMatch(m17, /aether_athens_date/);
    const occ = readMigration("0003_occupancy.sql");
    assert.match(occ, /bookings_occupies_before/);
  });

  test("aether_app grant matrix after 0017", async () => {
    const { pg } = await openDb();
    const meta = await pg.query<{ key: string; value: string }>(
      "select key, value from aether_meta",
    );
    const map = Object.fromEntries(meta.rows.map((row) => [row.key, row.value]));
    assert.equal(map.schema_phase, "16");
    assert.equal(map.checkpoint, "16");

    const priv = await pg.query<{
      hotels_select: boolean;
      hotels_insert: boolean;
      hotels_update: boolean;
      hotels_delete: boolean;
      dest_insert: boolean;
      dest_update: boolean;
      dest_delete: boolean;
      providers_insert: boolean;
      agreements_insert: boolean;
      agreements_update: boolean;
      memberships_insert: boolean;
      memberships_select: boolean;
      memberships_update: boolean;
      bookings_select: boolean;
      bookings_delete: boolean;
      bookings_trigger: boolean;
      meta_select: boolean;
      meta_insert: boolean;
      migrations_select: boolean;
      schema_usage: boolean;
      schema_create: boolean;
      audit_insert: boolean;
      audit_update: boolean;
      audit_delete: boolean;
      attempts_update: boolean;
      attempts_delete: boolean;
      vehicle_id_upd: boolean;
      driver_id_upd: boolean;
      cancelled_upd: boolean;
      status_upd: boolean;
      hotel_id_upd: boolean;
      exec_upd: boolean;
      occupies_upd: boolean;
      dest_id_upd: boolean;
      quote_amt_upd: boolean;
      quote_cur_upd: boolean;
      token_upd: boolean;
      date_upd: boolean;
      time_upd: boolean;
      dur_upd: boolean;
      op_login_ins: boolean;
      op_hash_upd: boolean;
      op_delete: boolean;
      veh_owner_ins: boolean;
      veh_hotel_ins: boolean;
      veh_name_upd: boolean;
      veh_owner_upd: boolean;
      drv_emp_ins: boolean;
      drv_hotel_ins: boolean;
      occupies_ins: boolean;
      vehicle_ins: boolean;
      civil_exec: boolean;
      athens_exec: boolean;
      today_exec: boolean;
      occupies_exec: boolean;
      quote_exec: boolean;
      date_exec: boolean;
    }>(
      `select
         has_table_privilege($1, 'hotels', 'SELECT') as hotels_select,
         has_table_privilege($1, 'hotels', 'INSERT') as hotels_insert,
         has_table_privilege($1, 'hotels', 'UPDATE') as hotels_update,
         has_table_privilege($1, 'hotels', 'DELETE') as hotels_delete,
         has_table_privilege($1, 'hotel_destinations', 'INSERT') as dest_insert,
         has_table_privilege($1, 'hotel_destinations', 'UPDATE') as dest_update,
         has_table_privilege($1, 'hotel_destinations', 'DELETE') as dest_delete,
         has_table_privilege($1, 'providers', 'INSERT') as providers_insert,
         has_table_privilege($1, 'hotel_provider_agreements', 'INSERT') as agreements_insert,
         has_table_privilege($1, 'hotel_provider_agreements', 'UPDATE') as agreements_update,
         has_table_privilege($1, 'operator_memberships', 'INSERT') as memberships_insert,
         has_table_privilege($1, 'operator_memberships', 'SELECT') as memberships_select,
         has_table_privilege($1, 'operator_memberships', 'UPDATE') as memberships_update,
         has_table_privilege($1, 'bookings', 'SELECT') as bookings_select,
         has_table_privilege($1, 'bookings', 'DELETE') as bookings_delete,
         has_table_privilege($1, 'bookings', 'TRIGGER') as bookings_trigger,
         has_table_privilege($1, 'aether_meta', 'SELECT') as meta_select,
         has_table_privilege($1, 'aether_meta', 'INSERT') as meta_insert,
         has_table_privilege($1, '_migrations', 'SELECT') as migrations_select,
         has_schema_privilege($1, 'public', 'USAGE') as schema_usage,
         has_schema_privilege($1, 'public', 'CREATE') as schema_create,
         has_table_privilege($1, 'audit_events', 'INSERT') as audit_insert,
         has_table_privilege($1, 'audit_events', 'UPDATE') as audit_update,
         has_table_privilege($1, 'audit_events', 'DELETE') as audit_delete,
         has_table_privilege($1, 'public_booking_attempts', 'UPDATE') as attempts_update,
         has_table_privilege($1, 'public_booking_attempts', 'DELETE') as attempts_delete,
         has_column_privilege($1, 'bookings', 'vehicle_id', 'UPDATE') as vehicle_id_upd,
         has_column_privilege($1, 'bookings', 'driver_id', 'UPDATE') as driver_id_upd,
         has_column_privilege($1, 'bookings', 'cancelled_at', 'UPDATE') as cancelled_upd,
         has_column_privilege($1, 'bookings', 'status', 'UPDATE') as status_upd,
         has_column_privilege($1, 'bookings', 'hotel_id', 'UPDATE') as hotel_id_upd,
         has_column_privilege($1, 'bookings', 'executing_provider_id', 'UPDATE') as exec_upd,
         has_column_privilege($1, 'bookings', 'occupies', 'UPDATE') as occupies_upd,
         has_column_privilege($1, 'bookings', 'destination_id', 'UPDATE') as dest_id_upd,
         has_column_privilege($1, 'bookings', 'quoted_amount_minor', 'UPDATE') as quote_amt_upd,
         has_column_privilege($1, 'bookings', 'quoted_currency', 'UPDATE') as quote_cur_upd,
         has_column_privilege($1, 'bookings', 'confirmation_token', 'UPDATE') as token_upd,
         has_column_privilege($1, 'bookings', 'transfer_date', 'UPDATE') as date_upd,
         has_column_privilege($1, 'bookings', 'pickup_time', 'UPDATE') as time_upd,
         has_column_privilege($1, 'bookings', 'duration_minutes', 'UPDATE') as dur_upd,
         has_column_privilege($1, 'operators', 'login', 'INSERT') as op_login_ins,
         has_column_privilege($1, 'operators', 'password_hash', 'UPDATE') as op_hash_upd,
         has_table_privilege($1, 'operators', 'DELETE') as op_delete,
         has_column_privilege($1, 'vehicles', 'owned_by_provider_id', 'INSERT') as veh_owner_ins,
         has_column_privilege($1, 'vehicles', 'owned_by_hotel_id', 'INSERT') as veh_hotel_ins,
         has_column_privilege($1, 'vehicles', 'name', 'UPDATE') as veh_name_upd,
         has_column_privilege($1, 'vehicles', 'owned_by_provider_id', 'UPDATE') as veh_owner_upd,
         has_column_privilege($1, 'drivers', 'employed_by_provider_id', 'INSERT') as drv_emp_ins,
         has_column_privilege($1, 'drivers', 'employed_by_hotel_id', 'INSERT') as drv_hotel_ins,
         has_column_privilege($1, 'bookings', 'occupies', 'INSERT') as occupies_ins,
         has_column_privilege($1, 'bookings', 'vehicle_id', 'INSERT') as vehicle_ins,
         has_function_privilege($1, 'aether_civil_instant(date, time, text)', 'EXECUTE') as civil_exec,
         has_function_privilege($1, 'aether_athens_instant(date, time)', 'EXECUTE') as athens_exec,
         has_function_privilege($1, 'aether_athens_today()', 'EXECUTE') as today_exec,
         has_function_privilege($1, 'aether_bookings_occupies_tg()', 'EXECUTE') as occupies_exec,
         has_function_privilege($1, 'aether_bookings_quote_immutable_tg()', 'EXECUTE') as quote_exec,
         has_function_privilege($1, 'aether_athens_date(timestamptz)', 'EXECUTE') as date_exec`,
      [AETHER_APP_ROLE],
    );
    const p = priv.rows[0]!;
    assert.equal(p.hotels_select, true);
    assert.equal(p.hotels_insert, false);
    assert.equal(p.hotels_update, false);
    assert.equal(p.hotels_delete, false);
    assert.equal(p.dest_insert, false);
    assert.equal(p.dest_update, false);
    assert.equal(p.dest_delete, false);
    assert.equal(p.providers_insert, false);
    assert.equal(p.agreements_insert, false);
    assert.equal(p.agreements_update, false);
    assert.equal(p.memberships_insert, false);
    assert.equal(p.memberships_select, true);
    assert.equal(p.memberships_update, false);
    assert.equal(p.bookings_select, true);
    assert.equal(p.bookings_delete, false);
    assert.equal(p.bookings_trigger, false);
    assert.equal(p.meta_select, true);
    assert.equal(p.meta_insert, false);
    assert.equal(p.migrations_select, false);
    assert.equal(p.schema_usage, true);
    assert.equal(p.schema_create, false);
    assert.equal(p.audit_insert, true);
    assert.equal(p.audit_update, false);
    assert.equal(p.audit_delete, false);
    assert.equal(p.attempts_update, false);
    assert.equal(p.attempts_delete, true);
    assert.equal(p.vehicle_id_upd, true);
    assert.equal(p.driver_id_upd, true);
    assert.equal(p.cancelled_upd, true);
    assert.equal(p.status_upd, true);
    assert.equal(p.hotel_id_upd, false);
    assert.equal(p.exec_upd, false);
    assert.equal(p.occupies_upd, false);
    assert.equal(p.dest_id_upd, false);
    assert.equal(p.quote_amt_upd, false);
    assert.equal(p.quote_cur_upd, false);
    assert.equal(p.token_upd, false);
    assert.equal(p.date_upd, false);
    assert.equal(p.time_upd, false);
    assert.equal(p.dur_upd, false);
    assert.equal(p.op_login_ins, true);
    assert.equal(p.op_hash_upd, true);
    assert.equal(p.op_delete, false);
    assert.equal(p.veh_owner_ins, true);
    assert.equal(p.veh_hotel_ins, false);
    assert.equal(p.veh_name_upd, true);
    assert.equal(p.veh_owner_upd, false);
    assert.equal(p.drv_emp_ins, true);
    assert.equal(p.drv_hotel_ins, false);
    assert.equal(p.occupies_ins, false);
    assert.equal(p.vehicle_ins, false);
    assert.equal(p.civil_exec, true);
    assert.equal(p.athens_exec, true);
    assert.equal(p.today_exec, true);
    assert.equal(p.occupies_exec, true);
    assert.equal(p.quote_exec, true);
    assert.equal(p.date_exec, false);

    const who = await pg.query<{ rolsuper: boolean; rolcanlogin: boolean }>(
      `select rolsuper, rolcanlogin from pg_roles where rolname = $1`,
      [AETHER_APP_ROLE],
    );
    assert.equal(who.rows[0]!.rolsuper, false);
    assert.equal(who.rows[0]!.rolcanlogin, true);
    await pg.close();
  });

  test("aether_app guest booking, lookup, quote, timezone, occupancy, rate limit, idempotency", async () => {
    const { db, pg } = await openDb();
    const athens = await seedLive(db, "quay", "Europe/Athens");
    const york = await seedLive(db, "york", "America/New_York");

    const created = await asApp(pg, () =>
      createBooking(db, bookInput(athens.hotel.code, athens.destinations[0]!.id)),
    );
    assert.match(created.humanReference, /^PT-/);
    assert.equal(created.pricing.priced, true);
    assert.equal(created.pricing.amountMinor, 4500);

    const looked = await asApp(pg, () => getPublicBookingByToken(db, created.confirmationToken));
    assert.equal(looked.humanReference, created.humanReference);

    const occupies = await asApp(pg, async () => {
      const rows = await db.query<{ empty: boolean; lo: string }>(
        `select isempty(occupies) as empty, lower(occupies)::text as lo
           from bookings where confirmation_token = $1`,
        [created.confirmationToken],
      );
      return rows[0]!;
    });
    assert.equal(occupies.empty, false);
    assert.equal(new Date(occupies.lo).toISOString(), "2026-01-15T07:00:00.000Z");

    const ny = await asApp(pg, () =>
      createBooking(db, bookInput(york.hotel.code, york.destinations[0]!.id, {
        guestEmail: "york@example.com",
      })),
    );
    const nyOcc = await db.query<{ lo: string }>(
      `select lower(occupies)::text as lo from bookings where confirmation_token = $1`,
      [ny.confirmationToken],
    );
    assert.equal(new Date(nyOcc[0]!.lo).toISOString(), "2026-01-15T14:00:00.000Z");

    const instant = await asApp(pg, () =>
      civilInstant(db, "2026-01-15", "09:00", "Europe/Athens"),
    );
    assert.equal(new Date(instant).toISOString(), "2026-01-15T07:00:00.000Z");

    await asApp(pg, () => assertGuestCreateRateLimit(db, "cp16-client"));
    const idem = await asApp(pg, () =>
      createBooking(
        db,
        bookInput(athens.hotel.code, athens.destinations[0]!.id, {
          guestEmail: "idem@example.com",
          idempotencyKey: "cp16-key",
        }),
      ),
    );
    const again = await asApp(pg, () =>
      createBooking(
        db,
        bookInput(athens.hotel.code, athens.destinations[0]!.id, {
          guestEmail: "idem@example.com",
          idempotencyKey: "cp16-key",
        }),
      ),
    );
    assert.equal(again.confirmationToken, idem.confirmationToken);
    await pg.close();
  });

  test("aether_app can update operational booking columns and cannot update protected columns", async () => {
    const { db, pg } = await openDb();
    const live = await seedLive(db, "quay", "Europe/Athens");
    const created = await asApp(pg, () =>
      createBooking(db, bookInput(live.hotel.code, live.destinations[0]!.id)),
    );
    const booking = await db.query<{ id: string; hotel_id: string }>(
      "select id, hotel_id from bookings where confirmation_token = $1",
      [created.confirmationToken],
    );
    const id = booking[0]!.id;
    const provider = await db.query<{ id: string }>(
      "select id from providers where code = 'quay-ops'",
    );
    const vehicle = (
      await pg.query<{ id: string }>(
        `insert into vehicles (name, capacity, active, owned_by_provider_id, operated_by_provider_id)
         values ('Van', 4, true, $1::uuid, $1::uuid) returning id`,
        [provider[0]!.id],
      )
    ).rows[0]!;
    const driver = (
      await pg.query<{ id: string }>(
        `insert into drivers (name, active, employed_by_provider_id, dispatched_by_provider_id)
         values ('Pat', true, $1::uuid, $1::uuid) returning id`,
        [provider[0]!.id],
      )
    ).rows[0]!;

    await asApp(pg, async () => {
      await db.query("update bookings set vehicle_id = $1::uuid where id = $2::uuid", [
        vehicle.id,
        id,
      ]);
      await db.query("update bookings set driver_id = $1::uuid where id = $2::uuid", [
        driver.id,
        id,
      ]);
      await db.query("update bookings set status = 'assigned' where id = $1::uuid", [id]);
      await db.query("update bookings set cancelled_at = now() where id = $1::uuid", [id]);
    });
    const after = await db.query<{ empty: boolean; status: string }>(
      "select isempty(occupies) as empty, status from bookings where id = $1::uuid",
      [id],
    );
    assert.equal(after[0]!.empty, true);
    assert.equal(after[0]!.status, "assigned");

    await asApp(pg, async () => {
      await expectDenied(() =>
        db.query("update bookings set hotel_id = $1::uuid where id = $2::uuid", [
          booking[0]!.hotel_id,
          id,
        ]),
      );
      await expectDenied(() =>
        db.query("update bookings set executing_provider_id = $1::uuid where id = $2::uuid", [
          provider[0]!.id,
          id,
        ]),
      );
      await expectDenied(() =>
        db.query("update bookings set occupies = 'empty'::tstzrange where id = $1::uuid", [id]),
      );
      await expectDenied(() =>
        db.query("update bookings set destination_id = $1::uuid where id = $2::uuid", [
          live.destinations[0]!.id,
          id,
        ]),
      );
      await expectDenied(() =>
        db.query("update bookings set quoted_amount_minor = 1 where id = $1::uuid", [id]),
      );
      await expectDenied(() =>
        db.query("update bookings set quoted_currency = 'USD' where id = $1::uuid", [id]),
      );
      await expectDenied(() =>
        db.query("update bookings set confirmation_token = 'nope' where id = $1::uuid", [id]),
      );
      await expectDenied(() =>
        db.query("update bookings set transfer_date = '2026-02-01' where id = $1::uuid", [id]),
      );
      await expectDenied(() =>
        db.query("update bookings set pickup_time = '10:00' where id = $1::uuid", [id]),
      );
      await expectDenied(() =>
        db.query("update bookings set duration_minutes = 30 where id = $1::uuid", [id]),
      );
      await expectDenied(() => db.query("delete from bookings where id = $1::uuid", [id]));
    });
    await pg.close();
  });

  test("aether_app is denied hotel/provider/membership/destination/meta/schema/occupancy DDL", async () => {
    const { db, pg } = await openDb();
    const live = await seedLive(db, "quay", "Europe/Athens");
    await asApp(pg, async () => {
      await expectDenied(() =>
        db.query("insert into hotels (code, name) values ('hack', 'Hack')"),
      );
      await expectDenied(() =>
        db.query("update hotels set name = 'X' where id = $1::uuid", [live.hotel.id]),
      );
      await expectDenied(() =>
        db.query("update hotels set iana_timezone = 'UTC' where id = $1::uuid", [live.hotel.id]),
      );
      await expectDenied(() => db.query("delete from hotels where id = $1::uuid", [live.hotel.id]));
      await expectDenied(() =>
        db.query(
          `insert into hotel_destinations (hotel_id, kind, name, amount_minor)
           values ($1::uuid, 'airport', 'X', 1)`,
          [live.hotel.id],
        ),
      );
      await expectDenied(() =>
        db.query("update hotel_destinations set amount_minor = 1 where hotel_id = $1::uuid", [
          live.hotel.id,
        ]),
      );
      await expectDenied(() =>
        db.query("insert into providers (code, name, kind) values ('x', 'X', 'external')"),
      );
      await expectDenied(() =>
        db.query("update providers set name = 'X' where code = 'quay-ops'"),
      );
      await expectDenied(() =>
        db.query(
          `insert into hotel_provider_agreements (hotel_id, provider_id, active)
           select $1::uuid, id, true from providers where code = 'quay-ops'`,
          [live.hotel.id],
        ),
      );
      await expectDenied(() =>
        db.query("insert into operator_memberships (operator_id, org_kind, hotel_id, access_class) select id, 'hotel', $1::uuid, 'hotel_desk' from operators limit 1", [
          live.hotel.id,
        ]),
      );
      await expectDenied(() => db.query("insert into aether_meta (key, value) values ('hack', '1')"));
      await expectDenied(() =>
        db.query("update aether_meta set value = 'x' where key = 'checkpoint'"),
      );
      await expectDenied(() => db.query("select * from _migrations"));
      await expectDenied(() => db.query("insert into _migrations (name) values ('x.sql')"));
      await expectDenied(() => pg.exec("create table cp16_probe (id int)"));
      await expectDenied(() =>
        pg.exec("alter table bookings disable trigger bookings_occupies_before"),
      );
      await expectDenied(() =>
        pg.exec("drop trigger bookings_occupies_before on bookings"),
      );
      await expectDenied(() =>
        pg.exec("alter table bookings drop constraint bookings_vehicle_occupancy_excl"),
      );
      await expectDenied(() => pg.exec("drop function aether_athens_instant(date, time)"));
      await expectDenied(() => pg.exec(`alter role ${AETHER_APP_ROLE} createdb`));
    });
    await pg.close();
  });

  test("provider fleet INSERT/UPDATE shape is preserved; hotel ownership INSERT is denied", async () => {
    const { db, pg } = await openDb();
    const live = await seedLive(db, "quay", "Europe/Athens");
    const provider = await db.query<{ id: string }>(
      "select id from providers where code = 'quay-ops'",
    );
    const other = await db.query<{ id: string }>(
      "select id from providers where code = 'legacy'",
    );

    const vehicle = await asApp(pg, async () => {
      const rows = await db.query<{ id: string; name: string }>(
        `insert into vehicles (name, capacity, active, owned_by_provider_id, operated_by_provider_id)
         values ('Coach', 12, true, $1::uuid, $1::uuid)
         returning id, name`,
        [provider[0]!.id],
      );
      return rows[0]!;
    });
    assert.equal(vehicle.name, "Coach");

    await asApp(pg, async () => {
      await db.query("update vehicles set name = 'Coach 2', capacity = 8, active = false where id = $1::uuid", [
        vehicle.id,
      ]);
      await expectDenied(() =>
        db.query("update vehicles set owned_by_provider_id = $1::uuid where id = $2::uuid", [
          other[0]!.id,
          vehicle.id,
        ]),
      );
      await expectDenied(() =>
        db.query(
          `insert into vehicles (name, capacity, active, owned_by_hotel_id, operated_by_provider_id)
           values ('Hotel Van', 4, true, $1::uuid, $2::uuid)`,
          [live.hotel.id, provider[0]!.id],
        ),
      );
    });

    // DATABASE LIMITATION (not solved by 0017): aether_app can INSERT another
    // provider's ownership UUID. HTTP does not accept that value from the DTO.
    const foreign = await asApp(pg, async () => {
      const rows = await db.query<{ owned: string }>(
        `insert into vehicles (name, capacity, active, owned_by_provider_id, operated_by_provider_id)
         values ('Foreign', 4, true, $1::uuid, $1::uuid)
         returning owned_by_provider_id::text as owned`,
        [other[0]!.id],
      );
      return rows[0]!.owned;
    });
    assert.equal(foreign, other[0]!.id);

    const driver = await asApp(pg, async () => {
      const rows = await db.query<{ id: string }>(
        `insert into drivers (name, active, employed_by_provider_id, dispatched_by_provider_id)
         values ('Kim', true, $1::uuid, $1::uuid) returning id`,
        [provider[0]!.id],
      );
      return rows[0]!;
    });
    await asApp(pg, async () => {
      await db.query("update drivers set name = 'Kim 2', active = false where id = $1::uuid", [
        driver.id,
      ]);
      await expectDenied(() =>
        db.query("update drivers set dispatched_by_provider_id = $1::uuid where id = $2::uuid", [
          other[0]!.id,
          driver.id,
        ]),
      );
    });
    await pg.close();
  });

  test("ensureOperatorFromEnv legacy writes, session lifecycle, membership mutation denied", async () => {
    const { db, pg } = await openDb();
    const live = await seedLive(db, "quay", "Europe/Athens");

    await asApp(pg, () =>
      ensureOperatorFromEnv(db, {
        AETHER_OPS_LOGIN: "desk",
        AETHER_OPS_PASSWORD: "desk-secret",
        VERCEL_ENV: "production",
      }),
    );
    const op = await db.query<{ id: string }>("select id from operators where login = 'desk'");
    assert.ok(op[0]);

    await asApp(pg, async () => {
      await expectDenied(() =>
        db.query(
          `insert into operator_memberships (operator_id, org_kind, hotel_id, access_class)
           values ($1::uuid, 'hotel', $2::uuid, 'hotel_desk')`,
          [op[0]!.id, live.hotel.id],
        ),
      );
    });

    await grantHotelDesk(db, op[0]!.id, live.hotel.id);

    const created = await asApp(pg, () =>
      createBooking(db, bookInput(live.hotel.code, live.destinations[0]!.id, {
        guestEmail: "desk@example.com",
      })),
    );
    const bookingId = (
      await db.query<{ id: string }>(
        "select id from bookings where confirmation_token = $1",
        [created.confirmationToken],
      )
    )[0]!.id;

    const cookies = memoryJar();
    const env: AuthEnv = {
      db,
      cookies,
      cookieSecure: false,
      production: true,
    };
    await asApp(pg, async () => {
      const logged = await loginOperator(env, "desk", "desk-secret");
      assert.equal(logged.login, "desk");
      const scope = await requireOps(env, { csrf: false });
      assert.equal(scope.accessClass, "hotel_desk");
      assert.equal(scope.hotelId, live.hotel.id);
      const seen = await getOpsBooking(db, scope, bookingId);
      assert.equal(seen.humanReference, created.humanReference);
      await cancelBooking(db, { bookingId, scope });
      env.headers = { get: (name) => (name === CSRF_HEADER ? cookies.get(CSRF_COOKIE) ?? null : null) };
      await logoutOperator(env);
      assert.equal(cookies.get(SESSION_COOKIE), undefined);
    });
    const cancelled = await db.query<{ empty: boolean }>(
      "select isempty(occupies) as empty from bookings where id = $1::uuid",
      [bookingId],
    );
    assert.equal(cancelled[0]!.empty, true);

    const attempts = await db.query<{ n: number }>(
      "select count(*)::int as n from login_attempts where login_key = 'desk'",
    );
    assert.ok((attempts[0]?.n ?? 0) >= 1);

    await asApp(pg, async () => {
      await expectDenied(() => db.query("delete from operators where login = 'desk'"));
      await expectDenied(() => db.query("update audit_events set action = 'x'"));
      await expectDenied(() => db.query("delete from audit_events"));
    });
    await pg.close();
  });

  test("preview aether_runtime identity is unchanged", async () => {
    const { pg } = await openDb();
    await pg.exec(`set role ${AETHER_RUNTIME_ROLE}`);
    const who = await pg.query<{ current_user: string }>("select current_user");
    assert.equal(who.rows[0]!.current_user, AETHER_RUNTIME_ROLE);
    await pg.exec("reset role");
    const previewInsert = await pg.query<{ ok: boolean }>(
      `select has_table_privilege($1, 'operator_memberships', 'INSERT') as ok`,
      [AETHER_RUNTIME_ROLE],
    );
    assert.equal(previewInsert.rows[0]!.ok, true);
    await pg.close();
  });
});
