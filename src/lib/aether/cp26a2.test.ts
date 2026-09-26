/**
 * CP26A.2A — billing/Connect entitlement must not write hotels.status.
 * 0020 remains the historical coupling. 0023 replaces the function only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { BookingError, createBooking, getPublicHotel, type BookingDb } from "./booking.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const HASH_0020 = "e554f58f72ebe71a7048786b16890aaa4e125642f314407d49ab863ac8365e0c";
const HASH_0021 = "b51166aab2016c2223cfe2e495d0e72e6677bfd216bfe029f1064ae18ae1e86a";
const HASH_0022 = "bf2563cbc13f773d0ec75865745ce1b6b6aa87ce7846fc8961c53beda77bccc3";

const THROUGH_0020 = [
  "0001_auth.sql",
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
  "0018_cp22_saas_onboarding.sql",
  "0019_cp23_public_hotel_slug.sql",
  "0020_cp24_stripe_billing.sql",
] as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function expectBookingCode(fn: () => Promise<unknown>, code: BookingError["code"]) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof BookingError, `expected BookingError, got ${err}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

function asBookingDb(pg: PGlite): BookingDb {
  return {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      return pg.transaction(async (tx) => {
        const inner: BookingDb = {
          query: async <R>(sql: string, params?: unknown[]) => (await tx.query<R>(sql, params)).rows,
          transaction: () => {
            throw new Error("nested");
          },
        };
        return fn(inner);
      });
    },
  };
}

async function applySqlFiles(pg: PGlite, names: readonly string[]) {
  for (const name of names) {
    await pg.exec(read(`migrations/${name}`));
  }
}

async function openThrough0020(): Promise<PGlite> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  try {
    await pg.exec("create database neondb");
  } catch {
    /* preview name may already exist */
  }
  await applySqlFiles(pg, THROUGH_0020);
  return pg;
}

type HotelRow = { id: string; code: string; status: string };

async function insertHotel(
  pg: PGlite,
  code: string,
  status: "unconfigured" | "configured" | "live",
  name = `${code} Hotel`,
): Promise<HotelRow> {
  const inserted = await pg.query<HotelRow>(
    `insert into hotels (code, name, locality, iana_timezone, currency, status)
     values ($1, $2, 'Kos', 'Europe/Athens', 'EUR', $3)
     returning id, code, status`,
    [code, name, status],
  );
  return inserted.rows[0]!;
}

