/**
 * Phase 9 — full Blueprint v2 test reconstruction.
 * These are current-rebuild tests. Historical "120 passed" is not coverage.
 * Neon concurrency is not verified in this environment (DATABASE_URL unset).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  createBooking,
  getPublicBookingByToken,
  newConfirmationToken,
  type BookingDb,
  type CreatedBooking,
  type PublicBooking,
} from "./booking.ts";
import {
  applyDirection,
  emptyDraft,
  touristMessage,
} from "./guest.ts";
import {
  InventoryError,
  assignDriver,
  assignVehicle,
  cancelBooking,
  setBookingStatus,
  unassignVehicle,
} from "./inventory.ts";
import { createOperator } from "./ops-auth.ts";
import { legacyDispatcherScope } from "./tenancy.ts";
import {
  getOpsBooking,
  listOpsAudit,
  listOpsBookings,
  listOpsDrivers,
  listOpsHotels,
  listOpsVehicles,
  upsertDriver,
} from "./ops-desk.ts";
import { applyCp14LiveCatalog } from "./cp14-fixture.ts";

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
] as const;

const PUBLIC_DTO_KEYS = [
  "cancelled",
  "destinationId",
  "destinationText",
  "durationMinutes",
  "guestName",
  "hotelCode",
  "hotelName",
  "humanReference",
  "luggageCount",
  "passengerCount",
  "pickupText",
  "pickupTime",
  "pricing",
  "transferDate",
] as const;

const CREATED_DTO_KEYS = [...PUBLIC_DTO_KEYS, "confirmationToken"] as const;

/** Current-rebuild registry. Titles must exist as test("…") in the named file. */
const MATRIX: Array<{ file: string; titles: string[] }> = [
  {
    file: "time.test.ts",
    titles: [
      "winter conversion 09:00 → 07:00Z",
      "summer conversion 09:00 → 06:00Z",
      "spring DST gap rejects",
      "autumn DST fold rejects",
      "24:00 rejects",
      "midnight crossing uses elapsed minutes, not the next civil date as pickup",
      "duration 1 and 1440 succeed; 0 and >1440 reject",
      "DST-crossing elapsed duration is minutes on the timestamptz axis",
      "session TimeZone does not change Athens instant or business date",
    ],
  },
  {
    file: "time-process-tz.test.ts",
    titles: ["Pacific/Auckland process TZ does not change Athens instants"],
  },
  {
    file: "occupancy.test.ts",
    titles: [
      "valid Athens winter time persists as absolute instant",
      "valid Athens summer time persists as absolute instant",
      "spring DST gap rejects: time does not exist",
      "autumn DST fold rejects: time is ambiguous",
      "24:00 rejects",
      "duration 0 rejects",
      "duration >1440 rejects",
      "[) adjacency succeeds; one-minute overlap fails with 23P01",
      "vehicle EXCLUDE works independently of driver",
      "driver EXCLUDE works independently of vehicle",
      "vehicle-only and driver-only bookings occupy independently",
      "cancellation releases occupancy",
      "unassignment releases the unassigned resource",
    ],
  },
  {
    file: "booking.test.ts",
    titles: [
      "unknown hotel is rejected",
      "valid booking persists with PT- reference and high-entropy token",
      "Athens civil-time validation uses the existing time domain",
      "duration 0 and >1440 reject; passenger/luggage/contact/location reject",
      "public lookup is token-only; reference-only lookup fails",
      "idempotent create returns the same booking and does not duplicate",
      "two creates without a key are distinct; tokens unique",
      "public functions stay unauthenticated and omit assignment/payment",
    ],
  },
  {
    file: "inventory.test.ts",
    titles: [
      "vehicle and driver assign/unassign independently",
      "inactive or missing resources are rejected",
      "vehicle overlap is unavailable; [) adjacency is allowed",
      "driver overlap is independent of vehicle",
      "cancellation releases occupancy so the resource can be reused",
      "unassignment releases only the unassigned resource",
      "PGLite (not Neon): overlapping assign rolls back; EXCLUDE remains authority",
    ],
  },
  {
    file: "ops-auth.test.ts",
    titles: [
      "unauthenticated requireOps fails",
      "login sets HttpOnly session cookie and non-HttpOnly CSRF cookie",
      "authenticated ops mutation succeeds; CSRF is required",
      "logout revokes the session",
      "login throttling locks after too many failures",
      "ops-fns never return a session token and public health stays open",
      "preview desk/desk-pass cannot seed or login in production",
      "ensureOperatorFromEnv does not attach legacy dispatcher to a hotel_desk operator",
      "ensureOperatorFromEnv still grants legacy dispatcher to an unaffiliated operator",
      "ensureOperatorFromEnv does not attach legacy dispatcher to an unaffiliated production operator",
    ],
  },
  {
    file: "guest.test.ts",
    titles: [
      "seeded hotel is public; unknown hotel does not leak other hotels",
      "token lookup works and reference-only lookup fails",
      "guest routes stay public and do not include ops controls",
    ],
  },
  {
    file: "ops-desk.test.ts",
    titles: [
      "Today board is Athens date, chronological, with attention flags",
      "Today board reflects assignment and cancellation",
      "ops desk HTTP is privileged; guest UI does not import it",
    ],
  },
  {
    file: "hotel.test.ts",
    titles: [
      "valid hotel code resolves with generated HotelMark and QR-ready path",
      "booking is attributed to the hotel from the booking code",
      "unknown hotel remains non-disclosing",
      "two hotel codes remain isolated at booking-attribution level",
      "guest UI stays monochrome, public, and free of ops controls",
    ],
  },
  {
    file: "hardening.test.ts",
    titles: [
      "0011 creates aether_runtime; occupancy objects remain owned by the migrator",
      "runtime role cannot ALTER, DROP, or DISABLE the occupancy trigger",
      "runtime role cannot DROP or ALTER occupancy EXCLUDE constraints",
      "runtime role cannot DROP or replace aether_athens_instant",
      "runtime role cannot CREATE or DROP required extensions",
      "runtime role may DML; occupies trigger and 23P01 remain authority",
      "runtime cancellation and unassignment still release occupancy",
      "table owner can disable the occupancy trigger — production DATABASE_URL must not be that owner",
      "Neon production-role split is BLOCKED when DATABASE_URL is unset",
    ],
  },
  {
    file: "cp12b.test.ts",
    titles: [
      "production without DATABASE_URL fails closed; preview and build do not",
      "0013 makes aether_runtime LOGIN; occupancy objects stay owner-owned",
      "valid public booking still works; lookup DTO omits PII and token",
      "guest create rate limit trips then fail-opens without the table",
    ],
  },
  {
    file: "cp13a.test.ts",
    titles: [
      "0011–0013 remain byte-identical and never mention aether_app",
      "0014 creates aether_app LOGIN without a password or neon_superuser grant",
      "production identity is aether_app; preview SET ROLE remains aether_runtime",
      "0014 applies: aether_app is least-privilege LOGIN; occupancy stays owner-owned",
      "aether_app has production DML and is denied occupancy DDL and meta writes",
    ],
  },
  {
    file: "cp14.1.test.ts",
    titles: [
      "0011–0014 remain byte-identical; 0015 does not rewrite occupancy",
      "existing hotels migrate unconfigured with Athens/EUR defaults",
    ],
  },
  {
    file: "cp14.2.test.ts",
    titles: [
      "LIVE hotel + active destination creates a quoted booking",
      "client cannot spoof amount or currency",
      "destination is hotel-scoped; inactive and foreign destinations reject",
      "non-LIVE hotel cannot create a public booking",
      "idempotency distinguishes destination and quote changes",
      "confirmation DTO exposes price; legacy unquoted lookup remains valid",
    ],
  },
  {
    file: "cp14.3.test.ts",
    titles: [
      "new hotel defaults to unconfigured",
      "hotel can be configured with valid identity data",
      "destination cannot be mutated through another hotel's scope",
      "hotel cannot become LIVE without destination and agreement",
      "hotel can become LIVE once all prerequisites are present",
      "unconfigured to live fails closed without the configured transition",
      "upsertHotel remains forbidden to ops",
      "gate harbor and legacy remain unconfigured",
    ],
  },
  {
    file: "cp14.4.test.ts",
    titles: [
      "0011–0015 remain byte-identical; 0003 occupancy tests stay 0003-only",
      "Europe/Athens winter booking occupies the Athens instant",
      "America/New_York DST gap and fold reject",
      "same civil time in Athens London and New York yields different instants",
      "invalid IANA timezone fails closed without Athens fallback",
    ],
  },
  {
    file: "cp15.test.ts",
    titles: [
      "0003–0015 remain byte-identical; CP15 adds no migration",
      "Hotel A hotel_desk session can load Hotel A Today",
      "Hotel A hotel_desk session cannot load Hotel B Today",
      "Hotel B hotel_desk session cannot load Hotel A Today",
      "Hotel A desk cannot get Hotel B booking",
      "Hotel A desk cannot cancel Hotel B booking",
      "Hotel A desk can cancel Hotel A booking",
      "hotel desk remains unable to assign vehicle/driver",
      "provider dispatcher retains provider-scoped Today visibility",
      "provider dispatcher retains assignment capability",
      "an operator with hotel_desk membership does NOT receive automatic legacy provider_dispatcher membership from ensureOperatorFromEnv",
      "loginOperatorFromRequest authenticates a hotel_desk env operator without adding a dispatcher hat",
      "production ensureOperatorFromEnv does not auto-attach a dispatcher hat",
      "the legacy sandbox/preview path still works where it is supposed to",
      "login produces exactly one active membership and correct session scope",
      "forged client hotel_id cannot alter scope",
      "public guest booking remains unchanged",
      "confirmation token behaviour remains unchanged",
      "CP14.4 hotel timezone / occupancy remains unchanged",
    ],
  },
];

