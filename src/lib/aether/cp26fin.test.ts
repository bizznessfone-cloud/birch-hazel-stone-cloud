/**
 * CP26 FINALISATION — property-licence catalogue cutover on an isolated PGLite.
 * Synthetic amounts are attack probes, not the commercial price.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openCp26cO41Db, PLATFORM_OWNER_USER, bootstrapPlatformOwner, insertAuthUser } from "./cp26a4-fixture.ts";

const SQL = readFileSync(join(process.cwd(), "migrations/0028_cp26fin_property_licence_catalogue.sql"), "utf8");

async function rows<T>(pg: { query: <R>(text: string, params?: unknown[]) => Promise<{ rows: R[] }> }, text: string, params?: unknown[]) {
  return (await pg.query<T>(text, params)).rows;
}

test("0028 activates property_licence, retires tier sellability, and seeds no amount", async () => {
  assert.doesNotMatch(SQL, /\b179\b/);
  const pg = await openCp26cO41Db();
  await insertAuthUser(pg, PLATFORM_OWNER_USER);
  await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "cp26fin probe");
  await pg.exec(SQL);
  const plans = await rows<{ code: string; active: boolean }>(
    pg,
    "select code, active from sbg_saas_plans order by code",
  );
  assert.deepEqual(
    plans.map((row) => `${row.code}:${row.active}`),
    ["basic:false", "premium:false", "pro:false", "property_licence:true"],
  );
  const prices = await rows<{ n: number }>(pg, "select count(*)::int as n from sbg_saas_price_versions");
  const mappings = await rows<{ n: number }>(pg, "select count(*)::int as n from sbg_saas_stripe_mappings");
  assert.equal(prices[0]?.n, 0);
  assert.equal(mappings[0]?.n, 0);
  const orgs = await rows<{ n: number }>(pg, "select count(*)::int as n from sbg_organisations");
  assert.equal(orgs[0]?.n, 0);
  for (const code of ["basic", "pro", "premium"]) {
    await assert.rejects(
      () => pg.query("select sbg_catalogue_create_price_version($1, $2, 1111)", [PLATFORM_OWNER_USER.id, code]),
      /historical plan cannot receive a price version/i,
    );
  }
  await pg.query("select sbg_catalogue_update_plan($1, 'basic', 'Basic', '', 10, true)", [PLATFORM_OWNER_USER.id]);
  await assert.rejects(
    () => pg.query("select sbg_catalogue_create_price_version($1, 'basic', 1111)", [PLATFORM_OWNER_USER.id]),
    /historical plan cannot receive a price version/i,
  );
  await pg.query("select sbg_catalogue_update_plan($1, 'property_licence', 'Property Licence', 'SCAN. BOOK. GO. property licence. One active allocation consumes one licence.', 40, false)", [
    PLATFORM_OWNER_USER.id,
  ]);
  await assert.rejects(
    () => pg.query("select sbg_catalogue_create_price_version($1, 'property_licence', 1111)", [PLATFORM_OWNER_USER.id]),
    /plan inactive/i,
  );
  await pg.query("select sbg_catalogue_update_plan($1, 'property_licence', 'Property Licence', 'SCAN. BOOK. GO. property licence. One active allocation consumes one licence.', 40, true)", [
    PLATFORM_OWNER_USER.id,
  ]);
  const created = await rows<{ id: string }>(
    pg,
    "select sbg_catalogue_create_price_version($1, 'property_licence', 1111) as id",
    [PLATFORM_OWNER_USER.id],
  );
  assert.equal(typeof created[0]?.id, "string");
  const amount = await rows<{ amount_minor: number }>(pg, "select amount_minor from sbg_saas_price_versions");
  assert.deepEqual(amount.map((row) => row.amount_minor), [1111]);
});

test("0028 refuses to run when a price version already exists", async () => {
  const pg = await openCp26cO41Db();
  await insertAuthUser(pg, PLATFORM_OWNER_USER);
  await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "cp26fin probe");
  await pg.query("select sbg_catalogue_create_price_version($1, 'basic', 1111)", [PLATFORM_OWNER_USER.id]);
  await assert.rejects(() => pg.exec(SQL), /UNEXPECTED COMMERCIAL STATE: price versions exist/i);
  const codes = await rows<{ code: string }>(pg, "select code from sbg_saas_plans order by code");
  assert.deepEqual(codes.map((row) => row.code), ["basic", "premium", "pro"]);
});
