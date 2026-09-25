/**
 * CP26C-O2 — Owner dashboard foundation.
 * PGLite + source inspection. No Production, no Stripe, no Vercel.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Sql } from "@/lib/db";
import {
  PlatformOwnerForbiddenError,
  decideOwnerGate,
  isPlatformOwner,
  requirePlatformOwner,
} from "./owner-auth.ts";
import {
  loadOwnerHotelDetail,
  loadOwnerHotels,
  loadOwnerOverview,
  loadOwnerRevenue,
} from "./owner-queries.ts";
import {
  ownerSystemHasSecretValues,
  ownerSystemSnapshot,
} from "./owner-system.ts";
import {
  OTHER_USER,
  OWNER_USER,
  PLATFORM_OWNER_USER,
  SECOND_HOTEL,
  applyBillingEvent,
  bootstrapPlatformOwner,
  createHotelForUser,
  insertAuthUser,
  onboardConfiguredFixture,
  openCp26cO2Db,
} from "./cp26a4-fixture.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

function asSql(pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql {
  const sql = (async () => {
    throw new Error("tagged-template SQL is not used in CP26C-O2 tests");
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
    const result = await pg.query(text, params);
    return result.rows as T[];
  };
  return sql;
}

async function seedDemoKos(pg: Awaited<ReturnType<typeof openCp26cO2Db>>) {
  await pg.query(
    `insert into hotels (code, name, locality, iana_timezone, currency, status)
     values ('demo-kos', 'Aether Demo Hotel', 'Kos', 'Europe/Athens', 'EUR', 'live')`,
  );
}

test("decideOwnerGate is fail-closed and does not treat session as Owner", () => {
  assert.deepEqual(decideOwnerGate({ hasSession: false, hasGrant: false }), {
    ok: false,
    reason: "unauthenticated",
  });
  assert.deepEqual(decideOwnerGate({ hasSession: false, hasGrant: true }), {
    ok: false,
    reason: "unauthenticated",
  });
  assert.deepEqual(decideOwnerGate({ hasSession: true, hasGrant: false }), {
    ok: false,
    reason: "forbidden",
  });
  assert.deepEqual(decideOwnerGate({ hasSession: true, hasGrant: true }), { ok: true });
});

test("CP26C-O2 authorization: hotel ownership and Ops membership do not grant Owner", async () => {
  const pg = await openCp26cO2Db();
  try {
    const db = asSql(pg);
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);

    assert.equal(await isPlatformOwner(db, ""), false);
    assert.equal(await isPlatformOwner(db, OWNER_USER.id), false);
    assert.equal(await isPlatformOwner(db, OTHER_USER.id), false);
    await assert.rejects(() => requirePlatformOwner(db, OWNER_USER.id), (err: unknown) => {
      assert.ok(err instanceof PlatformOwnerForbiddenError);
      assert.equal(err.status, 403);
      return true;
    });

    const ops = await pg.query<{ id: string }>(
      "insert into operators (login, password_hash) values ('sbg-test-desk', 'not-a-real-hash') returning id",
    );
    await pg.query(
      `insert into operator_memberships (operator_id, org_kind, hotel_id, access_class, active)
       values ($1::uuid, 'hotel', $2::uuid, 'hotel_desk', true)`,
      [ops.rows[0]!.id, fixture.hotelId],
    );
    assert.equal(await isPlatformOwner(db, OWNER_USER.id), false);

    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "o2 test");
    assert.equal(await isPlatformOwner(db, PLATFORM_OWNER_USER.id), true);
    await requirePlatformOwner(db, PLATFORM_OWNER_USER.id);
    assert.equal(await isPlatformOwner(db, OWNER_USER.id), false);

    await pg.query("select sbg_grant_platform_owner($1, $2, $3)", [
      PLATFORM_OWNER_USER.id,
      OTHER_USER.id,
      "second owner",
    ]);
    assert.equal(await isPlatformOwner(db, OTHER_USER.id), true);
    await pg.query("select sbg_revoke_platform_owner($1, $2, $3)", [
      PLATFORM_OWNER_USER.id,
      OTHER_USER.id,
      "revoke second",
    ]);
    assert.equal(await isPlatformOwner(db, OTHER_USER.id), false);

    await assert.rejects(
      () =>
        pg.query("select sbg_revoke_platform_owner($1, $2, $3)", [
          PLATFORM_OWNER_USER.id,
          PLATFORM_OWNER_USER.id,
          "last",
        ]),
      /last platform owner/i,
    );
    assert.equal(await isPlatformOwner(db, PLATFORM_OWNER_USER.id), true);

    const audit = await pg.query<{ action: string }>(
      "select action from sbg_owner_audit_events order by at asc",
    );
    assert.deepEqual(
      audit.rows.map((row) => row.action),
      ["owner.granted", "owner.granted", "owner.revoked"],
    );
  } finally {
    await pg.close();
  }
});

test("CP26C-O2 bootstrap is owner-plane; aether_app cannot insert grants", async () => {
  const sql = read("migrations/0025_cp26co2_platform_owners.sql");
  assert.match(sql, /create table if not exists sbg_platform_owners/);
  assert.match(sql, /create table if not exists sbg_owner_audit_events/);
  assert.match(sql, /grant select on table sbg_platform_owners to aether_app/);
  assert.match(sql, /grant select on table sbg_owner_audit_events to aether_app/);
  assert.match(sql, /grant select on table sbg_stripe_events to aether_app/);
  assert.match(sql, /sbg_bootstrap_platform_owner/);
  assert.doesNotMatch(sql, /grant execute on function sbg_bootstrap_platform_owner/i);
  assert.match(sql, /grant execute on function sbg_grant_platform_owner/);
  assert.match(sql, /cannot revoke the last platform owner/);
  assert.doesNotMatch(sql, /sbg_saas_plans/);
  assert.doesNotMatch(sql, /sbg_saas_price_versions/);
  assert.doesNotMatch(sql, /update\s+hotels/i);
  assert.doesNotMatch(sql, /SBG_SAAS_COMMERCE/);

  const pg = await openCp26cO2Db();
  try {
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await pg.exec("set role aether_app");
    await assert.rejects(
      () =>
        pg.query("insert into sbg_platform_owners (user_id, note) values ($1, 'nope')", [
          PLATFORM_OWNER_USER.id,
        ]),
      /permission denied|must be owner/i,
    );
    await assert.rejects(
      () => pg.query("select sbg_bootstrap_platform_owner($1, $2)", [PLATFORM_OWNER_USER.id, "x"]),
      /permission denied|must be owner/i,
    );
    await pg.exec("reset role");
    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id);
    const granted = await asSql(pg).query<{ user_id: string }>(
      "select user_id from sbg_platform_owners where revoked_at is null",
    );
    assert.equal(granted[0]?.user_id, PLATFORM_OWNER_USER.id);
  } finally {
    await pg.close();
  }
});

test("CP26C-O2 overview funnel excludes demo-kos and does not invent money", async () => {
  const pg = await openCp26cO2Db();
  try {
    const db = asSql(pg);
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await seedDemoKos(pg);
    const empty = await loadOwnerOverview(db);
    assert.equal(empty.operatorAccounts, 0);
    assert.equal(empty.saasHotels, 0);
    assert.equal(empty.mrr, "pending_catalogue");
    assert.equal(empty.arr, "pending_catalogue");
    assert.equal(empty.planDistribution, "pending_catalogue");
    assert.equal(empty.funnel.account, 0);

    const first = await onboardConfiguredFixture(pg, OWNER_USER.id);
    await applyBillingEvent(pg, first.hotelId, "active");
    await createHotelForUser(pg, OTHER_USER.id, SECOND_HOTEL);

    const overview = await loadOwnerOverview(db);
    assert.equal(overview.operatorAccounts, 2);
    assert.equal(overview.saasHotels, 2);
    assert.equal(overview.signups7d, 2);
    assert.equal(overview.signups30d, 2);
    assert.equal(overview.configured, 1);
    assert.equal(overview.unconfigured, 1);
    assert.equal(overview.live, 0);
    assert.equal(overview.subscribed, 1);
    assert.equal(overview.activeSubscriptions, 1);
    assert.equal(overview.funnel.account, 2);
    assert.equal(overview.funnel.hotelCreated, 2);
    assert.equal(overview.funnel.configured, 1);
    assert.equal(overview.funnel.subscribed, 1);
    assert.equal(overview.funnel.live, 0);
    assert.equal(overview.mrr, "pending_catalogue");
    const json = JSON.stringify(overview);
    assert.doesNotMatch(json, /amount_minor/);
    assert.doesNotMatch(json, /777777/);
    assert.equal(
      overview.recentSignups.some((row) => row.hotelCode === "demo-kos"),
      false,
    );

    const hotels = await loadOwnerHotels(db);
    assert.equal(hotels.length, 2);
    assert.equal(
      hotels.some((row) => row.code === "demo-kos"),
      false,
    );
    const search = await loadOwnerHotels(db, { q: "rhodes" });
    assert.equal(search.length, 1);
    assert.equal(search[0]?.code, SECOND_HOTEL.code);
    const liveOnly = await loadOwnerHotels(db, { status: "live" });
    assert.equal(liveOnly.length, 0);

    const detail = await loadOwnerHotelDetail(db, first.hotelId);
    assert.ok(detail);
    assert.equal(detail.status, "configured");
    assert.equal(detail.billing.entitled, true);
    assert.equal(detail.billing.status, "active");
    assert.equal(detail.owners[0]?.email, OWNER_USER.email);

    const missing = await loadOwnerHotelDetail(db, "00000000-0000-4000-8000-000000000000");
    assert.equal(missing, null);
    const demo = await pg.query<{ id: string }>("select id from hotels where code = 'demo-kos'");
    const demoDetail = await loadOwnerHotelDetail(db, demo.rows[0]!.id);
    assert.equal(demoDetail, null);

    const revenue = await loadOwnerRevenue(db);
    assert.equal(revenue.domain, "A");
    assert.equal(revenue.caption, "SBG SaaS");
    assert.equal(revenue.active, 1);
    assert.equal(revenue.entitled, 1);
    assert.equal(revenue.mrr, "pending_catalogue");
    assert.equal(revenue.arr, "pending_catalogue");
    assert.doesNotMatch(JSON.stringify(revenue), /amount_minor/);
  } finally {
    await pg.close();
  }
});

test("CP26C-O2 system health never returns secrets or allowlist raw ids", () => {
  const snapshot = ownerSystemSnapshot({
    SBG_SAAS_COMMERCE: "off",
    STRIPE_SECRET_KEY: "sk_live_this_must_never_appear",
    STRIPE_WEBHOOK_SECRET: "whsec_this_must_never_appear",
    BETTER_AUTH_SECRET: "super-secret",
    DATABASE_URL: "postgres://neondb.example/neondb",
    SBG_SAAS_TEST_HOTEL_IDS: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    STRIPE_BASIC_PRICE_ID: "price_secret_basic",
  });
  assert.equal(snapshot.commerceMode, "off");
  assert.equal(snapshot.stripeSecret, "live");
  assert.equal(snapshot.webhookSecret, "PRESENT");
  assert.equal(snapshot.priceEnv.STRIPE_BASIC_PRICE_ID, "PRESENT");
  assert.equal(snapshot.priceEnv.STRIPE_PRO_PRICE_ID, "ABSENT");
  assert.equal(snapshot.testAllowlist.status, "configured");
  assert.equal(snapshot.testAllowlist.count, 1);
  assert.equal(ownerSystemHasSecretValues(snapshot), false);
  const json = JSON.stringify(snapshot);
  assert.doesNotMatch(json, /sk_live_this_must_never_appear/);
  assert.doesNotMatch(json, /whsec_/);
  assert.doesNotMatch(json, /postgres:\/\//);
  assert.doesNotMatch(json, /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
  assert.doesNotMatch(json, /price_secret_basic/);
  assert.match(snapshot.caption, /CP31/);

  const absent = ownerSystemSnapshot({});
  assert.equal(absent.commerceMode, "off");
  assert.equal(absent.stripeSecret, "absent");
  assert.equal(absent.testAllowlist.status, "absent");
});

test("CP26C-O2 source: protected /owner shell, no commerce mutation, no Domain B revenue", () => {
  const ownerRoute = read("src/routes/owner.tsx");
  const session = read("src/lib/auth/owner-session.ts");
  const auth = read("src/lib/aether/owner-auth.ts");
  const fns = read("src/lib/aether/owner-fns.ts");
  const queries = read("src/lib/aether/owner-queries.ts");
  const system = read("src/lib/aether/owner-system.ts");
  const overview = read("src/routes/owner.index.tsx");
  const hotels = read("src/routes/owner.hotels.index.tsx");
  const detail = read("src/routes/owner.hotels.$hotelId.tsx");
  const plans = read("src/routes/owner.plans.tsx");
  const revenue = read("src/routes/owner.revenue.tsx");
  const systemRoute = read("src/routes/owner.system.tsx");
  const shell = read("src/components/aether/owner-shell.tsx");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  assert.match(ownerRoute, /getOwnerAccess/);
  assert.match(ownerRoute, /redirect\(\s*\{\s*to:\s*"\/login"/);
  assert.match(ownerRoute, /PlatformOwnerForbiddenError/);
  assert.doesNotMatch(ownerRoute, /to:\s*"\/app"/);
  assert.match(session, /getSessionUser/);
  assert.doesNotMatch(auth, /app_hotel_accounts/);
  assert.doesNotMatch(auth, /operator_memberships/);
  assert.doesNotMatch(auth, /user\.email|email\s*===|allowlist/);
  assert.match(fns, /authMiddleware/);
  assert.equal((fns.match(/createServerFn\(/g) ?? []).length, 10);
  assert.equal((fns.match(/await requirePlatformOwner/g) ?? []).length, 10);
  assert.doesNotMatch(queries, /sbg_booking_payments/);
  assert.doesNotMatch(fns, /sbg_booking_payments/);
  assert.doesNotMatch(overview, /sbg_booking_payments/);
  assert.doesNotMatch(revenue, /sbg_booking_payments/);
  assert.match(queries, /pending_catalogue/);
  assert.match(plans, /Price not configured/);
  assert.match(plans, /No price version has been created for this plan yet/);
  assert.match(plans, /LIVE commerce locked until CP31/);
  assert.doesNotMatch(plans, /pending_o3|pending catalogue/i);
  assert.doesNotMatch(plans, /amountMinor|59|69|29/);
  assert.match(systemRoute, /CP31/);
  assert.doesNotMatch(systemRoute, /GO LIVE|goLive|SBG_SAAS_COMMERCE\s*=/);
  assert.doesNotMatch(shell, /GO LIVE/);
  assert.doesNotMatch(detail, /impersonateOperator|goLive\(/);
  assert.doesNotMatch(hotels, /impersonateOperator|goLive\(/);
  for (const src of [fns, queries, system, ownerRoute, overview, revenue, systemRoute]) {
    assert.doesNotMatch(src, /process\.env\.SBG_SAAS_COMMERCE\s*=/);
    assert.doesNotMatch(src, /SBG_SAAS_COMMERCE\s*=\s*['"]test['"]/);
    assert.doesNotMatch(src, /SBG_SAAS_COMMERCE\s*=\s*['"]live['"]/);
  }
  assert.match(pkg.scripts["test:aether"], /cp26co2\.test\.ts/);
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.equal(
    pkg.scripts["db:migrate:0025"],
    "node scripts/cp26co2a-0025-production-migrate.mjs",
  );
  assert.doesNotMatch(pkg.scripts["db:migrate:0025"] ?? "", /production-db-migrate/);
  assert.equal(pkg.scripts["db:bootstrap:first-owner"], undefined);
  assert.doesNotMatch(pkg.scripts.build, /bootstrap:first-owner/);

  const files = readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.includes("0025_cp26co2_platform_owners.sql"));
  const preflight = read("scripts/production-db-preflight.mjs");
  assert.match(preflight, /0024_cp26b2_ordered_billing_events\.sql/);
  assert.match(preflight, /0025_cp26co2_platform_owners\.sql/);
  assert.match(preflight, /AUTHORISED_PENDING = \[\]/);
});
