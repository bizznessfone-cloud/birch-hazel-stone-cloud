/**
 * CP26C-O3.3 — Owner commercial catalogue UI orchestration.
 * PGLite + source inspection. Synthetic minor amounts are probes, not canonical prices.
 * No Production, no Stripe API, no Vercel.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Sql } from "@/lib/db";
import {
  FIXTURE_HOTEL,
  OTHER_USER,
  OWNER_USER,
  PLATFORM_OWNER_USER,
  bootstrapPlatformOwner,
  insertAuthUser,
  onboardConfiguredFixture,
  openCp26cO32Db,
} from "./cp26a4-fixture.ts";
import { PlatformOwnerForbiddenError } from "./owner-auth.ts";
import {
  CatalogueCommandError,
  activateOwnerPriceVersion,
  createOwnerPriceVersion,
  formatEurMinor,
  liveMappingLabel,
  loadOwnerCatalogue,
  parseEurMajorToMinor,
  priceVersionState,
  retireOwnerPriceVersion,
  updateOwnerPlan,
} from "./owner-catalogue.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const SYNTH_MAJOR = "11.11";
const SYNTH_MINOR = 1111;
const NEXT_MAJOR = "22.22";
const NEXT_MINOR = 2222;

function asSql(pg: PGlite): Sql {
  const sql = (async () => {
    throw new Error("tagged-template SQL is not used in CP26C-O3.3 tests");
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  };
  return sql;
}

async function countWhere(pg: PGlite, sql: string, params?: unknown[]): Promise<number> {
  const rows = (await pg.query<{ n: number }>(sql, params)).rows;
  return Number(rows[0]?.n ?? -1);
}

test("EUR major units convert strictly and never invent a zero price", () => {
  assert.deepEqual(parseEurMajorToMinor(SYNTH_MAJOR), { ok: true, amountMinor: SYNTH_MINOR });
  assert.deepEqual(parseEurMajorToMinor("1.2"), { ok: true, amountMinor: 120 });
  assert.deepEqual(parseEurMajorToMinor("10"), { ok: true, amountMinor: 1000 });
  assert.deepEqual(parseEurMajorToMinor(" 12.50 "), { ok: true, amountMinor: 1250 });
  const zero = parseEurMajorToMinor("0");
  const zeroCents = parseEurMajorToMinor("0.00");
  const negative = parseEurMajorToMinor("-1");
  const negativeCent = parseEurMajorToMinor("-0.01");
  const precision = parseEurMajorToMinor("1.234");
  const trailing = parseEurMajorToMinor("1.230");
  assert.equal(zero.ok, false);
  assert.equal(zeroCents.ok, false);
  assert.equal(negative.ok, false);
  assert.equal(negativeCent.ok, false);
  assert.equal(precision.ok, false);
  assert.equal(trailing.ok, false);
  if (!zero.ok) assert.equal(zero.code, "zero");
  if (!zeroCents.ok) assert.equal(zeroCents.code, "zero");
  if (!negative.ok) assert.equal(negative.code, "negative");
  if (!negativeCent.ok) assert.equal(negativeCent.code, "negative");
  if (!precision.ok) assert.equal(precision.code, "precision");
  if (!trailing.ok) assert.equal(trailing.code, "precision");
  for (const bad of ["", " ", "1,50", "+12", "10e2", "1.2.3", "01.50", "EUR 10", "."]) {
    const parsed = parseEurMajorToMinor(bad);
    assert.equal(parsed.ok, false, bad);
    if (!parsed.ok) assert.equal(parsed.code, bad.startsWith("-") ? "negative" : "malformed");
  }
  const huge = parseEurMajorToMinor("21474836.48");
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.equal(huge.code, "malformed");
  assert.equal(formatEurMinor(SYNTH_MINOR), "€11.11");
  assert.equal(liveMappingLabel(false, "not_mapped"), "Not mapped / Locked");
  assert.equal(liveMappingLabel(false, "verified"), "Verified / Locked");
  assert.equal(liveMappingLabel(true, "replaced"), "Replaced");
  assert.equal(priceVersionState({ purchasable: true, retiredAt: null }), "purchasable");
  assert.equal(priceVersionState({ purchasable: false, retiredAt: null }), "draft");
  assert.equal(priceVersionState({ purchasable: false, retiredAt: "now" }), "retired");
});

test("Owner catalogue source cannot record Stripe, unlock LIVE, or edit commercial terms", () => {
  const fns = read("src/lib/aether/owner-fns.ts");
  const catalogue = read("src/lib/aether/owner-catalogue.ts");
  const plans = read("src/routes/owner.plans.tsx");
  const queries = read("src/lib/aether/owner-queries.ts");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const app = `${fns}\n${catalogue}\n${plans}`;

  assert.match(fns, /loadOwnerCatalogue/);
  assert.doesNotMatch(fns, /pending_o3|SBG_SAAS_PLAN_CODES/);
  assert.doesNotMatch(fns, /STRIPE_BASIC_PRICE_ID|STRIPE_PRO_PRICE_ID|STRIPE_PREMIUM_PRICE_ID/);
  assert.equal((fns.match(/createServerFn\(/g) ?? []).length, 10);
  assert.equal((fns.match(/await requirePlatformOwner/g) ?? []).length, 10);
  assert.match(catalogue, /sbg_catalogue_update_plan\(\$1, \$2, \$3, \$4, \$5, \$6\)/);
  assert.match(catalogue, /sbg_catalogue_create_price_version\(\$1, \$2, \$3::integer, 'EUR', 'month', 1::smallint\)/);
  assert.match(catalogue, /sbg_catalogue_activate_price_version/);
  assert.match(catalogue, /sbg_catalogue_retire_price_version/);
  assert.doesNotMatch(catalogue, /input\.currency|input\.interval|p_currency/);
  assert.doesNotMatch(app, /sbg_catalogue_record_stripe_mapping/);
  assert.doesNotMatch(app, /sbg_resolve_domain_a_checkout_price/);
  assert.doesNotMatch(app, /update\s+sbg_saas_price_versions/i);
  assert.doesNotMatch(app, /update\s+sbg_saas_commerce_locks/i);
  assert.doesNotMatch(app, /delete\s+from\s+sbg_owner_audit_events/i);
  assert.doesNotMatch(app, /update\s+sbg_owner_audit_events/i);
  assert.doesNotMatch(app, /live_mapping_enabled\s*=|live_checkout_enabled\s*=/);
  assert.doesNotMatch(app, /SBG_SAAS_COMMERCE/);
  assert.doesNotMatch(app, /process\.env/);
  assert.doesNotMatch(app, /stripe\.server|new Stripe|api\.stripe/i);
  assert.doesNotMatch(plans, /amountMinor|59|69|29/);
  assert.match(plans, /Price not configured/);
  assert.match(plans, /No price version has been created for this plan yet/);
  assert.match(plans, /LIVE commerce locked until CP31/);
  assert.match(plans, /does not activate it/);
  assert.match(plans, /It does not/);
  assert.match(plans, /Confirm/);
  assert.doesNotMatch(plans, /window\.confirm/);
  assert.match(plans, /guest transfer prices/i);
  assert.doesNotMatch(plans, /hotel_destinations|hotels\.status/);
  assert.match(queries, /pending_catalogue/);
  assert.match(pkg.scripts["test:aether"] ?? "", /cp26co33\.test\.ts/);
  assert.doesNotMatch(pkg.scripts.build ?? "", /db:migrate/);
});

test("active Owner operates the catalogue; everyone else and unrelated planes stay put", async () => {
  const pg = await openCp26cO32Db();
  const db = asSql(pg);
  await insertAuthUser(pg, PLATFORM_OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);
  await insertAuthUser(pg, OWNER_USER);
  await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "o33 local probe");
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
  await pg.query(
    `insert into hotels (code, name, locality, iana_timezone, currency, status)
     values ('demo-kos', 'Aether Demo Hotel', 'Kos', 'Europe/Athens', 'EUR', 'live'),
            ('sbg-verify-a5', 'SBG Verification Hotel', 'Rhodes', 'Europe/Athens', 'EUR', 'configured')`,
  );
  const guest = await onboardConfiguredFixture(pg, OWNER_USER.id);
  const beforeDest = (
    await pg.query<{ amount_minor: number }>(
      "select amount_minor from hotel_destinations where id = $1::uuid",
      [guest.destinationId],
    )
  ).rows[0]?.amount_minor;
  assert.equal(beforeDest, FIXTURE_HOTEL.amountMinor);
  const beforeHotels = (
    await pg.query<{ code: string; status: string }>("select code, status from hotels order by code")
  ).rows;
  const billingBefore = await countWhere(pg, "select count(*)::int as n from sbg_billing_accounts");
  const eventsBefore = await countWhere(pg, "select count(*)::int as n from sbg_stripe_events");
  const auditsBefore = await countWhere(
    pg,
    "select count(*)::int as n from sbg_owner_audit_events where action like 'catalogue.%'",
  );

  await pg.exec("set role aether_app");

  await assert.rejects(
    () => updateOwnerPlan(db, "", { code: "basic", name: "Nope", description: "", active: true }),
    (err: unknown) => err instanceof PlatformOwnerForbiddenError,
  );
  await assert.rejects(
    () =>
      createOwnerPriceVersion(db, OWNER_USER.id, { code: "pro", amount: SYNTH_MAJOR }),
    (err: unknown) => err instanceof PlatformOwnerForbiddenError,
  );
  await assert.rejects(
    () =>
      activateOwnerPriceVersion(db, OTHER_USER.id, "00000000-0000-4000-8000-000000000099"),
    (err: unknown) => err instanceof PlatformOwnerForbiddenError,
  );
  assert.equal(await countWhere(pg, "select count(*)::int as n from sbg_saas_price_versions"), 0);

  const empty = await loadOwnerCatalogue(db);
  assert.deepEqual(
    empty.plans.map((plan) => plan.code),
    ["basic", "pro", "premium"],
  );
  assert.deepEqual(
    empty.plans.map((plan) => plan.name),
    ["Basic", "Pro", "Premium"],
  );
  for (const plan of empty.plans) {
    assert.equal(plan.currentPrice, "Price not configured");
    assert.equal(plan.versions.length, 0);
    assert.equal(plan.active, true);
  }
  assert.equal(empty.liveLocked, true);
  assert.equal(empty.liveCaption, "LIVE commerce locked until CP31");
  assert.equal(empty.activity.filter((event) => event.action === "catalogue.plan.created").length, 3);
  assert.ok(empty.activity.every((event) => event.actor === "System" || event.actor === "Owner" || event.actor === "SBG Platform Owner"));
  const emptyJson = JSON.stringify(empty);
  assert.doesNotMatch(emptyJson, /pending_catalogue|pending_o3|price_|prod_|sk_live|migration:0026/);
  assert.doesNotMatch(emptyJson, /user-sbg-platform-owner/);

  await assert.rejects(
    () => updateOwnerPlan(db, PLATFORM_OWNER_USER.id, { code: "enterprise", name: "X", description: "", active: true }),
    (err: unknown) => err instanceof CatalogueCommandError && err.message === "Unknown plan.",
  );
  await assert.rejects(
    () => updateOwnerPlan(db, PLATFORM_OWNER_USER.id, { code: "basic", name: "   ", description: "", active: true }),
    (err: unknown) => err instanceof CatalogueCommandError,
  );
  await updateOwnerPlan(db, PLATFORM_OWNER_USER.id, {
    code: "basic",
    name: "Basic Desk",
    description: "Synthetic display only",
    active: true,
  });
  const edited = await loadOwnerCatalogue(db);
  const basic = edited.plans.find((plan) => plan.code === "basic");
  assert.equal(basic?.name, "Basic Desk");
  assert.equal(basic?.description, "Synthetic display only");
  assert.equal(basic?.code, "basic");
  assert.equal(basic?.sortOrder, 10);
  assert.equal(
    await countWhere(
      pg,
      "select count(*)::int as n from sbg_owner_audit_events where action = 'catalogue.plan.updated' and target_id = 'basic'",
    ),
    1,
  );
  const editedJson = JSON.stringify(edited.activity);
  assert.doesNotMatch(editedJson, /user-sbg-platform-owner|before|after/);
  assert.match(editedJson, /SBG Platform Owner/);

  for (const amount of ["0", "0.00", "-4", "1.234", "12.3456", "10e1", "1,00"]) {
    await assert.rejects(
      () => createOwnerPriceVersion(db, PLATFORM_OWNER_USER.id, { code: "basic", amount }),
      (err: unknown) => err instanceof CatalogueCommandError,
    );
  }
  assert.equal(await countWhere(pg, "select count(*)::int as n from sbg_saas_price_versions"), 0);

  const created = await createOwnerPriceVersion(db, PLATFORM_OWNER_USER.id, {
    code: "basic",
    amount: SYNTH_MAJOR,
  });
  const draft = (await loadOwnerCatalogue(db)).plans.find((plan) => plan.code === "basic");
  assert.equal(draft?.currentPrice, "Price not configured");
  assert.equal(draft?.versions.length, 1);
  assert.equal(draft?.versions[0]?.id, created.id);
  assert.equal(draft?.versions[0]?.purchasable, false);
  assert.equal(draft?.versions[0]?.state, "draft");
  assert.equal(draft?.versions[0]?.amountMinor, SYNTH_MINOR);
  assert.equal(draft?.versions[0]?.amountLabel, "€11.11");
  assert.equal(draft?.versions[0]?.currency, "EUR");
  assert.equal(draft?.versions[0]?.interval, "month");
  assert.equal(draft?.versions[0]?.testMapping, "not_mapped");
  assert.equal(draft?.versions[0]?.liveMapping, "not_mapped");
  assert.equal(draft?.versions[0]?.liveLabel, "Not mapped / Locked");
  assert.equal(draft?.versions[0]?.effectiveFrom, null);

  const second = await createOwnerPriceVersion(db, PLATFORM_OWNER_USER.id, {
    code: "basic",
    amount: NEXT_MAJOR,
  });
  await activateOwnerPriceVersion(db, PLATFORM_OWNER_USER.id, created.id);
  let offer = (await loadOwnerCatalogue(db)).plans.find((plan) => plan.code === "basic");
  assert.equal(offer?.versions.filter((version) => version.purchasable).length, 1);
  assert.equal(offer?.versions.find((version) => version.id === created.id)?.state, "purchasable");
  assert.equal(offer?.versions.find((version) => version.id === second.id)?.state, "draft");
  assert.equal(offer?.currentPrice, "€11.11");
  await activateOwnerPriceVersion(db, PLATFORM_OWNER_USER.id, second.id);
  offer = (await loadOwnerCatalogue(db)).plans.find((plan) => plan.code === "basic");
  assert.equal(offer?.versions.length, 2);
  assert.equal(offer?.versions.find((version) => version.id === second.id)?.purchasable, true);
  assert.equal(offer?.versions.find((version) => version.id === created.id)?.purchasable, false);
  assert.equal(offer?.versions.find((version) => version.id === created.id)?.amountMinor, SYNTH_MINOR);
  assert.equal(offer?.versions.find((version) => version.id === second.id)?.amountMinor, NEXT_MINOR);
  assert.equal(offer?.currentPrice, "€22.22");

  await retireOwnerPriceVersion(db, PLATFORM_OWNER_USER.id, second.id);
  offer = (await loadOwnerCatalogue(db)).plans.find((plan) => plan.code === "basic");
  assert.equal(offer?.versions.length, 2);
  assert.equal(offer?.versions.find((version) => version.id === second.id)?.state, "retired");
  assert.equal(offer?.currentPrice, "Price not configured");
  await assert.rejects(
    () => activateOwnerPriceVersion(db, PLATFORM_OWNER_USER.id, second.id),
    (err: unknown) =>
      err instanceof CatalogueCommandError && /retired price cannot be made purchasable/i.test(err.message),
  );
  await assert.rejects(
    () => pg.query("update sbg_saas_price_versions set amount_minor = amount_minor + 1"),
    /permission denied/i,
  );
  await assert.rejects(
    () => pg.query("update sbg_saas_commerce_locks set live_mapping_enabled = true, live_checkout_enabled = true"),
    /permission denied/i,
  );
  await assert.rejects(
    () =>
      pg.query("select sbg_catalogue_record_stripe_mapping($1, $2::uuid, 'test', $3, $4)", [
        PLATFORM_OWNER_USER.id,
        second.id,
        "prod_sbg_o33_synth",
        "price_sbg_o33_synth",
      ]),
    /permission denied/i,
  );
  await assert.rejects(() => pg.query("delete from sbg_owner_audit_events"), /permission denied|append-only/i);
  await assert.rejects(() => pg.query("update sbg_owner_audit_events set action = 'tamper'"), /permission denied|append-only/i);

  const locks = (
    await pg.query<{ live_mapping_enabled: boolean; live_checkout_enabled: boolean }>(
      "select live_mapping_enabled, live_checkout_enabled from sbg_saas_commerce_locks where id = 1",
    )
  ).rows[0];
  assert.equal(locks?.live_mapping_enabled, false);
  assert.equal(locks?.live_checkout_enabled, false);
  assert.equal(await countWhere(pg, "select count(*)::int as n from sbg_saas_stripe_mappings"), 0);

  await pg.exec("reset role");
  const hotels = (
    await pg.query<{ code: string; status: string }>("select code, status from hotels order by code")
  ).rows;
  assert.deepEqual(hotels, beforeHotels);
  const afterDest = (
    await pg.query<{ amount_minor: number }>(
      "select amount_minor from hotel_destinations where id = $1::uuid",
      [guest.destinationId],
    )
  ).rows[0]?.amount_minor;
  assert.equal(afterDest, FIXTURE_HOTEL.amountMinor);
  assert.equal(await countWhere(pg, "select count(*)::int as n from sbg_billing_accounts"), billingBefore);
  assert.equal(await countWhere(pg, "select count(*)::int as n from sbg_stripe_events"), eventsBefore);
  const priceAudits = await countWhere(
    pg,
    "select count(*)::int as n from sbg_owner_audit_events where action = 'catalogue.price.created' and target_id = $1",
    [created.id],
  );
  assert.equal(priceAudits, 1);
  assert.ok(
    (await countWhere(pg, "select count(*)::int as n from sbg_owner_audit_events where action like 'catalogue.%'")) >
      auditsBefore,
  );
  await assert.rejects(
    () => pg.query("delete from sbg_owner_audit_events"),
    /append-only|permission denied/i,
  );
  await assert.rejects(
    () => pg.query("update sbg_saas_price_versions set amount_minor = amount_minor + 1"),
    /immutable/i,
  );
});
