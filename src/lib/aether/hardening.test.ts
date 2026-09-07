/**
 * Phase 10 — production hardening.
 * Privilege split: aether_runtime may DML and must not own occupancy objects.
 * Neon two-credential verification is BLOCKED when DATABASE_URL is unset.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  createBooking,
  type BookingDb,
} from "./booking.ts";
import {
  InventoryError,
  assignVehicle,
  cancelBooking,
  unassignVehicle,
} from "./inventory.ts";
import { createOperator } from "./ops-auth.ts";
import { AETHER_DATABASE_OWNER_URL_ENV, AETHER_RUNTIME_ROLE } from "./runtime-role.ts";

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
] as const;

type Pg = PGlite;

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

async function openDb(): Promise<{ pg: Pg; db: BookingDb }> {
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

async function asRuntime<T>(pg: Pg, fn: () => Promise<T>): Promise<T> {
  await pg.exec(`set role ${AETHER_RUNTIME_ROLE}`);
  try {
    return await fn();
  } finally {
    await pg.exec("reset role");
  }
}

async function occupancyIntact(pg: Pg): Promise<void> {
  const trigger = await pg.query<{ tgenabled: string; tgname: string }>(
    `select tgname, tgenabled from pg_trigger
     where tgname = 'bookings_occupies_before' and not tgisinternal`,
  );
  assert.equal(trigger.rows.length, 1);
  assert.notEqual(trigger.rows[0]!.tgenabled, "D");

  const objects = await pg.query<{ n: number }>(`
    select count(*)::int as n from (
      select 1 from pg_proc where proname = 'aether_athens_instant'
      union all
      select 1 from pg_trigger where tgname = 'bookings_occupies_before' and not tgisinternal
      union all
      select 1 from pg_constraint where conname = 'bookings_vehicle_occupancy_excl'
      union all
      select 1 from pg_constraint where conname = 'bookings_driver_occupancy_excl'
      union all
      select 1 from pg_extension where extname = 'btree_gist'
    ) s
  `);
  assert.equal(objects.rows[0]!.n, 5);
}

function bookingInput(email: string, pickupTime = "09:00") {
  return {
    hotelCode: "gate",
    transferDate: "2026-01-15",
    pickupTime,
    durationMinutes: 60,
    guestName: "Ada Guest",
    guestPhone: "+302101234567",
    guestEmail: email,
    passengerCount: 2,
    luggageCount: 1,
    pickupText: "Gate Hotel",
    destinationText: "ATH airport",
  };
}

function readSrc(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

describe("Phase 10 production hardening", () => {
  test("0011 creates aether_runtime; occupancy objects remain owned by the migrator", async () => {
    const { pg } = await openDb();
    const who = await pg.query<{ current_user: string }>("select current_user");
    assert.equal(who.rows[0]!.current_user, "postgres");

    const role = await pg.query<{ rolsuper: boolean; rolcanlogin: boolean }>(
      `select rolsuper, rolcanlogin from pg_roles where rolname = $1`,
      [AETHER_RUNTIME_ROLE],
    );
    assert.equal(role.rows.length, 1);
    assert.equal(role.rows[0]!.rolsuper, false);
    assert.equal(role.rows[0]!.rolcanlogin, false);

    const meta = await pg.query<{ key: string; value: string }>(
      "select key, value from aether_meta",
    );
    const map = Object.fromEntries(meta.rows.map((row) => [row.key, row.value]));
    assert.equal(map.schema_phase, "10");
    assert.equal(map.checkpoint, "10");
    assert.equal(map.runtime_role, AETHER_RUNTIME_ROLE);
    assert.equal(map.db_owner, "postgres");

    const owners = await pg.query<{ kind: string; owner: string }>(`
      select 'table' as kind, pg_get_userbyid(relowner) as owner
      from pg_class where relname = 'bookings'
      union all
      select 'function', pg_get_userbyid(proowner)
      from pg_proc where proname = 'aether_athens_instant'
      union all
      select 'extension', pg_get_userbyid(extowner)
      from pg_extension where extname = 'btree_gist'
    `);
    for (const row of owners.rows) {
      assert.equal(row.owner, "postgres", `${row.kind} owner`);
    }
    await occupancyIntact(pg);
    await pg.close();
  });

  test("runtime role cannot ALTER, DROP, or DISABLE the occupancy trigger", async () => {
    const { pg } = await openDb();
    await asRuntime(pg, async () => {
      const who = await pg.query<{ current_user: string; super: string }>(
        "select current_user, current_setting('is_superuser') as super",
      );
      assert.equal(who.rows[0]!.current_user, AETHER_RUNTIME_ROLE);
      assert.equal(who.rows[0]!.super, "off");
      await expectCode(
        () => pg.exec("alter table bookings disable trigger bookings_occupies_before"),
        "42501",
      );
      await expectCode(
        () => pg.exec("alter table bookings disable trigger all"),
        "42501",
      );
      await expectCode(
        () => pg.exec("drop trigger bookings_occupies_before on bookings"),
        "42501",
      );
      await expectCode(
        () =>
          pg.exec(
            "alter table bookings replica identity using index bookings_pkey",
          ),
        "42501",
      );
    });
    await occupancyIntact(pg);
    await pg.close();
  });

  test("runtime role cannot DROP or ALTER occupancy EXCLUDE constraints", async () => {
    const { pg } = await openDb();
    await asRuntime(pg, async () => {
      await expectCode(
        () => pg.exec("alter table bookings drop constraint bookings_vehicle_occupancy_excl"),
        "42501",
      );
      await expectCode(
        () => pg.exec("alter table bookings drop constraint bookings_driver_occupancy_excl"),
        "42501",
      );
      await expectCode(
        () => pg.exec("alter table bookings add column hack text"),
        "42501",
      );
    });
    await occupancyIntact(pg);
    await pg.close();
  });

  test("runtime role cannot DROP or replace aether_athens_instant", async () => {
    const { pg } = await openDb();
    await asRuntime(pg, async () => {
      await expectCode(
        () => pg.exec("drop function aether_athens_instant(date, time)"),
        "42501",
      );
      await expectCode(
        () =>
          pg.exec(`
            create or replace function aether_athens_instant(p_date date, p_time time)
            returns timestamptz language sql as $f$ select now() $f$
          `),
        "42501",
      );
      await expectCode(
        () =>
          pg.exec("alter function aether_athens_instant(date, time) owner to aether_runtime"),
        "42501",
      );
    });
    const still = await pg.query<{ n: number }>(
      "select count(*)::int as n from pg_proc where proname = 'aether_athens_instant'",
    );
    assert.equal(still.rows[0]!.n, 1);
    await pg.close();
  });

  test("runtime role cannot CREATE or DROP required extensions", async () => {
    const { pg } = await openDb();
    await asRuntime(pg, async () => {
      await expectCode(() => pg.exec("drop extension btree_gist"), "42501");
      await expectCode(() => pg.exec("drop extension if exists btree_gist"), "42501");
      try {
        await pg.exec("create extension cube");
        assert.fail("create extension cube should not succeed");
      } catch (err) {
        const code = errCode(err);
        assert.ok(
          code === "42501" || code === "0A000",
          `create extension expected 42501 or 0A000, got ${code}: ${errMessage(err)}`,
        );
      }
    });
    const ext = await pg.query<{ extname: string }>(
      "select extname from pg_extension where extname = 'btree_gist'",
    );
    assert.equal(ext.rows.length, 1);
    const cube = await pg.query<{ n: number }>(
      "select count(*)::int as n from pg_extension where extname = 'cube'",
    );
    assert.equal(cube.rows[0]!.n, 0);
    await pg.close();
  });

  test("runtime role may DML; occupies trigger and 23P01 remain authority", async () => {
    const { pg, db } = await openDb();
    await asRuntime(pg, async () => {
      const who = await pg.query<{ current_user: string }>("select current_user");
      assert.equal(who.rows[0]!.current_user, AETHER_RUNTIME_ROLE);

      const created = await createBooking(db, bookingInput("ada@example.com"));
      const row = await pg.query<{ occupies: string; id: string }>(
        "select id, occupies::text as occupies from bookings where confirmation_token = $1",
        [created.confirmationToken],
      );
      assert.match(row.rows[0]!.occupies, /2026-01-15 07:00:00\+00/);
      assert.match(row.rows[0]!.occupies, /2026-01-15 08:00:00\+00/);

      const spoof = await pg.query<{ occupies: string }>(
        `insert into bookings (
           hotel_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, pickup_text, destination_text,
           human_reference, confirmation_token, occupies
         ) values (
           (select id from hotels where code = 'gate'),
           '2026-01-15', '11:00', 60,
           'Ben', '+1', 'ben@example.com', 'A', 'B',
           'PT-SPOOFTEST', 'spoof-token-hardening-aaaa',
           tstzrange('2020-01-01 00:00:00+00', '2020-01-01 01:00:00+00', '[)')
         ) returning occupies::text as occupies`,
      );
      assert.match(spoof.rows[0]!.occupies, /2026-01-15 09:00:00\+00/);
      assert.doesNotMatch(spoof.rows[0]!.occupies, /2020-01-01/);

      const operator = await createOperator(db, "desk", "desk-pass", {
        N: 16,
        r: 8,
        p: 1,
      });
      const vehicles = await pg.query<{ id: string }>(
        "select id from vehicles where active = true order by name limit 1",
      );
      const vehicleId = vehicles.rows[0]!.id;
      await assignVehicle(db, {
        bookingId: row.rows[0]!.id,
        vehicleId,
        operatorId: operator.id,
      });

      const other = await createBooking(
        db,
        bookingInput("other@example.com", "09:00"),
      );
      const otherId = await pg.query<{ id: string }>(
        "select id from bookings where confirmation_token = $1",
        [other.confirmationToken],
      );
      try {
        await assignVehicle(db, {
          bookingId: otherId.rows[0]!.id,
          vehicleId,
          operatorId: operator.id,
        });
        assert.fail("overlap must fail");
      } catch (err) {
        assert.ok(err instanceof InventoryError);
        assert.equal(err.code, "unavailable");
      }

      try {
        await pg.exec("insert into aether_meta (key, value) values ('hack', '1')");
        assert.fail("runtime must not write aether_meta");
      } catch (err) {
        assert.equal(errCode(err), "42501");
      }
    });
    await pg.close();
  });

  test("runtime cancellation and unassignment still release occupancy", async () => {
    const { pg, db } = await openDb();
    await asRuntime(pg, async () => {
      const operator = await createOperator(db, "desk", "desk-pass", {
        N: 16,
        r: 8,
        p: 1,
      });
      const vehicles = await pg.query<{ id: string }>(
        "select id from vehicles where active = true order by name limit 1",
      );
      const vehicleId = vehicles.rows[0]!.id;

      const first = await createBooking(db, bookingInput("one@example.com", "13:00"));
      const firstId = (
        await pg.query<{ id: string }>(
          "select id from bookings where confirmation_token = $1",
          [first.confirmationToken],
        )
      ).rows[0]!.id;
      await assignVehicle(db, {
        bookingId: firstId,
        vehicleId,
        operatorId: operator.id,
      });
      await unassignVehicle(db, { bookingId: firstId, operatorId: operator.id });

      const second = await createBooking(db, bookingInput("two@example.com", "13:00"));
      const secondId = (
        await pg.query<{ id: string }>(
          "select id from bookings where confirmation_token = $1",
          [second.confirmationToken],
        )
      ).rows[0]!.id;
      const assigned = await assignVehicle(db, {
        bookingId: secondId,
        vehicleId,
        operatorId: operator.id,
      });
      assert.equal(assigned.vehicleId, vehicleId);

      await cancelBooking(db, { bookingId: secondId, operatorId: operator.id });
      const empty = await pg.query<{ empty: boolean }>(
        "select isempty(occupies) as empty from bookings where id = $1",
        [secondId],
      );
      assert.equal(empty.rows[0]!.empty, true);

      const reused = await assignVehicle(db, {
        bookingId: firstId,
        vehicleId,
        operatorId: operator.id,
      });
      assert.equal(reused.vehicleId, vehicleId);
    });
    await pg.close();
  });

  test("table owner can disable the occupancy trigger — production DATABASE_URL must not be that owner", async () => {
    const { pg } = await openDb();
    const who = await pg.query<{ current_user: string }>("select current_user");
    assert.equal(who.rows[0]!.current_user, "postgres");
    await pg.exec("alter table bookings disable trigger bookings_occupies_before");
    const disabled = await pg.query<{ tgenabled: string }>(
      `select tgenabled from pg_trigger
       where tgname = 'bookings_occupies_before' and not tgisinternal`,
    );
    assert.equal(disabled.rows[0]!.tgenabled, "D");
    await pg.exec("alter table bookings enable trigger bookings_occupies_before");
    await occupancyIntact(pg);
    await pg.close();
  });

  test("cookie, CSRF, throttle, revocation, and token entropy remain encoded", () => {
    const auth = readSrc("./ops-auth.ts");
    assert.match(auth, /cookieBase\(env, true\)/);
    assert.match(auth, /cookieBase\(env, false\)/);
    assert.match(auth, /sameSite: "lax"/);
    assert.match(auth, /secure: Boolean\(env.cookieSecure\)/);
    assert.match(auth, /THROTTLE_MAX_FAILURES = 5/);
    assert.match(auth, /revoked_at/);
    assert.match(auth, /randomBytes\(32\)/);
    assert.match(auth, /hashToken/);
    assert.doesNotMatch(auth, /localStorage|sessionStorage/);

    const adapter = readSrc("./ops-auth.server.ts");
    assert.match(adapter, /NODE_ENV === "production"\) return true/);
    assert.match(adapter, /assertOpsRequestOrigin/);
    assert.match(adapter, /sec-fetch-site/);

    const csrf = readSrc("./csrf-client.ts");
    assert.match(csrf, /aether_ops_csrf/);
    assert.match(csrf, /x-aether-csrf/);
    assert.doesNotMatch(csrf, /^\s*import /m);

    const booking = readSrc("./booking.ts");
    assert.match(booking, /randomBytes\(32\)\.toString\("base64url"\)/);
    assert.match(booking, /confirmation_token/);
    assert.doesNotMatch(
      booking.slice(booking.indexOf("insert into bookings"), booking.indexOf("returning id")),
      /occupies|vehicle_id|driver_id/,
    );
  });

  test("public DTO, guest isolation, secrets, and migration ownership stay hardened", () => {
    const guestBook = readSrc("../../components/aether/guest-book.tsx");
    const bookRoute = readSrc("../../routes/book.$hotelCode.tsx");
    const confirmed = readSrc("../../routes/confirmed.$token.tsx");
    assert.doesNotMatch(guestBook, /requireOps|ops-desk|internalNotes/);
    assert.doesNotMatch(bookRoute, /requireOps|ops-desk/);
    assert.doesNotMatch(confirmed, /requireOps|internalNotes|occupies/);

    const dto = readSrc("./booking.ts");
    assert.match(dto, /export type PublicBooking/);
    assert.doesNotMatch(
      dto.slice(dto.indexOf("export type PublicBooking"), dto.indexOf("type Validated")),
      /occupies|vehicleId|driverId|internalNotes|status/,
    );

    const dbSrc = readSrc("../../lib/db.ts");
    assert.match(dbSrc, /set role aether_runtime/);
    assert.match(dbSrc, /reset role/);
    assert.match(dbSrc, /pgRuntimeRoleOptions/);
    assert.doesNotMatch(dbSrc, /AETHER_DATABASE_OWNER_URL/);

    const kysely = readSrc("./kysely.ts");
    assert.match(kysely, /pgRuntimeRoleOptions/);

    const migrate = readFileSync(new URL("../../../scripts/migrate.mjs", import.meta.url), "utf8");
    assert.match(migrate, /AETHER_DATABASE_OWNER_URL/);
    assert.match(migrate, /ownerUrl/);
    assert.doesNotMatch(migrate, /set role aether_runtime/);

    const occupancy = readFileSync(
      new URL("../../../migrations/0003_occupancy.sql", import.meta.url),
      "utf8",
    );
    assert.match(occupancy, /bookings_occupies_before/);
    assert.match(occupancy, /aether_athens_instant/);
    const hardening = readFileSync(
      new URL("../../../migrations/0011_production_hardening.sql", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(hardening, /drop trigger|drop function aether_athens|drop constraint bookings_/i);
    assert.match(hardening, /create role aether_runtime/);

    assert.equal(existsSync(new URL("../../../.env", import.meta.url).pathname), false);
    assert.equal(existsSync(new URL("../../../.env.local", import.meta.url).pathname), false);

    const srcRoot = new URL("../../", import.meta.url);
    const queue = [srcRoot.pathname];
    const secretHits: string[] = [];
    while (queue.length) {
      const dir = queue.pop()!;
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}${name.name}`;
        if (name.isDirectory()) {
          if (name.name === "node_modules") continue;
          queue.push(`${full}/`);
          continue;
        }
        if (!/\.(ts|tsx|mjs|js|sql|sh|json)$/.test(name.name)) continue;
        const text = readFileSync(full, "utf8");
        if (/postgres:\/\/[^:]+:[^@]+@/.test(text)) secretHits.push(full);
        if (/AETHER_OPS_PASSWORD\s*=\s*["'](?!\$\{)[^"']+["']/.test(text) && !full.endsWith("startup.sh")) {
          secretHits.push(full);
        }
      }
    }
    assert.deepEqual(secretHits, []);
  });

  test("Neon production-role split is BLOCKED when DATABASE_URL is unset", () => {
    assert.equal(process.env.DATABASE_URL || "", "");
    assert.equal(process.env[AETHER_DATABASE_OWNER_URL_ENV] || "", "");
    assert.equal(
      process.env.AETHER_DATABASE_OWNER_URL || "",
      "",
      "owner URL must not be present in this preview",
    );
  });
});
