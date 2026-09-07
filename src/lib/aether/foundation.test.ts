import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const FOUNDATION_SQL = readFileSync(
  new URL("../../../migrations/0002_foundation.sql", import.meta.url),
  "utf8",
);

describe("Phase 0 foundation", () => {
  test("foundation migration applies and writes aether_meta", async () => {
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(FOUNDATION_SQL);

    const { rows } = await pg.query<{ key: string; value: string }>(
      "select key, value from aether_meta order by key",
    );
    const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    assert.equal(meta.product, "Aether Transfer");
    assert.equal(meta.schema_phase, "0");
    assert.equal(meta.checkpoint, "0");
    assert.equal(meta.blueprint, "v2");

    await pg.close();
  });

  test("migration is idempotent", async () => {
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(FOUNDATION_SQL);
    await pg.exec(FOUNDATION_SQL);
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from aether_meta",
    );
    assert.equal(rows[0]?.n, 4);
    await pg.close();
  });

  test("core time/range primitives required by later phases exist", async () => {
    const pg = new PGlite();
    await pg.waitReady;

    const uuid = await pg.query<{ id: string }>("select gen_random_uuid() as id");
    assert.equal(typeof uuid.rows[0]?.id, "string");
    assert.match(uuid.rows[0]!.id, /^[0-9a-f-]{36}$/i);

    const range = await pg.query<{ r: string }>(
      "select tstzrange(now(), now() + interval '90 minutes', '[)') as r",
    );
    assert.ok(range.rows[0]?.r?.startsWith("["));

    const athens = await pg.query<{ t: string }>(
      "select make_timestamptz(2026, 1, 15, 9, 0, 0, 'Europe/Athens') as t",
    );
    assert.ok(athens.rows[0]?.t);

    await pg.close();
  });

  test("PGlite with btree_gist contrib supports composite occupancy EXCLUDE", async () => {
    const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
    const pg = new PGlite({ extensions: { btree_gist } });
    await pg.waitReady;
    await pg.exec("create extension if not exists btree_gist");
    await pg.exec(`
      create table occupancy_composite_probe (
        vehicle_id uuid not null,
        occupies tstzrange not null,
        exclude using gist (vehicle_id with =, occupies with &&)
      )
    `);
    await pg.exec(`
      insert into occupancy_composite_probe values
        ('11111111-1111-1111-1111-111111111111',
         tstzrange('2026-01-15 08:00:00+00', '2026-01-15 09:30:00+00', '[)'))
    `);
    await pg.exec(`
      insert into occupancy_composite_probe values
        ('11111111-1111-1111-1111-111111111111',
         tstzrange('2026-01-15 09:30:00+00', '2026-01-15 11:00:00+00', '[)'))
    `);
    let overlapRejected = false;
    try {
      await pg.exec(`
        insert into occupancy_composite_probe values
          ('11111111-1111-1111-1111-111111111111',
           tstzrange('2026-01-15 09:00:00+00', '2026-01-15 10:00:00+00', '[)'))
      `);
    } catch (err) {
      overlapRejected = (err as { code?: string }).code === "23P01";
    }
    assert.equal(overlapRejected, true);
    await pg.close();
  });
});
