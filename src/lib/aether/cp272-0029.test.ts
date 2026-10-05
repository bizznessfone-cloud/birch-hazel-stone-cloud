/**
 * CP27.2 — 0029 Domain A checkout claims. PGLite only.
 * No Production connection, no Stripe API, no commerce change.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  OTHER_USER,
  OWNER_USER,
  ZERO_USER,
  createHotelForUser,
  insertAuthUser,
  openCp26finDb,
  FIXTURE_HOTEL,
} from "./cp26a4-fixture.ts";

const root = process.cwd();
const MIGRATION = "0029_cp272_domain_a_checkout_claims.sql";
const SQL = readFileSync(join(root, "migrations", MIGRATION), "utf8");
const SESSION = "cs_test_claim_a";
const SESSION_URL = "https://checkout.stripe.test/c/pay/cs_test_claim_a";
const OTHER_SESSION = "cs_test_claim_b";
const OTHER_URL = "https://checkout.stripe.test/c/pay/cs_test_claim_b";

type ClaimRow = {
  outcome: string;
  claim_token: string | null;
  stripe_checkout_session_id: string | null;
  stripe_checkout_url: string | null;
};

async function rejects(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(run, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, pattern);
    return true;
  });
}

async function org(pg: PGlite, userId: string, name: string): Promise<string> {
  const rows = await pg.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, $2)::text as id",
    [userId, name],
  );
  const id = rows.rows[0]?.id;
  if (!id) throw new Error("organisation was not created");
  return id;
}

async function claim(
  pg: PGlite,
  userId: string,
  organisationId: string,
  quantity: number,
  ttl = 60,
): Promise<ClaimRow> {
  const rows = await pg.query<ClaimRow>(
    "select * from sbg_claim_domain_a_checkout($1, $2::uuid, $3::integer, $4::integer)",
    [userId, organisationId, quantity, ttl],
  );
  const row = rows.rows[0];
  if (!row) throw new Error("claim returned no row");
  return row;
}

async function counts(pg: PGlite) {
  const hotels = await pg.query<{ code: string; status: string }>(
    "select code, status from hotels order by code",
  );
  const licensed = await pg.query<{ n: number }>(
    "select coalesce(sum(licensed_quantity), 0)::int as n from sbg_organisation_billing",
  );
  const allocations = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_property_licence_allocations",
  );
  const payments = await pg.query<{ n: number }>("select count(*)::int as n from sbg_booking_payments");
  return {
    hotels: hotels.rows,
    licensed: licensed.rows[0]!.n,
    allocations: allocations.rows[0]!.n,
    payments: payments.rows[0]!.n,
  };
}

test("0029 is accepted history and does not touch commerce rows", () => {
  const files = readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(files.filter((name) => name.startsWith("0029")).join(","), MIGRATION);
  assert.equal(files.includes("0030_later.sql"), false);
  const preflight = readFileSync(join(root, "scripts/production-db-preflight.mjs"), "utf8");
  assert.match(preflight, /"0029_cp272_domain_a_checkout_claims.sql",/);
  assert.match(preflight, /"0032_cp3005e2c1_organisation_acceptance.sql",\n\];/);
  assert.match(preflight, /AUTHORISED_PENDING = \[\];/);
  assert.equal(
    createHash("sha256").update(SQL).digest("hex"),
    "e5897eda1a4f3c8c4025e16235b9d11a677b3cc7994934058142934d4dea7adc",
  );
  assert.match(SQL, /set search_path = pg_catalog, public/);
  assert.match(SQL, /for update/);
  assert.doesNotMatch(SQL, /update\s+hotels/i);
  assert.doesNotMatch(SQL, /update\s+[\w.]*sbg_organisation_billing/i);
  assert.doesNotMatch(SQL, /insert\s+into\s+[\w.]*sbg_organisation_billing/i);
  assert.doesNotMatch(SQL, /sbg_property_licence_allocations/);
  assert.doesNotMatch(SQL, /sbg_booking_payments/);
  assert.doesNotMatch(SQL, /sk_live_|STRIPE_SECRET|DATABASE_URL|AETHER_DATABASE_OWNER_URL/);
  const workflows = readdirSync(join(root, ".github/workflows"));
  assert.equal(workflows.includes("cp272-0029-production-migrate.yml"), false);
});

test("0029 checkout claim state machine", async () => {
  const pg = await openCp26finDb();
  await pg.exec(SQL);
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  await insertAuthUser(pg, ZERO_USER);
  const before = await counts(pg);

  const hotel = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
  const hotelStatus = (
    await pg.query<{ status: string }>("select status from hotels where id = $1::uuid", [hotel.hotelId])
  ).rows[0]!.status;

  const quantity1 = await org(pg, OWNER_USER.id, "Qty One");
  const won1 = await claim(pg, OWNER_USER.id, quantity1, 1);
  assert.equal(won1.outcome, "claimed");
  assert.ok(won1.claim_token);

  const quantity49 = await org(pg, OWNER_USER.id, "Qty Forty Nine");
  const won49 = await claim(pg, OWNER_USER.id, quantity49, 49);
  assert.equal(won49.outcome, "claimed");
  assert.notEqual(won49.claim_token, won1.claim_token);

  await rejects(() => claim(pg, OWNER_USER.id, quantity1, 0), /quantity is not authorised/);
  await rejects(() => claim(pg, OWNER_USER.id, quantity1, 50), /quantity is not authorised/);
  await rejects(
    () =>
      pg.exec(
        `select * from sbg_claim_domain_a_checkout('${OWNER_USER.id}', '${quantity1}'::uuid, 1.5, 60)`,
      ),
    /does not exist|quantity is not authorised|invalid input/i,
  );

  const stranger = await org(pg, OWNER_USER.id, "Closed Org");
  await rejects(
    () => claim(pg, "missing-user", stranger, 2),
    /billing authority required/,
  );
  await rejects(() => claim(pg, ZERO_USER.id, stranger, 2), /billing authority required/);
  await pg.query(
    "select sbg_add_organisation_member($1, $2::uuid, $3, 'member', false)",
    [OWNER_USER.id, stranger, OTHER_USER.id],
  );
  await rejects(() => claim(pg, OTHER_USER.id, stranger, 2), /billing authority required/);
  const strangerClaims = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_domain_a_checkout_claims where organisation_id = $1::uuid",
    [stranger],
  );
  assert.equal(strangerClaims.rows[0]!.n, 0);

  const blocked = await org(pg, OWNER_USER.id, "Subscribed Org");
  await pg.query(
    `insert into sbg_organisation_billing (organisation_id, status, billing_interval, licensed_quantity)
     values ($1::uuid, 'active', 'month', 3)`,
    [blocked],
  );
  const blockedResult = await claim(pg, OWNER_USER.id, blocked, 3);
  assert.equal(blockedResult.outcome, "subscription_exists");
  assert.equal(blockedResult.claim_token, null);
  const blockedRows = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_domain_a_checkout_claims where organisation_id = $1::uuid",
    [blocked],
  );
  assert.equal(blockedRows.rows[0]!.n, 0);
  const stillLicensed = await pg.query<{ licensed_quantity: number }>(
    "select licensed_quantity from sbg_organisation_billing where organisation_id = $1::uuid",
    [blocked],
  );
  assert.equal(stillLicensed.rows[0]!.licensed_quantity, 3);

  const same = await org(pg, OWNER_USER.id, "Same Org");
  const other = await org(pg, OWNER_USER.id, "Other Org");
  const [first, second, foreign] = await Promise.all([
    claim(pg, OWNER_USER.id, same, 4),
    claim(pg, OWNER_USER.id, same, 5),
    claim(pg, OWNER_USER.id, other, 6),
  ]);
  const sameOutcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(sameOutcomes, ["busy", "claimed"]);
  assert.equal(foreign.outcome, "claimed");
  assert.ok(foreign.claim_token);
  const winner = first.outcome === "claimed" ? first : second;
  const loser = first.outcome === "busy" ? first : second;
  assert.equal(loser.claim_token, null);
  const stored = await pg.query<{ claim_token: string; quantity: number }>(
    "select claim_token::text, quantity from sbg_domain_a_checkout_claims where organisation_id = $1::uuid",
    [same],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0]!.claim_token, winner.claim_token);
  const again = await claim(pg, OWNER_USER.id, same, 7);
  assert.equal(again.outcome, "busy");
  assert.equal(again.claim_token, null);
  const still = await pg.query<{ claim_token: string }>(
    "select claim_token::text from sbg_domain_a_checkout_claims where organisation_id = $1::uuid",
    [same],
  );
  assert.equal(still.rows[0]!.claim_token, winner.claim_token);

  const defs = await pg.query<{ def: string }>(
    "select pg_get_functiondef('sbg_claim_domain_a_checkout(text,uuid,integer,integer)'::regprocedure) as def",
  );
  assert.match(defs.rows[0]!.def, /sbg_organisations[\s\S]*for update/i);
  assert.match(defs.rows[0]!.def, /search_path (TO|=) 'pg_catalog', 'public'|search_path = pg_catalog, public/i);

  const expiring = await org(pg, OWNER_USER.id, "Expiring Org");
  const old = await claim(pg, OWNER_USER.id, expiring, 2);
  await pg.query(
    `update sbg_domain_a_checkout_claims
        set expires_at = clock_timestamp() - interval '1 minute'
      where organisation_id = $1::uuid`,
    [expiring],
  );
  const replaced = await claim(pg, OWNER_USER.id, expiring, 8);
  assert.equal(replaced.outcome, "claimed");
  assert.notEqual(replaced.claim_token, old.claim_token);

  const releasable = await org(pg, OWNER_USER.id, "Release Org");
  const held = await claim(pg, OWNER_USER.id, releasable, 3);
  await rejects(
    () =>
      pg.query("select sbg_release_domain_a_checkout_claim($1, $2::uuid, $3::uuid)", [
        OWNER_USER.id,
        releasable,
        "00000000-0000-4000-8000-000000000099",
      ]),
    /token mismatch/,
  );
  const kept = await pg.query<{ claim_token: string; state: string }>(
    "select claim_token::text, state from sbg_domain_a_checkout_claims where organisation_id = $1::uuid",
    [releasable],
  );
  assert.equal(kept.rows[0]!.claim_token, held.claim_token);
  assert.equal(kept.rows[0]!.state, "claimed");
  const released = await pg.query<{ sbg_release_domain_a_checkout_claim: string }>(
    "select sbg_release_domain_a_checkout_claim($1, $2::uuid, $3::uuid)",
    [OWNER_USER.id, releasable, held.claim_token],
  );
  assert.equal(released.rows[0]!.sbg_release_domain_a_checkout_claim, "released");
  await rejects(
    () =>
      pg.query("select sbg_attach_domain_a_checkout_session($1, $2::uuid, $3::uuid, $4, $5)", [
        OWNER_USER.id,
        releasable,
        held.claim_token,
        SESSION,
        SESSION_URL,
      ]),
    /expired/,
  );
  const afterRelease = await claim(pg, OWNER_USER.id, releasable, 3);
  assert.equal(afterRelease.outcome, "claimed");

  const payable = await org(pg, OWNER_USER.id, "Attach Org");
  const open = await claim(pg, OWNER_USER.id, payable, 9);
  await rejects(
    () =>
      pg.query("select sbg_attach_domain_a_checkout_session($1, $2::uuid, $3::uuid, $4, $5)", [
        OWNER_USER.id,
        payable,
        "00000000-0000-4000-8000-000000000088",
        SESSION,
        SESSION_URL,
      ]),
    /token mismatch/,
  );
  await rejects(
    () =>
      pg.query("select sbg_attach_domain_a_checkout_session($1, $2::uuid, $3::uuid, $4, $5)", [
        OWNER_USER.id,
        other,
        open.claim_token,
        SESSION,
        SESSION_URL,
      ]),
    /token mismatch/,
  );
  const attached = await pg.query<{ sbg_attach_domain_a_checkout_session: string }>(
    "select sbg_attach_domain_a_checkout_session($1, $2::uuid, $3::uuid, $4, $5)",
    [OWNER_USER.id, payable, open.claim_token, SESSION, SESSION_URL],
  );
  assert.equal(attached.rows[0]!.sbg_attach_domain_a_checkout_session, "attached");
  const againAttached = await pg.query<{ sbg_attach_domain_a_checkout_session: string }>(
    "select sbg_attach_domain_a_checkout_session($1, $2::uuid, $3::uuid, $4, $5)",
    [OWNER_USER.id, payable, open.claim_token, SESSION, SESSION_URL],
  );
  assert.equal(againAttached.rows[0]!.sbg_attach_domain_a_checkout_session, "attached");
  await rejects(
    () =>
      pg.query("select sbg_attach_domain_a_checkout_session($1, $2::uuid, $3::uuid, $4, $5)", [
        OWNER_USER.id,
        payable,
        open.claim_token,
        OTHER_SESSION,
        OTHER_URL,
      ]),
    /already attached/,
  );
  await rejects(
    () =>
      pg.query("select sbg_release_domain_a_checkout_claim($1, $2::uuid, $3::uuid)", [
        OWNER_USER.id,
        payable,
        open.claim_token,
      ]),
    /cannot be released/,
  );
  await pg.query(
    `update sbg_domain_a_checkout_claims
        set expires_at = clock_timestamp() - interval '1 day'
      where organisation_id = $1::uuid`,
    [payable],
  );
  const afterTtl = await claim(pg, OWNER_USER.id, payable, 1);
  assert.equal(afterTtl.outcome, "session_attached");
  assert.equal(afterTtl.claim_token, null);
  assert.equal(afterTtl.stripe_checkout_session_id, SESSION);
  const stillAttached = await pg.query<{ state: string; n: number }>(
    `select state, count(*)::int as n
       from sbg_domain_a_checkout_claims
      where organisation_id = $1::uuid
      group by state`,
    [payable],
  );
  assert.equal(stillAttached.rows.length, 1);
  assert.equal(stillAttached.rows[0]!.state, "session_attached");
  assert.equal(stillAttached.rows[0]!.n, 1);

  const afterHotel = await pg.query<{ status: string }>(
    "select status from hotels where id = $1::uuid",
    [hotel.hotelId],
  );
  assert.equal(afterHotel.rows[0]!.status, hotelStatus);

  const privileges = await pg.query<{
    app_select: boolean;
    app_insert: boolean;
    app_update: boolean;
    app_delete: boolean;
    public_claim: boolean;
    public_attach: boolean;
    public_release: boolean;
    app_claim: boolean;
    app_attach: boolean;
    app_release: boolean;
    runtime_insert: boolean;
    runtime_execute: boolean;
  }>(
    `select has_table_privilege('aether_app', 'public.sbg_domain_a_checkout_claims', 'SELECT') as app_select,
            has_table_privilege('aether_app', 'public.sbg_domain_a_checkout_claims', 'INSERT') as app_insert,
            has_table_privilege('aether_app', 'public.sbg_domain_a_checkout_claims', 'UPDATE') as app_update,
            has_table_privilege('aether_app', 'public.sbg_domain_a_checkout_claims', 'DELETE') as app_delete,
            has_function_privilege('public', 'sbg_claim_domain_a_checkout(text,uuid,integer,integer)', 'EXECUTE') as public_claim,
            has_function_privilege('public', 'sbg_attach_domain_a_checkout_session(text,uuid,uuid,text,text)', 'EXECUTE') as public_attach,
            has_function_privilege('public', 'sbg_release_domain_a_checkout_claim(text,uuid,uuid)', 'EXECUTE') as public_release,
            has_function_privilege('aether_app', 'sbg_claim_domain_a_checkout(text,uuid,integer,integer)', 'EXECUTE') as app_claim,
            has_function_privilege('aether_app', 'sbg_attach_domain_a_checkout_session(text,uuid,uuid,text,text)', 'EXECUTE') as app_attach,
            has_function_privilege('aether_app', 'sbg_release_domain_a_checkout_claim(text,uuid,uuid)', 'EXECUTE') as app_release,
            has_table_privilege('aether_runtime', 'public.sbg_domain_a_checkout_claims', 'INSERT') as runtime_insert,
            has_function_privilege('aether_runtime', 'sbg_claim_domain_a_checkout(text,uuid,integer,integer)', 'EXECUTE') as runtime_execute`,
  );
  const priv = privileges.rows[0]!;
  assert.equal(priv.app_select, true);
  assert.equal(priv.app_insert, false);
  assert.equal(priv.app_update, false);
  assert.equal(priv.app_delete, false);
  assert.equal(priv.public_claim, false);
  assert.equal(priv.public_attach, false);
  assert.equal(priv.public_release, false);
  assert.equal(priv.app_claim, true);
  assert.equal(priv.app_attach, true);
  assert.equal(priv.app_release, true);
  assert.equal(priv.runtime_insert, false);
  assert.equal(priv.runtime_execute, false);

  async function deniedAsApp(sqlText: string, params: unknown[]): Promise<void> {
    await pg.transaction(async (tx) => {
      await tx.exec("set local role aether_app");
      await rejects(() => tx.query(sqlText, params), /permission denied/i);
    });
  }

  await deniedAsApp(
    `insert into sbg_domain_a_checkout_claims (
       organisation_id, claimed_by_user_id, quantity, claim_token, state, expires_at
     ) values ($1::uuid, $2, 1, gen_random_uuid(), 'claimed', clock_timestamp() + interval '1 minute')`,
    [payable, OWNER_USER.id],
  );
  await deniedAsApp(
    "update sbg_domain_a_checkout_claims set quantity = 1 where organisation_id = $1::uuid",
    [payable],
  );
  await deniedAsApp(
    "delete from sbg_domain_a_checkout_claims where organisation_id = $1::uuid",
    [payable],
  );

  const after = await counts(pg);
  assert.equal(after.licensed, before.licensed + 3);
  assert.equal(after.allocations, before.allocations);
  assert.equal(after.payments, before.payments);
  const hotelRow = after.hotels.find((row) => row.code === FIXTURE_HOTEL.code);
  assert.equal(hotelRow?.status, hotelStatus);
});
