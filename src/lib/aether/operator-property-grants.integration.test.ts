/** Gate 2 isolated migration verification. No Neon, production or credentials. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { openCp272PaymentDb } from "./cp26a4-fixture.ts";

test("operator grant storage is deny-by-default and creates no access grants", async () => {
  const pg = await openCp272PaymentDb();
  try {
    const migrations = [
      "0031_cp3005e2c_organisation_type.sql",
      "0032_cp3005e2c1_organisation_acceptance.sql",
      "0033_cp3005e2d2b_founding_organisation.sql",
      "0034_cp3005e2d2c_founding_classification_acceptance.sql",
      "0035_cp3005e2d2d_founding_property.sql",
      "0036_cp3005e2d2d_founding_integrity.sql",
      "0037_gate2_founding_property_eligibility.sql",
      "0038_gate2_approved_agreement_acceptance.sql",
      "0039_gate2_operator_property_grants.sql",
      "0040_gate2_operator_property_access_read.sql",
    ];
    for (const name of migrations) await pg.exec(readFileSync(`migrations/${name}`, "utf8"));
    const denied = await pg.query<{ allowed: boolean }>(
      "select public.sbg_operator_can_access_property_for_user($1, $2::uuid) as allowed",
      ["nonexistent-user", "11111111-1111-4111-8111-111111111111"],
    );
    assert.equal(denied.rows[0]?.allowed, false, "missing identity cannot gain access");
    const count = await pg.query<{ count: number }>("select count(*)::int as count from public.sbg_operator_property_grants");
    assert.equal(count.rows[0]?.count, 0, "migration must not create any implicit hotel/operator relationship");
    const policies = await pg.query<{ count: number }>(
      "select count(*)::int as count from pg_policies where schemaname = 'public' and tablename = 'sbg_operator_property_grants'",
    );
    assert.equal(policies.rows[0]?.count, 0, "no permissive RLS policy may be installed");
    const privileges = await pg.query<{ role: string; permitted: boolean }>(
      `select role, has_table_privilege(role, 'public.sbg_operator_property_grants', 'SELECT, INSERT, UPDATE, DELETE') as permitted
         from (values ('aether_app'), ('aether_runtime')) as r(role)`,
    );
    assert.ok(privileges.rows.every(row => row.permitted === false), "runtime roles must not access grant storage");
    const rls = await pg.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'public.sbg_operator_property_grants'::regclass",
    );
    assert.equal(rls.rows[0]?.relrowsecurity, true);
  } finally {
    await pg.close();
  }
});
