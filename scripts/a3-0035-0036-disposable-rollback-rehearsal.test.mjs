import test from "node:test";
import assert from "node:assert/strict";
import {TARGET,validateEnvironment,rehearsal} from "./a3-0035-0036-disposable-rollback-rehearsal.mjs";
const env={A3_REHEARSAL_CONFIRMATION:"REHEARSE-0035-0036-DISPOSABLE",A3_REHEARSAL_OWNER_URL:`postgresql://neondb_owner:placeholder@${TARGET.endpoint}.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require`};
test("pinned disposable endpoint accepted",()=>assert.deepEqual(validateEnvironment(env),[]));
test("production endpoint rejected",()=>assert.ok(validateEnvironment({...env,A3_REHEARSAL_OWNER_URL:env.A3_REHEARSAL_OWNER_URL.replace(TARGET.endpoint,"ep-withered-haze-b1fd9hse")}).includes("endpoint")));
test("ambient production credentials rejected",()=>assert.ok(validateEnvironment({...env,DATABASE_URL:"postgres://forbidden"}).includes("ambient-credentials")));
test("missing explicit confirmation rejected",()=>assert.ok(validateEnvironment({...env,A3_REHEARSAL_CONFIRMATION:""}).includes("confirmation")));
test("unapproved target does not connect",async()=>{let called=false;const r=await rehearsal({env:{...env,A3_REHEARSAL_CONFIRMATION:""},connect:async()=>{called=true;throw Error("unexpected");}});assert.equal(r.verdict,"BLOCKED");assert.equal(called,false)});
test("live identity drift rolls back",async()=>{
 const calls=[];
 const db={async query(sql){calls.push(sql);if(sql.includes("SELECT current_database()"))return {rows:[{database:"neondb",role:"neondb_owner",session_role:"neondb_owner",project:TARGET.project,branch:"br-wrong",endpoint:TARGET.endpoint}]};return {rows:[]}},async end(){calls.push("CLOSED")}};
 const r=await rehearsal({env,connect:async()=>db});
 assert.equal(r.verdict,"BLOCKED");assert.ok(r.failures.includes("live-identity"));assert.ok(calls.includes("ROLLBACK"));assert.equal(calls.at(-1),"CLOSED");assert.equal(calls.some(x=>/INSERT INTO public._migrations/.test(x)),false);
});
