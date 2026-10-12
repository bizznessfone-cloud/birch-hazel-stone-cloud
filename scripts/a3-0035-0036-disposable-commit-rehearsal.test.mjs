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
