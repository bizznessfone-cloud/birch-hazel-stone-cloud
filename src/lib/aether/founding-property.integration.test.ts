/** Gate 2 integration: isolated PGlite only, no Neon or production secrets. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { openCp272PaymentDb, insertAuthUser, OWNER_USER } from "./cp26a4-fixture.ts";
import { createFoundingProperty } from "./founding-property.ts";

const migrations = [
  "0031_cp3005e2c_organisation_type.sql",
  "0032_cp3005e2c1_organisation_acceptance.sql",
  "0033_cp3005e2d2b_founding_organisation.sql",
  "0034_cp3005e2d2c_founding_classification_acceptance.sql",
  "0035_cp3005e2d2d_founding_property.sql",
  "0036_cp3005e2d2d_founding_integrity.sql",
];
const property = {
  name: "Blue Lagoon Hotel", locality: "Kos, Greece", code: "sbg-gate2-a",
  ianaTimezone: "Europe/Athens", currency: "EUR",
};
test("founding-property service enforces effective test agreement in isolated database", async () => {
  const pg = await openCp272PaymentDb();
  try {
    for (const migration of migrations) {
      await pg.exec(readFileSync(`migrations/${migration}`, "utf8"));
    }
    await insertAuthUser(pg, OWNER_USER);
    const created = await pg.query<{ organisation_id: string }>(
      "select organisation_id::text as organisation_id from sbg_ensure_founding_organisation($1, $2)",
      [OWNER_USER.id, "Blue Lagoon Hotel"],
    );
    const orgId = created.rows[0]!.organisation_id;
    await pg.query("select sbg_classify_founding_organisation($1, 'hotel')", [OWNER_USER.id]);
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        const result = await pg.query(sql, params);
        return result.rows;
      },
    };
    await assert.rejects(
      createFoundingProperty({ db: db as never, userId: OWNER_USER.id, property }),
      /terms are not approved/i,
    );
    await pg.query("select sbg_record_founding_terms_acceptance($1)", [OWNER_USER.id]);
    await assert.rejects(
      createFoundingProperty({ db: db as never, userId: OWNER_USER.id, property }),
      /terms are not approved/i,
    );
    await pg.query(
      "insert into sbg_approved_property_agreement_versions (agreement_version, effective) values ($1, true)",
      ["fixture-gate2-not-legal"],
    );
    await assert.rejects(
      createFoundingProperty({ db: db as never, userId: OWNER_USER.id, property }),
      /terms are not approved/i,
    );
    await pg.query(
      "insert into sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version) values ($1::uuid, $2, $3)",
      [orgId, OWNER_USER.id, "fixture-gate2-not-legal"],
    );
    const result = await createFoundingProperty({ db: db as never, userId: OWNER_USER.id, property });
    assert.ok(result.hotelId);
    assert.ok(result.providerId);
    const hotels = await pg.query<{ organisation_id: string }>(
      "select organisation_id::text as organisation_id from hotels where id = $1::uuid",
      [result.hotelId],
    );
    assert.equal(hotels.rows[0]?.organisation_id, orgId);
    await assert.rejects(
      createFoundingProperty({ db: db as never, userId: "nonexistent-user", property: { ...property, code: "sbg-gate2-b" } }),
      /account not found/i,
    );
  } finally {
    await pg.close();
  }
});
