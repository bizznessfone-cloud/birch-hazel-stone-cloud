/**
 * CP30.05E-2D-2D A3-R — recover an existing unattached hotel onto the
 * caller's founding business. Does not create a property, provider, booking,
 * acceptance, or Stripe claim. PGLite. No Production connection.
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
import type { Sql } from "@/lib/db";
import {
  HotelRecoveryError,
  attachHotelRecovery,
  classifyHotelRecovery,
  readHotelRecovery,
  submitHotelRecoveryName,
} from "./hotel-recovery.ts";

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
    hotels: number;
    providers: number;
    agreements: number;
    accounts: number;
    claims: number;
  }>(
    `select
       (select count(*)::int from sbg_organisations) as orgs,
       (select count(*)::int from sbg_organisation_acceptances) as acceptances,
       (select count(*)::int from sbg_organisation_billing) as billing,
       (select count(*)::int from sbg_property_licence_allocations) as allocations,
       (select count(*)::int from bookings) as bookings,
       (select count(*)::int from hotels) as hotels,
       (select count(*)::int from providers) as providers,
       (select count(*)::int from hotel_provider_agreements) as agreements,
       (select count(*)::int from app_hotel_accounts) as accounts,
       (select count(*)::int from sbg_domain_a_checkout_claims) as claims`,
  );
  return rows.rows[0]!;
}

async function hotelRow(pg: PGlite, hotelId: string) {
  const rows = await pg.query<{ organisation_id: string | null; name: string }>(
    "select organisation_id::text as organisation_id, name from hotels where id = $1::uuid",
    [hotelId],
  );
  return rows.rows[0]!;
}

async function orgRows(pg: PGlite, userId: string) {
  const rows = await pg.query<{ name: string; organisation_type: string | null; n: number }>(
    `select name, organisation_type, count(*)::int as n
       from sbg_organisations
      where created_by_user_id = $1
      group by name, organisation_type
      order by name`,
    [userId],
  );
  return rows.rows;
}

function code(error: unknown): string {
  assert.equal(error instanceof HotelRecoveryError, true);
  return (error as HotelRecoveryError).code;
}

test("a missing business is named, explicitly classified, then linked without a new property", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const db = dbOf(pg);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const before = await effects(pg);
  const input = { db, userId: OWNER_USER.id, hotelId: hotel.hotelId };

  const missing = await readHotelRecovery(input);
  assert.deepEqual(missing, { kind: "missing", suggestedName: FIXTURE_HOTEL.name });

  const named = await submitHotelRecoveryName({ ...input, businessName: "  Aegean Hotels  " });
  assert.deepEqual(named, { kind: "classify", businessName: "Aegean Hotels" });
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, null);
  const again = await submitHotelRecoveryName({ ...input, businessName: "A different name" });
  assert.deepEqual(again, { kind: "classify", businessName: "Aegean Hotels" });
  assert.deepEqual(await orgRows(pg, OWNER_USER.id), [{ name: "Aegean Hotels", organisation_type: null, n: 1 }]);

  const classified = await classifyHotelRecovery(input);
  assert.deepEqual(classified, { kind: "attach", businessName: "Aegean Hotels" });
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, null);
  const repeatClassify = await classifyHotelRecovery(input);
  assert.deepEqual(repeatClassify, { kind: "attach", businessName: "Aegean Hotels" });

  const linked = await attachHotelRecovery(input);
  const relinked = await attachHotelRecovery(input);
  assert.deepEqual(linked, { kind: "attached" });
  assert.deepEqual(relinked, { kind: "attached" });
  const stored = await hotelRow(pg, hotel.hotelId);
  assert.equal(stored.name, FIXTURE_HOTEL.name);
  const orgId = (
    await pg.query<{ id: string }>(
      "select id::text as id from sbg_organisations where created_by_user_id = $1",
      [OWNER_USER.id],
    )
  ).rows[0]!.id;
  assert.equal(stored.organisation_id, orgId);
  assert.deepEqual(await readHotelRecovery(input), { kind: "attached" });

  const after = await effects(pg);
  assert.equal(after.orgs, before.orgs + 1);
  assert.equal(after.acceptances, before.acceptances);
  assert.equal(after.billing, before.billing);
  assert.equal(after.allocations, before.allocations);
  assert.equal(after.bookings, before.bookings);
  assert.equal(after.hotels, before.hotels);
  assert.equal(after.providers, before.providers);
  assert.equal(after.agreements, before.agreements);
  assert.equal(after.accounts, before.accounts);
  assert.equal(after.claims, before.claims);
  assert.deepEqual(await orgRows(pg, OWNER_USER.id), [{ name: "Aegean Hotels", organisation_type: "hotel", n: 1 }]);
});

test("an existing unclassified organisation is classified in place and never replaced", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const created = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'Legacy Hotels')::text as id",
    [OWNER_USER.id],
  );
  const organisationId = created.rows[0]!.id;
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const db = dbOf(pg);
  const input = { db, userId: OWNER_USER.id, hotelId: hotel.hotelId };
  const before = await effects(pg);

  assert.deepEqual(await readHotelRecovery(input), { kind: "classify", businessName: "Legacy Hotels" });
  const renamed = await submitHotelRecoveryName({ ...input, businessName: "Not Legacy" });
  assert.deepEqual(renamed, { kind: "classify", businessName: "Legacy Hotels" });
  assert.equal((await effects(pg)).orgs, before.orgs);
  assert.deepEqual(await orgRows(pg, OWNER_USER.id), [{ name: "Legacy Hotels", organisation_type: null, n: 1 }]);

  await assert.rejects(
    () => attachHotelRecovery(input),
    (error: unknown) => code(error) === "confirm_hotel",
  );
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, null);

  assert.deepEqual(await classifyHotelRecovery(input), { kind: "attach", businessName: "Legacy Hotels" });
  assert.deepEqual(await attachHotelRecovery(input), { kind: "attached" });
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, organisationId);
  assert.equal((await effects(pg)).orgs, before.orgs);
  assert.equal((await effects(pg)).acceptances, 0);
  assert.equal((await effects(pg)).hotels, before.hotels);
});

test("an already classified hotel organisation attaches without another organisation", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const db = dbOf(pg);
  await db.query("select sbg_ensure_founding_organisation($1, $2)", [OWNER_USER.id, "Kos Hotels"]);
  await db.query("select sbg_classify_founding_organisation($1, 'hotel')", [OWNER_USER.id]);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const quiet: Db = {
    query: async <T>(text: string, params?: unknown[]) => {
      if (text.includes("sbg_classify_founding_organisation") || text.includes("sbg_ensure_founding_organisation")) {
        throw new Error("recovery must not classify or create when the hotel business already exists");
      }
      return (await pg.query<T>(text, params)).rows;
    },
  };
  const input = { db: quiet, userId: OWNER_USER.id, hotelId: hotel.hotelId };
  assert.deepEqual(await readHotelRecovery(input), { kind: "attach", businessName: "Kos Hotels" });
  assert.deepEqual(await classifyHotelRecovery(input), { kind: "attach", businessName: "Kos Hotels" });
  assert.deepEqual(await attachHotelRecovery(input), { kind: "attached" });
  assert.deepEqual(await attachHotelRecovery(input), { kind: "attached" });
  assert.equal((await effects(pg)).orgs, 1);
  assert.equal((await effects(pg)).acceptances, 0);
  assert.equal((await effects(pg)).claims, 0);
});

test("a transfer operator is not linked and its type is not changed", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const db = dbOf(pg);
  await db.query("select sbg_ensure_founding_organisation($1, $2)", [OWNER_USER.id, "Island Transfers"]);
  await db.query("select sbg_classify_founding_organisation($1, 'transfer_operator')", [OWNER_USER.id]);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const before = await effects(pg);
  const input = { db, userId: OWNER_USER.id, hotelId: hotel.hotelId };

  const viewed = await readHotelRecovery(input);
  assert.equal(viewed.kind, "operator");
  await assert.rejects(
    () => classifyHotelRecovery(input),
    (error: unknown) => code(error) === "operator",
  );
  await assert.rejects(
    () => attachHotelRecovery(input),
    (error: unknown) => code(error) === "operator",
  );
  const afterName = await submitHotelRecoveryName({ ...input, businessName: "A second business" });
  assert.equal(afterName.kind, "operator");
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, null);
  assert.deepEqual(await orgRows(pg, OWNER_USER.id), [{ name: "Island Transfers", organisation_type: "transfer_operator", n: 1 }]);
  assert.equal((await effects(pg)).orgs, before.orgs);
  assert.equal((await effects(pg)).hotels, before.hotels);
  assert.equal((await effects(pg)).acceptances, 0);
});

test("ambiguous founding stops without a selector or a write", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const db = dbOf(pg);
  await pg.query("select sbg_create_organisation_for_user($1, 'First Business')", [OWNER_USER.id]);
  await pg.query("select sbg_create_organisation_for_user($1, 'Second Business')", [OWNER_USER.id]);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const before = await effects(pg);
  const input = { db, userId: OWNER_USER.id, hotelId: hotel.hotelId };

  assert.deepEqual(await readHotelRecovery(input), { kind: "support" });
  await assert.rejects(() => classifyHotelRecovery(input), (error: unknown) => code(error) === "support");
  await assert.rejects(() => attachHotelRecovery(input), (error: unknown) => code(error) === "support");
  const submitted = await submitHotelRecoveryName({ ...input, businessName: "Third Business" });
  assert.deepEqual(submitted, { kind: "support" });
  assert.equal((await effects(pg)).orgs, before.orgs);
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, null);
  assert.equal((await effects(pg)).acceptances, 0);
  assert.equal((await effects(pg)).hotels, before.hotels);
  assert.equal((await effects(pg)).providers, before.providers);
  assert.equal((await effects(pg)).claims, before.claims);
});

test("lost billing authority stops the link and does not change the hotel", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const db = dbOf(pg);
  await db.query("select sbg_ensure_founding_organisation($1, $2)", [OWNER_USER.id, "Unbilled Hotels"]);
  await db.query("select sbg_classify_founding_organisation($1, 'hotel')", [OWNER_USER.id]);
  await pg.query("update sbg_organisation_members set billing_authority = false where user_id = $1", [OWNER_USER.id]);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const before = await effects(pg);
  const input = { db, userId: OWNER_USER.id, hotelId: hotel.hotelId };

  assert.deepEqual(await readHotelRecovery(input), { kind: "support" });
  await assert.rejects(() => classifyHotelRecovery(input), (error: unknown) => code(error) === "support");
  await assert.rejects(() => attachHotelRecovery(input), (error: unknown) => code(error) === "support");
  assert.deepEqual(await submitHotelRecoveryName({ ...input, businessName: "Another Business" }), { kind: "support" });
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, null);
  assert.deepEqual(await orgRows(pg, OWNER_USER.id), [{ name: "Unbilled Hotels", organisation_type: "hotel", n: 1 }]);
  const after = await effects(pg);
  assert.equal(after.orgs, before.orgs);
  assert.equal(after.acceptances, before.acceptances);
  assert.equal(after.hotels, before.hotels);
  assert.equal(after.providers, before.providers);
  assert.equal(after.claims, before.claims);
  assert.equal(after.billing, before.billing);
});

test("an already attached hotel stays put even when founding state is ambiguous", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const legacy = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'Attached Legacy')::text as id",
    [OWNER_USER.id],
  );
  const organisationId = legacy.rows[0]!.id;
  await pg.query("select sbg_create_organisation_for_user($1, 'Extra Business')", [OWNER_USER.id]);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  await pg.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    OWNER_USER.id,
    organisationId,
    hotel.hotelId,
  ]);
  const before = await hotelRow(pg, hotel.hotelId);
  const orgsBefore = await effects(pg);
  const quiet: Db = {
    query: async <T>(text: string, params?: unknown[]) => {
      if (/sbg_attach_hotel_to_organisation|sbg_ensure_founding_organisation|sbg_classify_founding_organisation|sbg_read_founding_onboarding_state|sbg_create_organisation_for_user/.test(text)) {
        throw new Error("attached recovery must not read founding or write");
      }
      return (await pg.query<T>(text, params)).rows;
    },
  };
  const input = { db: quiet, userId: OWNER_USER.id, hotelId: hotel.hotelId };
  assert.deepEqual(await readHotelRecovery(input), { kind: "attached" });
  assert.deepEqual(await attachHotelRecovery(input), { kind: "attached" });
  await assert.rejects(
    () => submitHotelRecoveryName({ ...input, businessName: "Renamed" }),
    (error: unknown) => code(error) === "attached",
  );
  await assert.rejects(
    () => classifyHotelRecovery(input),
    (error: unknown) => code(error) === "attached",
  );
  assert.deepEqual(await hotelRow(pg, hotel.hotelId), before);
  assert.equal((await effects(pg)).orgs, orgsBefore.orgs);
  const type = await pg.query<{ organisation_type: string | null }>(
    "select organisation_type from sbg_organisations where id = $1::uuid",
    [organisationId],
  );
  assert.equal(type.rows[0]!.organisation_type, null);
  assert.equal((await effects(pg)).acceptances, 0);
});

test("another user cannot read or recover a hotel they do not own", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const before = await hotelRow(pg, hotel.hotelId);
  const input = { db: dbOf(pg), userId: OTHER_USER.id, hotelId: hotel.hotelId };
  await assert.rejects(() => readHotelRecovery(input), (error: unknown) => code(error) === "not_found");
  await assert.rejects(
    () => submitHotelRecoveryName({ ...input, businessName: "Stolen" }),
    (error: unknown) => code(error) === "not_found",
  );
  await assert.rejects(() => classifyHotelRecovery(input), (error: unknown) => code(error) === "not_found");
  await assert.rejects(() => attachHotelRecovery(input), (error: unknown) => code(error) === "not_found");
  assert.deepEqual(await hotelRow(pg, hotel.hotelId), before);
  assert.equal(
    (await pg.query<{ n: number }>("select count(*)::int as n from sbg_organisations where created_by_user_id = $1", [OTHER_USER.id])).rows[0]!.n,
    0,
  );
});

test("concurrent attachment keeps one organisation and does not reassign the hotel", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const db = dbOf(pg);
  await db.query("select sbg_ensure_founding_organisation($1, $2)", [OWNER_USER.id, "Kos Hotels"]);
  await db.query("select sbg_classify_founding_organisation($1, 'hotel')", [OWNER_USER.id]);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const before = await effects(pg);
  const organisationId = (
    await pg.query<{ id: string }>("select id::text as id from sbg_organisations where created_by_user_id = $1", [OWNER_USER.id])
  ).rows[0]!.id;

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

  const first = attachHotelRecovery({ db: racing, userId: OWNER_USER.id, hotelId: hotel.hotelId });
  await waitingToAttach;
  const second = await attachHotelRecovery({ db, userId: OWNER_USER.id, hotelId: hotel.hotelId });
  allowAttach?.();
  const firstResult = await first;
  assert.deepEqual(firstResult, { kind: "attached" });
  assert.deepEqual(second, { kind: "attached" });
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, organisationId);
  assert.equal((await effects(pg)).orgs, 1);

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
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, organisationId);
  assert.equal((await effects(pg)).acceptances, before.acceptances);
  assert.equal((await effects(pg)).billing, before.billing);
  assert.equal((await effects(pg)).claims, before.claims);
  assert.equal((await effects(pg)).hotels, before.hotels);
  assert.equal((await effects(pg)).providers, before.providers);
});

test("a classification conflict does not overwrite a transfer operator or link the hotel", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const db = dbOf(pg);
  await db.query("select sbg_ensure_founding_organisation($1, $2)", [OWNER_USER.id, "Undecided"]);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const before = await effects(pg);

  let allowClassify: (() => void) | undefined;
  const classifyAllowed = new Promise<void>((resolve) => {
    allowClassify = resolve;
  });
  let markWaiting: (() => void) | undefined;
  const waitingToClassify = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  let paused = false;
  const racing: Db = {
    query: async <T>(text: string, params?: unknown[]) => {
      if (!paused && text.includes("sbg_classify_founding_organisation")) {
        paused = true;
        markWaiting?.();
        await classifyAllowed;
      }
      return (await pg.query<T>(text, params)).rows;
    },
  };

  const attempt = classifyHotelRecovery({ db: racing, userId: OWNER_USER.id, hotelId: hotel.hotelId });
  await waitingToClassify;
  await pg.query("select sbg_classify_founding_organisation($1, 'transfer_operator')", [OWNER_USER.id]);
  allowClassify?.();
  await assert.rejects(attempt, (error: unknown) => code(error) === "operator");
  assert.equal((await hotelRow(pg, hotel.hotelId)).organisation_id, null);
  assert.deepEqual(await orgRows(pg, OWNER_USER.id), [{ name: "Undecided", organisation_type: "transfer_operator", n: 1 }]);
  assert.equal((await effects(pg)).acceptances, before.acceptances);
  assert.equal((await effects(pg)).hotels, before.hotels);
  assert.equal((await effects(pg)).providers, before.providers);
  assert.equal((await effects(pg)).claims, before.claims);
});

test("recovery source stays authenticated, explicit, and clear of property, terms, and stripe writes", () => {
  const recovery = read("src/lib/aether/hotel-recovery.ts");
  const fns = read("src/lib/aether/hotel-recovery-fns.ts");
  const route = read("src/routes/app.hotels.$hotelId.tsx");
  const founding = read("src/routes/app.founding.tsx");
  const home = read("src/routes/index.tsx");
  const forbidden = /sbg_create_hotel_for_user|sbg_create_organisation_for_user|sbg_record_founding_terms_acceptance|recordFoundingTermsAcceptance/;
  assert.doesNotMatch(recovery, forbidden);
  assert.doesNotMatch(fns, forbidden);
  assert.doesNotMatch(route, forbidden);
  assert.match(recovery, /organisationType: "hotel"/);
  assert.doesNotMatch(recovery, /organisationType:\s*input|transfer_operator"/);
  assert.match(fns, /authMiddleware/);
  assert.match(fns, /\.strict\(\)/);
  assert.doesNotMatch(fns, /organisationId|billing_authority|agreementVersion|organisationType/);
  assert.match(route, /getOnboardingState/);
  assert.match(route, /public_slug/);
  assert.match(route, /readHotelRecoveryFn/);
  assert.match(route, /recovery\.kind !== "attached"/);
  assert.match(route, /classifyHotelRecoveryFn\(\{ data: \{ hotelId \} \}\)/);
  assert.match(route, /attachHotelRecoveryFn\(\{ data: \{ hotelId \} \}\)/);
  assert.doesNotMatch(route, /\/book\//);
  assert.match(founding, /hotels\.hotels\.length > 0/);
  assert.doesNotMatch(founding, /recordFoundingTermsAcceptance/);
  assert.match(home, /href="#start"/);
  assert.doesNotMatch(home, /\/app\/founding|authClient\.signUp/);
});
