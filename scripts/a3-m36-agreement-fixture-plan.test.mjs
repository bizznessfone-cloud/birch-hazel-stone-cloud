/**
 * Agreement-fixture plan. No database is opened.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ACCEPTANCE_ID,
  NOT_LEGAL,
  ORGANISATION_ID,
  USER_ID,
  VERDICT_A,
  VERDICT_NONE,
  VERIFIED_FACTS,
  planAgreementFixture,
  planFromRepository,
} from "./a3-m36-agreement-fixture-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "scripts/a3-m36-agreement-fixture-plan.mjs"), "utf8");

function sources() {
  const read = (path) => readFileSync(join(root, path), "utf8");
  return {
    acceptanceSql: read("migrations/0032_cp3005e2c1_organisation_acceptance.sql"),
    propertySql: read("migrations/0036_cp3005e2d2d_founding_integrity.sql"),
    approvalSql: `${read("migrations/0035_cp3005e2d2d_founding_property.sql")}\n${read("migrations/0036_cp3005e2d2d_founding_integrity.sql")}`,
    concurrencySql: read("scripts/a3-m36-isolated-concurrency.mjs"),
  };
}

test("the plan file does not contain a database write", () => {
  assert.doesNotMatch(src, /\b(insert into|delete from|alter table|truncate table)\b/i);
  assert.doesNotMatch(src, /\bupdate\s+(public|sbg_)/i);
  assert.doesNotMatch(src, /new pg\.|AETHER_0036_ISOLATED_OWNER_URL|workflow_dispatch/);
  assert.match(src, /OPTION A, NOT AUTHORISED/);
});

test("current migrations support removing only the inactive catalogue row", () => {
  const plan = planFromRepository();
  assert.equal(plan.verdict, VERDICT_A);
  assert.equal(plan.options.recommendation, "A");
  assert.equal(plan.options.A.allowed, true);
  assert.equal(plan.options.B.allowed, false);
  assert.equal(plan.options.C.allowed, false);
  assert.equal(plan.specification.authorised, false);
  assert.equal(plan.specification.writes, false);
  assert.deepEqual(plan.specification.affected, [{
    table: "sbg_approved_property_agreement_versions",
    agreementVersion: NOT_LEGAL,
    effective: false,
    count: 1,
  }]);
  assert.equal(plan.specification.preserved[0].id, ACCEPTANCE_ID);
  assert.equal(plan.specification.preserved[1].id, ORGANISATION_ID);
  assert.equal(plan.specification.preserved[2].id, USER_ID);
  assert.match(plan.specification.audit, /does not erase the acceptance/);
  assert.match(plan.specification.failureHandling, /rolls the transaction back/);
  assert.match(plan.existingRecovery, /outside the recovery fixture list/);
});

test("an effective row, a different acceptance, or a weakened gate refuses option A", () => {
  const base = sources();
  const effective = planAgreementFixture({ ...base, facts: { ...VERIFIED_FACTS, approvalEffective: true, effectiveCount: 1 } });
  assert.equal(effective.verdict, VERDICT_NONE);
  assert.match(effective.options.failures.join(","), /approval-effective/);
  const otherAcceptance = planAgreementFixture({ ...base, facts: { ...VERIFIED_FACTS, acceptanceId: "00000000-0000-4000-8000-000000000000" } });
  assert.equal(otherAcceptance.options.recommendation, "NONE");
  const weakened = planAgreementFixture({
    ...base,
    concurrencySql: base.concurrencySql.replace("Number(approvals.n) !== 0", "Number(approvals.n) < 0"),
  });
  assert.equal(weakened.verdict, VERDICT_NONE);
  assert.match(weakened.options.failures.join(","), /emptyCatalogueGate/);
  const linked = planAgreementFixture({
    ...base,
    acceptanceSql: `${base.acceptanceSql}\nreferences sbg_approved_property_agreement_versions (agreement_version)`,
  });
  assert.match(linked.options.failures.join(","), /acceptanceHasNoCatalogueForeignKey/);
});
