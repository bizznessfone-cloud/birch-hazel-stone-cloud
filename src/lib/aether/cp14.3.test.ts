/**
 * CP14.3 — owner-only hotel provisioner.
 * Occupancy, RLS, tenants, timezone conversion, and public/ops HTTP are out of scope.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  BookingError,
  createBooking,
  getPublicHotel,
  type BookingDb,
} from "./booking.ts";
import { createOperator } from "./ops-auth.ts";
import { OpsDeskError, upsertHotel } from "./ops-desk.ts";
import {
  grantHotelDesk,
  grantProviderDispatcher,
  type OpsScope,
} from "./tenancy.ts";
import {
  ProvisionError,
  configureHotel,
  createHotel,
  ensureProvider,
  establishActiveAgreement,
  loadHotel,
  promoteHotelToConfigured,
  promoteHotelToLive,
  provisionHotel,
  upsertHotelDestination,
  validateHotelForLive,
  type ProvisionDb,
} from "./provision.ts";

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

function readMigration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readAether(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

async function expectProvision(
  fn: () => Promise<unknown>,
  code: ProvisionError["code"],
): Promise<ProvisionError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ProvisionError, `expected ProvisionError, got ${err}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected ${code}`);
}

async function openDb(): Promise<{ db: ProvisionDb & BookingDb; pg: PGlite }> {
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
  const db: ProvisionDb & BookingDb = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    async transaction<T>(fn: (inner: ProvisionDb & BookingDb) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner: ProvisionDb & BookingDb = {
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

const FAST = { N: 16, r: 8, p: 1 };

async function deskScope(db: BookingDb, login: string, hotelId: string): Promise<OpsScope> {
  const operator = await createOperator(db, login, "correct-horse", FAST);
  const membershipId = await grantHotelDesk(db, operator.id, hotelId);
  return {
    operatorId: operator.id,
    login: operator.login,
    sessionId: "test-session",
    membershipId,
    accessClass: "hotel_desk",
    hotelId,
    providerId: null,
  };
}

async function dispatcherScope(
  db: BookingDb,
  login: string,
  providerId: string,
): Promise<OpsScope> {
  const operator = await createOperator(db, login, "correct-horse", FAST);
  const membershipId = await grantProviderDispatcher(db, operator.id, providerId);
  return {
    operatorId: operator.id,
    login: operator.login,
    sessionId: "test-session",
    membershipId,
    accessClass: "provider_dispatcher",
    hotelId: null,
    providerId,
  };
}

function identity(code: string, extra: Record<string, string> = {}) {
  return {
    code,
    name: `${code[0]!.toUpperCase()}${code.slice(1)} Hotel`,
    locality: "Piraeus",
    ianaTimezone: "Europe/Athens",
    currency: "EUR",
    ...extra,
  };
}

describe("CP14.3 owner-only hotel provisioner", () => {
  test("0011–0015 remain byte-identical; occupancy SQL untouched", () => {
    for (const [name, expected] of Object.entries(IMMUTABLE)) {
      assert.equal(sha256(readMigration(name)), expected, name);
    }
    const kernel = readAether("./provision.ts");
    assert.doesNotMatch(kernel, /occupies/);
    assert.doesNotMatch(kernel, /aether_athens/);
    assert.doesNotMatch(kernel, /create table tenants/i);
    assert.doesNotMatch(kernel, /row level security/i);
    assert.doesNotMatch(kernel, /setHotelStatus/);
    const m15 = readMigration("0015_cp14_hotel_configuration.sql");
    assert.doesNotMatch(m15, /drop trigger bookings_occupies_before/i);
    assert.doesNotMatch(m15, /drop function aether_athens/i);
    assert.doesNotMatch(m15, /drop constraint bookings_vehicle_occupancy_excl/i);
    assert.doesNotMatch(m15, /drop constraint bookings_driver_occupancy_excl/i);
  });

  test("new hotel defaults to unconfigured", async () => {
    const { db, pg } = await openDb();
    const hotel = await createHotel(db, { code: "Quay", name: "Quay Hotel" });
    assert.equal(hotel.code, "quay");
    assert.equal(hotel.name, "Quay Hotel");
    assert.equal(hotel.status, "unconfigured");
    assert.equal(hotel.locality, "unspecified");
    assert.equal(hotel.ianaTimezone, "Europe/Athens");
    assert.equal(hotel.currency, "EUR");
    const gate = await db.query<{ status: string }>(
      "select status from hotels where code = 'gate'",
    );
    assert.equal(gate[0]?.status, "unconfigured");
    await pg.close();
  });

  test("hotel can be configured with valid identity data", async () => {
    const { db, pg } = await openDb();
    const created = await createHotel(db, { code: "quay", name: "Quay Hotel" });
    const configured = await configureHotel(db, {
      hotelId: created.id,
      ...identity("quay"),
    });
    assert.equal(configured.status, "unconfigured");
    assert.equal(configured.locality, "Piraeus");
    assert.equal(configured.ianaTimezone, "Europe/Athens");
    assert.equal(configured.currency, "EUR");
    const promoted = await promoteHotelToConfigured(db, created.id);
    assert.equal(promoted.status, "configured");
    await expectProvision(
      () =>
        configureHotel(db, {
          hotelId: created.id,
          ...identity("quay", { locality: "unspecified" }),
        }),
      "invalid",
    );
    await expectProvision(
      () =>
        configureHotel(db, {
          hotelId: created.id,
          ...identity("quay", { ianaTimezone: " " }),
        }),
      "invalid",
    );
    await expectProvision(
      () =>
        configureHotel(db, {
          hotelId: created.id,
          ...identity("quay", { currency: "euro" }),
        }),
      "invalid",
    );
    await pg.close();
  });

  test("destination is created for the target hotel only", async () => {
    const { db, pg } = await openDb();
    const hotel = await createHotel(db, { code: "quay", name: "Quay Hotel" });
    await configureHotel(db, { hotelId: hotel.id, ...identity("quay") });
    const dest = await upsertHotelDestination(db, {
      hotelId: hotel.id,
      kind: "airport",
      name: "ATH",
      sortOrder: 10,
      amountMinor: 4500,
    });
    assert.equal(dest.hotelId, hotel.id);
    assert.equal(dest.kind, "airport");
    assert.equal(dest.name, "ATH");
    assert.equal(dest.amountMinor, 4500);
    assert.equal(dest.active, true);
    const rows = await db.query<{ hotel_id: string }>(
      "select hotel_id from hotel_destinations where id = $1::uuid",
      [dest.id],
    );
    assert.equal(rows[0]?.hotel_id, hotel.id);
    const other = await db.query<{ n: number }>(
      "select count(*)::int as n from hotel_destinations where hotel_id <> $1::uuid and id = $2::uuid",
      [hotel.id, dest.id],
    );
    assert.equal(other[0]?.n, 0);
    await pg.close();
  });

  test("destination cannot be mutated through another hotel's scope", async () => {
    const { db, pg } = await openDb();
    const quay = await createHotel(db, { code: "quay", name: "Quay Hotel" });
    const cove = await createHotel(db, { code: "cove", name: "Cove Hotel" });
    await configureHotel(db, { hotelId: quay.id, ...identity("quay") });
    await configureHotel(db, { hotelId: cove.id, ...identity("cove") });
    const dest = await upsertHotelDestination(db, {
      hotelId: quay.id,
      kind: "airport",
      name: "ATH",
      amountMinor: 4500,
    });
    await expectProvision(
      () =>
        upsertHotelDestination(db, {
          hotelId: cove.id,
          id: dest.id,
          kind: "port",
          name: "Hijack",
          amountMinor: 1,
        }),
      "forbidden",
    );
    const still = await db.query<{ name: string; hotel_id: string; amount_minor: number }>(
      "select name, hotel_id, amount_minor from hotel_destinations where id = $1::uuid",
      [dest.id],
    );
    assert.equal(still[0]?.hotel_id, quay.id);
    assert.equal(still[0]?.name, "ATH");
    assert.equal(Number(still[0]?.amount_minor), 4500);
    await pg.close();
  });

  test("active provider agreement can be established", async () => {
    const { db, pg } = await openDb();
    const hotel = await createHotel(db, { code: "quay", name: "Quay Hotel" });
    await configureHotel(db, { hotelId: hotel.id, ...identity("quay") });
    const provider = await ensureProvider(db, { code: "fleet", name: "Fleet Co" });
    const agreement = await establishActiveAgreement(db, {
      hotelId: hotel.id,
      providerId: provider.id,
    });
    assert.equal(agreement.hotelId, hotel.id);
    assert.equal(agreement.providerId, provider.id);
    assert.equal(agreement.active, true);
    const other = await ensureProvider(db, { code: "other", name: "Other Co" });
    await establishActiveAgreement(db, { hotelId: hotel.id, providerId: other.id });
    const active = await db.query<{ n: number; provider_id: string }>(
      `select count(*)::int as n, max(provider_id::text) as provider_id
         from hotel_provider_agreements
        where hotel_id = $1::uuid and active`,
      [hotel.id],
    );
    assert.equal(active[0]?.n, 1);
    assert.equal(active[0]?.provider_id, other.id);
    await pg.close();
  });

  test("hotel cannot become configured without identity configuration", async () => {
    const { db, pg } = await openDb();
    const hotel = await createHotel(db, { code: "quay", name: "Quay Hotel" });
    const err = await expectProvision(() => promoteHotelToConfigured(db, hotel.id), "incomplete");
    assert.ok(err.issues.some((issue) => /locality/.test(issue)));
    const liveReport = await validateHotelForLive(db, hotel.id);
    assert.equal(liveReport.ok, false);
    assert.ok(liveReport.issues.some((issue) => /locality/.test(issue)));
    assert.ok(liveReport.issues.some((issue) => /destination/.test(issue)));
    assert.ok(liveReport.issues.some((issue) => /agreement/.test(issue)));
    const row = await loadHotel(db, hotel.id);
    assert.equal(row.status, "unconfigured");
    await pg.close();
  });

  test("hotel cannot become LIVE without destination and agreement", async () => {
    const { db, pg } = await openDb();
    const hotel = await createHotel(db, { code: "quay", name: "Quay Hotel" });
    await configureHotel(db, { hotelId: hotel.id, ...identity("quay") });
    await promoteHotelToConfigured(db, hotel.id);
    const err = await expectProvision(() => promoteHotelToLive(db, hotel.id), "incomplete");
    assert.ok(err.issues.some((issue) => /destination/.test(issue)));
    assert.ok(err.issues.some((issue) => /agreement/.test(issue)));
    assert.equal((await loadHotel(db, hotel.id)).status, "configured");

    await upsertHotelDestination(db, {
      hotelId: hotel.id,
      kind: "airport",
      name: "ATH",
      amountMinor: 4500,
    });
    const still = await expectProvision(() => promoteHotelToLive(db, hotel.id), "incomplete");
    assert.ok(still.issues.some((issue) => /agreement/.test(issue)));
    assert.equal((await loadHotel(db, hotel.id)).status, "configured");
    await pg.close();
  });

  test("hotel can become LIVE once all prerequisites are present", async () => {
    const { db, pg } = await openDb();
    const result = await provisionHotel(db, {
      hotel: identity("quay"),
      destinations: [{ kind: "airport", name: "ATH", sortOrder: 10, amountMinor: 4500 }],
      provider: { code: "fleet", name: "Fleet Co" },
      goLive: true,
    });
    assert.equal(result.hotel.status, "live");
    assert.equal(result.hotel.locality, "Piraeus");
    assert.equal(result.destinations.length, 1);
    const report = await validateHotelForLive(db, result.hotel.id);
    assert.equal(report.ok, true);
    assert.equal(report.activeDestinationCount, 1);
    assert.equal(report.activeAgreementCount, 1);
    assert.equal(report.executingProviderId, result.provider.id);
    await expectProvision(
      () =>
        configureHotel(db, {
          hotelId: result.hotel.id,
          ...identity("quay", { locality: "Athens" }),
        }),
      "illegal_transition",
    );
    const frozen = await loadHotel(db, result.hotel.id);
    assert.equal(frozen.status, "live");
    assert.equal(frozen.locality, "Piraeus");
    await pg.close();
  });

  test("unconfigured to live fails closed without the configured transition", async () => {
    const { db, pg } = await openDb();
    const hotel = await createHotel(db, { code: "quay", name: "Quay Hotel" });
    await configureHotel(db, { hotelId: hotel.id, ...identity("quay") });
    const provider = await ensureProvider(db, { code: "fleet", name: "Fleet Co" });
    await establishActiveAgreement(db, { hotelId: hotel.id, providerId: provider.id });
    await upsertHotelDestination(db, {
      hotelId: hotel.id,
      kind: "airport",
      name: "ATH",
      amountMinor: 4500,
    });
    await expectProvision(() => promoteHotelToLive(db, hotel.id), "illegal_transition");
    assert.equal((await loadHotel(db, hotel.id)).status, "unconfigured");

    const live = await provisionHotel(db, {
      hotel: identity("cove"),
      destinations: [{ kind: "port", name: "Piraeus", amountMinor: 3000 }],
      provider: { code: "fleet", name: "Fleet Co" },
      goLive: true,
    });
    assert.equal(live.hotel.status, "live");
    assert.equal(live.hotel.code, "cove");
    await pg.close();
  });

  test("upsertHotel remains forbidden to ops", async () => {
    const { db, pg } = await openDb();
    const hotel = await createHotel(db, { code: "quay", name: "Quay Hotel" });
    const provider = await ensureProvider(db, { code: "fleet", name: "Fleet Co" });
    const desk = await deskScope(db, "desk-a", hotel.id);
    const dispatcher = await dispatcherScope(db, "disp-a", provider.id);
    await upsertHotel(db, desk, { code: "nope", name: "Nope" }).then(
      () => assert.fail("upsertHotel should 403"),
      (err: unknown) => {
        assert.ok(err instanceof OpsDeskError && err.code === "forbidden");
        assert.equal(err.status, 403);
      },
    );
    await upsertHotel(db, dispatcher, { code: "nope", name: "Nope" }).then(
      () => assert.fail("upsertHotel should 403"),
      (err: unknown) => {
        assert.ok(err instanceof OpsDeskError && err.code === "forbidden");
      },
    );
    const source = readAether("./ops-desk.ts");
    assert.match(source, /throw new OpsDeskError\("forbidden", 403/);
    assert.doesNotMatch(source, /provision/);
    await pg.close();
  });

  test("hotel_desk cannot provision hotels", async () => {
    const { db, pg } = await openDb();
    const hotel = await createHotel(db, { code: "quay", name: "Quay Hotel" });
    const desk = await deskScope(db, "desk-b", hotel.id);
    assert.equal(desk.accessClass, "hotel_desk");
    await assert.rejects(
      () => upsertHotel(db, desk, { code: "quay", name: "Renamed" }),
      (err: unknown) => err instanceof OpsDeskError && err.code === "forbidden",
    );
    for (const name of [
      "./ops-desk.ts",
      "./ops-desk.server.ts",
      "./ops-desk-fns.ts",
      "./guest.ts",
      "./booking.server.ts",
      "../../routes/ops.hotels.tsx",
      "../../routes/book.$hotelCode.tsx",
    ]) {
      assert.doesNotMatch(readAether(name), /aether\/provision|from "\.\/provision/);
    }
    await pg.close();
  });

  test("provider_dispatcher cannot provision hotels", async () => {
    const { db, pg } = await openDb();
    const provider = await ensureProvider(db, { code: "fleet", name: "Fleet Co" });
    const dispatcher = await dispatcherScope(db, "disp-b", provider.id);
    assert.equal(dispatcher.accessClass, "provider_dispatcher");
    await assert.rejects(
      () => upsertHotel(db, dispatcher, { id: null, code: "fresh", name: "Fresh" }),
      (err: unknown) => err instanceof OpsDeskError && err.code === "forbidden",
    );
    await pg.close();
  });

  test("gate harbor and legacy remain unconfigured", async () => {
    const { db, pg } = await openDb();
    await provisionHotel(db, {
      hotel: identity("quay"),
      destinations: [{ kind: "airport", name: "ATH", amountMinor: 4500 }],
      provider: { code: "fleet", name: "Fleet Co" },
      goLive: true,
    });
    await expectProvision(() => createHotel(db, { code: "gate", name: "Gate Hotel" }), "forbidden");
    await expectProvision(
      () => createHotel(db, { code: "harbor", name: "Harbor Hotel" }),
      "forbidden",
    );
    const gate = await db.query<{ id: string; status: string }>(
      "select id, status from hotels where code = 'gate'",
    );
    await expectProvision(() => promoteHotelToConfigured(db, gate[0]!.id), "forbidden");
    await expectProvision(() => promoteHotelToLive(db, gate[0]!.id), "forbidden");
    const hotels = await db.query<{ code: string; status: string }>(
      "select code, status from hotels where code in ('gate', 'harbor') order by code",
    );
    assert.deepEqual(
      hotels.map((row) => [row.code, row.status]),
      [
        ["gate", "unconfigured"],
        ["harbor", "unconfigured"],
      ],
    );
    const legacy = await db.query<{ code: string; name: string }>(
      "select code, name from providers where code = 'legacy'",
    );
    assert.equal(legacy[0]?.name, "Legacy Operations");
    await pg.close();
  });

  test("provisioned LIVE hotel accepts public booking quote path", async () => {
    const { db, pg } = await openDb();
    const result = await provisionHotel(db, {
      hotel: identity("quay"),
      destinations: [{ kind: "airport", name: "ATH", sortOrder: 10, amountMinor: 4500 }],
      provider: { code: "fleet", name: "Fleet Co" },
      goLive: true,
    });
    const created = await createBooking(db, {
      hotelCode: "quay",
      destinationId: result.destinations[0]!.id,
      transferDate: "2026-01-15",
      pickupTime: "09:00",
      durationMinutes: 60,
      guestName: "Ada Guest",
      guestPhone: "+302101234567",
      guestEmail: "ada@example.com",
      passengerCount: 2,
      luggageCount: 1,
      pickupText: "Quay Hotel",
      quotedAmountMinor: 1,
      quotedCurrency: "USD",
    });
    assert.equal(created.destinationId, result.destinations[0]!.id);
    assert.equal(created.destinationText, "ATH");
    assert.deepEqual(created.pricing, {
      priced: true,
      currency: "EUR",
      amountMinor: 4500,
    });
    const publicHotel = await getPublicHotel(db, "quay");
    assert.equal(publicHotel.currency, "EUR");
    assert.equal(publicHotel.destinations[0]?.amountMinor, 4500);
    const occ = await db.query<{ empty: boolean }>(
      "select isempty(occupies) as empty from bookings where confirmation_token = $1",
      [created.confirmationToken],
    );
    assert.equal(occ[0]?.empty, false);

    await assert.rejects(
      () => getPublicHotel(db, "gate"),
      (err: unknown) => err instanceof BookingError && err.code === "hotel_not_live",
    );
    await pg.close();
  });

  test("failed LIVE provision does not leave a live hotel", async () => {
    const { db, pg } = await openDb();
    await assert.rejects(() =>
      provisionHotel(db, {
        hotel: identity("quay"),
        destinations: [],
        provider: { code: "fleet", name: "Fleet Co" },
        goLive: true,
      }),
    );
    const missing = await db.query<{ n: number }>(
      "select count(*)::int as n from hotels where code = 'quay'",
    );
    assert.equal(missing[0]?.n, 0);
    await pg.close();
  });

  test("seeded occupancy engine remains intact", async () => {
    const { db, pg } = await openDb();
    await provisionHotel(db, {
      hotel: identity("quay"),
      destinations: [{ kind: "airport", name: "ATH", amountMinor: 0 }],
      provider: { code: "fleet", name: "Fleet Co" },
      goLive: true,
    });
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
    assert.equal(objects[0]?.n, 4);
    const later = SQL_FILES.slice(SQL_FILES.indexOf("0008_guest_ux.sql"))
      .map((name) => readMigration(name))
      .join("\n");
    assert.doesNotMatch(
      later,
      /drop trigger bookings_occupies_before|drop function aether_athens|drop constraint bookings_vehicle_occupancy_excl|drop constraint bookings_driver_occupancy_excl/i,
    );
    await pg.close();
  });

  test("owner script uses owner URL only and never logs secrets", () => {
    const script = readFileSync(
      new URL("../../../scripts/provision-hotel.mjs", import.meta.url),
      "utf8",
    );
    assert.match(script, /resolveMigratePlan/);
    assert.match(script, /AETHER_DATABASE_OWNER_URL/);
    assert.match(script, /Never SET ROLE/);
    assert.doesNotMatch(script, /SET ROLE aether/);
    assert.doesNotMatch(script, /connectionString:\s*runtime/);
    assert.match(script, /never a fallback/);
    assert.match(script, /redact/);
    assert.doesNotMatch(script, /createServerFn|createFileRoute/);

    const skip = spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/provision-hotel.mjs", import.meta.url)), "provision", "{}"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "development",
        DATABASE_URL: "unused-runtime-url",
      },
    });
    assert.equal(skip.status, 0, skip.stderr);
    assert.match(skip.stdout, /AETHER_DATABASE_OWNER_URL/);
    assert.doesNotMatch(`${skip.stdout}${skip.stderr}`, /unused-runtime-url/);

    const fail = spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/provision-hotel.mjs", import.meta.url)), "provision", "{}"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        VERCEL_ENV: "production",
        DATABASE_URL: "unused-runtime-url",
      },
    });
    assert.equal(fail.status, 1, fail.stdout);
    assert.match(fail.stderr, /AETHER_DATABASE_OWNER_URL/);
    assert.doesNotMatch(`${fail.stdout}${fail.stderr}`, /unused-runtime-url/);
  });
});
