/**
 * CP15 — hotel-scoped Ops Today identity.
 * No schema change. Occupancy, quote, timezone, and public booking stay as CP14.4.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createBooking, type BookingDb } from "./booking.ts";
import {
  InventoryError,
  assignDriver,
  assignVehicle,
  cancelBooking,
  setBookingStatus,
} from "./inventory.ts";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  createOperator,
  ensureOperatorFromEnv,
  loginOperator,
  requireOps,
  type AuthEnv,
  type CookieJar,
  type CookieOpts,
} from "./ops-auth.ts";
import {
  OpsDeskError,
  getOpsBooking,
  listOpsBookings,
  listOpsVehicles,
  loadTodayBoard,
} from "./ops-desk.ts";
import {
  grantHotelDesk,
  grantProviderDispatcher,
  type OpsScope,
} from "./tenancy.ts";
import { athensToday } from "./time.ts";
import { applyCp14LiveCatalog } from "./cp14-fixture.ts";

const CP15_SQL_KEY = Symbol.for("aether:cp15-sql");
const CP15_DB_STUB = new URL("./cp15-db-stub.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/db") {
      return { url: CP15_DB_STUB, shortCircuit: true };
    }
    if (
      context.parentURL?.includes("/src/lib/aether/") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[a-zA-Z0-9]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

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
] as const;

const IMMUTABLE = {
  "0003_occupancy.sql":
    "23f7fe21c0ca60e92bfb85e77235574bf2a923753180650af300a4bc7df05266",
  "0005_time_domain.sql":
    "ebd4753b2ce7c503417dafee856bfd292257d67c189af25239d41692d530cb10",
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
} as const;

const FAST = { N: 16, r: 8, p: 1 };

type StoredCookie = { value: string; options: CookieOpts };

function readMigration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readAether(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

function memoryJar(): CookieJar & { store: Map<string, StoredCookie> } {
  const store = new Map<string, StoredCookie>();
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

async function openDb() {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  try {
    await pg.exec("create database neondb");
  } catch {
    /* preview name may already exist */
  }
  for (const name of SQL_FILES) {
    await pg.exec(readMigration(name));
  }
  const destinations = await applyCp14LiveCatalog(pg);
  const db: BookingDb = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner: BookingDb = {
          query: async <R>(text: string, params?: unknown[]) => (await tx.query<R>(text, params)).rows,
          transaction: () => {
            throw new Error("nested");
          },
        };
        return fn(inner);
      });
    },
  };
  return { db, pg, destinations };
}

function envFor(db: BookingDb, jar: CookieJar): AuthEnv {
  return {
    db,
    cookies: jar,
    headers: {
      get: (name) => (name.toLowerCase() === "x-aether-csrf" ? jar.get("aether_ops_csrf") ?? null : null),
    },
    cookieSecure: false,
  };
}

async function loginHotelDesk(
  db: BookingDb,
  login: string,
  hotelId: string,
): Promise<OpsScope> {
  const operator = await createOperator(db, login, "correct-horse", FAST);
  await grantHotelDesk(db, operator.id, hotelId);
  const jar = memoryJar();
  // Same sequence as loginOperatorFromRequest: env bootstrap, then login, then requireOps.
  await ensureOperatorFromEnv(db, {
    AETHER_OPS_LOGIN: login,
    AETHER_OPS_PASSWORD: "correct-horse",
  });
  await loginOperator(envFor(db, jar), login, "correct-horse");
  return requireOps(envFor(db, jar), { csrf: true });
}

async function loginDispatcher(
  db: BookingDb,
  login: string,
  providerId: string,
): Promise<OpsScope> {
  const operator = await createOperator(db, login, "correct-horse", FAST);
  await grantProviderDispatcher(db, operator.id, providerId);
  const jar = memoryJar();
  await ensureOperatorFromEnv(db, {
    AETHER_OPS_LOGIN: login,
    AETHER_OPS_PASSWORD: "correct-horse",
  });
  await loginOperator(envFor(db, jar), login, "correct-horse");
  return requireOps(envFor(db, jar), { csrf: true });
}

function guestInput(
  hotelCode: string,
  destinationId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    hotelCode,
    destinationId,
    transferDate: "2026-03-10",
    pickupTime: "10:00",
    durationMinutes: 60,
    guestName: "Nikos",
    guestPhone: "+306900000001",
    guestEmail: `${hotelCode}@example.com`,
    passengerCount: 2,
    luggageCount: 1,
    pickupText: "Lobby",
    ...extra,
  };
}

