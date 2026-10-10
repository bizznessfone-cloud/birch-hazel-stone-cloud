/**
 * CP30.05E-2D-2D A1 — authenticated founding journey.
 * PGLite and source checks. No Production connection. No Stripe. No Terms write.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  OTHER_USER,
  OWNER_USER,
  createHotelForUser,
  insertAuthUser,
  openCp272PaymentDb,
} from "./cp26a4-fixture.ts";
import {
  classifyFoundingOrganisation,
  readFoundingOnboardingState,
  type FoundingOnboardingError,
} from "./founding-onboarding.ts";
import { ensureFoundingOrganisation } from "./founding-organisation.ts";
import {
  AMBIGUOUS_MESSAGE,
  BUSINESS_QUESTION,
  TERMS_PENDING_TITLE,
  TYPE_QUESTION,
  allowsFirstPropertyCreation,
  foundingCustomerMessage,
  foundingGate,
} from "./founding-journey.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

type Db = {
  query: <T>(text: string, params?: unknown[]) => Promise<T[]>;
};

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

function code(err: unknown): string {
  assert.equal(err instanceof Error && err.name, "FoundingOnboardingError");
  return (err as FoundingOnboardingError).code;
}

async function sideEffects(pg: PGlite) {
  const rows = await pg.query<{
    orgs: number;
    members: number;
    acceptances: number;
    hotels: number;
    providers: number;
    vehicles: number;
    drivers: number;
    billing: number;
    allocations: number;
  }>(
    `select
       (select count(*)::int from sbg_organisations) as orgs,
       (select count(*)::int from sbg_organisation_members) as members,
       (select count(*)::int from sbg_organisation_acceptances) as acceptances,
       (select count(*)::int from hotels) as hotels,
       (select count(*)::int from providers) as providers,
       (select count(*)::int from vehicles) as vehicles,
       (select count(*)::int from drivers) as drivers,
       (select count(*)::int from sbg_organisation_billing) as billing,
       (select count(*)::int from sbg_property_licence_allocations) as allocations`,
  );
  return rows.rows[0]!;
}

test("the founding gate fails closed and keeps hotel customers in their workspace", () => {
  assert.deepEqual(foundingGate({ hotelCount: 0, founding: { status: "missing" } }), { kind: "business-name" });
  assert.deepEqual(foundingGate({ hotelCount: 0, founding: null }), { kind: "unavailable" });
  assert.deepEqual(foundingGate({ hotelCount: -1, founding: { status: "missing" } }), { kind: "unavailable" });
  assert.deepEqual(foundingGate({ hotelCount: 1.5, founding: { status: "missing" } }), { kind: "unavailable" });
  assert.deepEqual(foundingGate({ hotelCount: 0, founding: { status: "ambiguous" } }), { kind: "ambiguous" });
  const ready = {
    status: "ready" as const,
    organisationId: "org-1",
    organisationType: null,
    termsVersion: "terms-v1" as const,
    termsAccepted: false,
  };
  assert.deepEqual(foundingGate({ hotelCount: 0, founding: ready }), { kind: "classify" });
  assert.deepEqual(
    foundingGate({ hotelCount: 0, founding: { ...ready, organisationType: "hotel" } }),
    { kind: "terms-pending", organisationType: "hotel" },
  );
  assert.deepEqual(
    foundingGate({ hotelCount: 0, founding: { ...ready, organisationType: "transfer_operator", termsAccepted: true } }),
    { kind: "terms-pending", organisationType: "transfer_operator" },
  );
  for (const founding of [null, { status: "missing" as const }, { status: "ambiguous" as const }, ready, { ...ready, organisationType: "hotel" as const }]) {
    assert.deepEqual(foundingGate({ hotelCount: 2, founding }), { kind: "existing-workspace" });
  }
  assert.equal(allowsFirstPropertyCreation(0), false);
  assert.equal(allowsFirstPropertyCreation(1), true);
  assert.equal(foundingCustomerMessage(new Error("invalid organisation name")), "Enter a business name using ordinary letters, numbers, and punctuation.");
  assert.match(foundingCustomerMessage(new Error("organisation type is already set")), /already has a type/);
  assert.equal(foundingCustomerMessage(new Error("founding organisation is ambiguous")), AMBIGUOUS_MESSAGE);
  assert.equal(foundingCustomerMessage(new Error("Unauthorized")), "Sign in to continue.");
  assert.equal(BUSINESS_QUESTION, "What is your business called?");
  assert.equal(TYPE_QUESTION, "What best describes your business?");
  assert.equal(TERMS_PENDING_TITLE, "Terms are not available yet");
});

test("an unauthenticated founding call is rejected before SQL", async () => {
  let queried = false;
  const db: Db = {
    query: async () => {
      queried = true;
      return [];
    },
  };
  await assert.rejects(
    () => ensureFoundingOrganisation({ db, userId: " ", businessName: "Blue Lagoon Hotel" }),
    /Unauthorized/,
  );
  await assert.rejects(
    () => classifyFoundingOrganisation({ db, userId: "", organisationType: "hotel" }),
    (err: unknown) => code(err) === "unauthorized",
  );
  await assert.rejects(
    () => readFoundingOnboardingState({ db, userId: undefined }),
    (err: unknown) => code(err) === "unauthorized",
  );
  assert.equal(queried, false);
});

test("a new founder creates one organisation, classifies once, and writes no terms or property", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const before = await sideEffects(pg);
  const db = dbOf(pg);
  assert.deepEqual(await readFoundingOnboardingState({ db, userId: OWNER_USER.id }), { status: "missing" });
  assert.deepEqual(foundingGate({ hotelCount: 0, founding: { status: "missing" } }), { kind: "business-name" });

  const created = await ensureFoundingOrganisation({
    db,
    userId: OWNER_USER.id,
    businessName: "  Blue Lagoon Hotel  ",
  });
  const resumed = await ensureFoundingOrganisation({
    db,
    userId: OWNER_USER.id,
    businessName: "Not a second organisation",
  });
  assert.equal(resumed.organisationId, created.organisationId);
  assert.equal(resumed.name, "Blue Lagoon Hotel");
  assert.equal(resumed.organisationType, null);
  const unclassified = await readFoundingOnboardingState({ db, userId: OWNER_USER.id });
  assert.equal(unclassified.status, "ready");
  assert.equal(foundingGate({ hotelCount: 0, founding: unclassified }).kind, "classify");

  const hotel = await classifyFoundingOrganisation({ db, userId: OWNER_USER.id, organisationType: "hotel" });
  const hotelAgain = await classifyFoundingOrganisation({ db, userId: OWNER_USER.id, organisationType: "hotel" });
  assert.equal(hotelAgain.organisationId, hotel.organisationId);
  await assert.rejects(
    () => classifyFoundingOrganisation({ db, userId: OWNER_USER.id, organisationType: "transfer_operator" }),
    (err: unknown) => code(err) === "conflict",
  );
  const hotelState = await readFoundingOnboardingState({ db, userId: OWNER_USER.id });
  assert.equal(hotelState.status, "ready");
  assert.equal(foundingGate({ hotelCount: 0, founding: hotelState }).kind, "terms-pending");
  if (hotelState.status === "ready") {
    assert.equal(hotelState.organisationType, "hotel");
    assert.equal(hotelState.termsAccepted, false);
  }

  const operator = await ensureFoundingOrganisation({
    db,
    userId: OTHER_USER.id,
    businessName: "Blue Lagoon Hotel",
  });
  assert.notEqual(operator.organisationId, created.organisationId);
  await classifyFoundingOrganisation({ db, userId: OTHER_USER.id, organisationType: "transfer_operator" });
  const operatorState = await readFoundingOnboardingState({ db, userId: OTHER_USER.id });
  assert.equal(operatorState.status, "ready");
  assert.deepEqual(foundingGate({ hotelCount: 0, founding: operatorState }), {
    kind: "terms-pending",
    organisationType: "transfer_operator",
  });
  if (operatorState.status === "ready") assert.equal(operatorState.termsAccepted, false);

  const effects = await sideEffects(pg);
  assert.equal(effects.orgs - before.orgs, 2);
  assert.equal(effects.members - before.members, 2);
  assert.equal(effects.acceptances, before.acceptances);
  assert.equal(effects.hotels, before.hotels);
  assert.equal(effects.providers, before.providers);
  assert.equal(effects.vehicles, before.vehicles);
  assert.equal(effects.drivers, before.drivers);
  assert.equal(effects.billing, before.billing);
  assert.equal(effects.allocations, before.allocations);
  assert.equal(effects.acceptances, 0);
});

test("ambiguous founding state is not classified and an existing hotel customer is not mutated", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const db = dbOf(pg);
  await pg.query("select sbg_create_organisation_for_user($1, 'First')", [OWNER_USER.id]);
  await pg.query("select sbg_create_organisation_for_user($1, 'Second')", [OWNER_USER.id]);
  const ambiguous = await readFoundingOnboardingState({ db, userId: OWNER_USER.id });
  assert.deepEqual(ambiguous, { status: "ambiguous" });
  assert.deepEqual(foundingGate({ hotelCount: 0, founding: ambiguous }), { kind: "ambiguous" });
  await assert.rejects(
    () => classifyFoundingOrganisation({ db, userId: OWNER_USER.id, organisationType: "hotel" }),
    (err: unknown) => code(err) === "ambiguous",
  );
  await assert.rejects(
    () => ensureFoundingOrganisation({ db, userId: OWNER_USER.id, businessName: "Third" }),
    /ambiguous/i,
  );
  const types = await pg.query<{ organisation_type: string | null }>(
    "select organisation_type from sbg_organisations where created_by_user_id = $1 order by name",
    [OWNER_USER.id],
  );
  assert.deepEqual(types.rows.map((row) => row.organisation_type), [null, null]);

  const hotel = await createHotelForUser(pg, OTHER_USER.id, {
    code: "blue-lagoon",
    name: "Blue Lagoon Hotel",
    locality: "Kos, Greece",
    ianaTimezone: "Europe/Athens",
    currency: "EUR",
  });
  const accounts = await pg.query<{ n: number }>(
    "select count(*)::int as n from app_hotel_accounts where user_id = $1",
    [OTHER_USER.id],
  );
  assert.equal(accounts.rows[0]!.n, 1);
  const customer = await readFoundingOnboardingState({ db, userId: OTHER_USER.id });
  assert.deepEqual(customer, { status: "missing" });
  assert.deepEqual(foundingGate({ hotelCount: accounts.rows[0]!.n, founding: customer }), { kind: "existing-workspace" });
  assert.equal(allowsFirstPropertyCreation(accounts.rows[0]!.n), true);
  const stored = await pg.query<{ organisation_id: string | null; name: string }>(
    "select organisation_id::text as organisation_id, name from hotels where id = $1::uuid",
    [hotel.hotelId],
  );
  assert.equal(stored.rows[0]!.name, "Blue Lagoon Hotel");
  assert.equal(stored.rows[0]!.organisation_id, null);
  const customerOrgs = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_organisations where created_by_user_id = $1",
    [OTHER_USER.id],
  );
  assert.equal(customerOrgs.rows[0]!.n, 0);
  assert.equal((await sideEffects(pg)).acceptances, 0);
});

test("A1 routes call founding create, classify, and read, and stop before later stages", () => {
  const founding = read("src/routes/app.founding.tsx");
  const index = read("src/routes/app.index.tsx");
  const onboarding = read("src/routes/app.onboarding.tsx");
  const billing = read("src/routes/app.billing.tsx");
  const onboardingFns = read("src/lib/aether/onboarding-fns.ts");
  const billingServer = read("src/lib/aether/saas-billing.server.ts");
  const home = read("src/routes/index.tsx");
  const app = read("src/routes/app.tsx");
  const tree = read("src/routeTree.gen.ts");
  const styles = read("src/styles.css");

  assert.match(app, /if \(!session\.ok\) throw redirect\(\{ to: "\/login" \}\)/);
  assert.match(tree, /fullPath: '\/app\/founding'/);
  assert.match(tree, /parentRoute: typeof AppRoute/);
  assert.match(founding, /createFileRoute\("\/app\/founding"\)/);
  assert.match(founding, /ensureFoundingOrganisationFn/);
  assert.match(founding, /classifyFoundingOrganisationFn/);
  assert.match(founding, /readFoundingOnboardingStateFn/);
  assert.match(founding, /BUSINESS_QUESTION/);
  assert.match(founding, /TYPE_QUESTION/);
  assert.match(founding, /TERMS_PENDING_TITLE/);
  assert.match(founding, /Hotel \/ Accommodation/);
  assert.match(founding, /Independent Transfer Operator/);
  assert.match(founding, /Terms are not yet available for acceptance/);
  assert.match(founding, /htmlFor="business-name"/);
  assert.match(founding, /min-h-12/);
  assert.match(founding, /aria-invalid/);
  assert.match(founding, /role="alert"/);
  assert.match(founding, /aria-busy/);
  assert.match(founding, /disabled=\{busy/);
  assert.doesNotMatch(founding, /recordFoundingTermsAcceptance|sbg_record_founding_terms_acceptance/);
  assert.doesNotMatch(founding, /ensureHotelOrganisation|createOnboardingHotel|sbg_create_organisation_for_user/);
  assert.doesNotMatch(founding, /stripe|checkout|sk_live|sk_test/i);
  assert.doesNotMatch(founding, /gradient|glow|animate-/);
  assert.doesNotMatch(founding.slice(founding.indexOf("function TermsPending")), /<button/);
  assert.match(styles, /Outfit/);
  assert.match(styles, /:focus-visible/);

  assert.match(index, /to: "\/app\/hotels\/\$hotelId"/);
  assert.match(index, /to: "\/app\/founding"/);
  assert.doesNotMatch(index, /to: "\/app\/onboarding"/);
  assert.doesNotMatch(index, /ensureFoundingOrganisation|sbg_ensure_founding_organisation|founding-onboarding/);
  assert.match(onboarding, /result\.hotels\.length === 0[\s\S]*throw redirect\(\{ to: "\/app\/founding" \}\)/);
  assert.match(onboarding, /createOnboardingHotel/);
  assert.match(billing, /hotels\.hotels\.length === 0[\s\S]*throw redirect\(\{ to: "\/app\/founding" \}\)/);
  assert.match(billing, /if \(!access\.ok\)/);
  assert.match(billing, /ensureHotelOrganisationFn/);
  assert.match(onboardingFns, /count\(\*\)::int as n from app_hotel_accounts/);
  assert.match(onboardingFns, /code: "business_setup"/);
  assert.match(onboardingFns, /Finish business setup before adding a property\./);
  const guardAt = onboardingFns.indexOf('code: "business_setup"');
  const createAt = onboardingFns.indexOf("sbg_create_hotel_for_user");
  assert.ok(guardAt >= 0 && createAt > guardAt);

  assert.doesNotMatch(billingServer, /sbg_create_organisation_for_user|sbg_ensure_founding_organisation|sbg_classify_founding_organisation|sbg_record_founding_terms_acceptance/);
  assert.match(billingServer, /readFoundingOnboardingState/);
  assert.match(billingServer, /sbg_attach_hotel_to_organisation/);
  assert.match(read("src/lib/aether/founding-onboarding-fns.ts"), /export const recordFoundingTermsAcceptanceFn/);
  assert.doesNotMatch(home, /\/app\/founding|authClient\.signUp/);
  assert.match(home, /href="#start"/);
});
