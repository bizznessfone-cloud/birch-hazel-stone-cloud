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
  "0037_gate2_founding_property_eligibility.sql",
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
    const eligibility = async () => {
      const rows = await pg.query<{ eligible: boolean; reason: string }>(
        "select eligible, reason from sbg_founding_property_eligibility_for_user($1)",
        [OWNER_USER.id],
      );
      return rows.rows[0];
    };
    assert.deepEqual(await eligibility(), { eligible: false, reason: "agreement_required" });
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
    assert.deepEqual(await eligibility(), { eligible: true, reason: "ready" });
    const result = await createFoundingProperty({ db: db as never, userId: OWNER_USER.id, property });
    assert.ok(result.hotelId);
    assert.ok(result.providerId);
    const hotels = await pg.query<{ organisation_id: string }>(
      "select organisation_id::text as organisation_id from hotels where id = $1::uuid",
      [result.hotelId],
    );
    assert.equal(hotels.rows[0]?.organisation_id, orgId);
    const workspace = await pg.query<{ id: string; code: string; iana_timezone: string; currency: string }>(
      "select h.id::text as id, h.code, h.iana_timezone, h.currency from app_hotel_accounts aha join hotels h on h.id = aha.hotel_id where aha.user_id = $1",
      [OWNER_USER.id],
    );
    assert.equal(workspace.rows.length, 1, "new hotel must appear in authenticated dashboard account list");
    assert.equal(workspace.rows[0]?.id, result.hotelId);
    assert.equal(workspace.rows[0]?.code, property.code);
    assert.equal(workspace.rows[0]?.iana_timezone, property.ianaTimezone);
    assert.equal(workspace.rows[0]?.currency, property.currency);
    await assert.rejects(
      createFoundingProperty({ db: db as never, userId: OWNER_USER.id, property }),
    );
    const count = await pg.query<{ count: number }>(
      "select count(*)::int as count from hotels where code = $1",
      [property.code],
    );
    assert.equal(count.rows[0]?.count, 1, "duplicate submission must not create another hotel");
    const second = await createFoundingProperty({
      db: db as never, userId: OWNER_USER.id,
      property: { ...property, name: "Harbour House", code: "sbg-gate2-b" },
    });
    assert.notEqual(second.hotelId, result.hotelId);
    const secondHotel = await pg.query<{ organisation_id: string }>(
      "select organisation_id::text as organisation_id from hotels where id = $1::uuid",
      [second.hotelId],
    );
    assert.equal(secondHotel.rows[0]?.organisation_id, orgId);
    await assert.rejects(
      createFoundingProperty({ db: db as never, userId: "nonexistent-user", property: { ...property, code: "sbg-gate2-c" } }),
      /account not found/i,
    );
  } finally {
    await pg.close();
  }
});