async function openDb() {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  try {
    await pg.exec("create database neondb");
  } catch {
    /* already exists on a reused instance */
  }
  for (const name of SQL_FILES) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  const db: BookingDb = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
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
  return { db, pg };
}

function bookingInput(
  hotelCode: string,
  destinationId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    hotelCode,
    destinationId,
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

function readAether(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

describe("Phase 9 full test reconstruction", () => {
  test("Blueprint v2 matrix items remain registered as current-rebuild tests", () => {
    for (const entry of MATRIX) {
      const src = readAether(`./${entry.file}`);
      for (const title of entry.titles) {
        assert.ok(
          src.includes(`test("${title}"`),
          `missing current test in ${entry.file}: ${title}`,
        );
      }
    }
  });

  test("guest, ops, hotel, ICS, Neon, and occupancy-authority reconstruction", () => {
    const wizard = readAether("../../components/aether/guest-book.tsx");
    assert.match(wizard, /type Step = "landing" \| "find" \| "journey" \| "when" \| "party" \| "contact" \| "review"/);
    assert.match(wizard, /Book transfer/);
    assert.match(wizard, /View my booking/);
    assert.match(wizard, /createPublicBooking/);
    assert.doesNotMatch(wizard, /requireOps|ops-desk|\/ops/);

    const confirmed = readAether("../../routes/confirmed.$token.tsx");
    assert.match(confirmed, /getPublicBooking/);
    assert.match(confirmed, /A booking reference on its own cannot open this page/);
    assert.doesNotMatch(confirmed, /requireOps|internalNotes|occupies/);

    const book = readAether("../../routes/book.$hotelCode.tsx");
    assert.doesNotMatch(book, /requireOps|ops-desk/);

    const opsLayout = readAether("../../routes/ops.tsx");
    const opsLogin = readAether("../../routes/ops.login.tsx");
    const opsIndex = readAether("../../routes/ops.index.tsx");
    const opsBookings = readAether("../../routes/ops.bookings.index.tsx");
    const opsDetail = readAether("../../routes/ops.bookings.$bookingId.tsx");
    const opsVehicles = readAether("../../routes/ops.vehicles.tsx");
    const opsDrivers = readAether("../../routes/ops.drivers.tsx");
    const opsHotels = readAether("../../routes/ops.hotels.tsx");
    assert.match(opsLayout, /opsWhoAmI/);
    assert.match(opsLogin, /opsLogin/);
    assert.match(opsIndex, /opsTodayBoard/);
    assert.match(opsBookings, /opsListBookings/);
    assert.match(opsDetail, /opsAssignVehicle/);
    assert.match(opsDetail, /opsUnassignVehicle/);
    assert.match(opsDetail, /opsAssignDriver/);
    assert.match(opsDetail, /opsUnassignDriver/);
    assert.match(opsDetail, /opsCancelBooking/);
    assert.match(opsVehicles, /opsListVehicles|opsUpsertVehicle/);
    assert.match(opsDrivers, /opsListDrivers|opsUpsertDriver/);
    assert.match(opsHotels, /QR-ready booking URL/);
    assert.match(opsHotels, /to="\/book\/\$hotelCode"/);

    const deskServer = readAether("./ops-desk.server.ts");
    assert.match(deskServer, /requireOps\(\{ csrf: false \}\)/);
    assert.match(deskServer, /requireOps\(\{ csrf: true \}\)/);

    const auth = readAether("./ops-auth.ts");
    assert.match(auth, /cookieBase\(env, true\)/);
    assert.match(auth, /cookieBase\(env, false\)/);
    assert.match(auth, /sameSite: "lax"/);
    assert.match(auth, /secure: Boolean\(env.cookieSecure\)/);
    assert.doesNotMatch(auth, /localStorage|sessionStorage/);

    const csrf = readAether("./csrf-client.ts");
    assert.doesNotMatch(csrf, /^\s*import /m);
    assert.match(csrf, /aether_ops_csrf/);
    assert.match(csrf, /x-aether-csrf/);

    const occupancy = readAether("../../../migrations/0003_occupancy.sql");
    assert.match(occupancy, /aether_bookings_occupies_tg/);
    assert.match(occupancy, /bookings_vehicle_occupancy_excl/);
    assert.match(occupancy, /bookings_driver_occupancy_excl/);
    assert.match(occupancy, /tstzrange/);
    assert.match(occupancy, /'\[\)'/);

    const later = ["0008_guest_ux.sql", "0009_ops_desk.sql", "0010_hotel_white_label.sql", "0011_production_hardening.sql", "0012_cp12_tenancy.sql", "0013_cp12b_runtime_login.sql", "0014_cp13a_production_app_role.sql", "0015_cp14_hotel_configuration.sql", "0016_cp14_hotel_timezone.sql"]
      .map((name) => readAether(`../../../migrations/${name}`))
      .join("\n");
    assert.doesNotMatch(
      later,
      /drop trigger bookings_occupies_before|drop function aether_athens|drop constraint bookings_vehicle_occupancy_excl|drop constraint bookings_driver_occupancy_excl/i,
    );

    const bookingInsert = readAether("./booking.ts");
    const insert = bookingInsert.slice(
      bookingInsert.indexOf("insert into bookings"),
      bookingInsert.indexOf("returning id"),
    );
    assert.doesNotMatch(insert, /occupies|vehicle_id|driver_id/);

    let icsHits = 0;
    for (const name of readdirSync(new URL(".", import.meta.url))) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      const src = readAether(`./${name}`);
      if (/BEGIN:VCALENDAR|\bics\b/i.test(src) && !name.includes("matrix.test") && !name.includes("time.test")) {
        icsHits += 1;
      }
    }
    assert.equal(icsHits, 0, "ICS must remain unimplemented until the formula/instant contract is known");

    assert.equal(process.env.DATABASE_URL || "", "", "DATABASE_URL must stay unset here");
  });

  test("migrations 0002–0014 apply; occupancy engine remains authority", async () => {
    const { db, pg } = await openDb();
    const meta = await db.query<{ key: string; value: string }>(
      "select key, value from aether_meta",
    );
    const map = Object.fromEntries(meta.map((row) => [row.key, row.value]));
    assert.equal(map.product, "Aether Transfer");
    assert.equal(map.blueprint, "v2");
    assert.equal(map.schema_phase, "13");
    assert.equal(map.checkpoint, "13a");
    assert.equal(map.runtime_role, "aether_runtime");
    assert.equal(map.production_role, "aether_app");
    assert.equal(map.runtime_login, "aether_app");

    const objects = await db.query<{ n: number }>(`
      select count(*)::int as n from (
        select 1 from pg_proc where proname = 'aether_athens_instant'
        union all
        select 1 from pg_trigger where tgname = 'bookings_occupies_before' and not tgisinternal
        union all
        select 1 from pg_constraint where conname = 'bookings_vehicle_occupancy_excl'
        union all
        select 1 from pg_constraint where conname = 'bookings_driver_occupancy_excl'
      ) s
    `);
    assert.equal(objects[0]!.n, 4);

    const hotels = await db.query<{ code: string }>("select code from hotels order by code");
    assert.deepEqual(
      hotels.map((row) => row.code),
      ["gate", "harbor"],
    );
    await pg.close();
  });

  test("guest complete journey persists and token confirmation works", async () => {
    const { db, pg } = await openDb();
    const destinations = await applyCp14LiveCatalog(pg);
    let draft = emptyDraft("Gate Hotel");
    assert.equal(draft.direction, "from_hotel");
    assert.equal(draft.pickupText, "Gate Hotel");
    draft = applyDirection(draft, "to_hotel", "Gate Hotel");
    assert.equal(draft.destinationText, "Gate Hotel");
    draft = applyDirection(draft, "from_hotel", "Gate Hotel");
    draft = {
      ...draft,
      placeKind: "airport",
      destinationId: destinations.gate!,
      destinationText: "ATH airport",
      transferDate: "2026-01-15",
      pickupTime: "09:00",
      durationMinutes: 60,
      passengerCount: 2,
      luggageCount: 1,
      guestName: "Nikos Guest",
      guestPhone: "+302101111111",
      guestEmail: "nikos@example.com",
      specialRequirements: "Flight A3 400",
    };

    const created = await createBooking(db, {
      hotelCode: "gate",
      destinationId: destinations.gate!,
      transferDate: draft.transferDate,
      pickupTime: draft.pickupTime,
      durationMinutes: draft.durationMinutes,
      guestName: draft.guestName,
      guestPhone: draft.guestPhone,
      guestEmail: draft.guestEmail,
      passengerCount: draft.passengerCount,
      luggageCount: draft.luggageCount,
      pickupText: draft.pickupText,
      destinationText: draft.destinationText,
      specialRequirements: draft.specialRequirements,
    });
    assert.equal(created.hotelCode, "gate");
    assert.equal(created.hotelName, "Gate Hotel");
    assert.equal(created.guestName, "Nikos Guest");
    assert.equal("specialRequirements" in created, false);
    assert.equal("guestPhone" in created, false);
    assert.equal("guestEmail" in created, false);
    assert.equal(created.pricing.priced, true);
    assert.equal(created.destinationId, destinations.gate);

    const found = await getPublicBookingByToken(db, created.confirmationToken);
    assert.equal(found.humanReference, created.humanReference);
    assert.equal("occupies" in found, false);
    assert.equal("vehicleId" in found, false);
    assert.equal("internalNotes" in found, false);
    assert.equal("confirmationToken" in found, false);
    assert.equal("specialRequirements" in found, false);

    try {
      await getPublicBookingByToken(db, created.humanReference);
      assert.fail("reference-only lookup must fail");
    } catch (err) {
      assert.equal((err as { code: string }).code, "not_found");
      assert.match(touristMessage("not_found"), /could not find that booking/i);
    }
    try {
      await getPublicBookingByToken(db, "invalid-token");
      assert.fail("invalid token must fail");
    } catch (err) {
      assert.equal((err as { code: string }).code, "not_found");
      assert.doesNotMatch((err as Error).message, /gate|harbor|nikos|sql/i);
    }
    await pg.close();
  });

  test("ops desk list/detail/audit/fleet and Phase 7 assignment cycle", async () => {
    const { db, pg } = await openDb();
    const destinations = await applyCp14LiveCatalog(pg);
    const created = await createBooking(db, bookingInput("gate", destinations.gate!));
    const id = await bookingId(db, created.confirmationToken);
    const operator = await createOperator(db, "desk", "desk-pass", { N: 16, r: 8, p: 1 });
    const scope = await legacyDispatcherScope(db, operator.id, operator.login);
    const list = await listOpsBookings(db, scope);
    const listed = list.find((row) => row.id === id);
    assert.ok(listed);
    assert.equal(listed.hotelCode, "gate");
    assert.equal(listed.needsVehicle, true);
    assert.equal(listed.needsDriver, true);

    const detail = await getOpsBooking(db, scope, id);
    assert.equal(detail.humanReference, created.humanReference);
    assert.equal(detail.guestName, "Ada Guest");

    const vehicles = await listOpsVehicles(db, scope);
    const drivers = await listOpsDrivers(db, scope);
    const hotels = await listOpsHotels(db, scope);
    assert.ok(vehicles.length >= 2);
    assert.ok(drivers.length >= 2);
    assert.ok(hotels.some((row) => row.code === "gate" && row.bookingPath === "/book/gate"));
    assert.ok(hotels.some((row) => row.code === "harbor" && row.bookingPath === "/book/harbor"));

    const extraDriver = await upsertDriver(db, scope, { name: "Driver Extra", active: true });
    assert.equal(extraDriver.active, true);

    const withVehicle = await assignVehicle(db, {
      bookingId: id,
      vehicleId: vehicles[0]!.id,
      scope,
    });
    assert.equal(withVehicle.vehicleId, vehicles[0]!.id);
    const withDriver = await assignDriver(db, {
      bookingId: id,
      driverId: drivers[0]!.id,
      scope,
    });
    assert.equal(withDriver.driverId, drivers[0]!.id);
    const labelled = await setBookingStatus(db, {
      bookingId: id,
      status: "confirmed",
      scope,
    });
    assert.equal(labelled.status, "confirmed");

    const audit = await listOpsAudit(db, scope, id);
    const actions = audit.map((row) => row.action);
    assert.ok(actions.includes("booking.create"));
    assert.ok(actions.includes("vehicle.assign"));
    assert.ok(actions.includes("driver.assign"));
    assert.ok(actions.includes("booking.status"));

    await unassignVehicle(db, { bookingId: id, scope });
    const afterUnassign = await getOpsBooking(db, scope, id);
    assert.equal(afterUnassign.vehicleId, null);
    assert.equal(afterUnassign.driverId, drivers[0]!.id);

    const other = await createBooking(
      db,
      bookingInput("harbor", destinations.harbor!, { guestName: "Ben Harbor", guestEmail: "ben@example.com" }),
    );
    const otherId = await bookingId(db, other.confirmationToken);
    await assignVehicle(db, {
      bookingId: otherId,
      vehicleId: vehicles[0]!.id,
      scope,
    });

    await cancelBooking(db, { bookingId: id, scope });
    const cancelled = await getOpsBooking(db, scope, id);
    assert.equal(cancelled.cancelled, true);
    const empty = await db.query<{ empty: boolean }>(
      "select isempty(occupies) as empty from bookings where id = $1",
      [id],
    );
    assert.equal(empty[0]!.empty, true);
    await pg.close();
  });

  test("PGLite concurrent overlapping assigns yield one winner; Neon unverified", async () => {
    assert.equal(process.env.DATABASE_URL || "", "");
    const { db, pg } = await openDb();
    const destinations = await applyCp14LiveCatalog(pg);
    const operator = await createOperator(db, "desk", "desk-pass", { N: 16, r: 8, p: 1 });
    const scope = await legacyDispatcherScope(db, operator.id, operator.login);
    const vehicles = await listOpsVehicles(db, scope);
    const drivers = await listOpsDrivers(db, scope);
    const vehicleId = vehicles[0]!.id;
    const driverId = drivers[0]!.id;

    const a = await createBooking(db, bookingInput("gate", destinations.gate!, { pickupTime: "14:00", guestEmail: "a@example.com" }));
    const b = await createBooking(db, bookingInput("gate", destinations.gate!, { pickupTime: "14:00", guestEmail: "b@example.com" }));
    const idA = await bookingId(db, a.confirmationToken);
    const idB = await bookingId(db, b.confirmationToken);

    const vehicleSettled = await Promise.allSettled([
      assignVehicle(db, { bookingId: idA, vehicleId, scope }),
      assignVehicle(db, { bookingId: idB, vehicleId, scope }),
    ]);
    const vehicleWins = vehicleSettled.filter((row) => row.status === "fulfilled");
    const vehicleLosses = vehicleSettled.filter((row) => row.status === "rejected");
    assert.equal(vehicleWins.length, 1, `vehicle concurrent winners=${vehicleWins.length}`);
    assert.equal(vehicleLosses.length, 1);
    const vehicleErr = (vehicleLosses[0] as PromiseRejectedResult).reason;
    assert.ok(vehicleErr instanceof InventoryError);
    assert.equal(vehicleErr.code, "unavailable");
    assert.doesNotMatch(vehicleErr.message, /23P01|EXCLUDE|SQLSTATE/i);

    const c = await createBooking(db, bookingInput("gate", destinations.gate!, { pickupTime: "16:00", guestEmail: "c@example.com" }));
    const d = await createBooking(db, bookingInput("gate", destinations.gate!, { pickupTime: "16:00", guestEmail: "d@example.com" }));
    const idC = await bookingId(db, c.confirmationToken);
    const idD = await bookingId(db, d.confirmationToken);

    const driverSettled = await Promise.allSettled([
      assignDriver(db, { bookingId: idC, driverId, scope }),
      assignDriver(db, { bookingId: idD, driverId, scope }),
    ]);
    const driverWins = driverSettled.filter((row) => row.status === "fulfilled");
    const driverLosses = driverSettled.filter((row) => row.status === "rejected");
    assert.equal(driverWins.length, 1, `driver concurrent winners=${driverWins.length}`);
    assert.equal(driverLosses.length, 1);
    const driverErr = (driverLosses[0] as PromiseRejectedResult).reason;
    assert.ok(driverErr instanceof InventoryError);
    assert.equal(driverErr.code, "unavailable");
    await pg.close();
  });

  test("public DTO is minimised; confirmation tokens are high-entropy and unique", async () => {
    const { db, pg } = await openDb();
    const destinations = await applyCp14LiveCatalog(pg);
    const created = await createBooking(db, bookingInput("gate", destinations.gate!));
    const keys = Object.keys(created).sort();
    assert.deepEqual(keys, [...CREATED_DTO_KEYS].sort());
    assert.equal("occupies" in created, false);
    assert.equal("vehicleId" in created, false);
    assert.equal("driverId" in created, false);
    assert.equal("internalNotes" in created, false);
    assert.equal("id" in created, false);
    assert.equal("status" in created, false);
    assert.equal("guestPhone" in created, false);
    assert.equal("guestEmail" in created, false);
    assert.equal("specialRequirements" in created, false);
    const payload = JSON.stringify(created);
    assert.doesNotMatch(payload, /occupies|internal_notes|vehicle_id|driver_id/);

    const typed: CreatedBooking = created;
    assert.ok(typed.confirmationToken.length >= 40);
    assert.match(typed.humanReference, /^PT-[A-Z2-9]{10}$/);

    const looked = await getPublicBookingByToken(db, created.confirmationToken);
    const publicTyped: PublicBooking = looked;
    assert.deepEqual(Object.keys(looked).sort(), [...PUBLIC_DTO_KEYS].sort());
    assert.equal("confirmationToken" in publicTyped, false);

    const tokens = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      const token = newConfirmationToken();
      assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
      tokens.add(token);
    }
    assert.equal(tokens.size, 32);

    const unique = await db.query<{ n: number }>(`
      select count(*)::int as n
      from pg_constraint
      where conrelid = 'bookings'::regclass
        and contype = 'u'
        and pg_get_constraintdef(oid) ilike '%confirmation_token%'
    `);
    assert.equal(unique[0]!.n, 1);

    await pg.close();
  });
});
