import test from "node:test";
import assert from "node:assert/strict";
import { TARGET, validateEnvironment, validIntegrity, runProductionAdmissionDraft } from "./a3-0035-0036-production-admission-executor.DRAFT.mjs";

const ownerUrl = `postgresql://neondb_owner:offline-test@${TARGET.endpoint}.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require`;
const env = {
  A3_PRODUCTION_APPLY_CONFIRMATION: "APPLY-0035-0036-PRODUCTION-EXPLICIT-AUTHORISATION",
  A3_PRODUCTION_APPROVAL_RECORD: "APPROVED-0035-0036-PRODUCTION",
  A3_PRODUCTION_APPLY_OWNER_URL: ownerUrl,
  SBG_ADMISSION_PROJECT_ID: TARGET.project,
  SBG_ADMISSION_BRANCH_ID: TARGET.branch,
  SBG_ADMISSION_ENDPOINT_ID: TARGET.endpoint,
};
const indexRows = [
  { index_name: "sbg_organisations_one_founding_creator_uidx", indisunique: true, indisvalid: true, indisready: true, first_key: "created_by_user_id", predicate: null },
  { index_name: "sbg_approved_property_agreement_versions_one_effective_uidx", indisunique: true, indisvalid: true, indisready: true, first_key: "effective", predicate: "effective" },
];
const columns = [{ data_type: "boolean", is_nullable: "NO", column_default: "false" }];
test("draft remains unconditionally blocked even with exact simulated approval", () => {
  assert.deepEqual(validateEnvironment(env), ["executor-not-certified-or-authorised"]);
});
test("inert draft never calls connection or reads SQL", async () => {
  let connections = 0, reads = 0;
  const result = await runProductionAdmissionDraft({
    env,
    connect: async () => { connections++; throw Error("must not connect"); },
    read: async () => { reads++; throw Error("must not read"); },
  });
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.failures.includes("executor-not-certified-or-authorised"));
  assert.equal(connections, 0);
  assert.equal(reads, 0);
});
test("wrong target branch and endpoint rejected", () => {
  const failures = validateEnvironment({
    ...env, SBG_ADMISSION_BRANCH_ID: "br-crimson-cherry-b1zd1gay",
    A3_PRODUCTION_APPLY_OWNER_URL: ownerUrl.replace(TARGET.endpoint, "ep-cold-bread-b108y6kr"),
  });
  assert.ok(failures.includes("target-pin"));
  assert.ok(failures.includes("endpoint"));
});
test("pooler and extra URL parameters rejected", () => {
  assert.ok(validateEnvironment({ ...env, A3_PRODUCTION_APPLY_OWNER_URL: ownerUrl.replace(".c-5.", "-pooler.c-5.") }).includes("endpoint"));
  assert.ok(validateEnvironment({ ...env, A3_PRODUCTION_APPLY_OWNER_URL: ownerUrl + "&channel_binding=require" }).includes("connection-options"));
});
test("missing approval and ambient credentials rejected", () => {
  const failures = validateEnvironment({ ...env, A3_PRODUCTION_APPROVAL_RECORD: "", DATABASE_URL: "not-used" });
  assert.ok(failures.includes("approval-record"));
  assert.ok(failures.includes("ambient-credentials"));
});
test("integrity checker accepts exact unique indexes and effective column", () => {
  assert.equal(validIntegrity(indexRows, columns), true);
});
test("integrity checker rejects missing, duplicate, invalid or nonunique indexes", () => {
  assert.equal(validIntegrity(indexRows.slice(0,1), columns), false);
  assert.equal(validIntegrity([indexRows[0],indexRows[0]], columns), false);
  for (const flag of ["indisunique","indisvalid","indisready"]) {
    assert.equal(validIntegrity([{...indexRows[0],[flag]:false},indexRows[1]],columns),false);
  }
});
test("integrity checker rejects index key or partial predicate drift", () => {
  assert.equal(validIntegrity([{...indexRows[0],first_key:"name"},indexRows[1]],columns),false);
  assert.equal(validIntegrity([indexRows[0],{...indexRows[1],predicate:null}],columns),false);
});
test("integrity checker rejects nullable, wrong type or default drift", () => {
  assert.equal(validIntegrity(indexRows,[{...columns[0],is_nullable:"YES"}]),false);
  assert.equal(validIntegrity(indexRows,[{...columns[0],data_type:"text"}]),false);
  assert.equal(validIntegrity(indexRows,[{...columns[0],column_default:"true"}]),false);
});
test("integrity checker rejects missing or extra column metadata", () => {
  assert.equal(validIntegrity(indexRows,[]),false);
  assert.equal(validIntegrity(indexRows,[...columns,...columns]),false);
});
