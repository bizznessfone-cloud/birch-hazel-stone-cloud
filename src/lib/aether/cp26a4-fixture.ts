/**
 * CP26A.4 local/PGLite SaaS verification harness.
 * Disposable. No Neon, no Vercel, no Production credentials or IDs.
 * Not imported by application runtime routes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { BookingDb } from "./booking.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

export const LOCAL_FIXTURE_EMAIL_DOMAIN = "sbg.test";
export const LOCAL_FIXTURE_EMAIL_PREFIX = "verify-";
export const LOCAL_FIXTURE_CODE_PREFIX = "sbg-test-";
export const LOCAL_FIXTURE_NAME_MARKER = "[TEST]";

export const OWNER_USER = {
  id: "user-sbg-test-owner",
  email: `${LOCAL_FIXTURE_EMAIL_PREFIX}owner@${LOCAL_FIXTURE_EMAIL_DOMAIN}`,
  name: "SBG Test Owner",
} as const;

export const OTHER_USER = {
  id: "user-sbg-test-other",
  email: `${LOCAL_FIXTURE_EMAIL_PREFIX}other@${LOCAL_FIXTURE_EMAIL_DOMAIN}`,
  name: "SBG Test Other",
} as const;

export const ZERO_USER = {
  id: "user-sbg-test-zero",
  email: `${LOCAL_FIXTURE_EMAIL_PREFIX}zero@${LOCAL_FIXTURE_EMAIL_DOMAIN}`,
  name: "SBG Test Zero",
} as const;

export const PLATFORM_OWNER_USER = {
  id: "user-sbg-platform-owner",
  email: `${LOCAL_FIXTURE_EMAIL_PREFIX}platform-owner@${LOCAL_FIXTURE_EMAIL_DOMAIN}`,
  name: "SBG Platform Owner",
} as const;

export const FIXTURE_HOTEL = {
  code: `${LOCAL_FIXTURE_CODE_PREFIX}kos`,
  name: `SBG Test Kos ${LOCAL_FIXTURE_NAME_MARKER}`,
  locality: "Kos, Greece",
  ianaTimezone: "Europe/Athens",
  currency: "EUR",
  serviceName: "SBG Test Transfers",
  destinationKind: "airport" as const,
  destinationName: "KOS Test Airport",
  amountMinor: 3500,
};

export const SECOND_HOTEL = {
  code: `${LOCAL_FIXTURE_CODE_PREFIX}rho`,
  name: `SBG Test Rhodes ${LOCAL_FIXTURE_NAME_MARKER}`,
  locality: "Rhodes, Greece",
  ianaTimezone: "Europe/Athens",
  currency: "EUR",
};

export const MIGRATIONS_THROUGH_0023 = [
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
  "0021_cp25_hotel_guest_payments.sql",
  "0022_cp25g3_better_auth_runtime_privileges.sql",
  "0023_cp26a2_entitlement_publication_decoupling.sql",
] as const;

export const MIGRATIONS_THROUGH_0024 = [
  ...MIGRATIONS_THROUGH_0023,
  "0024_cp26b2_ordered_billing_events.sql",
] as const;

export const MIGRATIONS_THROUGH_0025 = [
  ...MIGRATIONS_THROUGH_0024,
  "0025_cp26co2_platform_owners.sql",
] as const;

export type FixtureUser = { id: string; email: string; name: string };

async function openFixtureDb(migrations: readonly string[]): Promise<PGlite> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  try {
    await pg.exec("create database neondb");
  } catch {
    /* preview name may already exist */
  }
  for (const name of migrations) {
    await pg.exec(read(`migrations/${name}`));
  }
  return pg;
}

export async function openCp26a4Db(): Promise<PGlite> {
  return openFixtureDb(MIGRATIONS_THROUGH_0024);
}

export async function openCp26a4DbThrough0023(): Promise<PGlite> {
  return openFixtureDb(MIGRATIONS_THROUGH_0023);
}

export async function openCp26cO2Db(): Promise<PGlite> {
  return openFixtureDb(MIGRATIONS_THROUGH_0025);
}

export const MIGRATIONS_THROUGH_0026 = [
  ...MIGRATIONS_THROUGH_0025,
  "0026_cp26co3_commercial_catalogue.sql",
] as const;

export async function openCp26cO32Db(): Promise<PGlite> {
  return openFixtureDb(MIGRATIONS_THROUGH_0026);
}

