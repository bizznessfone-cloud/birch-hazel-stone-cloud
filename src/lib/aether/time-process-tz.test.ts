/**
 * Must be executed with TZ set to a non-Athens zone (see package.json).
 * Proves process/browser timezone is not the conversion authority.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { athensInstant, type TimeDb } from "./time.ts";

const FOUNDATION_SQL = readFileSync(
  new URL("../../../migrations/0002_foundation.sql", import.meta.url),
  "utf8",
);
const OCCUPANCY_SQL = readFileSync(
  new URL("../../../migrations/0003_occupancy.sql", import.meta.url),
  "utf8",
);
const AUTH_SQL = readFileSync(
  new URL("../../../migrations/0004_ops_auth.sql", import.meta.url),
  "utf8",
);
const TIME_SQL = readFileSync(
  new URL("../../../migrations/0005_time_domain.sql", import.meta.url),
  "utf8",
);

describe("Phase 3 process timezone mismatch", () => {
  test("Pacific/Auckland process TZ does not change Athens instants", async () => {
    assert.equal(process.env.TZ, "Pacific/Auckland");
    const naiveWinter = new Date("2026-01-15T09:00");
    const naiveSummer = new Date("2026-07-15T09:00");
    assert.notEqual(naiveWinter.toISOString(), "2026-01-15T07:00:00.000Z");
    assert.notEqual(naiveSummer.toISOString(), "2026-07-15T06:00:00.000Z");

    const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
    const pg = new PGlite({ extensions: { btree_gist } });
    await pg.waitReady;
    await pg.exec(FOUNDATION_SQL);
    await pg.exec(OCCUPANCY_SQL);
    await pg.exec(AUTH_SQL);
    await pg.exec(TIME_SQL);
    const db: TimeDb = {
      async query<T>(text: string, params?: unknown[]) {
        const result = await pg.query<T>(text, params);
        return result.rows;
      },
    };

    assert.equal(
      await athensInstant(db, "2026-01-15", "09:00"),
      "2026-01-15T07:00:00.000Z",
    );
    assert.equal(
      await athensInstant(db, "2026-07-15", "09:00"),
      "2026-07-15T06:00:00.000Z",
    );
    assert.equal(
      await athensInstant(db, "2026-01-15", "00:00"),
      "2026-01-14T22:00:00.000Z",
    );
    await pg.close();
  });
});
