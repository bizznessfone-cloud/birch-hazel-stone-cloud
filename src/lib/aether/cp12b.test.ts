/**
 * CP12B — pre-Vercel production hardening.
 * Occupancy SQL is not rewritten here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  BookingError,
  createBooking,
  getPublicBookingByToken,
  type BookingDb,
} from "./booking.ts";
import {
  GUEST_CREATE_LIMIT,
  assertGuestCreateRateLimit,
  hashGuestClientKey,
} from "./guest-rate-limit.ts";
import {
  assertProductionDatabaseUrl,
  isBundlingProcess,
  isProductionRuntime,
  neonPoolSettings,
} from "./runtime-config.ts";
import { AETHER_RUNTIME_ROLE } from "./runtime-role.ts";

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
] as const;

async function openDb(): Promise<{ pg: PGlite; db: BookingDb }> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  for (const name of SQL_FILES) {
    await pg.exec(
      readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"),
    );
  }
  const db: BookingDb = {
    query: async <T>(text: string, params?: unknown[]) =>
      (await pg.query<T>(text, params)).rows,
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner: BookingDb = {
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
  return { pg, db };
}

describe("CP12B production hardening", () => {
  test("production without DATABASE_URL fails closed; preview and build do not", () => {
    assert.throws(
      () => assertProductionDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: "" }),
      /DATABASE_URL/,
    );
    assert.throws(
      () =>
        assertProductionDatabaseUrl({
          AETHER_RESTORE_TARGET: "production",
        }),
      /DATABASE_URL/,
    );
    assert.doesNotThrow(() =>
      assertProductionDatabaseUrl({ NODE_ENV: "development" }),
    );
    assert.doesNotThrow(() =>
      assertProductionDatabaseUrl({
        NODE_ENV: "production",
        npm_lifecycle_event: "build",
      }),
    );
    assert.doesNotThrow(() =>
      assertProductionDatabaseUrl({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://localhost/aether",
      }),
    );
    assert.equal(
      isProductionRuntime({ NODE_ENV: "production", npm_lifecycle_event: "build" }),
      false,
    );
    assert.equal(isBundlingProcess({ npm_lifecycle_event: "build" }), true);
    const dbSrc = readFileSync(new URL("../../lib/db.ts", import.meta.url), "utf8");
    assert.match(dbSrc, /assertProductionDatabaseUrl/);
    assert.doesNotMatch(dbSrc, /dbSource === "pglite"/);
    assert.doesNotMatch(dbSrc, /options:\s*pgRuntimeRoleOptions|options:\s*`-c role=/);
  });

  test("0013 makes aether_runtime LOGIN; occupancy objects stay owner-owned", async () => {
    const { pg } = await openDb();
    const role = await pg.query<{ rolcanlogin: boolean; rolsuper: boolean }>(
      `select rolcanlogin, rolsuper from pg_roles where rolname = $1`,
      [AETHER_RUNTIME_ROLE],
    );
    assert.equal(role.rows[0]!.rolcanlogin, true);
    assert.equal(role.rows[0]!.rolsuper, false);

    const meta = await pg.query<{ key: string; value: string }>(
      "select key, value from aether_meta",
    );
    const map = Object.fromEntries(meta.rows.map((row) => [row.key, row.value]));
    assert.equal(map.schema_phase, "12");
    assert.equal(map.checkpoint, "12b");
    assert.equal(map.runtime_login, AETHER_RUNTIME_ROLE);

    const owners = await pg.query<{ owner: string }>(`
      select pg_get_userbyid(relowner) as owner from pg_class where relname = 'bookings'
    `);
    assert.equal(owners.rows[0]!.owner, "postgres");
    assert.notEqual(owners.rows[0]!.owner, AETHER_RUNTIME_ROLE);

    const m13 = readFileSync(
      new URL("../../../migrations/0013_cp12b_runtime_login.sql", import.meta.url),
      "utf8",
    );
    assert.match(m13, /alter role aether_runtime/i);
    assert.match(m13, /login/i);
    assert.doesNotMatch(m13, /password\s+'|identified by/i);
    assert.doesNotMatch(m13, /drop trigger|drop function aether_athens|drop constraint bookings_/i);

    const m11 = readFileSync(
      new URL("../../../migrations/0011_production_hardening.sql", import.meta.url),
      "utf8",
    );
    assert.match(m11, /nologin/);
    await pg.close();
  });

  test("CP12 tenancy objects exist after 0012+0013", async () => {
    const { pg } = await openDb();
    const tables = await pg.query<{ n: number }>(`
      select count(*)::int as n from information_schema.tables
       where table_name in ('providers', 'hotel_provider_agreements', 'operator_memberships', 'public_booking_attempts')
    `);
    assert.equal(tables.rows[0]!.n, 4);
    await pg.close();
  });

  test("valid public booking still works; lookup DTO omits PII and token", async () => {
    const { db, pg } = await openDb();
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
      pickupText: "Gate Hotel",
      destinationText: "ATH airport",
      specialRequirements: "window seat",
      idempotencyKey: "cp12b-key",
    });
    assert.ok(created.confirmationToken.length >= 40);
    assert.equal("guestPhone" in created, false);
    assert.equal("guestEmail" in created, false);
    assert.equal("specialRequirements" in created, false);

    const again = await createBooking(db, {
      hotelCode: "gate",
      transferDate: "2026-01-15",
      pickupTime: "09:00",
      durationMinutes: 60,
      guestName: "Ada Guest",
      guestPhone: "+302101234567",
      guestEmail: "ada@example.com",
      passengerCount: 2,
      luggageCount: 1,
      pickupText: "Gate Hotel",
      destinationText: "ATH airport",
      specialRequirements: "window seat",
      idempotencyKey: "cp12b-key",
    });
    assert.equal(again.confirmationToken, created.confirmationToken);

    const found = await getPublicBookingByToken(db, created.confirmationToken);
    assert.equal(found.guestName, "Ada Guest");
    assert.equal("confirmationToken" in found, false);
    assert.equal("guestPhone" in found, false);
    assert.equal("guestEmail" in found, false);
    assert.equal("specialRequirements" in found, false);
    const json = JSON.stringify(found);
    assert.doesNotMatch(json, /\+302101234567|ada@example.com|window seat/);
    await pg.close();
  });

  test("guest create rate limit trips then fail-opens without the table", async () => {
    const { db, pg } = await openDb();
    const key = hashGuestClientKey("203.0.113.10");
    const t0 = new Date("2026-06-01T12:00:00.000Z");
    for (let i = 0; i < GUEST_CREATE_LIMIT; i += 1) {
      await assertGuestCreateRateLimit(db, key, new Date(t0.getTime() + i * 1000));
    }
    await assert.rejects(
      () =>
        assertGuestCreateRateLimit(
          db,
          key,
          new Date(t0.getTime() + GUEST_CREATE_LIMIT * 1000),
        ),
      (err: unknown) => err instanceof BookingError && err.code === "rate_limited",
    );

    const other = hashGuestClientKey("203.0.113.11");
    await assertGuestCreateRateLimit(db, other, t0);

    await pg.exec("drop table public_booking_attempts");
    await assertGuestCreateRateLimit(db, key, new Date(t0.getTime() + 60_000));
    await pg.close();
  });

  test("serverless pool is shared and capped; verifier does not SET ROLE", () => {
    const settings = neonPoolSettings();
    assert.equal(settings.max, 2);
    assert.ok(settings.idleTimeoutMillis <= 10_000);
    assert.ok(settings.connectionTimeoutMillis <= 8_000);

    const dbSrc = readFileSync(new URL("../../lib/db.ts", import.meta.url), "utf8");
    assert.match(dbSrc, /getPgPool/);
    assert.match(dbSrc, /neonPoolSettings/);
    assert.doesNotMatch(dbSrc, /options:\s*\{/);

    const kysely = readFileSync(new URL("./kysely.ts", import.meta.url), "utf8");
    assert.match(kysely, /getPgPool/);
    assert.doesNotMatch(kysely, /new pg\.default\.Pool/);

    const verifier = readFileSync(
      new URL("../../../scripts/verify-neon-production.mjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(verifier, /-c role=/);
    assert.match(verifier, /c\.relowner/);
    assert.match(verifier, /session_user/);
    assert.match(verifier, /rolcanlogin/);

    const migrate = readFileSync(
      new URL("../../../scripts/migrate.mjs", import.meta.url),
      "utf8",
    );
    assert.match(migrate, /resolveMigratePlan/);
    assert.doesNotMatch(migrate, /DATABASE_URL \|\|/);
    assert.doesNotMatch(migrate, /AETHER_DATABASE_OWNER_URL \|\| DATABASE_URL/);
  });
});