async function bookingId(db: BookingDb, token: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    "select id from bookings where confirmation_token = $1",
    [token],
  );
  return rows[0]!.id;
}

function bindCp15Sql(db: BookingDb): () => void {
  const g = globalThis as Record<symbol, unknown>;
  const previous = g[CP15_SQL_KEY];
  g[CP15_SQL_KEY] = {
    query: <T>(text: string, params?: unknown[]) => db.query<T>(text, params),
  };
  return () => {
    if (previous === undefined) delete g[CP15_SQL_KEY];
    else g[CP15_SQL_KEY] = previous;
  };
}

function cookieHeaderFromSetCookie(setCookies: string[]): {
  cookie: string;
  csrf: string;
} {
  const pairs: string[] = [];
  let csrf = "";
  for (const line of setCookies) {
    const nv = line.split(";")[0]?.trim() ?? "";
    if (!nv.includes("=")) continue;
    pairs.push(nv);
    if (nv.startsWith(`${CSRF_COOKIE}=`)) {
      csrf = nv.slice(`${CSRF_COOKIE}=`.length);
    }
  }
  return { cookie: pairs.join("; "), csrf };
}

async function withOpsRequest<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<{ value: T; setCookies: string[] }> {
  const { requestHandler } = await import("@tanstack/react-start/server");
  let value: T | undefined;
  const handler = requestHandler(async () => {
    value = await fn();
    return new Response("ok");
  });
  const response = await handler(request, {});
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie") as string]
        : [];
  return { value: value as T, setCookies };
}

