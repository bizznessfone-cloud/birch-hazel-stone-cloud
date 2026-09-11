/**
 * CP14.1 — hotel configuration schema only.
 * Does not convert timezone, quote in application code, or change occupancy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AETHER_APP_ROLE } from "./runtime-role.ts";

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
} as const;

function readMigration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.equal(
      errCode(err),
      code,
      `expected ${code}, got ${errCode(err)}: ${errMessage(err)}`,
    );
    return;
  }
  assert.fail(`expected SQLSTATE ${code}`);
}

async function openDb(): Promise<PGlite> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  try {
    await pg.exec("create database neondb");
  } catch {
    /* preview name may already exist */
  }
  await pg.exec(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  for (const name of SQL_FILES) {
    await pg.exec(readMigration(name));
  }
  return pg;
}

describe("CP14.1 hotel configuration schema", () => {
  test("0011–0014 remain byte-identical; 0015 does not rewrite occupancy", () => {
    for (const [name, expected] of Object.entries(IMMUTABLE)) {
      assert.equal(sha256(readMigration(name)), expected, name);
    }
    const m15 = readMigration("0015_cp14_hotel_configuration.sql");
    assert.doesNotMatch(m15, /drop trigger bookings_occupies_before/i);
    assert.doesNotMatch(m15, /drop function aether_athens/i);
    assert.doesNotMatch(m15, /drop constraint bookings_vehicle_occupancy_excl/i);
    assert.doesNotMatch(m15, /drop constraint bookings_driver_occupancy_excl/i);
    assert.doesNotMatch(m15, /aether_civil_instant/);
    assert.doesNotMatch(m15, /create table tenants/i);
    assert.doesNotMatch(m15, /enable row level security/i);
    assert.doesNotMatch(m15, /alter table _migrations/i);
  });

  test("existing hotels migrate unconfigured with Athens/EUR defaults", async () => {
    const pg = await openDb();
    const hotels = await pg.query<{
      code: string;
      locality: string;
      iana_timezone: string;
      currency: string;
      status: string;
    }>(
      `select code, locality, btrim(iana_timezone) as iana_timezone,
              btrim(currency) as currency, status
         from hotels
        order by code`,
    );
    assert.ok(hotels.rows.length >= 2);
    for (const row of hotels.rows) {
      assert.equal(row.status, "unconfigured", row.code);
      assert.equal(row.iana_timezone, "Europe/Athens", row.code);
      assert.equal(row.currency, "EUR", row.code);
      assert.ok(row.locality.trim().length > 0, row.code);
    }
    const gate = hotels.rows.find((row) => row.code === "gate");
    assert.ok(gate);
    assert.equal(gate.locality, "Gate Hotel");

    const meta = await pg.query<{ key: string; value: string }>(
      "select key, value from aether_meta",
    );
    const map = Object.fromEntries(meta.rows.map((row) => [row.key, row.value]));
    assert.equal(map.schema_phase, "14");
    assert.equal(map.checkpoint, "14.1");

    await expectCode(
      () => pg.exec("update hotels set status = 'ready' where code = 'gate'"),
      "23514",
    );
    await pg.close();
  });

  test("destinations are hotel-scoped; invalid kind and negative amount rejected", async () => {
    const pg = await openDb();
    const hotel = await pg.query<{ id: string }>(
      "select id from hotels where code = 'gate'",
    );
    const hotelId = hotel.rows[0]!.id;

    const dest = await pg.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, sort_order, amount_minor)
       values ($1::uuid, 'airport', 'ATH', 10, 4500)
       returning id`,
      [hotelId],
    );
    assert.ok(dest.rows[0]?.id);

    for (const kind of ["airport", "port", "hotel", "other"] as const) {
      const rows = await pg.query<{ id: string }>(
        `insert into hotel_destinations (hotel_id, kind, name, amount_minor)
         values ($1::uuid, $2, $3, 0)
         returning id`,
        [hotelId, kind, `Kind ${kind}`],
      );
      assert.ok(rows.rows[0]?.id);
    }

    await expectCode(
      () =>
        pg.query(
          `insert into hotel_destinations (hotel_id, kind, name, amount_minor)
           values ($1::uuid, 'station', 'Rail', 100)`,
          [hotelId],
        ),
      "23514",
    );
    await expectCode(
      () =>
        pg.query(
          `insert into hotel_destinations (hotel_id, kind, name, amount_minor)
           values ($1::uuid, 'airport', 'Neg', -1)`,
          [hotelId],
        ),
      "23514",
    );
    await pg.close();
  });

  test("booking destination must belong to the same hotel; quoted snapshot stored and immutable", async () => {
    const pg = await openDb();
    const hotels = await pg.query<{ id: string; code: string }>(
      "select id, code from hotels where code in ('gate', 'harbor')",
    );
    const gate = hotels.rows.find((row) => row.code === "gate")!.id;
    const harbor = hotels.rows.find((row) => row.code === "harbor")!.id;
    const provider = await pg.query<{ provider_id: string }>(
      `select provider_id from hotel_provider_agreements
        where hotel_id = $1::uuid and active`,
      [gate],
    );
    const destGate = await pg.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, amount_minor)
       values ($1::uuid, 'airport', 'ATH Terminal', 5500)
       returning id`,
      [gate],
    );
    const destHarbor = await pg.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, amount_minor)
       values ($1::uuid, 'port', 'Piraeus', 3000)
       returning id`,
      [harbor],
    );
    const gateDest = destGate.rows[0]!.id;
    const harborDest = destHarbor.rows[0]!.id;

    const booking = await pg.query<{
      id: string;
      destination_id: string;
      quoted_amount_minor: number;
      quoted_currency: string;
      occupies: string;
    }>(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email,
         pickup_text, destination_text,
         human_reference, confirmation_token,
         destination_id, quoted_amount_minor, quoted_currency
       ) values (
         $1::uuid, $2::uuid, '2026-05-20', '09:00', 60,
         'Guest', '+306900000001', 'guest@example.com',
         'Gate Hotel', 'ATH Terminal',
         'PT-CFGTEST01', 'tok-cfg-1',
         $3::uuid, 5500, 'EUR'
       )
       returning id, destination_id, quoted_amount_minor, btrim(quoted_currency) as quoted_currency,
                 occupies::text as occupies`,
      [gate, provider.rows[0]!.provider_id, gateDest],
    );
    const row = booking.rows[0]!;
    assert.equal(row.destination_id, gateDest);
    assert.equal(Number(row.quoted_amount_minor), 5500);
    assert.equal(row.quoted_currency, "EUR");
    assert.notEqual(row.occupies, "empty");

    await expectCode(
      () =>
        pg.query(
          `insert into bookings (
             hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
             guest_name, guest_phone, guest_email,
             pickup_text, destination_text,
             human_reference, confirmation_token,
             destination_id, quoted_amount_minor, quoted_currency
           ) values (
             $1::uuid, $2::uuid, '2026-05-21', '10:00', 60,
             'Guest', '+306900000002', 'guest2@example.com',
             'Gate Hotel', 'Piraeus',
             'PT-CFGTEST02', 'tok-cfg-2',
             $3::uuid, 3000, 'EUR'
           )`,
          [gate, provider.rows[0]!.provider_id, harborDest],
        ),
      "23503",
    );

    await expectCode(
      () =>
        pg.query("update bookings set quoted_amount_minor = 1 where id = $1::uuid", [
          row.id,
        ]),
      "27000",
    );
    await expectCode(
      () => pg.query("update bookings set quoted_currency = 'USD' where id = $1::uuid", [row.id]),
      "27000",
    );
    await expectCode(
      () =>
        pg.query("update bookings set destination_id = $1::uuid where id = $2::uuid", [
          harborDest,
          row.id,
        ]),
      "27000",
    );

    const updated = await pg.query<{ status: string; occupies: string }>(
      `update bookings
          set status = 'assigned', internal_notes = 'ops'
        where id = $1::uuid
        returning status, occupies::text as occupies`,
      [row.id],
    );
    assert.equal(updated.rows[0]!.status, "assigned");
    assert.notEqual(updated.rows[0]!.occupies, "empty");

    const cancelled = await pg.query<{ occupies: string }>(
      `update bookings
          set cancelled_at = now()
        where id = $1::uuid
        returning occupies::text as occupies`,
      [row.id],
    );
    assert.match(cancelled.rows[0]!.occupies, /empty/i);

    const trigger = await pg.query<{ n: number }>(
      `select count(*)::int as n from pg_trigger
        where tgname = 'bookings_occupies_before' and not tgisinternal`,
    );
    assert.equal(trigger.rows[0]!.n, 1);

    const ledger = await pg.query<{ ok: boolean }>(
      `select has_table_privilege($1, '_migrations', 'SELECT') as ok`,
      [AETHER_APP_ROLE],
    );
    assert.equal(ledger.rows[0]!.ok, false);
    const destPriv = await pg.query<{ ok: boolean }>(
      `select has_table_privilege($1, 'hotel_destinations', 'INSERT') as ok`,
      [AETHER_APP_ROLE],
    );
    assert.equal(destPriv.rows[0]!.ok, true);
    await pg.close();
  });
});
