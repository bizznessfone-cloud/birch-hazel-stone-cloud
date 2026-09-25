/**
 * CP26C-O3.2 — commercial catalogue migration, isolated PGLite only.
 * Synthetic minor amounts below are attack probes, not BASIC/PRO/PREMIUM prices.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { saasCommerceMode } from "./saas-commerce.server.ts";
import {
  OTHER_USER,
  OWNER_USER,
  PLATFORM_OWNER_USER,
  bootstrapPlatformOwner,
  insertAuthUser,
  openCp26cO32Db,
} from "./cp26a4-fixture.ts";

const SYNTH_A = 1111;
const SYNTH_B = 2222;
const PRICE_A = "price_sbg_o32_synth_a";
const PRICE_B = "price_sbg_o32_synth_b";
const PRICE_LIVE = "price_sbg_o32_synth_live";
const PRODUCT = "prod_sbg_o32_synth";

const RUNTIME_EXECUTE = new Set([
  "sbg_catalogue_update_plan",
  "sbg_catalogue_create_price_version",
  "sbg_catalogue_activate_price_version",
  "sbg_catalogue_retire_price_version",
  "sbg_resolve_domain_a_checkout_price",
]);

function walkSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkSources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

async function rejects(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(run, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, pattern);
    return true;
  });
}

async function rows<T>(pg: PGlite, text: string, params?: unknown[]): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

async function snapshot(pg: PGlite) {
  const hotels = await rows<{ code: string; status: string }>(
    pg,
    "select code, status from hotels order by code",
  );
  const billing = await rows<{ n: number }>(pg, "select count(*)::int as n from sbg_billing_accounts");
  const events = await rows<{ n: number }>(pg, "select count(*)::int as n from sbg_stripe_events");
  const owners = await rows<{ n: number }>(
    pg,
    "select count(*)::int as n from sbg_platform_owners where revoked_at is null",
  );
  return {
    hotels,
    billing: billing[0]?.n ?? -1,
    events: events[0]?.n ?? -1,
    owners: owners[0]?.n ?? -1,
  };
}

test("runtime does not call the catalogue resolver and absent commerce is off", () => {
  const hits = walkSources(join(process.cwd(), "src")).filter((path) =>
    readFileSync(path, "utf8").includes("sbg_resolve_domain_a_checkout_price"),
  );
  assert.deepEqual(hits, []);
  assert.equal(saasCommerceMode({}), "off");
  assert.equal(saasCommerceMode({ SBG_SAAS_COMMERCE: "" }), "off");
});

test("0026 catalogue contract holds in an isolated database", async () => {
  const pg = await openCp26cO32Db();
  try {
    const plans = await rows<{
      code: string;
      name: string;
      description: string;
      sort_order: number;
      active: boolean;
    }>(pg, "select code, name, description, sort_order, active from sbg_saas_plans order by sort_order");
    assert.deepEqual(plans, [
      { code: "basic", name: "Basic", description: "", sort_order: 10, active: true },
      { code: "pro", name: "Pro", description: "", sort_order: 20, active: true },
      { code: "premium", name: "Premium", description: "", sort_order: 30, active: true },
    ]);
    const versions = await rows<{ n: number }>(pg, "select count(*)::int as n from sbg_saas_price_versions");
    const mappings = await rows<{ n: number }>(pg, "select count(*)::int as n from sbg_saas_stripe_mappings");
    const locks = await rows<{ id: number; live_mapping_enabled: boolean; live_checkout_enabled: boolean }>(
      pg,
      "select id, live_mapping_enabled, live_checkout_enabled from sbg_saas_commerce_locks",
    );
    assert.equal(versions[0]?.n, 0);
    assert.equal(mappings[0]?.n, 0);
    assert.deepEqual(locks, [{ id: 1, live_mapping_enabled: false, live_checkout_enabled: false }]);

    const seeded = await rows<{ actor_user_id: string | null; target_id: string; metadata: { source?: string } }>(
      pg,
      `select actor_user_id, target_id, metadata
         from sbg_owner_audit_events
        where action = 'catalogue.plan.created'
        order by target_id`,
    );
    assert.equal(seeded.length, 3);
    assert.deepEqual(
      seeded.map((row) => row.target_id),
      ["basic", "premium", "pro"],
    );
    assert.ok(seeded.every((row) => row.actor_user_id == null && row.metadata.source === "migration:0026"));

    const hotelColumn = await rows<{ n: number }>(
      pg,
      `select count(*)::int as n from information_schema.columns
        where table_schema = 'public'
          and table_name in ('sbg_saas_plans','sbg_saas_price_versions','sbg_saas_stripe_mappings','sbg_saas_commerce_locks')
          and column_name = 'hotel_id'`,
    );
    assert.equal(hotelColumn[0]?.n, 0);

    const privileges = await rows<{ proname: string; app_exec: boolean; public_exec: boolean; secdef: boolean }>(
      pg,
      `select p.proname,
              has_function_privilege('aether_app', p.oid, 'EXECUTE') as app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
              p.prosecdef as secdef
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (p.proname like 'sbg_catalogue%' or p.proname in ('sbg_resolve_domain_a_checkout_price','sbg_owner_audit_immutable'))
        order by p.proname`,
    );
    assert.ok(privileges.length >= 8);
    for (const row of privileges) {
      assert.equal(row.public_exec, false, row.proname);
      assert.equal(row.app_exec, RUNTIME_EXECUTE.has(row.proname), row.proname);
    }
    const secdef = new Map(privileges.map((row) => [row.proname, row.secdef]));
    for (const name of RUNTIME_EXECUTE) assert.equal(secdef.get(name), true, name);
    assert.equal(secdef.get("sbg_catalogue_record_stripe_mapping"), true);
    assert.equal(secdef.get("sbg_catalogue_require_owner"), true);
    assert.equal(secdef.get("sbg_catalogue_plan_guard"), false);
    assert.equal(secdef.get("sbg_catalogue_reject_delete"), false);
    assert.equal(secdef.get("sbg_catalogue_price_version_guard"), false);
    assert.equal(secdef.get("sbg_owner_audit_immutable"), false);

    const tables = await rows<{ relname: string; sel: boolean; ins: boolean; upd: boolean; del: boolean }>(
      pg,
      `select c.relname,
              has_table_privilege('aether_app', c.oid, 'SELECT') as sel,
              has_table_privilege('aether_app', c.oid, 'INSERT') as ins,
              has_table_privilege('aether_app', c.oid, 'UPDATE') as upd,
              has_table_privilege('aether_app', c.oid, 'DELETE') as del
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('sbg_saas_plans','sbg_saas_price_versions','sbg_saas_stripe_mappings','sbg_saas_commerce_locks')`,
    );
    assert.equal(tables.length, 4);
    for (const row of tables) {
      assert.equal(row.sel, true, row.relname);
      assert.equal(row.ins, false, row.relname);
      assert.equal(row.upd, false, row.relname);
      assert.equal(row.del, false, row.relname);
    }

    const paths = await rows<{ proname: string; proconfig: string[] | null }>(
      pg,
      `select proname, proconfig from pg_proc
        where proname in ('sbg_catalogue_update_plan','sbg_catalogue_record_stripe_mapping','sbg_resolve_domain_a_checkout_price')`,
    );
    for (const row of paths) {
      assert.ok(row.proconfig?.some((item) => item === "search_path=public, pg_temp"), row.proname);
    }

    await insertAuthUser(pg, PLATFORM_OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    await insertAuthUser(pg, OWNER_USER);
    await pg.query(
      `insert into hotels (code, name, locality, iana_timezone, currency, status)
       values ('demo-kos', 'Aether Demo Hotel', 'Kos', 'Europe/Athens', 'EUR', 'live'),
              ('sbg-verify-a5', 'SBG Verification Hotel', 'Rhodes', 'Europe/Athens', 'EUR', 'configured')`,
    );
    const before = await snapshot(pg);
    assert.equal(before.hotels.find((row) => row.code === "demo-kos")?.status, "live");
    assert.equal(before.hotels.find((row) => row.code === "sbg-verify-a5")?.status, "configured");
    assert.equal(before.owners, 0);

    await rejects(
      () =>
        pg.query("select sbg_catalogue_update_plan($1, 'basic', 'Nope', '', 10, true)", [OWNER_USER.id]),
      /not a platform owner/i,
    );
    await rejects(
      () => pg.query("select sbg_catalogue_create_price_version($1, 'basic', $2)", [null, SYNTH_A]),
      /not a platform owner/i,
    );

    await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "o32 local probe");
    await pg.query("select sbg_grant_platform_owner($1, $2, $3)", [
      PLATFORM_OWNER_USER.id,
      OTHER_USER.id,
      "second",
    ]);
    await pg.query("select sbg_revoke_platform_owner($1, $2, $3)", [
      PLATFORM_OWNER_USER.id,
      OTHER_USER.id,
      "revoke second",
    ]);
    await rejects(
      () =>
        pg.query("select sbg_catalogue_create_price_version($1, 'pro', $2)", [OTHER_USER.id, SYNTH_A]),
      /not a platform owner/i,
    );

    await pg.exec("set role aether_app");
    await rejects(
      () => pg.query("insert into sbg_saas_plans (code, name, sort_order) values ('basic', 'X', 99)"),
      /permission denied/i,
    );
    await rejects(
      () => pg.query("update sbg_saas_plans set name = 'X' where code = 'basic'"),
      /permission denied/i,
    );
    await rejects(() => pg.query("delete from sbg_saas_plans where code = 'basic'"), /permission denied/i);
    await rejects(
      () => pg.query("update sbg_saas_commerce_locks set live_mapping_enabled = true, live_checkout_enabled = true"),
      /permission denied/i,
    );
    await rejects(
      () =>
        pg.query("select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', $3, $4)", [
          PLATFORM_OWNER_USER.id,
          "00000000-0000-4000-8000-000000000099",
          PRODUCT,
          PRICE_A,
        ]),
      /permission denied/i,
    );
    const visible = await rows<{ code: string }>(pg, "select code from sbg_saas_plans order by sort_order");
    assert.deepEqual(
      visible.map((row) => row.code),
      ["basic", "pro", "premium"],
    );
    await pg.query("select sbg_catalogue_update_plan($1, 'basic', 'Basic', 'synth display', 10, true)", [
      PLATFORM_OWNER_USER.id,
    ]);
    await pg.exec("reset role");

    const renamed = await rows<{ code: string; description: string }>(
      pg,
      "select code, description from sbg_saas_plans where code = 'basic'",
    );
    assert.equal(renamed[0]?.description, "synth display");
    await rejects(
      () =>
        pg.query(
          "update sbg_saas_plans set code = case code when 'basic' then 'pro' when 'pro' then 'basic' else code end",
        ),
      /plan code is immutable/i,
    );
    await rejects(
      () => pg.query("insert into sbg_saas_plans (code, name, sort_order) values ('enterprise', 'Enterprise', 40)"),
      /sbg_saas_plans_code_check|check constraint/i,
    );
    await rejects(
      () =>
        pg.query("select sbg_catalogue_update_plan($1, $2, 'x', '', 10, true)", [
          PLATFORM_OWNER_USER.id,
          "basic'; drop table hotels; --",
        ]),
      /plan not found/i,
    );

    await rejects(
      () => pg.query("select sbg_catalogue_create_price_version($1, 'pro', 0)", [PLATFORM_OWNER_USER.id]),
      /invalid commercial price/i,
    );
    await rejects(
      () => pg.query("select sbg_catalogue_create_price_version($1, 'pro', -5)", [PLATFORM_OWNER_USER.id]),
      /invalid commercial price/i,
    );
    await rejects(
      () =>
        pg.query(
          "select sbg_catalogue_create_price_version($1::text, 'pro', $2::integer, 'USD', 'month', 1::smallint)",
          [PLATFORM_OWNER_USER.id, SYNTH_A],
        ),
      /invalid commercial price/i,
    );
    await rejects(
      () =>
        pg.query(
          "select sbg_catalogue_create_price_version($1::text, 'pro', $2::integer, 'EUR', 'year', 1::smallint)",
          [PLATFORM_OWNER_USER.id, SYNTH_A],
        ),
      /invalid commercial price/i,
    );
    await rejects(
      () =>
        pg.query(
          "select sbg_catalogue_create_price_version($1::text, 'pro', $2::integer, 'EUR', 'month', 12::smallint)",
          [PLATFORM_OWNER_USER.id, SYNTH_A],
        ),
      /invalid commercial price/i,
    );
    await rejects(
      () =>
        pg.query(
          `insert into sbg_saas_price_versions (plan_code, currency, amount_minor, billing_interval, interval_count, created_by_user_id)
           values ('pro', 'EUR', 0, 'month', 1, $1)`,
          [PLATFORM_OWNER_USER.id],
        ),
      /sbg_saas_price_amount_positive|check constraint/i,
    );

    const created = await rows<{ id: string }>(
      pg,
      "select sbg_catalogue_create_price_version($1::text, 'basic', $2::integer) as id",
      [PLATFORM_OWNER_USER.id, SYNTH_A],
    );
    const firstId = created[0]?.id;
    assert.ok(firstId);
    await rejects(
      () => pg.query("update sbg_saas_price_versions set amount_minor = amount_minor + 1 where id = $1::uuid", [firstId]),
      /commercial price terms are immutable/i,
    );
    const second = await rows<{ id: string }>(
      pg,
      "select sbg_catalogue_create_price_version($1::text, 'basic', $2::integer) as id",
      [PLATFORM_OWNER_USER.id, SYNTH_B],
    );
    const secondId = second[0]?.id;
    assert.ok(secondId);
    await pg.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [
      PLATFORM_OWNER_USER.id,
      firstId,
    ]);
    await rejects(
      () => pg.query("update sbg_saas_price_versions set purchasable = true where id = $1::uuid", [secondId]),
      /duplicate key|unique|one_purchasable/i,
    );
    await pg.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [
      PLATFORM_OWNER_USER.id,
      secondId,
    ]);
    const offers = await rows<{ id: string; purchasable: boolean; retired_at: string | null; amount_minor: number }>(
      pg,
      "select id, purchasable, retired_at, amount_minor from sbg_saas_price_versions order by created_at",
    );
    assert.equal(offers.length, 2);
    assert.equal(offers.filter((row) => row.purchasable).length, 1);
    assert.equal(offers.find((row) => row.id === secondId)?.purchasable, true);
    assert.equal(offers.find((row) => row.id === firstId)?.purchasable, false);
    assert.equal(offers.find((row) => row.id === firstId)?.retired_at, null);
    assert.equal(offers.find((row) => row.id === firstId)?.amount_minor, SYNTH_A);
    await rejects(
      () =>
        pg.query("update sbg_saas_price_versions set effective_from = now() + interval '1 day' where id = $1::uuid", [
          secondId,
        ]),
      /effective_from is immutable/i,
    );

    const premium = await rows<{ id: string }>(
      pg,
      "select sbg_catalogue_create_price_version($1::text, 'premium', $2::integer) as id",
      [PLATFORM_OWNER_USER.id, SYNTH_A],
    );
    await pg.query("select sbg_catalogue_update_plan($1, 'premium', 'Premium', '', 30, false)", [
      PLATFORM_OWNER_USER.id,
    ]);
    await rejects(
      () =>
        pg.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [
          PLATFORM_OWNER_USER.id,
          premium[0]?.id,
        ]),
      /plan inactive/i,
    );
    await pg.query("select sbg_catalogue_update_plan($1, 'premium', 'Premium', '', 30, true)", [
      PLATFORM_OWNER_USER.id,
    ]);
    await rejects(
      () => pg.query("select sbg_resolve_domain_a_checkout_price('premium', 'test')"),
      /checkout price unavailable|plan unavailable/i,
    );
    await rejects(
      () => pg.query("select sbg_resolve_domain_a_checkout_price('enterprise', 'test')"),
      /plan unavailable/i,
    );
    await rejects(
      () => pg.query("select sbg_resolve_domain_a_checkout_price('basic', 'staging')"),
      /invalid commerce environment/i,
    );
    await rejects(
      () => pg.query("select sbg_resolve_domain_a_checkout_price('basic', 'test')"),
      /checkout price unavailable/i,
    );

    const mapped = await rows<{ id: string }>(
      pg,
      "select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', $3, $4) as id",
      [PLATFORM_OWNER_USER.id, secondId, PRODUCT, PRICE_A],
    );
    const firstMap = mapped[0]?.id;
    assert.ok(firstMap);
    await rejects(
      () =>
        pg.query("select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', $3, $4)", [
          PLATFORM_OWNER_USER.id,
          secondId,
          PRODUCT,
          PRICE_A,
        ]),
      /duplicate key|unique|stripe_price_id/i,
    );
    await rejects(
      () =>
        pg.query("select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', 'not-a-product', $3)", [
          PLATFORM_OWNER_USER.id,
          secondId,
          PRICE_B,
        ]),
      /invalid Stripe identifier/i,
    );
    const replaced = await rows<{ id: string }>(
      pg,
      "select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', $3, $4) as id",
      [PLATFORM_OWNER_USER.id, secondId, PRODUCT, PRICE_B],
    );
    const history = await rows<{ id: string; status: string; stripe_price_id: string }>(
      pg,
      "select id, status, stripe_price_id from sbg_saas_stripe_mappings order by created_at",
    );
    assert.equal(history.length, 2);
    assert.equal(history.find((row) => row.id === firstMap)?.status, "replaced");
    assert.equal(history.find((row) => row.id === replaced[0]?.id)?.status, "verified");
    assert.equal(history.find((row) => row.id === firstMap)?.stripe_price_id, PRICE_A);

    await pg.exec("set role aether_app");
    const resolved = await rows<{ price: string }>(
      pg,
      "select sbg_resolve_domain_a_checkout_price('basic', 'test') as price",
    );
    assert.equal(resolved[0]?.price, PRICE_B);
    await rejects(
      () => pg.query("select sbg_resolve_domain_a_checkout_price('basic', 'live')"),
      /live checkout is locked/i,
    );
    await pg.exec("reset role");

    await rejects(
      () =>
        pg.query("select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'live', $3, $4)", [
          PLATFORM_OWNER_USER.id,
          secondId,
          PRODUCT,
          PRICE_LIVE,
        ]),
      /live Stripe mapping is locked/i,
    );

    await pg.query("update sbg_saas_commerce_locks set live_mapping_enabled = true where id = 1");
    await pg.query("select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'live', $3, $4)", [
      PLATFORM_OWNER_USER.id,
      secondId,
      "prod_sbg_o32_synth_live",
      PRICE_LIVE,
    ]);
    await pg.query("update sbg_saas_commerce_locks set live_mapping_enabled = false where id = 1");
    const testStill = await rows<{ price: string }>(
      pg,
      "select sbg_resolve_domain_a_checkout_price('basic', 'test') as price",
    );
    assert.equal(testStill[0]?.price, PRICE_B);
    await rejects(
      () => pg.query("select sbg_resolve_domain_a_checkout_price('basic', 'live')"),
      /live checkout is locked/i,
    );
    await pg.query("update sbg_saas_commerce_locks set live_checkout_enabled = true where id = 1");
    const liveResolved = await rows<{ price: string }>(
      pg,
      "select sbg_resolve_domain_a_checkout_price('basic', 'live') as price",
    );
    assert.equal(liveResolved[0]?.price, PRICE_LIVE);
    await pg.query(
      "update sbg_saas_commerce_locks set live_mapping_enabled = false, live_checkout_enabled = false where id = 1",
    );
    const locksAfter = await rows<{ live_mapping_enabled: boolean; live_checkout_enabled: boolean }>(
      pg,
      "select live_mapping_enabled, live_checkout_enabled from sbg_saas_commerce_locks",
    );
    assert.deepEqual(locksAfter, [{ live_mapping_enabled: false, live_checkout_enabled: false }]);
    await rejects(
      () => pg.query("select sbg_resolve_domain_a_checkout_price('basic', 'live')"),
      /live checkout is locked/i,
    );

    await pg.query("drop index sbg_saas_mapping_one_verified_idx");
    await pg.query(
      `insert into sbg_saas_stripe_mappings (price_version_id, environment, stripe_product_id, stripe_price_id, status)
       values ($1::uuid, 'test', $2, 'price_sbg_o32_synth_ambiguous', 'verified')`,
      [secondId, PRODUCT],
    );
    await rejects(
      () => pg.query("select sbg_resolve_domain_a_checkout_price('basic', 'test')"),
      /checkout price unavailable/i,
    );

    await pg.query("select sbg_catalogue_retire_price_version($1, $2::uuid)", [
      PLATFORM_OWNER_USER.id,
      secondId,
    ]);
    await rejects(
      () =>
        pg.query("select sbg_catalogue_activate_price_version($1, $2::uuid)", [
          PLATFORM_OWNER_USER.id,
          secondId,
        ]),
      /price version retired/i,
    );
    await rejects(
      () => pg.query("update sbg_saas_price_versions set retired_at = null where id = $1::uuid", [secondId]),
      /retired_at is immutable/i,
    );
    await rejects(
      () => pg.query("update sbg_saas_price_versions set purchasable = true where id = $1::uuid", [secondId]),
      /retired price cannot be purchasable|check constraint/i,
    );
    await rejects(
      () => pg.query("select sbg_resolve_domain_a_checkout_price('basic', 'test')"),
      /checkout price unavailable/i,
    );

    await rejects(() => pg.query("delete from sbg_saas_plans where code = 'pro'"), /cannot be deleted/i);
    await rejects(
      () => pg.query("delete from sbg_saas_price_versions where id = $1::uuid", [firstId]),
      /cannot be deleted/i,
    );
    await rejects(() => pg.query("delete from sbg_saas_stripe_mappings where id = $1::uuid", [firstMap]), /cannot be deleted/i);
    await rejects(() => pg.query("truncate sbg_saas_plans cascade"), /cannot be deleted/i);
    await rejects(() => pg.query("truncate sbg_saas_price_versions cascade"), /cannot be deleted/i);
    await rejects(() => pg.query("truncate sbg_saas_stripe_mappings"), /cannot be deleted/i);
    await rejects(
      () => pg.query("update sbg_owner_audit_events set action = 'tampered'"),
      /append-only/i,
    );
    await rejects(() => pg.query("delete from sbg_owner_audit_events"), /append-only/i);
    await rejects(() => pg.query("truncate sbg_owner_audit_events"), /append-only/i);

    const audit = await rows<{ action: string; metadata: string }>(
      pg,
      `select action, metadata::text as metadata from sbg_owner_audit_events where action like 'catalogue.%'`,
    );
    const actions = audit.map((row) => row.action).sort();
    for (const required of [
      "catalogue.plan.created",
      "catalogue.plan.updated",
      "catalogue.price.created",
      "catalogue.price.activated",
      "catalogue.price.retired",
      "catalogue.stripe_mapping.created",
      "catalogue.stripe_mapping.replaced",
    ]) {
      assert.ok(actions.includes(required), required);
    }
    assert.equal(actions.filter((action) => action === "catalogue.plan.created").length, 3);
    const blob = audit.map((row) => row.metadata).join("\n");
    assert.doesNotMatch(blob, /@|sk_|whsec_|password|postgres:\/\//i);

    const after = await snapshot(pg);
    assert.deepEqual(after.hotels, before.hotels);
    assert.equal(after.billing, before.billing);
    assert.equal(after.events, before.events);
    assert.equal(after.owners, 1);
    const verifyAttached = await rows<{ n: number }>(
      pg,
      `select count(*)::int as n from sbg_billing_accounts b
         join hotels h on h.id = b.hotel_id
        where h.code in ('demo-kos', 'sbg-verify-a5')`,
    );
    assert.equal(verifyAttached[0]?.n, 0);
  } finally {
    await pg.exec("reset role");
    await pg.close();
  }
});
