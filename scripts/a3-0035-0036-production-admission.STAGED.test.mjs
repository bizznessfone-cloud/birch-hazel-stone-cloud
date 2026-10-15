import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TARGET, validateEnvironment, runProductionAdmission } from "./a3-0035-0036-production-admission.STAGED.mjs";

const url = `postgresql://neondb_owner:offline-only@${TARGET.endpoint}.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require`;
const valid = {
  A3_PRODUCTION_APPLY_CONFIRMATION: "APPLY-0035-0036-PRODUCTION-EXPLICIT-AUTHORISATION",
  A3_PRODUCTION_APPROVAL_RECORD: "APPROVED-0035-0036-PRODUCTION",
  A3_PRODUCTION_APPLY_OWNER_URL: url,
  SBG_ADMISSION_PROJECT_ID: TARGET.project,
  SBG_ADMISSION_BRANCH_ID: TARGET.branch,
  SBG_ADMISSION_ENDPOINT_ID: TARGET.endpoint,
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW: "A3 0035-0036 production admission APPROVAL REQUIRED",
};
test("staged module validates exact target in offline-only configuration", () => {
  assert.deepEqual(validateEnvironment(valid), []);
  assert.ok(validateEnvironment({...valid, SBG_ADMISSION_BRANCH_ID:"wrong"}).includes("target-pin"));
  assert.ok(validateEnvironment({...valid, A3_PRODUCTION_APPLY_OWNER_URL:url.replace(".c-5.", "-pooler.c-5.")}).includes("endpoint"));
  assert.ok(validateEnvironment({...valid, A3_PRODUCTION_APPROVAL_RECORD:""}).includes("approval-record"));
  assert.ok(validateEnvironment({...valid, DATABASE_URL:"ambient"}).includes("ambient-credentials"));
  assert.ok(validateEnvironment({...valid, GITHUB_REF:"refs/heads/review"}).includes("workflow-context"));
  assert.ok(validateEnvironment({...valid, GITHUB_EVENT_NAME:"push"}).includes("workflow-context"));
  assert.ok(validateEnvironment({...valid, GITHUB_WORKFLOW:"other"}).includes("workflow-identity"));
});
test("without approval the staged module never connects or reads SQL", async () => {
  let connections=0, reads=0;
  const result=await runProductionAdmission({
    env:{...valid,A3_PRODUCTION_APPROVAL_RECORD:""},
    connect:async()=>{connections++;throw Error("must not connect");},
    read:async()=>{reads++;throw Error("must not read");}
  });
  assert.equal(result.verdict,"BLOCKED");
  assert.equal(connections,0);
  assert.equal(reads,0);
});
test("staged module is not a command-line executable and workflow is fail-closed", async () => {
  const source=await readFile(new URL("./a3-0035-0036-production-admission.STAGED.mjs",import.meta.url),"utf8");
  assert.ok(!source.includes("process.argv"));
  const workflow=await readFile(new URL("../.github/workflows/a3-0035-0036-production-apply.STAGED.yml",import.meta.url),"utf8");
  assert.ok(workflow.includes("pull_request:"));
  assert.ok(workflow.includes("node --test"));
  assert.ok(!workflow.includes("A3_PRODUCTION_APPLY_OWNER_URL"));
  assert.ok(!workflow.includes("runProductionAdmission("));
});

test("production workflow template remains inert and requires approval and immutable source", async () => {
  const template=await readFile(new URL("../docs/a3-0035-0036-production-apply.WORKFLOW-TEMPLATE.txt",import.meta.url),"utf8");
  assert.ok(template.includes("environment: a3-production-0035-0036"));
  assert.ok(template.includes("github.ref == 'refs/heads/main'"));
  assert.ok(template.includes("workflow_dispatch:"));
  assert.ok(template.includes("EXPECTED_SHA: ${{ vars.A3_APPROVED_SOURCE_SHA }}"));\n  assert.ok(template.includes("ref: ${{ github.sha }}"));\n  assert.ok(template.includes('test "$GITHUB_SHA" = "$EXPECTED_SHA"'));\n  assert.ok(template.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'));
  assert.ok(template.includes("secrets.A3_PRODUCTION_APPLY_OWNER_URL"));
  assert.ok(template.includes("a3-0035-0036-production-admission-entry.STAGED.mjs"));
  assert.ok(!template.includes("pull_request:\\n"));
});