async function addCatalogue(pg: PGlite, hotelId: string, prefix: string) {
  await pg.query(
    `insert into hotel_services (hotel_id, kind, name, active)
     values ($1::uuid, 'transfer', $2, true)`,
    [hotelId, `${prefix} transfer`],
  );
  await pg.query(
    `insert into hotel_destinations (hotel_id, kind, name, sort_order, amount_minor, active)
     values ($1::uuid, 'airport', 'KOS', 10, 4500, true)`,
    [hotelId],
  );
  const provider = await pg.query<{ id: string }>(
    `insert into providers (code, name, kind)
     values ($1, $2, 'in_house')
     returning id`,
    [`${prefix}-ops`.slice(0, 32), `${prefix} Ops`],
  );
  await pg.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active)
     values ($1::uuid, $2::uuid, true)`,
    [hotelId, provider.rows[0]!.id],
  );
}

async function setBilling(pg: PGlite, hotelId: string, status: string) {
  await pg.query(
    `insert into sbg_billing_accounts (hotel_id, status, updated_at)
     values ($1::uuid, $2, now())
     on conflict (hotel_id) do update
       set status = excluded.status, updated_at = now()`,
    [hotelId, status],
  );
}

async function setConnect(pg: PGlite, hotelId: string, accountId: string, connected: boolean) {
  await pg.query(
    `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode, connected_at, disconnected_at)
     values ($1::uuid, $2, false, now(), $3::timestamptz)
     on conflict (hotel_id) do update
       set stripe_account_id = excluded.stripe_account_id,
           disconnected_at = excluded.disconnected_at,
           connected_at = excluded.connected_at`,
    [hotelId, accountId, connected ? null : new Date().toISOString()],
  );
}

async function sync(pg: PGlite, hotelId: string): Promise<string> {
  const result = await pg.query<{ status: string }>(
    "select sbg_sync_hotel_entitlement($1::uuid) as status",
    [hotelId],
  );
  return result.rows[0]!.status;
}

async function loadHotels(pg: PGlite): Promise<HotelRow[]> {
  const result = await pg.query<HotelRow>("select id, code, status from hotels order by code");
  return result.rows;
}

test("CP26A.2 source: 0023 replaces entitlement without writing hotels; 0020 stays historical", () => {
  const m20 = read("migrations/0020_cp24_stripe_billing.sql");
  const m21 = read("migrations/0021_cp25_hotel_guest_payments.sql");
  const m22 = read("migrations/0022_cp25g3_better_auth_runtime_privileges.sql");
  const m23 = read("migrations/0023_cp26a2_entitlement_publication_decoupling.sql");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const files = readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort();

  assert.equal(sha256(m20), HASH_0020);
  assert.equal(sha256(m21), HASH_0021);
  assert.equal(sha256(m22), HASH_0022);
  assert.match(m20, /update hotels set status = 'live'/);
  assert.match(m20, /update hotels set status = 'configured'/);
  assert.match(m20, /create or replace function sbg_sync_hotel_entitlement\(p_hotel_id uuid\)/);

  const body = m23.slice(m23.indexOf("as $$"), m23.lastIndexOf("$$"));
  assert.match(m23, /create or replace function sbg_sync_hotel_entitlement\(p_hotel_id uuid\)/);
  assert.match(m23, /returns text/);
  assert.match(m23, /errcode = 'P0002'/);
  assert.match(m23, /grant execute on function sbg_sync_hotel_entitlement\(uuid\) to aether_app/);
  assert.doesNotMatch(m23, /update\s+hotels/i);
  assert.doesNotMatch(m23, /insert\s+into\s+hotels/i);
  assert.doesNotMatch(m23, /delete\s+from\s+hotels/i);
  assert.doesNotMatch(m23, /set status = 'live'/i);
  assert.doesNotMatch(m23, /set status = 'configured'/i);
  assert.doesNotMatch(body, /sbg_billing_accounts/);
  assert.doesNotMatch(body, /sbg_stripe_connections/);
  assert.doesNotMatch(body, /sbg_booking_payments/);
  assert.doesNotMatch(m23, /create table/i);
  assert.doesNotMatch(m23, /alter table/i);
  assert.doesNotMatch(m23, /drop table/i);
  assert.doesNotMatch(m23, /create role/i);
  assert.doesNotMatch(m23, /sk_live|STRIPE_SECRET|DATABASE_URL|AETHER_DATABASE_OWNER_URL/i);

  assert.equal(files.filter((name) => name.startsWith("0023_")).length, 1);
  assert.ok(files.includes("0023_cp26a2_entitlement_publication_decoupling.sql"));
  assert.match(pkg.scripts["test:aether"], /cp26a2\.test\.ts/);
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkg.scripts.build, /0023_cp26a2/);
});

test("CP26A.2 callers remain compatible; Stripe paths no longer own publication", () => {
  const stripe = read("src/lib/aether/stripe.server.ts");
  const webhook = read("src/routes/api/stripe/webhook.ts");
  const billingWebhook = read("src/lib/aether/saas-billing-webhook.ts");
  const provision = read("src/lib/aether/provision.ts");
  const onboarding = read("migrations/0018_cp22_saas_onboarding.sql");
  const commerce = read("src/lib/aether/saas-commerce.server.ts");

  assert.match(stripe, /sbg_sync_hotel_entitlement/);
  assert.doesNotMatch(webhook, /sbg_sync_hotel_entitlement/);
  assert.match(stripe, /completeStripeConnect/);
  assert.match(billingWebhook, /sbg_apply_organisation_billing_event/);
  assert.doesNotMatch(commerce, /sbg_sync_hotel_entitlement/);
  assert.doesNotMatch(commerce, /update hotels set status/i);

  assert.match(onboarding, /sbg_create_hotel_for_user/);
  assert.match(onboarding, /'unconfigured'/);
  assert.match(onboarding, /sbg_promote_configured_for_user/);
  assert.match(onboarding, /update hotels set status = 'configured'/);
  assert.match(provision, /promoteHotelToConfigured/);
  assert.match(provision, /promoteHotelToLive/);
  assert.match(provision, /input\.goLive/);
  assert.match(provision, /set status = 'live'/);
  assert.doesNotMatch(provision, /sbg_sync_hotel_entitlement/);
  assert.doesNotMatch(stripe, /update hotels set status/i);
  assert.doesNotMatch(webhook, /update hotels set status/i);
});

test("CP26A.2 PGLite: 0020 still couples; 0023 does not rewrite or publish hotels", async () => {
  const pg = await openThrough0020();
  const db = asBookingDb(pg);

  const unconfigured = await insertHotel(pg, "unconf", "unconfigured");
  const configured = await insertHotel(pg, "cfg-active", "configured");
  const trialing = await insertHotel(pg, "cfg-trial", "configured");
  const liveInactive = await insertHotel(pg, "live-inact", "live");
  const liveDisconnected = await insertHotel(pg, "live-disc", "live");
  const demoKos = await insertHotel(pg, "demo-kos", "live", "Aether Demo Hotel");
  const pastDue = await insertHotel(pg, "cfg-pastdue", "configured");

  await addCatalogue(pg, configured.id, "cfg-active");
  await addCatalogue(pg, trialing.id, "cfg-trial");
  await addCatalogue(pg, liveInactive.id, "live-inact");
  await addCatalogue(pg, liveDisconnected.id, "live-disc");
  await addCatalogue(pg, demoKos.id, "demo-kos");
  await addCatalogue(pg, pastDue.id, "cfg-pastdue");

  await setBilling(pg, configured.id, "active");
  await setConnect(pg, configured.id, "acct_cfg_active", true);
  await setBilling(pg, trialing.id, "trialing");
  await setConnect(pg, trialing.id, "acct_cfg_trial", true);
  await setBilling(pg, liveInactive.id, "inactive");
  await setConnect(pg, liveInactive.id, "acct_live_inact", true);
  await setBilling(pg, liveDisconnected.id, "active");
  await setConnect(pg, liveDisconnected.id, "acct_live_disc", false);
  await setBilling(pg, demoKos.id, "canceled");
  await setConnect(pg, demoKos.id, "acct_demo_kos", false);
  await setBilling(pg, pastDue.id, "past_due");
  await setConnect(pg, pastDue.id, "acct_cfg_pastdue", true);

  assert.equal(await sync(pg, configured.id), "live");
  assert.equal((await loadHotels(pg)).find((row) => row.code === "cfg-active")?.status, "live");
  assert.equal(await sync(pg, liveInactive.id), "configured");
  assert.equal((await loadHotels(pg)).find((row) => row.code === "live-inact")?.status, "configured");

  await pg.query("update hotels set status = 'configured' where id = $1::uuid", [configured.id]);
  await pg.query("update hotels set status = 'live' where id = $1::uuid", [liveInactive.id]);
  await pg.query("update hotels set status = 'live' where id = $1::uuid", [demoKos.id]);

  const before = await loadHotels(pg);
  await applySqlFiles(pg, ["0023_cp26a2_entitlement_publication_decoupling.sql"]);
  const afterApply = await loadHotels(pg);
  assert.deepEqual(afterApply, before);

  const cases: Array<{ id: string; code: string; expected: string }> = [
    { id: unconfigured.id, code: "unconf", expected: "unconfigured" },
    { id: configured.id, code: "cfg-active", expected: "configured" },
    { id: trialing.id, code: "cfg-trial", expected: "configured" },
    { id: liveInactive.id, code: "live-inact", expected: "live" },
    { id: liveDisconnected.id, code: "live-disc", expected: "live" },
    { id: demoKos.id, code: "demo-kos", expected: "live" },
    { id: pastDue.id, code: "cfg-pastdue", expected: "configured" },
  ];

  for (const row of cases) {
    const returned = await sync(pg, row.id);
    assert.equal(returned, row.expected, `${row.code} return`);
    const current = (await loadHotels(pg)).find((hotel) => hotel.id === row.id);
    assert.equal(current?.status, row.expected, `${row.code} stored`);
  }

  assert.deepEqual(await loadHotels(pg), afterApply);

  await expectBookingCode(() => getPublicHotel(db, "cfg-active"), "hotel_not_live");
  const configuredDestination = await pg.query<{ id: string }>(
    "select id from hotel_destinations where hotel_id = $1::uuid",
    [configured.id],
  );
  await expectBookingCode(
    () =>
      createBooking(db, {
        hotelCode: "cfg-active",
        destinationId: configuredDestination.rows[0]!.id,
        transferDate: "2026-01-15",
        pickupTime: "09:00",
        durationMinutes: 60,
        guestName: "Ada Guest",
        guestPhone: "+302101234567",
        guestEmail: "ada@example.com",
        passengerCount: 2,
        luggageCount: 1,
        pickupText: "Configured Hotel",
      }),
    "hotel_not_live",
  );

  const publicDemo = await getPublicHotel(db, "demo-kos");
  assert.equal(publicDemo.code, "demo-kos");
  assert.ok(publicDemo.destinations.length >= 1);

  try {
    await pg.query("select sbg_sync_hotel_entitlement($1::uuid)", [
      "00000000-0000-0000-0000-000000000001",
    ]);
    assert.fail("missing hotel must raise");
  } catch (err) {
    assert.equal(errCode(err), "P0002", errMessage(err));
    assert.match(errMessage(err), /hotel not found/i);
  }

  const billing = await pg.query<{ hotel_id: string; status: string }>(
    "select hotel_id, status from sbg_billing_accounts order by hotel_id",
  );
  const connections = await pg.query<{ hotel_id: string; disconnected_at: string | null }>(
    "select hotel_id, disconnected_at from sbg_stripe_connections order by hotel_id",
  );
  assert.ok(billing.rows.some((row) => row.status === "active"));
  assert.ok(billing.rows.some((row) => row.status === "canceled"));
  assert.ok(connections.rows.some((row) => row.disconnected_at == null));
  assert.ok(connections.rows.some((row) => row.disconnected_at != null));

  await pg.close();
});
