import test from "node:test";
import assert from "node:assert/strict";
import {EXPECTED,validateTarget,validateLedger,validateState} from "./a3-0035-0036-production-admission-preflight.mjs";

const env={
  SBG_ADMISSION_PROJECT_ID:EXPECTED.project,
  SBG_ADMISSION_BRANCH_ID:EXPECTED.branch,
  SBG_ADMISSION_ENDPOINT_ID:EXPECTED.endpoint,
  AETHER_DATABASE_OWNER_URL:`postgresql://neondb_owner:example@${EXPECTED.endpoint}.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require`,
};
test("direct pinned owner endpoint accepted",()=>assert.deepEqual(validateTarget(env),[]));
test("missing secret rejected",()=>assert.ok(validateTarget({...env,AETHER_DATABASE_OWNER_URL:""}).includes("missing-owner-url")));
test("wrong project rejected",()=>assert.ok(validateTarget({...env,SBG_ADMISSION_PROJECT_ID:"round-sunset-69114165"}).includes("project")));
test("pooled endpoint rejected",()=>assert.ok(validateTarget({...env,AETHER_DATABASE_OWNER_URL:env.AETHER_DATABASE_OWNER_URL.replace(".c-5.","-pooler.c-5.")}).includes("pooled-endpoint")));
test("wrong owner rejected",()=>assert.ok(validateTarget({...env,AETHER_DATABASE_OWNER_URL:env.AETHER_DATABASE_OWNER_URL.replace("neondb_owner","aether_app")}).includes("role")));
test("ledger fails closed for missing or future migrations",()=>{
  assert.ok(validateLedger([]).length);
  assert.ok(validateLedger(Array.from({length:35},(_,i)=>String(i+1).padStart(4,"0")+"_x.sql")).length);
});
test("duplicate creators and preexisting migration objects rejected",()=>{
  const state={current_database:"neondb",current_user:"neondb_owner",session_user:"neondb_owner",duplicate_creator_groups:"0",approved_table_exists:0,creator_index_exists:0,effective_index_exists:0};
  assert.deepEqual(validateState(state),[]);
  assert.ok(validateState({...state,duplicate_creator_groups:"1"}).includes("duplicate-creators"));
  assert.ok(validateState({...state,approved_table_exists:1}).includes("approved-table-preexists"));
});
