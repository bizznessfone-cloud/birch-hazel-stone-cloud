/**
 * CP30.05E-2D-2B — founding organisation is one atomic, idempotent primitive.
 * PGLite. No Production connection. No Stripe.
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
  ZERO_USER,
  createHotelForUser,
  insertAuthUser,
  openCp272PaymentDb,
} from "./cp26a4-fixture.ts";
import {
  ensureFoundingOrganisation,
  parseFoundingBusinessName,
  type FoundingOrganisation,
} from "./founding-organisation.ts";

const require = createRequire(import.meta.url);
const { ACCEPTED_LEDGER, AUTHORISED_PENDING, isAuthorisedPending } = require(
  "../../../scripts/production-db-preflight.mjs",
) as {
  ACCEPTED_LEDGER: string[];
  AUTHORISED_PENDING: string[];
  isAuthorisedPending: (name: string) => boolean;
};

const root = process.cwd();
const MIGRATION = "0033_cp3005e2d2b_founding_organisation.sql";
const DIGEST = "8880dbf93aa416e393af621957e3170da6390a6e3aef792d68fe97b709c22875";
const read = (path: string) => readFileSync(join(root, path), "utf8");
const SQL = read(`migrations/${MIGRATION}`);

type FoundRow = {
  organisation_id: string;
  name: string;
  organisation_type: string | null;
};

async function openDb(): Promise<PGlite> {
  const pg = await openCp272PaymentDb();
  await pg.exec(read("migrations/0031_cp3005e2c_organisation_type.sql"));
  await pg.exec(read("migrations/0032_cp3005e2c1_organisation_acceptance.sql"));
  await pg.exec(SQL);
  return pg;
}

async function found(pg: PGlite, userId: string, name: string): Promise<FoundRow> {
  const rows = await pg.query<FoundRow>(
    `select organisation_id::text as organisation_id, name, organisation_type
       from sbg_ensure_founding_organisation($1, $2)`,
    [userId, name],
  );
  const row = rows.rows[0];
  assert.ok(row);
  return row;
}

async function counts(pg: PGlite, userId?: string) {
  const orgs = await pg.query<{ n: number }>(
    userId
      ? "select count(*)::int as n from sbg_organisations where created_by_user_id = $1"
      : "select count(*)::int as n from sbg_organisations",
    userId ? [userId] : [],
  );
  const members = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_organisation_members where removed_at is null",
  );
  const hotels = await pg.query<{ n: number; attached: number }>(
    `select count(*)::int as n,
            count(organisation_id)::int as attached
       from hotels`,
  );
  const billing = await pg.query<{ n: number }>("select count(*)::int as n from sbg_organisation_billing");
  const allocations = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_property_licence_allocations",
  );
  const acceptances = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_organisation_acceptances",
  );
  return {
    orgs: orgs.rows[0]!.n,
    members: members.rows[0]!.n,
    hotels: hotels.rows[0]!.n,
    attached: hotels.rows[0]!.attached,
    billing: billing.rows[0]!.n,
    allocations: allocations.rows[0]!.n,
    acceptances: acceptances.rows[0]!.n,
  };
}

test("0033 is accepted history and least privilege", () => {
  assert.equal(createHash("sha256").update(SQL).digest("hex"), DIGEST);
  assert.equal(ACCEPTED_LEDGER.includes(MIGRATION), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0033_cp3005e2d2b_founding_organisation.sql");
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(MIGRATION), false);
  const preflight = read("scripts/production-db-preflight.mjs");
  assert.match(preflight, /"0033_cp3005e2d2b_founding_organisation.sql",\n\];/);
  assert.doesNotMatch(preflight, /0034_/);
  const executable = SQL.replace(/--.*$/gm, "");
  assert.match(executable, /for update/);
  assert.match(executable, /'member'/);
  assert.match(executable, /billing_authority/);
  assert.match(executable, /grant execute on function sbg_ensure_founding_organisation\(text, text\) to aether_app/);
  assert.match(executable, /revoke all on function sbg_ensure_founding_organisation\(text, text\) from public/);
  assert.match(executable, /revoke all on function sbg_ensure_founding_organisation\(text, text\) from aether_app/);
  assert.doesNotMatch(executable, /unique\s*\(\s*user_id\s*\)/i);
  assert.doesNotMatch(executable, /insert\s+into\s+(public\.)?hotels/i);
  assert.doesNotMatch(executable, /insert\s+into\s+(public\.)?sbg_organisation_billing/i);
  assert.doesNotMatch(executable, /insert\s+into\s+(public\.)?sbg_property_licence_allocations/i);
  assert.doesNotMatch(executable, /insert\s+into\s+(public\.)?sbg_organisation_acceptances/i);
  assert.doesNotMatch(executable, /organisation_type\s*=/i);
  assert.doesNotMatch(executable, /update\s+(public\.)?(sbg_|hotels)/i);
  assert.doesNotMatch(executable, /stripe|checkout|sk_live|sk_test/i);
  assert.match(read("src/lib/aether/saas-billing.server.ts"), /sbg_create_organisation_for_user/);
  assert.doesNotMatch(read("src/lib/aether/saas-billing.server.ts"), /sbg_ensure_founding_organisation/);
  const fn = read("src/lib/aether/founding-organisation-fns.ts");
  assert.match(fn, /authMiddleware/);
  assert.match(fn, /\.strict\(\)/);
  assert.match(fn, /businessName/);
  assert.doesNotMatch(fn, /user_id|created_by_user_id|billing_authority|organisation_type|hotelId|licensed_quantity|priceId/);
  for (const path of [
    "src/routes/index.tsx",
    "src/routes/login.tsx",
    "src/routes/app.onboarding.tsx",
    "src/routes/app.billing.tsx",
    "src/routes/app.index.tsx",
    "src/lib/aether/onboarding-fns.ts",
    "src/lib/aether/stripe-fns.ts",
  ]) {
    assert.doesNotMatch(read(path), /ensureFoundingOrganisation|sbg_ensure_founding_organisation/, path);
  }
});

test("an unauthenticated wrapper call is rejected before SQL", async () => {
  let queried = false;
  await assert.rejects(
    () =>
      ensureFoundingOrganisation({
        db: {
          query: async () => {
            queried = true;
            return [];
          },
        },
        userId: "  ",
        businessName: "Kos Executive Transfers",
      }),
    (err: unknown) => err instanceof Error && err.message === "Unauthorized",
  );
  assert.equal(queried, false);
  assert.throws(() => parseFoundingBusinessName("  "), /invalid organisation name/);
  assert.equal(parseFoundingBusinessName("  Kos Transfers Limited  "), "Kos Transfers Limited");
});

test("first founding call creates one unclassified organisation and one billing member", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const before = await counts(pg);
  const created = await ensureFoundingOrganisation({
    db: {
      query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
    },
    userId: OWNER_USER.id,
    businessName: "  Kos Executive Transfers  ",
  });
  assert.equal(created.name, "Kos Executive Transfers");
  assert.equal(created.organisationType, null);
  const member = await pg.query<{ role: string; billing_authority: boolean; n: number }>(
    `select role, billing_authority, count(*)::int as n
       from sbg_organisation_members
      where organisation_id = $1::uuid and user_id = $2 and removed_at is null
      group by role, billing_authority`,
    [created.organisationId, OWNER_USER.id],
  );
  assert.equal(member.rows.length, 1);
  assert.equal(member.rows[0]!.role, "member");
  assert.equal(member.rows[0]!.billing_authority, true);
  assert.equal(member.rows[0]!.n, 1);
  const after = await counts(pg, OWNER_USER.id);
  assert.equal(after.orgs, 1);
  assert.equal(after.members, before.members + 1);
  assert.equal(after.hotels, before.hotels);
  assert.equal(after.attached, 0);
  assert.equal(after.billing, 0);
  assert.equal(after.allocations, 0);
  assert.equal(after.acceptances, 0);
});

test("retry reuses the same organisation and does not rename it", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const first = await found(pg, OWNER_USER.id, "Kos Executive Transfers");
  const same = await found(pg, OWNER_USER.id, "Kos Executive Transfers");
  const renamed = await found(pg, OWNER_USER.id, "Kos Transfers 2");
  assert.equal(same.organisation_id, first.organisation_id);
  assert.equal(renamed.organisation_id, first.organisation_id);
  assert.equal(renamed.name, "Kos Executive Transfers");
  assert.equal(renamed.organisation_type, null);
  const tally = await counts(pg, OWNER_USER.id);
  assert.equal(tally.orgs, 1);
  assert.equal(tally.members, 1);
});

test("a nonexistent account is rejected and a bad name creates nothing", async () => {
  const pg = await openDb();
  const before = await counts(pg);
  await assert.rejects(
    () => found(pg, "missing-user", "Kos Executive Transfers"),
    (err: unknown) => /account not found/i.test(err instanceof Error ? err.message : String(err)),
  );
  assert.deepEqual(await counts(pg), before);
  await insertAuthUser(pg, OWNER_USER);
  await assert.rejects(() => found(pg, OWNER_USER.id, "   "), /invalid organisation name/i);
  await assert.rejects(() => found(pg, OWNER_USER.id, "A".repeat(161)), /invalid organisation name/i);
  await assert.rejects(() => found(pg, OWNER_USER.id, "Kos\nTransfers"), /invalid organisation name/i);
  assert.equal((await counts(pg, OWNER_USER.id)).orgs, 0);
});

test("overlapping founding calls for one user produce one organisation", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const same = await Promise.all([
    found(pg, OWNER_USER.id, "Kos Executive Transfers"),
    found(pg, OWNER_USER.id, "Kos Executive Transfers"),
    found(pg, OWNER_USER.id, "Kos Executive Transfers"),
  ]);
  assert.equal(new Set(same.map((row) => row.organisation_id)).size, 1);
  assert.equal((await counts(pg, OWNER_USER.id)).orgs, 1);
  assert.equal((await counts(pg, OWNER_USER.id)).members, 1);

  await insertAuthUser(pg, OTHER_USER);
  const raced = await Promise.all([
    found(pg, OTHER_USER.id, "Alpha Harbour Transfers"),
    found(pg, OTHER_USER.id, "Beta Harbour Transfers"),
  ]);
  assert.equal(raced[0]!.organisation_id, raced[1]!.organisation_id);
  assert.equal((await counts(pg, OTHER_USER.id)).orgs, 1);
  assert.ok(["Alpha Harbour Transfers", "Beta Harbour Transfers"].includes(raced[0]!.name));
  assert.equal(raced[1]!.name, raced[0]!.name);
});

test("different users found separate organisations and a second membership stays possible", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const a = await found(pg, OWNER_USER.id, "Greco Blu Hotels");
  const b = await found(pg, OTHER_USER.id, "Kos Transfers Limited");
  assert.notEqual(a.organisation_id, b.organisation_id);
  await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'operator', false)", [
    OTHER_USER.id,
    b.organisation_id,
    OWNER_USER.id,
  ]);
  const again = await found(pg, OWNER_USER.id, "Should Not Rename");
  assert.equal(again.organisation_id, a.organisation_id);
  assert.equal(again.name, "Greco Blu Hotels");
  const memberships = await pg.query<{ n: number }>(
    `select count(*)::int as n
       from sbg_organisation_members
      where user_id = $1 and removed_at is null`,
    [OWNER_USER.id],
  );
  assert.equal(memberships.rows[0]!.n, 2);
  const indexes = await pg.query<{ indexdef: string }>(
    "select indexdef from pg_indexes where tablename = 'sbg_organisation_members'",
  );
  assert.equal(
    indexes.rows.some((row) => /unique.*\(user_id\)/i.test(row.indexdef) && !/organisation_id/i.test(row.indexdef)),
    false,
  );
});

test("one existing self-service organisation is reused and is not renamed", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const legacy = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, $2)::text as id",
    [OWNER_USER.id, "Existing Operator"],
  );
  const existingId = legacy.rows[0]!.id;
  await pg.query("update sbg_organisations set organisation_type = 'transfer_operator' where id = $1::uuid", [
    existingId,
  ]);
  const reused = await found(pg, OWNER_USER.id, "Kos Transfers 2");
  assert.equal(reused.organisation_id, existingId);
  assert.equal(reused.name, "Existing Operator");
  assert.equal(reused.organisation_type, "transfer_operator");
  assert.equal((await counts(pg, OWNER_USER.id)).orgs, 1);
  assert.equal((await counts(pg)).members, 1);
});

test("ambiguous legacy founding state fails closed and does not merge", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const first = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'First')::text as id",
    [OWNER_USER.id],
  );
  const second = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'Second')::text as id",
    [OWNER_USER.id],
  );
  assert.notEqual(first.rows[0]!.id, second.rows[0]!.id);
  await assert.rejects(() => found(pg, OWNER_USER.id, "Third"), /founding organisation is ambiguous/i);
  const names = await pg.query<{ name: string }>(
    "select name from sbg_organisations where created_by_user_id = $1 order by name",
    [OWNER_USER.id],
  );
  assert.deepEqual(names.rows.map((row) => row.name), ["First", "Second"]);
});

test("a founded organisation without billing authority is not replaced", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const legacy = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, 'Dormant')::text as id",
    [OWNER_USER.id],
  );
  await pg.query(
    `update sbg_organisation_members
        set removed_at = now()
      where organisation_id = $1::uuid and user_id = $2`,
    [legacy.rows[0]!.id, OWNER_USER.id],
  );
  await assert.rejects(() => found(pg, OWNER_USER.id, "Replacement"), /founding organisation is ambiguous/i);
  assert.equal((await counts(pg, OWNER_USER.id)).orgs, 1);
});

test("a billing seat on someone else's organisation is not hijacked", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const foreign = await found(pg, OTHER_USER.id, "Other Company");
  await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'member', true)", [
    OTHER_USER.id,
    foreign.organisation_id,
    OWNER_USER.id,
  ]);
  await assert.rejects(() => found(pg, OWNER_USER.id, "My Company"), /founding organisation is ambiguous/i);
  const owners = await pg.query<{ created_by_user_id: string; name: string }>(
    "select created_by_user_id, name from sbg_organisations order by name",
  );
  assert.deepEqual(owners.rows, [{ created_by_user_id: OTHER_USER.id, name: "Other Company" }]);
});

test("a non-billing member cannot take the other organisation and can found their own", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  const foreign = await found(pg, OTHER_USER.id, "Portobello Operator");
  await pg.query("select sbg_add_organisation_member($1, $2::uuid, $3, 'operator', false)", [
    OTHER_USER.id,
    foreign.organisation_id,
    OWNER_USER.id,
  ]);
  const own = await found(pg, OWNER_USER.id, "Kos Transfers Limited");
  assert.notEqual(own.organisation_id, foreign.organisation_id);
  assert.equal(own.name, "Kos Transfers Limited");
  assert.equal(own.organisation_type, null);
  const hotelNamed = await pg.query<{ n: number }>(
    "select count(*)::int as n from hotels where name = 'Kos Transfers Limited'",
  );
  assert.equal(hotelNamed.rows[0]!.n, 0);
  const foreignStill = await pg.query<{ name: string; created_by_user_id: string }>(
    "select name, created_by_user_id from sbg_organisations where id = $1::uuid",
    [foreign.organisation_id],
  );
  assert.equal(foreignStill.rows[0]!.name, "Portobello Operator");
  assert.equal(foreignStill.rows[0]!.created_by_user_id, OTHER_USER.id);
});

test("founding does not create or attach a property and rolls back a failed membership", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, ZERO_USER);
  const hotel = await createHotelForUser(pg, OWNER_USER.id, {
    code: "portobello-royal",
    name: "Portobello Royal",
    locality: "Kos, Greece",
    ianaTimezone: "Europe/Athens",
    currency: "EUR",
  });
  const before = await pg.query<{ organisation_id: string | null; status: string; name: string }>(
    "select organisation_id::text as organisation_id, status, name from hotels where id = $1::uuid",
    [hotel.hotelId],
  );
  await found(pg, ZERO_USER.id, "Kos Transfers Limited");
  const after = await pg.query<{ organisation_id: string | null; status: string; name: string }>(
    "select organisation_id::text as organisation_id, status, name from hotels where id = $1::uuid",
    [hotel.hotelId],
  );
  assert.deepEqual(after.rows[0], before.rows[0]);
  assert.equal(after.rows[0]!.organisation_id, null);
  assert.equal(after.rows[0]!.status, "unconfigured");
  assert.equal((await counts(pg)).billing, 0);
  assert.equal((await counts(pg)).allocations, 0);
  assert.equal((await counts(pg)).acceptances, 0);

  await pg.exec(`
    create or replace function sbg_test_reject_founding_member()
    returns trigger language plpgsql as $reject$
    begin
      if new.user_id = '${OWNER_USER.id}' then
        raise exception 'blocked member' using errcode = '23514';
      end if;
      return new;
    end;
    $reject$;
  `);
  await pg.exec(`
    create trigger sbg_test_reject_founding_member
    before insert on sbg_organisation_members
    for each row execute function sbg_test_reject_founding_member();
  `);
  await assert.rejects(() => found(pg, OWNER_USER.id, "Should Roll Back"), /blocked member/i);
  const orphan = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_organisations where created_by_user_id = $1",
    [OWNER_USER.id],
  );
  assert.equal(orphan.rows[0]!.n, 0);
  await pg.exec("drop trigger sbg_test_reject_founding_member on sbg_organisation_members");
  await pg.exec("drop function sbg_test_reject_founding_member()");
});

test("aether_app may execute the primitive and still cannot write the tables", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const priv = await pg.query<{
    exec: boolean;
    org_insert: boolean;
    org_update: boolean;
    org_delete: boolean;
    member_insert: boolean;
    acl: string;
  }>(
    `select
       has_function_privilege('aether_app', 'sbg_ensure_founding_organisation(text,text)', 'execute') as exec,
       has_table_privilege('aether_app', 'sbg_organisations', 'insert') as org_insert,
       has_table_privilege('aether_app', 'sbg_organisations', 'update') as org_update,
       has_table_privilege('aether_app', 'sbg_organisations', 'delete') as org_delete,
       has_table_privilege('aether_app', 'sbg_organisation_members', 'insert') as member_insert,
       coalesce(proacl::text, '') as acl
     from pg_proc
    where proname = 'sbg_ensure_founding_organisation'`,
  );
  assert.equal(priv.rows[0]!.exec, true);
  assert.equal(priv.rows[0]!.org_insert, false);
  assert.equal(priv.rows[0]!.org_update, false);
  assert.equal(priv.rows[0]!.org_delete, false);
  assert.equal(priv.rows[0]!.member_insert, false);
  assert.match(priv.rows[0]!.acl, /aether_app=X/);
  assert.doesNotMatch(priv.rows[0]!.acl, /(^\{|,)=X\//);

  await pg.exec("begin");
  await pg.exec("set local role aether_app");
  const asApp = await pg.query<FoundRow>(
    `select organisation_id::text as organisation_id, name, organisation_type
       from sbg_ensure_founding_organisation($1, $2)`,
    [OWNER_USER.id, "App Role Founding"],
  );
  assert.equal(asApp.rows[0]!.organisation_type, null);
  await assert.rejects(
    () => pg.query("insert into sbg_organisations (name, created_by_user_id) values ('Nope', $1)", [OWNER_USER.id]),
    /permission denied/i,
  );
  await pg.exec("rollback");
  const kept = await pg.query<{ name: string }>(
    "select name from sbg_organisations where created_by_user_id = $1",
    [OWNER_USER.id],
  );
  assert.deepEqual(kept.rows.map((row) => row.name), []);
});

test("wrapper result is the stored organisation, not a second call's name", async () => {
  const pg = await openDb();
  await insertAuthUser(pg, OWNER_USER);
  const db = {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
  };
  const first: FoundingOrganisation = await ensureFoundingOrganisation({
    db,
    userId: OWNER_USER.id,
    businessName: "Kos Transfers Limited",
  });
  const second = await ensureFoundingOrganisation({
    db,
    userId: OWNER_USER.id,
    businessName: "Not The Property",
  });
  assert.equal(second.organisationId, first.organisationId);
  assert.equal(second.name, "Kos Transfers Limited");
  assert.equal(second.organisationType, null);
});