describe("CP15 hotel-scoped Ops Today", () => {
  test("0003–0015 remain byte-identical; CP15 adds no migration", () => {
    for (const [name, expected] of Object.entries(IMMUTABLE)) {
      assert.equal(sha256(readMigration(name)), expected, name);
    }
    assert.match(readMigration("0016_cp14_hotel_timezone.sql"), /aether_civil_instant/);
    const auth = readAether("./ops-auth.ts");
    assert.match(auth, /attachLegacyDispatcherIfUnaffiliated/);
    assert.match(auth, /isProductionOpsGuard\(env\)/);
    assert.match(auth, /from operator_memberships/);
    const adapter = readAether("./ops-auth.server.ts");
    assert.match(adapter, /await ensureOperatorFromEnv\(env\.db\)/);
    assert.match(adapter, /return loginOperator\(env, login, password\)/);
    const today = readAether("./ops-desk.ts");
    assert.match(today, /athensToday/);
    assert.match(today, /b\.hotel_id = \$IDX/);
    assert.match(today, /lower\(b\.occupies\) >= now\(\)/);
    assert.doesNotMatch(today, /aether_athens_instant\(b\.transfer_date/);
    const script = readFileSync(
      new URL("../../../scripts/provision-hotel.mjs", import.meta.url),
      "utf8",
    );
    assert.match(script, /grant-hotel-desk/);
    assert.match(script, /grantHotelDesk/);
    assert.match(script, /operator not found/);
    assert.doesNotMatch(script, /createOperator/);
    assert.doesNotMatch(script, /createServerFn/);
  });

  test("Hotel A hotel_desk session can load Hotel A Today", async () => {
    const { db, pg, destinations } = await openDb();
    const today = await athensToday(db);
    const hotels = await db.query<{ id: string; code: string }>("select id, code from hotels");
    const gate = hotels.find((h) => h.code === "gate")!;
    await createBooking(
      db,
      guestInput("gate", destinations.gate!, {
        transferDate: today,
        guestEmail: "a-today@example.com",
      }),
    );
    const desk = await loginHotelDesk(db, "gate-today", gate.id);
    const board = await loadTodayBoard(db, desk);
    assert.equal(board.boardDate, today);
    assert.ok(board.feed.length >= 1);
    assert.equal(board.feed.every((row) => row.hotelCode === "gate"), true);
    await pg.close();
  });

  test("Hotel A hotel_desk session cannot load Hotel B Today", async () => {
    const { db, pg, destinations } = await openDb();
    const today = await athensToday(db);
    const hotels = await db.query<{ id: string; code: string }>("select id, code from hotels");
    const gate = hotels.find((h) => h.code === "gate")!;
    await createBooking(
      db,
      guestInput("gate", destinations.gate!, {
        transferDate: today,
        guestEmail: "ga-today@example.com",
      }),
    );
    await createBooking(
      db,
      guestInput("harbor", destinations.harbor!, {
        transferDate: today,
        guestEmail: "hb-today@example.com",
        guestName: "Harbor Guest",
      }),
    );
    const deskA = await loginHotelDesk(db, "desk-a-today", gate.id);
    const board = await loadTodayBoard(db, deskA);
    assert.equal(board.feed.some((row) => row.hotelCode === "harbor"), false);
    assert.equal(board.feed.every((row) => row.hotelCode === "gate"), true);
    await pg.close();
  });

  test("Hotel B hotel_desk session cannot load Hotel A Today", async () => {
    const { db, pg, destinations } = await openDb();
    const today = await athensToday(db);
    const hotels = await db.query<{ id: string; code: string }>("select id, code from hotels");
    const harbor = hotels.find((h) => h.code === "harbor")!;
    await createBooking(
      db,
      guestInput("gate", destinations.gate!, {
        transferDate: today,
        guestEmail: "ga2-today@example.com",
      }),
    );
    await createBooking(
      db,
      guestInput("harbor", destinations.harbor!, {
        transferDate: today,
        guestEmail: "hb2-today@example.com",
        guestName: "Harbor Guest",
      }),
    );
    const deskB = await loginHotelDesk(db, "desk-b-today", harbor.id);
    const board = await loadTodayBoard(db, deskB);
    assert.equal(board.feed.some((row) => row.hotelCode === "gate"), false);
    assert.equal(board.feed.every((row) => row.hotelCode === "harbor"), true);
    await pg.close();
  });

  test("Hotel A desk cannot get Hotel B booking", async () => {
    const { db, pg, destinations } = await openDb();
    const hotels = await db.query<{ id: string; code: string }>("select id, code from hotels");
    const gate = hotels.find((h) => h.code === "gate")!;
    const harbor = await createBooking(
      db,
      guestInput("harbor", destinations.harbor!, { guestEmail: "hb-get@example.com" }),
    );
    const bId = await bookingId(db, harbor.confirmationToken);
    const deskA = await loginHotelDesk(db, "desk-a-get", gate.id);
    await assert.rejects(
      () => getOpsBooking(db, deskA, bId),
      (err: unknown) => err instanceof OpsDeskError && err.code === "not_found",
    );
    const listed = await listOpsBookings(db, deskA);
    assert.equal(listed.some((row) => row.id === bId), false);
    await pg.close();
  });

  test("Hotel A desk cannot cancel Hotel B booking", async () => {
    const { db, pg, destinations } = await openDb();
    const hotels = await db.query<{ id: string; code: string }>("select id, code from hotels");
    const gate = hotels.find((h) => h.code === "gate")!;
    const harbor = await createBooking(
      db,
      guestInput("harbor", destinations.harbor!, { guestEmail: "hb-cancel@example.com" }),
    );
    const bId = await bookingId(db, harbor.confirmationToken);
    const deskA = await loginHotelDesk(db, "desk-a-cancel", gate.id);
    await assert.rejects(
      () => cancelBooking(db, { bookingId: bId, scope: deskA }),
      (err: unknown) => err instanceof InventoryError && err.code === "not_found",
    );
    await pg.close();
  });

  test("Hotel A desk can cancel Hotel A booking", async () => {
    const { db, pg, destinations } = await openDb();
    const hotels = await db.query<{ id: string }>("select id from hotels where code = 'gate'");
    const gate = hotels[0]!;
    const created = await createBooking(
      db,
      guestInput("gate", destinations.gate!, { guestEmail: "ga-cancel@example.com" }),
    );
    const id = await bookingId(db, created.confirmationToken);
    const deskA = await loginHotelDesk(db, "desk-a-own-cancel", gate.id);
    const own = await getOpsBooking(db, deskA, id);
    assert.equal(own.id, id);
    assert.equal(own.hotelCode, "gate");
    const snap = await cancelBooking(db, { bookingId: id, scope: deskA });
    assert.equal(snap.cancelled, true);
    await pg.close();
  });

  test("hotel desk remains unable to assign vehicle/driver", async () => {
    const { db, pg, destinations } = await openDb();
    const hotels = await db.query<{ id: string; code: string }>("select id, code from hotels");
    const gate = hotels.find((h) => h.code === "gate")!;
    const created = await createBooking(
      db,
      guestInput("gate", destinations.gate!, { guestEmail: "assign@example.com" }),
    );
    const id = await bookingId(db, created.confirmationToken);
    const desk = await loginHotelDesk(db, "desk-assign", gate.id);
    const van = (await db.query<{ id: string }>("select id from vehicles limit 1"))[0]!;
    const driver = (await db.query<{ id: string }>("select id from drivers limit 1"))[0]!;
    await assert.rejects(
      () => assignVehicle(db, { bookingId: id, vehicleId: van.id, scope: desk }),
      (err: unknown) => err instanceof InventoryError && err.code === "forbidden",
    );
    await assert.rejects(
      () => assignDriver(db, { bookingId: id, driverId: driver.id, scope: desk }),
      (err: unknown) => err instanceof InventoryError && err.code === "forbidden",
    );
    await assert.rejects(
      () => setBookingStatus(db, { bookingId: id, status: "rolling", scope: desk }),
      (err: unknown) => err instanceof InventoryError && err.code === "forbidden",
    );
    await assert.rejects(
      () => listOpsVehicles(db, desk),
      (err: unknown) => err instanceof OpsDeskError && err.code === "forbidden",
    );
    await pg.close();
  });

  test("provider dispatcher retains provider-scoped Today visibility", async () => {
    const { db, pg, destinations } = await openDb();
    const today = await athensToday(db);
    await createBooking(
      db,
      guestInput("gate", destinations.gate!, {
        transferDate: today,
        guestEmail: "disp-a@example.com",
      }),
    );
    await createBooking(
      db,
      guestInput("harbor", destinations.harbor!, {
        transferDate: today,
        guestEmail: "disp-b@example.com",
        guestName: "Harbor Guest",
      }),
    );
    const legacy = (await db.query<{ id: string }>("select id from providers where code = 'legacy'"))[0]!;
    const dispatcher = await loginDispatcher(db, "legacy-today", legacy.id);
    const board = await loadTodayBoard(db, dispatcher);
    assert.ok(board.feed.some((row) => row.hotelCode === "gate"));
    assert.ok(board.feed.some((row) => row.hotelCode === "harbor"));
    await pg.close();
  });

  test("provider dispatcher retains assignment capability", async () => {
    const { db, pg, destinations } = await openDb();
    const created = await createBooking(
      db,
      guestInput("gate", destinations.gate!, { guestEmail: "disp-assign@example.com" }),
    );
    const id = await bookingId(db, created.confirmationToken);
    const legacy = (await db.query<{ id: string }>("select id from providers where code = 'legacy'"))[0]!;
    const dispatcher = await loginDispatcher(db, "legacy-assign", legacy.id);
    const van = (
      await db.query<{ id: string }>(
        "select id from vehicles where operated_by_provider_id = $1::uuid limit 1",
        [legacy.id],
      )
    )[0]!;
    const snap = await assignVehicle(db, { bookingId: id, vehicleId: van.id, scope: dispatcher });
    assert.equal(snap.vehicleId, van.id);
    await pg.close();
  });

  test("an operator with hotel_desk membership does NOT receive automatic legacy provider_dispatcher membership from ensureOperatorFromEnv", async () => {
    const { db, pg } = await openDb();
    const hotel = (await db.query<{ id: string }>("select id from hotels where code = 'gate'"))[0]!;
    const op = await createOperator(db, "gate-ops", "desk-secret", FAST);
    await grantHotelDesk(db, op.id, hotel.id);
    const before = await db.query<{ access_class: string; hotel_id: string | null }>(
      `select access_class, hotel_id
         from operator_memberships
        where operator_id = $1::uuid and active`,
      [op.id],
    );
    assert.equal(before.length, 1);
    assert.equal(before[0]!.access_class, "hotel_desk");
    await ensureOperatorFromEnv(db, {
      AETHER_OPS_LOGIN: "gate-ops",
      AETHER_OPS_PASSWORD: "desk-secret",
    });
    const hats = await db.query<{ n: number; access_class: string }>(
      `select count(*)::int as n, min(access_class) as access_class
         from operator_memberships
        where operator_id = $1::uuid and active`,
      [op.id],
    );
    assert.equal(hats[0]!.n, 1);
    assert.equal(hats[0]!.access_class, "hotel_desk");
    const jar = memoryJar();
    await ensureOperatorFromEnv(db, {
      AETHER_OPS_LOGIN: "gate-ops",
      AETHER_OPS_PASSWORD: "desk-secret",
    });
    await loginOperator(envFor(db, jar), "gate-ops", "desk-secret");
    const ctx = await requireOps(envFor(db, jar), { csrf: true });
    assert.equal(ctx.accessClass, "hotel_desk");
    assert.equal(ctx.hotelId, hotel.id);
    assert.equal(ctx.providerId, null);
    await pg.close();
  });

  test("loginOperatorFromRequest authenticates a hotel_desk env operator without adding a dispatcher hat", async () => {
    const { db, pg } = await openDb();
    const hotel = (await db.query<{ id: string }>("select id from hotels where code = 'gate'"))[0]!;
    const login = "quay-http";
    const password = "correct-horse";
    const op = await createOperator(db, login, password, FAST);
    await grantHotelDesk(db, op.id, hotel.id);
    const before = await db.query<{ access_class: string; hotel_id: string | null }>(
      `select access_class, hotel_id
         from operator_memberships
        where operator_id = $1::uuid and active`,
      [op.id],
    );
    assert.equal(before.length, 1);
    assert.equal(before[0]!.access_class, "hotel_desk");
    assert.equal(before[0]!.hotel_id, hotel.id);

    const unbind = bindCp15Sql(db);
    const prevLogin = process.env.AETHER_OPS_LOGIN;
    const prevPassword = process.env.AETHER_OPS_PASSWORD;
    process.env.AETHER_OPS_LOGIN = login;
    process.env.AETHER_OPS_PASSWORD = password;
    try {
      const { loginOperatorFromRequest, requireOps: requireOpsFromRequest } = await import(
        "./ops-auth.server.ts"
      );
      const loginRequest = new Request("http://localhost/ops/login", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      });
      const loggedIn = await withOpsRequest(loginRequest, () =>
        loginOperatorFromRequest(login, password),
      );
      assert.equal(loggedIn.value.login, login);
      assert.equal(loggedIn.value.operatorId, op.id);
      assert.ok(
        loggedIn.setCookies.some((line) => line.startsWith(`${SESSION_COOKIE}=`)),
        "session cookie must be issued by the adapter",
      );
      assert.ok(
        loggedIn.setCookies.some((line) => line.startsWith(`${CSRF_COOKIE}=`)),
        "csrf cookie must be issued by the adapter",
      );

      const after = await db.query<{ n: number; access_class: string }>(
        `select count(*)::int as n, min(access_class) as access_class
           from operator_memberships
          where operator_id = $1::uuid and active`,
        [op.id],
      );
      assert.equal(after[0]!.n, 1);
      assert.equal(after[0]!.access_class, "hotel_desk");

      const cookies = cookieHeaderFromSetCookie(loggedIn.setCookies);
      const authedRequest = new Request("http://localhost/ops", {
        method: "GET",
        headers: {
          cookie: cookies.cookie,
          [CSRF_HEADER]: cookies.csrf,
          "sec-fetch-site": "same-origin",
        },
      });
      const authed = await withOpsRequest(authedRequest, () =>
        requireOpsFromRequest({ csrf: true }),
      );
      assert.equal(authed.value.accessClass, "hotel_desk");
      assert.equal(authed.value.hotelId, hotel.id);
      assert.equal(authed.value.providerId, null);
    } finally {
      if (prevLogin === undefined) delete process.env.AETHER_OPS_LOGIN;
      else process.env.AETHER_OPS_LOGIN = prevLogin;
      if (prevPassword === undefined) delete process.env.AETHER_OPS_PASSWORD;
      else process.env.AETHER_OPS_PASSWORD = prevPassword;
      unbind();
      await pg.close();
    }
  });

  test("production ensureOperatorFromEnv does not auto-attach a dispatcher hat", async () => {
    const { db, pg } = await openDb();
    await ensureOperatorFromEnv(db, {
      NODE_ENV: "production",
      AETHER_OPS_LOGIN: "prod-hotel-ops",
      AETHER_OPS_PASSWORD: "a-real-production-pass",
    });
    const hats = await db.query<{ n: number }>(
      `select count(*)::int as n
         from operator_memberships
        where active
          and operator_id = (select id from operators where login = 'prod-hotel-ops')`,
    );
    assert.equal(hats[0]!.n, 0);
    await pg.close();
  });

  test("the legacy sandbox/preview path still works where it is supposed to", async () => {
    const { db, pg } = await openDb();
    await ensureOperatorFromEnv(db, {
      AETHER_OPS_LOGIN: "desk",
      AETHER_OPS_PASSWORD: "desk-pass",
    });
    const jar = memoryJar();
    await loginOperator(envFor(db, jar), "desk", "desk-pass");
    const ctx = await requireOps(envFor(db, jar), { csrf: false });
    assert.equal(ctx.accessClass, "provider_dispatcher");
    assert.equal(ctx.hotelId, null);
    assert.ok(ctx.providerId);
    await pg.close();
  });

  test("login produces exactly one active membership and correct session scope", async () => {
    const { db, pg } = await openDb();
    const hotel = (await db.query<{ id: string }>("select id from hotels where code = 'harbor'"))[0]!;
    const op = await createOperator(db, "harbor-desk", "harbor-pass", FAST);
    await grantHotelDesk(db, op.id, hotel.id);
    const jar = memoryJar();
    const result = await loginOperator(envFor(db, jar), "harbor-desk", "harbor-pass");
    assert.equal(result.login, "harbor-desk");
    const ctx = await requireOps(envFor(db, jar), { csrf: true });
    assert.equal(ctx.accessClass, "hotel_desk");
    assert.equal(ctx.hotelId, hotel.id);
    assert.equal(ctx.providerId, null);
    const hats = await db.query<{ n: number }>(
      `select count(*)::int as n from operator_memberships where operator_id = $1::uuid and active`,
      [op.id],
    );
    assert.equal(hats[0]!.n, 1);
    await pg.close();
  });

  test("forged client hotel_id cannot alter scope", () => {
    const fns = readAether("./ops-desk-fns.ts");
    const inventory = readAether("./inventory-fns.ts");
    const authFns = readAether("./ops-fns.ts");
    const today = readAether("./ops-desk.server.ts");
    assert.match(fns, /opsTodayBoard = createServerFn\(\{ method: "GET" \}\)\.handler/);
    assert.doesNotMatch(inventory, /hotelId|hotel_id|hotelCode/);
    const loginBlock = authFns.slice(
      authFns.indexOf("const loginInput"),
      authFns.indexOf("export const opsLogin"),
    );
    assert.doesNotMatch(loginBlock, /hotelId|hotel_id|membership/);
    assert.match(authFns, /hotelId: ops\.hotelId/);
    assert.match(today, /requireOps\(\{ csrf: false \}\)/);
    const login = readAether("./ops-auth.ts");
    assert.match(login, /membership_id/);
    assert.doesNotMatch(login, /cookies\.get\("hotel/);
  });

  test("public guest booking remains unchanged", async () => {
    const { db, pg, destinations } = await openDb();
    const created = await createBooking(
      db,
      guestInput("gate", destinations.gate!, { guestEmail: "guest-cp15@example.com" }),
    );
    assert.match(created.humanReference, /^PT-/);
    assert.ok(created.confirmationToken.length >= 32);
    assert.equal(created.hotelCode, "gate");
    assert.equal("vehicleId" in created, false);
    await pg.close();
  });

  test("confirmation token behaviour remains unchanged", async () => {
    const booking = readAether("./booking.ts");
    assert.match(booking, /confirmation_token = \$1/);
    assert.match(booking, /newConfirmationToken/);
    const confirmed = readFileSync(
      new URL("../../../src/routes/confirmed.$token.tsx", import.meta.url),
      "utf8",
    );
    assert.match(confirmed, /getPublicBooking/);
    assert.doesNotMatch(confirmed, /requireOps/);
  });

  test("CP14.4 hotel timezone / occupancy remains unchanged", () => {
    const occ = readAether("./occupancy.test.ts");
    assert.doesNotMatch(occ, /0016_cp14_hotel_timezone/);
    const time = readAether("./time.ts");
    assert.match(time, /aether_civil_instant/);
    const m16 = readMigration("0016_cp14_hotel_timezone.sql");
    assert.match(m16, /aether_civil_instant/);
    assert.doesNotMatch(m16, /drop trigger bookings_occupies_before/i);
    const today = readAether("./ops-desk.ts");
    assert.match(today, /athensToday/);
  });
});
