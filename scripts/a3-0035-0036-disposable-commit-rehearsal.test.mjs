import test from "node:test";
import assert from "node:assert/strict";
import { TARGET, validateEnvironment, runCommitRehearsal } from "./a3-0035-0036-disposable-commit-rehearsal.mjs";
const good = {
 A3_COMMIT_REHEARSAL_CONFIRMATION:"COMMIT-0035-0036-DISPOSABLE-ONLY",
 A3_COMMIT_REHEARSAL_OWNER_URL:`postgresql://neondb_owner:example@${TARGET.endpoint}.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require`,
};
test("exact disposable direct URL accepted",()=>assert.deepEqual(validateEnvironment(good),[]));
test("missing confirmation fails",()=>assert.ok(validateEnvironment({...good,A3_COMMIT_REHEARSAL_CONFIRMATION:""}).includes("confirmation")));
test("production host rejected",()=>assert.ok(validateEnvironment({...good,A3_COMMIT_REHEARSAL_OWNER_URL:good.A3_COMMIT_REHEARSAL_OWNER_URL.replace(TARGET.endpoint,"ep-withered-haze-b1fd9hse")}).includes("endpoint")));
test("pooler rejected",()=>assert.ok(validateEnvironment({...good,A3_COMMIT_REHEARSAL_OWNER_URL:good.A3_COMMIT_REHEARSAL_OWNER_URL.replace(".c-5.","-pooler.c-5.")}).includes("endpoint")));
test("additional connection options rejected",()=>assert.ok(validateEnvironment({...good,A3_COMMIT_REHEARSAL_OWNER_URL:good.A3_COMMIT_REHEARSAL_OWNER_URL+"&channel_binding=require"}).includes("connection-options")));
test("ambient production owner secret rejected",()=>assert.ok(validateEnvironment({...good,AETHER_DATABASE_OWNER_URL:"not-used"}).includes("ambient-credentials")));
test("tampered SQL refuses connection",async()=>{
 let attempted=false;
 const result=await runCommitRehearsal({env:good,read:async()=>Buffer.from("tampered"),connect:async()=>{attempted=true;throw Error("unexpected connection")}});
 assert.equal(result.verdict,"BLOCKED");
 assert.equal(attempted,false);
});
test("live wrong-branch identity prevents writes and rolls back",async()=>{
 const queries=[];
 const client={
  async query(sql){
   queries.push(sql);
   if(sql.includes("SELECT current_database()"))return {rows:[{database:"neondb",role:"neondb_owner",session_role:"neondb_owner",project:TARGET.project,branch:"br-green-darkness-b1k7wkue",endpoint:TARGET.endpoint}]};
   return {rows:[]};
  },
  async end(){queries.push("CLOSE");}
 };
 const result=await runCommitRehearsal({env:good,connect:async()=>client});
 assert.equal(result.verdict,"BLOCKED");
 assert.ok(result.failures.includes("live-identity"));
 assert.ok(queries.includes("ROLLBACK"));
 assert.ok(!queries.includes("COMMIT"));
 assert.ok(!queries.some(q=>q.includes("INSERT INTO public._migrations")));
});
test("pre-commit database error triggers rollback",async()=>{
 const queries=[];
 const client={
  async query(sql){
   queries.push(sql);
   if(sql.includes("SELECT pg_advisory_xact_lock"))throw Error("lock contention");
   return {rows:[]};
  },
  async end(){queries.push("CLOSE");}
 };
 const result=await runCommitRehearsal({env:good,connect:async()=>client});
 assert.equal(result.verdict,"BLOCKED");
 assert.ok(queries.includes("ROLLBACK"));
 assert.ok(!queries.includes("COMMIT"));
});

test("failed COMMIT is ambiguous and never retried",async()=>{
 const queries=[];
 const state={database:"neondb",role:"neondb_owner",session_role:"neondb_owner",project:TARGET.project,branch:TARGET.branch,endpoint:TARGET.endpoint};
 const client={
  async query(sql){
   queries.push(sql);
   if(sql.includes("SELECT current_database()"))return {rows:[state]};
   if(sql.includes("SELECT name FROM public._migrations"))return {rows:(await import("./production-db-preflight.mjs")).ACCEPTED_LEDGER.map(name=>({name}))};
   if(sql.includes("AS duplicates"))return {rows:[{duplicates:0,acceptances:0,approval_exists:false}]};
   if(sql.includes("AS ledger_count"))return {rows:[{ledger_count:36,approval_exists:true,creator_index_exists:true,effective_index_exists:true,approved_versions:0}]};
   if(sql==="COMMIT")throw Error("connection dropped after COMMIT sent");
   return {rows:[]};
  },
  async end(){queries.push("CLOSE");},
 };
 const result=await runCommitRehearsal({env:good,connect:async()=>client});
 assert.equal(result.verdict,"ESCALATE");
 assert.ok(result.failures.includes("commit-or-verification-ambiguous"));
 assert.equal(queries.filter(q=>q==="COMMIT").length,1);
 assert.equal(queries.filter(q=>q==="ROLLBACK").length,0);
});
test("persisted-state mismatch escalates after successful COMMIT",async()=>{
 const calls=[];
 let sessions=0;
 const connect=async()=>{
  const session=++sessions;
  return {
   async query(sql){
    calls.push([session,sql]);
    if(sql.includes("SELECT current_database()"))return {rows:[{database:"neondb",role:"neondb_owner",session_role:"neondb_owner",project:TARGET.project,branch:TARGET.branch,endpoint:TARGET.endpoint}]};
    if(sql.includes("SELECT name FROM public._migrations"))return {rows:(await import("./production-db-preflight.mjs")).ACCEPTED_LEDGER.map(name=>({name}))};
    if(sql.includes("AS duplicates"))return {rows:[{duplicates:0,acceptances:0,approval_exists:false}]};
    if(sql.includes("AS ledger_count"))return {rows:session===1?[{ledger_count:36,approval_exists:true,creator_index_exists:true,effective_index_exists:true,approved_versions:0}]:[{ledger_count:34,creator_index_exists:false,effective_index_exists:false,approved_versions:0}]};
    if(sql.includes("SELECT current_setting('neon.branch_id'"))return {rows:[{branch:TARGET.branch,endpoint:TARGET.endpoint}]};
    return {rows:[]};
   },
   async end(){calls.push([session,"CLOSE"]);},
  };
 };
 const result=await runCommitRehearsal({env:good,connect});
 assert.equal(result.verdict,"ESCALATE");
 assert.ok(result.failures.includes("persisted-state-verification"));
 assert.equal(calls.filter(([,q])=>q==="COMMIT").length,1);
 assert.equal(calls.filter(([,q])=>q==="ROLLBACK").length,1);
 assert.equal(sessions,2);
});