export function asBookingDb(pg: PGlite): BookingDb {
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

export async function insertAuthUser(pg: PGlite, user: FixtureUser): Promise<void> {
  await pg.query(
    `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
     values ($1, $2, $3, false, now(), now())`,
    [user.id, user.name, user.email],
  );
}

export async function createHotelForUser(
  pg: PGlite,
  userId: string,
  hotel: { code: string; name: string; locality: string; ianaTimezone: string; currency: string },
): Promise<{ hotelId: string; providerId: string }> {
  const rows = await pg.query<{ hotel_id: string; provider_id: string }>(
    "select * from sbg_create_hotel_for_user($1, $2, $3, $4, $5, $6)",
    [userId, hotel.code, hotel.name, hotel.locality, hotel.ianaTimezone, hotel.currency],
  );
  const row = rows.rows[0];
  if (!row) throw new Error("sbg_create_hotel_for_user returned no row");
  return { hotelId: row.hotel_id, providerId: row.provider_id };
}

export async function createServiceForUser(
  pg: PGlite,
  userId: string,
  hotelId: string,
  name: string,
): Promise<string> {
  const rows = await pg.query<{ sbg_create_service_for_user: string }>(
    "select sbg_create_service_for_user($1, $2::uuid, 'transfer', $3)",
    [userId, hotelId, name],
  );
  const id = rows.rows[0]?.sbg_create_service_for_user;
  if (!id) throw new Error("sbg_create_service_for_user returned no id");
  return id;
}

export async function addDestinationForUser(
  pg: PGlite,
  userId: string,
  hotelId: string,
  kind: string,
  name: string,
  amountMinor: number,
): Promise<string> {
  const rows = await pg.query<{ sbg_add_destination_for_user: string }>(
    "select sbg_add_destination_for_user($1, $2::uuid, $3, $4, $5)",
    [userId, hotelId, kind, name, amountMinor],
  );
  const id = rows.rows[0]?.sbg_add_destination_for_user;
  if (!id) throw new Error("sbg_add_destination_for_user returned no id");
  return id;
}

export async function promoteConfiguredForUser(
  pg: PGlite,
  userId: string,
  hotelId: string,
): Promise<boolean> {
  const rows = await pg.query<{ sbg_promote_configured_for_user: boolean }>(
    "select sbg_promote_configured_for_user($1, $2::uuid)",
    [userId, hotelId],
  );
  return Boolean(rows.rows[0]?.sbg_promote_configured_for_user);
}

export async function loadOwnedHotels(pg: PGlite, userId: string) {
  const hotels = await pg.query<{
    id: string;
    code: string;
    public_slug: string;
    name: string;
    locality: string;
    iana_timezone: string;
    currency: string;
    status: string;
  }>(
    `select h.id, h.code, h.public_slug, h.name, h.locality, h.iana_timezone, h.currency, h.status
       from app_hotel_accounts aha
       join hotels h on h.id = aha.hotel_id
      where aha.user_id = $1
      order by aha.created_at asc`,
    [userId],
  );
  return hotels.rows;
}

export async function setBillingPriceForUser(
  pg: PGlite,
  userId: string,
  hotelId: string,
  priceId: string,
): Promise<void> {
  await pg.query("select sbg_set_billing_price_for_user($1, $2::uuid, $3)", [userId, hotelId, priceId]);
}

export async function saveConnectForUser(
  pg: PGlite,
  userId: string,
  hotelId: string,
  accountId: string,
  livemode: boolean,
): Promise<void> {
  await pg.query("select sbg_save_stripe_connection_for_user($1, $2::uuid, $3, $4)", [
    userId,
    hotelId,
    accountId,
    livemode,
  ]);
}

let billingEventCreated = 1_700_000_000;

export async function applyBillingEvent(
  pg: PGlite,
  hotelId: string,
  status: string,
  extra: {
    created?: number;
    eventId?: string;
    subscriptionId?: string;
    customerId?: string;
    priceId?: string;
    cancelAtPeriodEnd?: boolean;
  } = {},
): Promise<string> {
  const created = extra.created ?? ++billingEventCreated;
  const eventId = extra.eventId ?? `evt_sbg_test_${status}_${hotelId.slice(0, 8)}_${created}`;
  const rows = await pg.query<{ sbg_apply_billing_event: string }>(
    `select sbg_apply_billing_event($1, $2, $3::bigint, $4::uuid, $5, $6, $7, $8, $9::timestamptz, $10::boolean)`,
    [
      eventId,
      "customer.subscription.updated",
      created,
      hotelId,
      extra.customerId ?? `cus_sbg_test_${hotelId.slice(0, 8)}`,
      extra.subscriptionId ?? `sub_sbg_test_${hotelId.slice(0, 8)}`,
      extra.priceId ?? "price_sbg_test_basic",
      status,
      new Date(Date.now() + 86400000).toISOString(),
      extra.cancelAtPeriodEnd ?? false,
    ],
  );
  return rows.rows[0]?.sbg_apply_billing_event ?? "";
}

export async function syncEntitlement(pg: PGlite, hotelId: string): Promise<string> {
  const rows = await pg.query<{ status: string }>(
    "select sbg_sync_hotel_entitlement($1::uuid) as status",
    [hotelId],
  );
  return rows.rows[0]!.status;
}

export async function hotelStatus(pg: PGlite, hotelId: string): Promise<string> {
  const rows = await pg.query<{ status: string }>("select status from hotels where id = $1::uuid", [
    hotelId,
  ]);
  return rows.rows[0]!.status;
}

export async function onboardConfiguredFixture(
  pg: PGlite,
  userId: string,
  hotel = FIXTURE_HOTEL,
): Promise<{ hotelId: string; providerId: string; serviceId: string; destinationId: string }> {
  const created = await createHotelForUser(pg, userId, hotel);
  const serviceId = await createServiceForUser(pg, userId, created.hotelId, hotel.serviceName);
  const destinationId = await addDestinationForUser(
    pg,
    userId,
    created.hotelId,
    hotel.destinationKind,
    hotel.destinationName,
    hotel.amountMinor,
  );
  const promoted = await promoteConfiguredForUser(pg, userId, created.hotelId);
  if (!promoted) throw new Error("sbg_promote_configured_for_user did not succeed");
  return { ...created, serviceId, destinationId };
}

export async function bootstrapPlatformOwner(
  pg: PGlite,
  userId: string,
  note = "test bootstrap",
): Promise<void> {
  await pg.query("select sbg_bootstrap_platform_owner($1, $2)", [userId, note]);
}
