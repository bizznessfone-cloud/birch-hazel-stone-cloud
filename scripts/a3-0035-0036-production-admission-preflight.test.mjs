import test from "node:test";
import {ACCEPTED_LEDGER} from "./production-db-preflight.mjs";
import assert from "node:assert/strict";
import {EXPECTED,validateTarget,validateLedger,validateState,checkSource,runPreflight} from "./a3-0035-0036-production-admission-preflight.mjs";

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
test("ledger exactly matches frozen 0001–0034",()=>{
  assert.deepEqual(validateLedger(ACCEPTED_LEDGER),[]);
  const altered=[...ACCEPTED_LEDGER]; altered[0]="0001_wrong.sql";
  assert.ok(validateLedger(altered).length);
});
test("ledger fails closed for missing or future migrations",()=>{
  assert.ok(validateLedger([]).length);
  assert.ok(validateLedger(Array.from({length:35},(_,i)=>String(i+1).padStart(4,"0")+"_x.sql")).length);
});
test("duplicate creators and preexisting migration objects rejected",()=>{
  const state={current_database:"neondb",neon_project_id:EXPECTED.project,neon_branch_id:EXPECTED.branch,neon_endpoint_id:EXPECTED.endpoint,current_user:"neondb_owner",session_user:"neondb_owner",duplicate_creator_groups:"0",agreement_acceptance_count:0,approved_table_exists:0,creator_index_exists:0,effective_index_exists:0,effective_column_exists:0,property_function_exists:0};
  assert.deepEqual(validateState(state),[]);
  assert.ok(validateState({...state,duplicate_creator_groups:"1"}).includes("duplicate-creators"));
  assert.ok(validateState({...state,approved_table_exists:1}).includes("approved-table-preexists"));
  assert.ok(validateState({...state,property_function_exists:1}).includes("property-function-preexists"));
  assert.ok(validateState({...state,neon_branch_id:"br-wrong"}).includes("live-branch-identity"));
  assert.ok(validateState({...state,neon_project_id:"round-sunset-69114165"}).includes("live-project-identity"));
});

test("ambient runtime credentials and connection options rejected",()=>{
  assert.ok(validateTarget({...env,DATABASE_URL:"postgres://not-used"}).includes("forbidden-ambient-database-credentials"));
  assert.ok(validateTarget({...env,NEON_API_KEY:"not-used"}).includes("forbidden-ambient-database-credentials"));
  assert.ok(validateTarget({...env,AETHER_DATABASE_OWNER_URL:env.AETHER_DATABASE_OWNER_URL+"&options=-csearch_path%3Dpublic"}).includes("unexpected-connection-options"));
});
test("unexpected Terms acceptance blocks baseline",()=>{
  const state={current_database:"neondb",neon_project_id:EXPECTED.project,neon_branch_id:EXPECTED.branch,neon_endpoint_id:EXPECTED.endpoint,current_user:"neondb_owner",session_user:"neondb_owner",duplicate_creator_groups:0,agreement_acceptance_count:1,approved_table_exists:0,creator_index_exists:0,effective_index_exists:0,effective_column_exists:0,property_function_exists:0};
  assert.ok(validateState(state).includes("unexpected-acceptances"));
});

test("pinned migration files pass immutable SHA-256 verification",async()=>{
  assert.deepEqual(await checkSource(),[]);
});
test("tampered migration content is rejected without connecting",async()=>{
  const bad=await checkSource(async()=>Buffer.from("tampered migration"));
  assert.equal(bad.length,2);
});
test("read-only preflight rolls back and closes client on drift",async()=>{
  const calls=[];
  const state={
    current_database:EXPECTED.database,neon_project_id:EXPECTED.project,
    neon_branch_id:EXPECTED.branch,neon_endpoint_id:EXPECTED.endpoint,
    current_user:EXPECTED.role,session_user:EXPECTED.role,
    duplicate_creator_groups:1,agreement_acceptance_count:0,
    approved_table_exists:0,creator_index_exists:0,
    effective_index_exists:0,effective_column_exists:0,property_function_exists:0,
  };
  const client={
    async query(sql){
      calls.push(sql);
      if(sql.includes("SELECT current_database()"))return {rows:[state]};
      if(sql.includes("SELECT name FROM public._migrations"))return {rows:ACCEPTED_LEDGER.map(name=>({name}))};
      return {rows:[]};
    },
    async end(){calls.push("CLOSED");},
  };
  const result=await runPreflight({env,connect:async()=>client});
  assert.equal(result.verdict,"BLOCKED");
  assert.ok(result.failures.includes("duplicate-creators"));
  assert.equal(calls[0],"BEGIN READ ONLY");
  assert.ok(calls.includes("ROLLBACK"));
  assert.equal(calls.at(-1),"CLOSED");
  assert.equal(calls.some(sql=>/\b(COMMIT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql)),false);
});
test("read-only preflight rolls back even on query failure",async()=>{
  const calls=[];
  const client={
    async query(sql){
      calls.push(sql);
      if(sql.includes("SELECT current_database()"))throw new Error("simulated read failure");
      return {rows:[]};
    },
    async end(){calls.push("CLOSED");},
  };
  await assert.rejects(runPreflight({env,connect:async()=>client}),/simulated read failure/);
  assert.ok(calls.includes("ROLLBACK"));
  assert.equal(calls.at(-1),"CLOSED");
});
