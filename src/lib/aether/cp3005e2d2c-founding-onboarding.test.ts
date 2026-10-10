/**
 * CP30.05E-2D-2C — founding classification and provisional terms acceptance.
 * PGLite. No Production connection. No Stripe. One connection is not a
 * two-session race.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  OTHER_USER,
  OWNER_USER,
  PLATFORM_OWNER_USER,
  ZERO_USER,
  createHotelForUser,
  insertAuthUser,
  openCp272PaymentDb,
} from "./cp26a4-fixture.ts";
import {
  classifyFoundingOrganisation,
  parseFoundingOrganisationType,
  PROVISIONAL_TERMS_VERSION,
  readFoundingOnboardingState,
  recordFoundingTermsAcceptance,
  type FoundingOnboardingError,
} from "./founding-onboarding.ts";
import { isAgreementVersion } from "./organisation-acceptance.ts";

const require = createRequire(import.meta.url);
const { ACCEPTED_LEDGER, AUTHORISED_PENDING, isAuthorisedPending } = require(
  "../../../scripts/production-db-preflight.mjs",
) as {
  ACCEPTED_LEDGER: string[];
  AUTHORISED_PENDING: string[];
  isAuthorisedPending: (name: string) => boolean;
};

const root = process.cwd();
const MIGRATION = "0034_cp3005e2d2c_founding_classification_acceptance.sql";
const DIGEST = "3a80e2ec5ff9ab474c8dabf562fe8e3e37b8fcaa77ef7e8467bd0127afdc433c";
const read = (path: string) => readFileSync(join(root, path), "utf8");
const SQL = read(`migrations/${MIGRATION}`);

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
  await pg.exec(SQL);
  return pg;
}

async function found(pg: PGlite, userId: string, name: string) {
  const rows = await pg.query<{ organisation_id: string; name: string; organisation_type: string | null }>(
    `select organisation_id::text as organisation_id, name, organisation_type
       from sbg_ensure_founding_organisation($1, $2)`,
    [userId, name],
  );
  const row = rows.rows[0];
  assert.ok(row);
  return row;
}

async function member(pg: PGlite, organisationId: string, userId: string) {
  const rows = await pg.query<{ role: string; billing_authority: boolean }>(
    `select role, billing_authority
       from sbg_organisation_members
      where organisation_id = $1::uuid and user_id = $2 and removed_at is null`,
    [organisationId, userId],
  );
  return rows.rows[0];
}

async function acceptanceCount(pg: PGlite) {
  const rows = await pg.query<{ n: number }>("select count(*)::int as n from sbg_organisation_acceptances");
  return rows.rows[0]!.n;
}

function code(err: unknown): string {
  assert.equal(err instanceof Error && err.name, "FoundingOnboardingError");
  return (err as FoundingOnboardingError).code;
}

test("0034 is accepted history and least privilege", () => {
  assert.equal(createHash("sha256").update(SQL).digest("hex"), DIGEST);
  assert.equal(ACCEPTED_LEDGER.includes(MIGRATION), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0034_cp3005e2d2c_founding_classification_acceptance.sql");
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(MIGRATION), false);
  const preflight = read("scripts/production-db-preflight.mjs");
  assert.match(preflight, /"0034_cp3005e2d2c_founding_classification_acceptance.sql",\n\];/);
  const executable = SQL.replace(/--.*$/gm, "");
  assert.match(executable, /for update/);
  assert.match(executable, /'terms-v1'/);
  assert.match(executable, /on conflict \(organisation_id, accepted_by_user_id, agreement_version\) do nothing/);
  assert.match(executable, /grant execute on function sbg_classify_founding_organisation\(text, text\) to aether_app/);
  assert.match(executable, /grant execute on function sbg_record_founding_terms_acceptance\(text\) to aether_app/);
  assert.match(executable, /grant execute on function sbg_read_founding_onboarding_state\(text\) to aether_app/);
  assert.doesNotMatch(executable, /grant execute on function sbg_founding_onboarding_target\(text\) to aether_app/);
  assert.doesNotMatch(executable, /grant\s+(select|insert|update|delete|truncate)/i);
  assert.doesNotMatch(executable, /insert\s+into\s+(public\.)?hotels/i);
  assert.doesNotMatch(executable, /insert\s+into\s+(public\.)?sbg_organisation_billing/i);
  assert.doesNotMatch(executable, /sbg_property_licence_allocations/);
  assert.doesNotMatch(executable, /stripe|checkout|sk_live|sk_test/i);
  assert.doesNotMatch(executable, /update\s+(public\.)?sbg_organisation_members/i);
  assert.equal(isAgreementVersion(PROVISIONAL_TERMS_VERSION), true);
  assert.equal(PROVISIONAL_TERMS_VERSION, "terms-v1");
  const fn = read("src/lib/aether/founding-onboarding-fns.ts");
  assert.match(fn, /authMiddleware/);
  assert.match(fn, /\.strict\(\)/);
  assert.match(fn, /organisationType: z\.enum\(\["hotel", "transfer_operator"\]\)/);
  assert.match(fn, /z\.object\(\{\}\)\.strict\(\)/);
  assert.doesNotMatch(fn, /agreementVersion:|acceptedAt:|organisationId:|hotelId:|billing_authority:/);
  assert.doesNotMatch(read("src/lib/aether/founding-organisation.ts"), /sbg_classify_founding_organisation|sbg_record_founding_terms_acceptance/);
  assert.doesNotMatch(read("src/lib/aether/founding-organisation-fns.ts"), /recordFoundingTermsAcceptance|classifyFoundingOrganisation/);
  assert.match(read("src/lib/aether/saas-billing.server.ts"), /sbg_create_organisation_for_user/);
  assert.doesNotMatch(read("src/lib/aether/saas-billing.server.ts"), /sbg_classify_founding_organisation|sbg_record_founding_terms_acceptance/);
  for (const path of [
    "src/routes/index.tsx",
    "src/routes/login.tsx",
    "src/routes/app.onboarding.tsx",
    "src/routes/app.billing.tsx",
    "src/routes/app.index.tsx",
    "src/lib/aether/onboarding-fns.ts",
    "src/lib/aether/stripe-fns.ts",
  ]) {
    assert.doesNotMatch(read(path), /founding-onboarding|sbg_classify_founding_organisation|sbg_record_founding_terms_acceptance/, path);
  }
  const foundingRoute = read("src/routes/app.founding.tsx");
  assert.match(foundingRoute, /ensureFoundingOrganisationFn/);
  assert.match(foundingRoute, /classifyFoundingOrganisationFn/);
  assert.match(foundingRoute, /readFoundingOnboardingStateFn/);
  assert.doesNotMatch(
    foundingRoute,
    /recordFoundingTermsAcceptance|sbg_record_founding_terms_acceptance|ensureHotelOrganisation|createOnboardingHotel|sbg_create_organisation_for_user|stripe/i,
  );
});

test("an unauthenticated wrapper call is rejected before SQL", async () => {
  let queried = false;
  const db: Db = {
    query: async () => {
      queried = true;
      return [];
    },
  };
  await assert.rejects(() => classifyFoundingOrganisation({ db, userId: " ", organisationType: "hotel" }), (err: unknown) => {
    assert.equal(code(err), "unauthorized");
    return true;
  });
  await assert.rejects(() => recordFoundingTermsAcceptance({ db, userId: "" }), (err: unknown) => {
    assert.equal(code(err), "unauthorized");
    return true;
  });
  await assert.rejects(() => readFoundingOnboardingState({ db, userId: undefined }), (err: unknown) => {
    assert.equal(code(err), "unauthorized");
    return true;
  });
  assert.equal(queried, false);
  assert.equal(parseFoundingOrganisationType("hotel"), "hotel");
  assert.throws(() => parseFoundingOrganisationType("Hotel"), (err: unknown) => code(err) === "invalid_type");
  assert.throws(() => parseFoundingOrganisationType("operator"), (err: unknown) => code(err) === "invalid_type");
  assert.throws(() => parseFoundingOrganisationType("member"), (err: unknown) => code(err) === "invalid_type");
});

test("a founder can classify hotel without creating a property or an acceptance", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const created = await found(pg, OWNER_USER.id, "Kos Transfers Limited");
  const hotel = await createHotelForUser(pg, OWNER_USER.id, {
    code: "portobello-royal",
    name: "Portobello Royal",
    locality: "Kos, Greece",
    ianaTimezone: "Europe/Athens",
    currency: "EUR",
  });
  const beforeHotel = await pg.query<{ organisation_id: string | null; status: string }>(
    "select organisation_id::text as organisation_id, status from hotels where id = $1::uuid",
    [hotel.hotelId],
  );
  const classified = await classifyFoundingOrganisation({
    db: dbOf(pg),
    userId: OWNER_USER.id,
    organisationType: "hotel",
  });
  assert.equal(classified.organisationId, created.organisation_id);
  assert.equal(classified.organisationType, "hotel");
  assert.deepEqual(await member(pg, created.organisation_id, OWNER_USER.id), {
    role: "member",
    billing_authority: true,
  });
  assert.equal(await acceptanceCount(pg), 0);
  const state = await readFoundingOnboardingState({ db: dbOf(pg), userId: OWNER_USER.id });
  assert.deepEqual(state, {
    status: "ready",
    organisationId: created.organisation_id,
    organisationType: "hotel",
    termsVersion: "terms-v1",
    termsAccepted: false,
  });
  assert.equal(await acceptanceCount(pg), 0);
  const afterHotel = await pg.query<{ organisation_id: string | null; status: string }>(
    "select organisation_id::text as organisation_id, status from hotels where id = $1::uuid",
    [hotel.hotelId],
  );
  assert.deepEqual(afterHotel.rows[0], beforeHotel.rows[0]);
  assert.equal(afterHotel.rows[0]!.organisation_id, null);
  const side = await pg.query<{ billing: number; allocations: number }>(
    `select (select count(*)::int from sbg_organisation_billing) as billing,
            (select count(*)::int from sbg_property_licence_allocations) as allocations`,
  );
  assert.deepEqual(side.rows[0], { billing: 0, allocations: 0 });
  const named = await pg.query<{ n: number }>("select count(*)::int as n from hotels where name = 'Kos Transfers Limited'");
  assert.equal(named.rows[0]!.n, 0);
});

test("transfer_operator classification is idempotent and a conflicting type is rejected", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const created = await found(pg, OWNER_USER.id, "Kos Transfers Limited");
  const first = await classifyFoundingOrganisation({
    db: dbOf(pg),
    userId: OWNER_USER.id,
    organisationType: "transfer_operator",
  });
  const second = await classifyFoundingOrganisation({
    db: dbOf(pg),
    userId: OWNER_USER.id,
    organisationType: "transfer_operator",
  });
  assert.equal(second.organisationId, first.organisationId);
  assert.equal(second.organisationType, "transfer_operator");
  await assert.rejects(
    () => classifyFoundingOrganisation({ db: dbOf(pg), userId: OWNER_USER.id, organisationType: "hotel" }),
    (err: unknown) => code(err) === "conflict",
  );
  const stored = await pg.query<{ organisation_type: string; role: string }>(
    `select o.organisation_type, m.role
       from sbg_organisations o
       join sbg_organisation_members m on m.organisation_id = o.id and m.removed_at is null
      where o.id = $1::uuid`,
    [created.organisation_id],
  );
  assert.equal(stored.rows[0]!.organisation_type, "transfer_operator");
  assert.equal(stored.rows[0]!.role, "member");
  assert.equal(await acceptanceCount(pg), 0);
});

test("illegal types and a missing founding organisation create nothing", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await assert.rejects(
    () => pg.query("select * from sbg_classify_founding_organisation($1, $2)", [OWNER_USER.id, "operator"]),
    /invalid organisation type/i,
  );
  await assert.rejects(
    () => pg.query("select * from sbg_classify_founding_organisation($1, $2)", [OWNER_USER.id, "terms-v1"]),
    /invalid organisation type/i,
  );
  await assert.rejects(
    () => classifyFoundingOrganisation({ db: dbOf(pg), userId: OWNER_USER.id, organisationType: "hotel" }),
    (err: unknown) => code(err) === "missing",
  );
  await assert.rejects(
    () => pg.query("select * from sbg_classify_founding_organisation($1, $2)", ["missing-user", "hotel"]),
    /account not found/i,
  );
  const state = await readFoundingOnboardingState({ db: dbOf(pg), userId: OWNER_USER.id });
  assert.deepEqual(state, { status: "missing" });
  assert.equal(
    (await pg.query<{ n: number }>("select count(*)::int as n from sbg_organisations")).rows[0]!.n,
    0,
  );
  assert.equal(await acceptanceCount(pg), 0);
});

test("overlapping conflicting classification keeps one type on one connection", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const created = await found(pg, OWNER_USER.id, "Greco Blu Hotels");
  const settled = await Promise.allSettled([
    classifyFoundingOrganisation({ db: dbOf(pg), userId: OWNER_USER.id, organisationType: "hotel" }),
    classifyFoundingOrganisation({ db: dbOf(pg), userId: OWNER_USER.id, organisationType: "transfer_operator" }),
  ]);
  const fulfilled = settled.filter((row) => row.status === "fulfilled");
  const rejected = settled.filter((row) => row.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(code(rejected[0] && rejected[0].status === "rejected" ? rejected[0].reason : null), "conflict");
  const stored = await pg.query<{ organisation_type: string }>(
    "select organisation_type from sbg_organisations where id = $1::uuid",
    [created.organisation_id],
  );
  assert.equal(stored.rows.length, 1);
  assert.ok(stored.rows[0]!.organisation_type === "hotel" || stored.rows[0]!.organisation_type === "transfer_operator");
  assert.equal(stored.rows[0]!.organisation_type, fulfilled[0] && fulfilled[0].status === "fulfilled" ? fulfilled[0].value.organisationType : "");
  assert.deepEqual(await member(pg, created.organisation_id, OWNER_USER.id), {
    role: "member",
    billing_authority: true,
  });
});

test("ambiguous legacy founding state fails closed and does not merge", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const first = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'First')::text as id",
    [OWNER_USER.id],
  );
  const second = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'Second')::text as id",
    [OWNER_USER.id],
  );
  await assert.rejects(
    () => classifyFoundingOrganisation({ db: dbOf(pg), userId: OWNER_USER.id, organisationType: "hotel" }),
    (err: unknown) => code(err) === "ambiguous",
  );
  const state = await readFoundingOnboardingState({ db: dbOf(pg), userId: OWNER_USER.id });
  assert.deepEqual(state, { status: "ambiguous" });
  const types = await pg.query<{ organisation_type: string | null }>(
    "select organisation_type from sbg_organisations where id = any($1::uuid[])",
    [[first.rows[0]!.id, second.rows[0]!.id]],
  );
  assert.deepEqual(types.rows.map((row) => row.organisation_type), [null, null]);
  assert.equal(await acceptanceCount(pg), 0);

  const dormant = await found(pg, OTHER_USER.id, "Dormant");
  await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'member', true)", [
    OTHER_USER.id,
    dormant.organisation_id,
    OWNER_USER.id,
  ]);
  await pg.query("select sbg_remove_organisation_member($1, $2::uuid, $3)", [
    OWNER_USER.id,
    dormant.organisation_id,
    OTHER_USER.id,
  ]);
  await assert.rejects(
    () => classifyFoundingOrganisation({ db: dbOf(pg), userId: OTHER_USER.id, organisationType: "hotel" }),
    (err: unknown) => code(err) === "ambiguous",
  );
  const still = await pg.query<{ organisation_type: string | null }>(
    "select organisation_type from sbg_organisations where id = $1::uuid",
    [dormant.organisation_id],
  );
  assert.equal(still.rows[0]!.organisation_type, null);
});

test("another organisation cannot be hijacked by a billing or non-billing member", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  await insertAuthUser(pg, ZERO_USER);
  await insertAuthUser(pg, PLATFORM_OWNER_USER);
  const own = await found(pg, OWNER_USER.id, "Kos Transfers Limited");
  const foreign = await found(pg, OTHER_USER.id, "Portobello Operator");
  await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'member', true)", [
    OTHER_USER.id,
    foreign.organisation_id,
    PLATFORM_OWNER_USER.id,
  ]);
  await assert.rejects(
    () =>
      classifyFoundingOrganisation({
        db: dbOf(pg),
        userId: PLATFORM_OWNER_USER.id,
        organisationType: "hotel",
      }),
    (err: unknown) => code(err) === "ambiguous",
  );
  await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'member', false)", [
    OTHER_USER.id,
    foreign.organisation_id,
    ZERO_USER.id,
  ]);
  await assert.rejects(
    () => classifyFoundingOrganisation({ db: dbOf(pg), userId: ZERO_USER.id, organisationType: "hotel" }),
    (err: unknown) => code(err) === "missing",
  );
  await assert.rejects(
    () => recordFoundingTermsAcceptance({ db: dbOf(pg), userId: ZERO_USER.id }),
    (err: unknown) => code(err) === "missing",
  );
  await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'member', true)", [
    OTHER_USER.id,
    foreign.organisation_id,
    OWNER_USER.id,
  ]);
  const classified = await classifyFoundingOrganisation({
    db: dbOf(pg),
    userId: OWNER_USER.id,
    organisationType: "transfer_operator",
  });
  assert.equal(classified.organisationId, own.organisation_id);
  const types = await pg.query<{ id: string; organisation_type: string | null }>(
    "select id::text as id, organisation_type from sbg_organisations",
  );
  assert.equal(types.rows.find((row) => row.id === foreign.organisation_id)?.organisation_type, null);
  assert.equal(types.rows.find((row) => row.id === own.organisation_id)?.organisation_type, "transfer_operator");
  assert.equal(await acceptanceCount(pg), 0);
});

test("explicit terms acceptance is one idempotent row and only after classification", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const created = await found(pg, OWNER_USER.id, "Kos Transfers Limited");
  await assert.rejects(
    () => recordFoundingTermsAcceptance({ db: dbOf(pg), userId: OWNER_USER.id }),
    (err: unknown) => code(err) === "unclassified",
  );
  assert.equal(await acceptanceCount(pg), 0);
  await classifyFoundingOrganisation({ db: dbOf(pg), userId: OWNER_USER.id, organisationType: "hotel" });
  const unread = await readFoundingOnboardingState({ db: dbOf(pg), userId: OWNER_USER.id });
  assert.equal(unread.status, "ready");
  assert.equal(unread.status === "ready" && unread.termsAccepted, false);
  assert.equal(await acceptanceCount(pg), 0);

  const accepted = await recordFoundingTermsAcceptance({ db: dbOf(pg), userId: OWNER_USER.id });
  assert.equal(accepted.organisationId, created.organisation_id);
  assert.equal(accepted.agreementVersion, "terms-v1");
  assert.equal(accepted.alreadyAccepted, false);
  const row = await pg.query<{
    organisation_id: string;
    accepted_by_user_id: string;
    agreement_version: string;
    accepted_at: string;
    n: number;
  }>(
    `select organisation_id::text as organisation_id, accepted_by_user_id, agreement_version,
            accepted_at::text as accepted_at, count(*)::int as n
       from sbg_organisation_acceptances
      group by organisation_id, accepted_by_user_id, agreement_version, accepted_at`,
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0]!.organisation_id, created.organisation_id);
  assert.equal(row.rows[0]!.accepted_by_user_id, OWNER_USER.id);
  assert.equal(row.rows[0]!.agreement_version, "terms-v1");
  assert.equal(row.rows[0]!.n, 1);
  const columns = await pg.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_name = 'sbg_organisation_acceptances' order by column_name`,
  );
  assert.deepEqual(
    columns.rows.map((item) => item.column_name),
    ["accepted_at", "accepted_by_user_id", "agreement_version", "id", "organisation_id"],
  );

  const again = await recordFoundingTermsAcceptance({ db: dbOf(pg), userId: OWNER_USER.id });
  assert.equal(again.alreadyAccepted, true);
  const still = await pg.query<{ n: number; accepted_at: string }>(
    "select count(*)::int as n, min(accepted_at)::text as accepted_at from sbg_organisation_acceptances",
  );
  assert.equal(still.rows[0]!.n, 1);
  assert.equal(still.rows[0]!.accepted_at, row.rows[0]!.accepted_at);
  const after = await readFoundingOnboardingState({ db: dbOf(pg), userId: OWNER_USER.id });
  assert.equal(after.status === "ready" && after.termsAccepted, true);
  assert.equal(await acceptanceCount(pg), 1);

  await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'member', true)", [
    OWNER_USER.id,
    created.organisation_id,
    OTHER_USER.id,
  ]);
  await assert.rejects(
    () => recordFoundingTermsAcceptance({ db: dbOf(pg), userId: OTHER_USER.id }),
    (err: unknown) => code(err) === "ambiguous",
  );
  const onlyOwner = await pg.query<{ accepted_by_user_id: string }>(
    "select accepted_by_user_id from sbg_organisation_acceptances",
  );
  assert.deepEqual(onlyOwner.rows.map((item) => item.accepted_by_user_id), [OWNER_USER.id]);

  await assert.rejects(
    () => pg.query("update sbg_organisation_acceptances set agreement_version = 'privacy-v1'"),
    /immutable/i,
  );
  await assert.rejects(() => pg.query("delete from sbg_organisation_acceptances"), /immutable/i);
  await assert.rejects(() => pg.exec("truncate sbg_organisation_acceptances"), /immutable/i);
  assert.equal(await acceptanceCount(pg), 1);
  assert.deepEqual(await member(pg, created.organisation_id, OWNER_USER.id), {
    role: "member",
    billing_authority: true,
  });
});

test("aether_app may execute the wrappers and still cannot write the tables", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await found(pg, OWNER_USER.id, "Kos Transfers Limited");
  const priv = await pg.query<{
    classify: boolean;
    accept: boolean;
    read: boolean;
    target: boolean;
    insert: boolean;
    update: boolean;
    del: boolean;
    select: boolean;
    acl: string;
    target_acl: string;
  }>(
    `select
       has_function_privilege('aether_app', 'sbg_classify_founding_organisation(text,text)', 'execute') as classify,
       has_function_privilege('aether_app', 'sbg_record_founding_terms_acceptance(text)', 'execute') as accept,
       has_function_privilege('aether_app', 'sbg_read_founding_onboarding_state(text)', 'execute') as read,
       has_function_privilege('aether_app', 'sbg_founding_onboarding_target(text)', 'execute') as target,
       has_table_privilege('aether_app', 'sbg_organisation_acceptances', 'insert') as insert,
       has_table_privilege('aether_app', 'sbg_organisation_acceptances', 'update') as update,
       has_table_privilege('aether_app', 'sbg_organisation_acceptances', 'delete') as del,
       has_table_privilege('aether_app', 'sbg_organisation_acceptances', 'select') as select,
       coalesce((select proacl::text from pg_proc where proname = 'sbg_classify_founding_organisation'), '') as acl,
       coalesce((select proacl::text from pg_proc where proname = 'sbg_founding_onboarding_target'), '') as target_acl`,
  );
  assert.equal(priv.rows[0]!.classify, true);
  assert.equal(priv.rows[0]!.accept, true);
  assert.equal(priv.rows[0]!.read, true);
  assert.equal(priv.rows[0]!.target, false);
  assert.equal(priv.rows[0]!.insert, false);
  assert.equal(priv.rows[0]!.update, false);
  assert.equal(priv.rows[0]!.del, false);
  assert.equal(priv.rows[0]!.select, false);
  assert.match(priv.rows[0]!.acl, /aether_app=X/);
  assert.doesNotMatch(priv.rows[0]!.acl, /(^\{|,)=X\//);
  assert.doesNotMatch(priv.rows[0]!.target_acl, /aether_app=X/);
  assert.doesNotMatch(priv.rows[0]!.target_acl, /(^\{|,)=X\//);

  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  await assert.rejects(() => pg.query("select * from sbg_founding_onboarding_target($1)", [OWNER_USER.id]), /permission denied/i);
  await pg.exec("rollback");

  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  const classified = await pg.query<{ organisation_type: string }>(
    "select organisation_type from sbg_classify_founding_organisation($1, $2)",
    [OWNER_USER.id, "hotel"],
  );
  assert.equal(classified.rows[0]!.organisation_type, "hotel");
  await assert.rejects(
    () => pg.query("update sbg_organisations set organisation_type = 'transfer_operator'"),
    /permission denied/i,
  );
  await pg.exec("rollback");

  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  await assert.rejects(
    () =>
      pg.query(
        `insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version)
         values ((select id from sbg_organisations limit 1), $1, 'terms-v1')`,
        [OWNER_USER.id],
      ),
    /permission denied/i,
  );
  await pg.exec("rollback");
  const rolled = await pg.query<{ organisation_type: string | null }>(
    "select organisation_type from sbg_organisations where created_by_user_id = $1",
    [OWNER_USER.id],
  );
  assert.equal(rolled.rows[0]!.organisation_type, null);
  assert.equal(await acceptanceCount(pg), 0);

  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  await pg.query("select organisation_type from sbg_classify_founding_organisation($1, $2)", [OWNER_USER.id, "hotel"]);
  await pg.query("select agreement_version from sbg_record_founding_terms_acceptance($1)", [OWNER_USER.id]);
  const seen = await pg.query<{ terms_accepted: boolean }>(
    "select terms_accepted from sbg_read_founding_onboarding_state($1)",
    [OWNER_USER.id],
  );
  assert.equal(seen.rows[0]!.terms_accepted, true);
  await pg.exec("commit");
  assert.equal(await acceptanceCount(pg), 1);
});
