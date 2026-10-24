/** Gate 2 isolated customer journey: explicit approved acceptance -> first property -> workspace.
 * PGlite only. No production/Neon credentials, approved legal content, or live commerce.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { openCp272PaymentDb, insertAuthUser, OWNER_USER } from "./cp26a4-fixture.ts";
import { acceptApprovedFoundingAgreement } from "./founding-approved-acceptance.ts";
import { createFoundingProperty } from "./founding-property.ts";

const migrations = [
  "0031_cp3005e2c_organisation_type.sql",
  "0032_cp3005e2c1_organisation_acceptance.sql",
  "0033_cp3005e2d2b_founding_organisation.sql",
  "0034_cp3005e2d2c_founding_classification_acceptance.sql",
  "0035_cp3005e2d2d_founding_property.sql",
  "0036_cp3005e2d2d_founding_integrity.sql",
  "0037_gate2_founding_property_eligibility.sql",
  "0038_gate2_approved_agreement_acceptance.sql",
];

test("authenticated hotel founder explicitly accepts isolated fixture version and enters own workspace", async () => {
  const pg = await openCp272PaymentDb();
  try {
    for (const migration of migrations) await pg.exec(readFileSync(`migrations/${migration}`, "utf8"));
    await insertAuthUser(pg, OWNER_USER);
    const org = await pg.query<{ organisation_id: string }>(
      "select organisation_id::text from sbg_ensure_founding_organisation($1,$2)",
      [OWNER_USER.id, "Test Hotel Organisation"],
    );
    const orgId = org.rows[0]?.organisation_id;
    assert.ok(orgId);
    await pg.query("select sbg_classify_founding_organisation($1,'hotel')", [OWNER_USER.id]);

    const db = { query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params)).rows };
    const property = { name: "Test Hotel", locality: "Kos, Greece", code: "sbg-gate2-journey",
      ianaTimezone: "Europe/Athens", currency: "EUR" };
    const create = () => createFoundingProperty({ db: db as never, userId: OWNER_USER.id, property });
    await assert.rejects(create(), /terms are not approved/i);

    const fixtureVersion = "fixture-journey-not-legal";
    await pg.query(
      "insert into sbg_approved_property_agreement_versions(agreement_version,effective) values($1,true)",
      [fixtureVersion],
    );
    // Publishing an isolated fixture version alone must never constitute acceptance.
    await assert.rejects(create(), /terms are not approved/i);
    await assert.rejects(acceptApprovedFoundingAgreement({
      db: db as never, userId: OWNER_USER.id, agreementVersion: "terms-v1",
    }), /Approved agreement version required/);
    const accepted = await acceptApprovedFoundingAgreement({
      db: db as never, userId: OWNER_USER.id, agreementVersion: fixtureVersion,
    });
    assert.deepEqual(accepted, { agreementVersion: fixtureVersion, alreadyAccepted: false });
    const repeated = await acceptApprovedFoundingAgreement({
      db: db as never, userId: OWNER_USER.id, agreementVersion: fixtureVersion,
    });
    assert.equal(repeated.alreadyAccepted, true);

    const created = await create();
    const workspace = await pg.query<{ id: string; organisation_id: string; code: string }>(
      `select h.id::text as id, h.organisation_id::text as organisation_id, h.code
         from app_hotel_accounts a join hotels h on h.id = a.hotel_id
         where a.user_id = $1`, [OWNER_USER.id],
    );
    assert.equal(workspace.rows.length, 1);
    assert.deepEqual(workspace.rows[0], {
      id: created.hotelId, organisation_id: orgId, code: property.code,
    });
  } finally {
    await pg.close();
  }
});
