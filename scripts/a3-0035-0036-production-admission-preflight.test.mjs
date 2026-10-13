import test from "node:test";
import {ACCEPTED_LEDGER} from "./production-db-preflight.mjs";
import assert from "node:assert/strict";
import {EXPECTED,validateTarget,validateLedger,validateState,validatePrivileges,checkSource,runPreflight} from "./a3-0035-0036-production-admission-preflight.mjs";


const safePrivileges = Object.freeze({rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,rolcanlogin:true,rolinherit:false,membership_count:0,database_connect:true,database_create:false,schema_usage:true,schema_create:false,ledger_read:true,organisations_read:true,acceptances_read:true,ledger_write:false,organisations_write:false,acceptances_write:false,security_definer_execute:false});
test("role permission matrix fails closed on administrative, inherited, and write capabilities",()=>{
  assert.deepEqual(validatePrivileges(safePrivileges),[]);
  for(const field of ["rolsuper","rolcreatedb","rolcreaterole","rolbypassrls","database_create","schema_create","ledger_write","organisations_write","acceptances_write","security_definer_execute"]){
    assert.ok(validatePrivileges({...safePrivileges,[field]:true}).includes("privilege-"+field),field);
  }
  assert.ok(validatePrivileges({...safePrivileges,membership_count:1}).includes("privilege-memberships"));
  assert.ok(validatePrivileges({...safePrivileges,rolinherit:true}).includes("privilege-inherit"));
  assert.ok(validatePrivileges({...safePrivileges,ledger_read:false}).includes("privilege-required-read"));
  assert.ok(validatePrivileges(null).length > 0);
});

