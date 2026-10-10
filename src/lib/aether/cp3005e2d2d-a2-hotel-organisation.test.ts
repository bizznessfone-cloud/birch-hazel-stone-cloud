/**
 * CP30.05E-2D-2D A2 — an unattached hotel joins the caller's hotel founding
 * organisation. It does not create a second organisation from the hotel name.
 * PGLite. No Production connection. No Stripe checkout.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  FIXTURE_HOTEL,
  OTHER_USER,
  OWNER_USER,
  createHotelForUser,
  insertAuthUser,
  openCp272PaymentDb,
} from "./cp26a4-fixture.ts";
import { classifyFoundingOrganisation, readFoundingOnboardingState } from "./founding-onboarding.ts";
import { ensureFoundingOrganisation } from "./founding-organisation.ts";
import type { Sql } from "@/lib/db";
import {
  HotelOrganisationError,
  ensureHotelOrganisation,
  loadDomainABillingState,
} from "./saas-billing.server.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

type Db = Pick<Sql, "query">;

function dbOf(pg: PGlite): Db {
  return {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
  };
}

async function openDb(): Promise<PGlite> {
  const pg = await openCp272PaymentDb();
  await pg.exec(read("migrations/0031_cp3005e2c_organisation_type.sql"));
  await pg.exec(read("migrations/0032_cp3005e2c1_organisation_acceptance.sql"));
  await pg.exec(read("migrations/0033_cp3005e2d2b_founding_organisation.sql"));
  await pg.exec(read("migrations/0034_cp3005e2d2c_founding_classification_acceptance.sql"));
  return pg;
}

async function effects(pg: PGlite) {
  const rows = await pg.query<{
    orgs: number;
    acceptances: number;
    billing: number;
    allocations: number;
    bookings: number;
  }>(
    `select
       (select count(*)::int from sbg_organisations) as orgs,
       (select count(*)::int from sbg_organisation_acceptances) as acceptances,
       (select count(*)::int from sbg_organisation_billing) as billing,
       (select count(*)::int from sbg_property_licence_allocations) as allocations,
       (select count(*)::int from bookings) as bookings`,
  );
  return rows.rows[0]!;
}

async function hotelRow(pg: PGlite, hotelId: string) {
  const rows = await pg.query<{ organisation_id: string | null; name: string; status: string }>(
    "select organisation_id::text as organisation_id, name, status from hotels where id = $1::uuid",
    [hotelId],
  );
  return rows.rows[0]!;
}

function code(error: unknown): string {
  assert.equal(error instanceof HotelOrganisationError, true);
  return (error as HotelOrganisationError).code;
}

test("an unattached hotel attaches once to its hotel business, including when the names match", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const db = dbOf(pg);
  const before = await effects(pg);
  const created = await ensureFoundingOrganisation({
    db,
    userId: OWNER_USER.id,
    businessName: "Blue Lagoon Hotel",
  });
  await classifyFoundingOrganisation({ db, userId: OWNER_USER.id, organisationType: "hotel" });
  const hotel = await createHotelForUser(pg, OWNER_USER.id, {
    ...FIXTURE_HOTEL,
    name: "Blue Lagoon Hotel",
  });
  const statusBefore = (await hotelRow(pg, hotel.hotelId)).status;

  const first = await ensureHotelOrganisation({ db, userId: OWNER_USER.id, hotelId: hotel.hotelId });
  const second = await ensureHotelOrganisation({ db, userId: OWNER_USER.id, hotelId: hotel.hotelId });
  assert.equal(first.organisationId, created.organisationId);
  assert.equal(second.organisationId, created.organisationId);

  const stored = await hotelRow(pg, hotel.hotelId);
  assert.equal(stored.organisation_id, created.organisationId);
  assert.equal(stored.name, "Blue Lagoon Hotel");
  assert.equal(stored.status, statusBefore);
  const org = await pg.query<{ name: string; organisation_type: string; n: number }>(
    `select name, organisation_type, count(*)::int as n
       from sbg_organisations
      where created_by_user_id = $1
      group by name, organisation_type`,
    [OWNER_USER.id],
  );
  assert.deepEqual(org.rows, [{ name: "Blue Lagoon Hotel", organisation_type: "hotel", n: 1 }]);
  const after = await effects(pg);
  assert.equal(after.orgs, before.orgs + 1);
  assert.equal(after.acceptances, before.acceptances);
  assert.equal(after.billing, before.billing);
  assert.equal(after.allocations, before.allocations);
  assert.equal(after.bookings, before.bookings);

  const viewed = await loadDomainABillingState(db as Sql, OWNER_USER.id, hotel.hotelId);
  assert.equal(viewed.organisationId, created.organisationId);
  assert.equal(viewed.billing, null);
  const again = await ensureHotelOrganisation({ db, userId: OWNER_USER.id, hotelId: hotel.hotelId });
  assert.equal(again.organisationId, created.organisationId);
  assert.equal((await effects(pg)).acceptances, before.acceptances);
});

test("an already-attached unclassified hotel keeps its organisation and does not gain another", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const legacy = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'Legacy Hotel Business')::text as id",
    [OWNER_USER.id],
  );
  const organisationId = legacy.rows[0]!.id;
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    OWNER_USER.id,
    organisationId,
    hotel.hotelId,
  ]);
  const before = await hotelRow(pg, hotel.hotelId);

  const resolved = await ensureHotelOrganisation({
    db: dbOf(pg),
    userId: OWNER_USER.id,
    hotelId: hotel.hotelId,
  });
  assert.equal(resolved.organisationId, organisationId);
  assert.deepEqual(await hotelRow(pg, hotel.hotelId), before);
  const type = await pg.query<{ organisation_type: string | null; n: number }>(
    "select organisation_type, count(*)::int as n from sbg_organisations group by organisation_type",
  );
  assert.deepEqual(type.rows, [{ organisation_type: null, n: 1 }]);
  assert.equal((await effects(pg)).acceptances, 0);

  await pg.query(
    "update sbg_organisation_members set billing_authority = false where user_id = $1",
    [OWNER_USER.id],
  );
  await assert.rejects(
    () => ensureHotelOrganisation({ db: dbOf(pg), userId: OWNER_USER.id, hotelId: hotel.hotelId }),
    /Organisation billing authority required/,
  );
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, organisationId);

  await assert.rejects(
    () => ensureHotelOrganisation({ db: dbOf(pg), userId: OTHER_USER.id, hotelId: hotel.hotelId }),
    /Hotel not found/,
  );
  assert.equal(
    (await pg.query<{ n: number }>("select count(*)::int as n from sbg_organisations where created_by_user_id = $1", [OTHER_USER.id])).rows[0]!.n,
    0,
  );
});

test("missing, ambiguous, unclassified, operator, and unauthorised hotels fail closed", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const db = dbOf(pg);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const before = await effects(pg);

  await assert.rejects(
    () => ensureHotelOrganisation({ db, userId: OWNER_USER.id, hotelId: hotel.hotelId }),
    (error: unknown) => code(error) === "missing",
  );

  const created = await ensureFoundingOrganisation({ db, userId: OWNER_USER.id, businessName: "Unclassified Hotels" });
  await assert.rejects(
    () => ensureHotelOrganisation({ db, userId: OWNER_USER.id, hotelId: hotel.hotelId }),
    (error: unknown) => code(error) === "unclassified",
  );
  await classifyFoundingOrganisation({ db, userId: OWNER_USER.id, organisationType: "transfer_operator" });
  await assert.rejects(
    () => ensureHotelOrganisation({ db, userId: OWNER_USER.id, hotelId: hotel.hotelId }),
    (error: unknown) => code(error) === "not_hotel",
  );
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, null);
  assert.equal(
    (await pg.query<{ organisation_type: string }>("select organisation_type from sbg_organisations where id = $1::uuid", [created.organisationId])).rows[0]!.organisation_type,
    "transfer_operator",
  );

  await pg.query("update sbg_organisations set organisation_type = null where id = $1::uuid", [created.organisationId]);
  await pg.query(
    "update sbg_organisation_members set billing_authority = false where organisation_id = $1::uuid",
    [created.organisationId],
  );
  const state = await readFoundingOnboardingState({ db, userId: OWNER_USER.id });
  assert.equal(state.status, "ambiguous");
  await assert.rejects(
    () => ensureHotelOrganisation({ db, userId: OWNER_USER.id, hotelId: hotel.hotelId }),
    (error: unknown) => code(error) === "ambiguous",
  );

  await pg.query("select sbg_create_organisation_for_user($1, 'Second Business')", [OWNER_USER.id]);
  await pg.query(
    "update sbg_organisation_members set billing_authority = true where organisation_id = $1::uuid",
    [created.organisationId],
  );
  await assert.rejects(
    () => ensureHotelOrganisation({ db, userId: OWNER_USER.id, hotelId: hotel.hotelId }),
    (error: unknown) => code(error) === "ambiguous",
  );
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, null);

  const foreign = await ensureFoundingOrganisation({ db, userId: OTHER_USER.id, businessName: "Other Hotels" });
  await classifyFoundingOrganisation({ db, userId: OTHER_USER.id, organisationType: "hotel" });
  await assert.rejects(
    () => ensureHotelOrganisation({ db, userId: OTHER_USER.id, hotelId: hotel.hotelId }),
    /Hotel not found/,
  );
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, null);
  assert.equal(
    (await pg.query<{ organisation_id: string | null }>("select organisation_id::text as organisation_id from hotels where id = $1::uuid", [hotel.hotelId])).rows[0]!.organisation_id,
    null,
  );
  const foreignHotels = await pg.query<{ n: number }>(
    "select count(*)::int as n from hotels where organisation_id = $1::uuid",
    [foreign.organisationId],
  );
  assert.equal(foreignHotels.rows[0]!.n, 0);
  const after = await effects(pg);
  assert.equal(after.acceptances, before.acceptances);
  assert.equal(after.billing, before.billing);
  assert.equal(after.allocations, before.allocations);
  assert.equal(after.bookings, before.bookings);
  assert.equal(after.orgs, before.orgs + 3);
});

test("concurrent attachment retries keep one organisation and cannot reassign the hotel", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const db = dbOf(pg);
  const created = await ensureFoundingOrganisation({ db, userId: OWNER_USER.id, businessName: "Kos Hotels" });
  await classifyFoundingOrganisation({ db, userId: OWNER_USER.id, organisationType: "hotel" });
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);

  let allowAttach: (() => void) | undefined;
  const attachAllowed = new Promise<void>((resolve) => {
    allowAttach = resolve;
  });
  let markWaiting: (() => void) | undefined;
  const waitingToAttach = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  let paused = false;
  const racing: Db = {
    query: async <T>(text: string, params?: unknown[]) => {
      if (!paused && text.includes("sbg_attach_hotel_to_organisation")) {
        paused = true;
        markWaiting?.();
        await attachAllowed;
      }
      return (await pg.query<T>(text, params)).rows;
    },
  };

  const first = ensureHotelOrganisation({ db: racing, userId: OWNER_USER.id, hotelId: hotel.hotelId });
  await waitingToAttach;
  const second = await ensureHotelOrganisation({ db, userId: OWNER_USER.id, hotelId: hotel.hotelId });
  allowAttach?.();
  const firstResult = await first;
  assert.equal(firstResult.organisationId, created.organisationId);
  assert.equal(second.organisationId, created.organisationId);
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, created.organisationId);
  assert.equal(
    (await pg.query<{ n: number }>("select count(*)::int as n from sbg_organisations where created_by_user_id = $1", [OWNER_USER.id])).rows[0]!.n,
    1,
  );

  const other = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'Not The Founding Business')::text as id",
    [OWNER_USER.id],
  );
  await assert.rejects(
    () =>
      pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
        OWNER_USER.id,
        other.rows[0]!.id,
        hotel.hotelId,
      ]),
    /hotel is already attached/i,
  );
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, created.organisationId);
  assert.equal((await effects(pg)).acceptances, 0);
  assert.equal((await effects(pg)).billing, 0);
});

test("A2 billing source resolves founding server-side and does not create an organisation", () => {
  const billing = read("src/lib/aether/saas-billing.server.ts");
  const fn = billing.slice(
    billing.indexOf("export async function ensureHotelOrganisation"),
    billing.indexOf("export class DomainACheckoutClaimError"),
  );
  const stripeFns = read("src/lib/aether/stripe-fns.ts");
  const ensureFn = stripeFns.slice(
    stripeFns.indexOf("export const ensureHotelOrganisationFn"),
    stripeFns.indexOf("export const allocatePropertyLicenceFn"),
  );
  const route = read("src/routes/app.billing.tsx");
  const home = read("src/routes/index.tsx");
  assert.doesNotMatch(fn, /sbg_create_organisation_for_user|sbg_ensure_founding_organisation|sbg_classify_founding_organisation|sbg_record_founding_terms_acceptance/);
  assert.match(fn, /readFoundingOnboardingState/);
  assert.match(fn, /sbg_attach_hotel_to_organisation/);
  assert.ok(fn.indexOf("if (existing)") < fn.indexOf("readFoundingOnboardingState"));
  assert.doesNotMatch(fn, /organisationId:\s*input|data\.organisationId|hotel\.name/);
  assert.doesNotMatch(ensureFn, /organisationId/);
  assert.match(ensureFn, /hotelId: data\.hotelId/);
  assert.match(route, /ensureHotelOrganisationFn\(\{ data: \{ hotelId \} \}\)/);
  assert.match(home, /href="#start"/);
  assert.doesNotMatch(home, /\/app\/founding|authClient\.signUp/);
  assert.doesNotMatch(read("src/lib/aether/guest-payment-fns.ts"), /ensureHotelOrganisation/);
});