const env={
  SBG_ADMISSION_PROJECT_ID:EXPECTED.project,
  SBG_ADMISSION_BRANCH_ID:EXPECTED.branch,
  SBG_ADMISSION_ENDPOINT_ID:EXPECTED.endpoint,
  A3_PREFLIGHT_READONLY_URL:`postgresql://sbg_a3_preflight_ro:example@${EXPECTED.endpoint}.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require`,
};
test("direct pinned read-only endpoint accepted",()=>assert.deepEqual(validateTarget(env),[]));
test("missing secret rejected",()=>assert.ok(validateTarget({...env,A3_PREFLIGHT_READONLY_URL:""}).includes("missing-readonly-url")));
test("wrong project rejected",()=>assert.ok(validateTarget({...env,SBG_ADMISSION_PROJECT_ID:"round-sunset-69114165"}).includes("project")));
test("pooled endpoint rejected",()=>assert.ok(validateTarget({...env,A3_PREFLIGHT_READONLY_URL:env.A3_PREFLIGHT_READONLY_URL.replace(".c-5.","-pooler.c-5.")}).includes("pooled-endpoint")));
test("privileged owner rejected",()=>assert.ok(validateTarget({...env,A3_PREFLIGHT_READONLY_URL:env.A3_PREFLIGHT_READONLY_URL.replace("sbg_a3_preflight_ro","neondb_owner")}).includes("role")));
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
  const state={current_database:"neondb",neon_project_id:EXPECTED.project,neon_branch_id:EXPECTED.branch,neon_endpoint_id:EXPECTED.endpoint,current_user:"sbg_a3_preflight_ro",session_user:"sbg_a3_preflight_ro",duplicate_creator_groups:"0",agreement_acceptance_count:0,approved_table_exists:0,creator_index_exists:0,effective_index_exists:0,effective_column_exists:0,property_function_exists:0};
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
  assert.ok(validateTarget({...env,A3_PREFLIGHT_READONLY_URL:env.A3_PREFLIGHT_READONLY_URL+"&options=-csearch_path%3Dpublic"}).includes("unexpected-connection-options"));
});
test("unexpected Terms acceptance blocks baseline",()=>{
  const state={current_database:"neondb",neon_project_id:EXPECTED.project,neon_branch_id:EXPECTED.branch,neon_endpoint_id:EXPECTED.endpoint,current_user:"sbg_a3_preflight_ro",session_user:"sbg_a3_preflight_ro",duplicate_creator_groups:0,agreement_acceptance_count:1,approved_table_exists:0,creator_index_exists:0,effective_index_exists:0,effective_column_exists:0,property_function_exists:0};
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
      if(sql.includes("FROM pg_catalog.pg_roles r WHERE r.rolname = current_user"))return {rows:[safePrivileges]};
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

test("fully matching read-only baseline returns advisory pass without authorisation",async()=>{
  const calls=[];
  const state={
    current_database:EXPECTED.database,neon_project_id:EXPECTED.project,
    neon_branch_id:EXPECTED.branch,neon_endpoint_id:EXPECTED.endpoint,
    current_user:EXPECTED.role,session_user:EXPECTED.role,
    duplicate_creator_groups:0,agreement_acceptance_count:0,
    approved_table_exists:0,creator_index_exists:0,
    effective_index_exists:0,effective_column_exists:0,property_function_exists:0,
  };
  const client={
    async query(sql){
      calls.push(sql);
      if(sql.includes("SELECT current_database()"))return {rows:[state]};
      if(sql.includes("SELECT name FROM public._migrations"))return {rows:ACCEPTED_LEDGER.map(name=>({name}))};
      if(sql.includes("FROM pg_catalog.pg_roles r WHERE r.rolname = current_user"))return {rows:[safePrivileges]};
      return {rows:[]};
    },
    async end(){calls.push("CLOSED");},
  };
  const result=await runPreflight({env,connect:async()=>client});
  assert.equal(result.verdict,"PREFLIGHT PASS — APPLY NOT AUTHORISED");
  assert.deepEqual(result.failures,[]);
  assert.equal(result.ledgerCount,34);
  assert.equal(calls.filter(sql=>sql==="ROLLBACK").length,1);
  assert.equal(calls.at(-1),"CLOSED");
});
test("live preflight rejects privileged role even when the ledger and identity match",async()=>{
  const state={current_database:EXPECTED.database,neon_project_id:EXPECTED.project,neon_branch_id:EXPECTED.branch,neon_endpoint_id:EXPECTED.endpoint,current_user:EXPECTED.role,session_user:EXPECTED.role,duplicate_creator_groups:0,agreement_acceptance_count:0,approved_table_exists:0,creator_index_exists:0,effective_index_exists:0,effective_column_exists:0,property_function_exists:0};
  const calls=[];
  const client={async query(sql){calls.push(sql);if(sql.includes("SELECT current_database()"))return {rows:[state]};if(sql.includes("SELECT name FROM public._migrations"))return {rows:ACCEPTED_LEDGER.map(name=>({name}))};if(sql.includes("FROM pg_catalog.pg_roles r WHERE r.rolname = current_user"))return {rows:[{...safePrivileges,rolcreaterole:true}]};return {rows:[]};},async end(){calls.push("CLOSED");}};
  const result=await runPreflight({env,connect:async()=>client});
  assert.equal(result.verdict,"BLOCKED");
  assert.ok(result.failures.includes("privilege-rolcreaterole"));
  assert.equal(calls.at(-1),"CLOSED");
});

test("preflight fails before connecting when the production target is wrong",async()=>{
  let attempted=false;
  const result=await runPreflight({
    env:{...env,SBG_ADMISSION_BRANCH_ID:"br-proud-field-b1tymqgc"},
    connect:async()=>{attempted=true;throw Error("must not connect");},
  });
  assert.equal(result.verdict,"BLOCKED");
  assert.ok(result.failures.includes("branch"));
  assert.equal(attempted,false);
});

test("null counters rejected",()=>{
  const state={current_database:EXPECTED.database,neon_project_id:EXPECTED.project,neon_branch_id:EXPECTED.branch,neon_endpoint_id:EXPECTED.endpoint,current_user:EXPECTED.role,session_user:EXPECTED.role,duplicate_creator_groups:"0",agreement_acceptance_count:"0",approved_table_exists:0,creator_index_exists:0,effective_index_exists:0,effective_column_exists:0,property_function_exists:0};
  assert.deepEqual(validateState(state),[]);
  assert.ok(validateState({...state,agreement_acceptance_count:null}).includes("unexpected-acceptances"));
  assert.ok(validateState({...state,duplicate_creator_groups:null}).includes("duplicate-creators"));
  assert.ok(validateState({...state,creator_index_exists:undefined}).includes("creator-index-preexists"));
});

test("application runtime credential rejected",()=>assert.ok(validateTarget({...env,A3_PREFLIGHT_READONLY_URL:env.A3_PREFLIGHT_READONLY_URL.replace("sbg_a3_preflight_ro","aether_app")}).includes("role")));
test("owner identity rejected after connection",()=>{const state={current_database:EXPECTED.database,neon_project_id:EXPECTED.project,neon_branch_id:EXPECTED.branch,neon_endpoint_id:EXPECTED.endpoint,current_user:"neondb_owner",session_user:"neondb_owner",duplicate_creator_groups:0,agreement_acceptance_count:0,approved_table_exists:0,creator_index_exists:0,effective_index_exists:0,effective_column_exists:0,property_function_exists:0};assert.ok(validateState(state).includes("readonly-role-identity"));});
