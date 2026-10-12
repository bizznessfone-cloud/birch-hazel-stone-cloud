#!/usr/bin/env node
/**
 * Combined 0035/0036 disposable rehearsal. NEVER targets production.
 * Defaults to ROLLBACK; even COMMIT is restricted to the pinned disposable branch.
 * Requires explicit A3_REHEARSAL_CONFIRMATION=REHEARSE-0035-0036-DISPOSABLE.
 */
import pg from "pg";
import {readFile} from "node:fs/promises";
import {resolve,dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {ACCEPTED_LEDGER} from "./production-db-preflight.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
export const TARGET=Object.freeze({project:"quiet-sound-53513710",branch:"br-crimson-cherry-b1zd1gay",endpoint:"ep-cold-bread-b108y6kr",database:"neondb",role:"neondb_owner"});
const migrations=[
 ["0035_cp3005e2d2d_founding_property.sql","80d1d3ec68eebfba0bcfbe07ac3c3dd1ade11d7d0466be9264cf0f28d27def67"],
 ["0036_cp3005e2d2d_founding_integrity.sql","fb300bb17c8e9758700cf2fd09aa355b0293b5cd84c692e2913835876ece18fc"],
];
export function validateEnvironment(env){
 const errors=[];
 if(env.A3_REHEARSAL_CONFIRMATION!=="REHEARSE-0035-0036-DISPOSABLE")errors.push("confirmation");
 if(env.DATABASE_URL||env.NEON_API_KEY||env.AETHER_DATABASE_OWNER_URL)errors.push("ambient-credentials");
 let u;
 try{u=new URL(env.A3_REHEARSAL_OWNER_URL);}catch{return [...errors,"owner-url"];}
 if(!["postgres:","postgresql:"].includes(u.protocol))errors.push("protocol");
 if(decodeURIComponent(u.username)!==TARGET.role)errors.push("role");
 if(!u.password)errors.push("password");
 if(decodeURIComponent(u.pathname.slice(1))!==TARGET.database)errors.push("database");
 if(u.hostname!==TARGET.endpoint+".c-5.eu-central-1.aws.neon.tech")errors.push("endpoint");
 if(u.searchParams.get("sslmode")!=="require")errors.push("ssl");
 if([...u.searchParams.keys()].some(k=>!["sslmode"].includes(k)))errors.push("connection-options");
 return errors;
}
const hash=b=>createHash("sha256").update(b).digest("hex");
export async function rehearsal({env=process.env,connect,read=readFile}={}){
 const failures=validateEnvironment(env);
 if(failures.length)return {verdict:"BLOCKED",failures};
 const sources=[];
 for(const [name,digest] of migrations){
   const bytes=await read(join(root,"migrations",name));
   if(hash(bytes)!==digest)return {verdict:"BLOCKED",failures:["migration-digest-"+name]};
   sources.push(String(bytes));
 }
 const db=connect?await connect(env.A3_REHEARSAL_OWNER_URL):new pg.Client({connectionString:env.A3_REHEARSAL_OWNER_URL,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:5000,statement_timeout:30000,query_timeout:35000});
 let open=false;
 try{
  if(!connect)await db.connect();
  await db.query("BEGIN");open=true;
  await db.query("SET LOCAL lock_timeout = '5s'");
  await db.query("SET LOCAL statement_timeout = '30s'");
  const id=(await db.query("SELECT current_database() AS database,current_user AS role,session_user AS session_role,current_setting('neon.project_id',true) AS project,current_setting('neon.branch_id',true) AS branch,current_setting('neon.endpoint_id',true) AS endpoint")).rows[0];
  if(!id||id.database!==TARGET.database||id.role!==TARGET.role||id.session_role!==TARGET.role||id.project!==TARGET.project||id.branch!==TARGET.branch||id.endpoint!==TARGET.endpoint)return {verdict:"BLOCKED",failures:["live-identity"]};
  const names=(await db.query("SELECT name FROM public._migrations ORDER BY name")).rows.map(r=>r.name);
  if(names.length!==ACCEPTED_LEDGER.length||new Set(names).size!==names.length||names.some(n=>!ACCEPTED_LEDGER.includes(n)))return {verdict:"BLOCKED",failures:["ledger-drift"]};
  const pre=(await db.query("SELECT (SELECT count(*) FROM (SELECT created_by_user_id FROM public.sbg_organisations GROUP BY created_by_user_id HAVING count(*)>1) x)::int AS duplicates,(SELECT count(*) FROM public.sbg_organisation_acceptances)::int AS acceptances,(to_regclass('public.sbg_approved_property_agreement_versions') IS NOT NULL) AS approval_exists")).rows[0];
  if(pre.duplicates!==0||pre.acceptances!==0||pre.approval_exists!==false)return {verdict:"BLOCKED",failures:["baseline-drift"]};
  for(let i=0;i<2;i++){
   await db.query(sources[i]);
   await db.query("INSERT INTO public._migrations(name) VALUES ($1)",[migrations[i][0]]);
  }
  const post=(await db.query("SELECT (SELECT count(*) FROM public._migrations)::int AS ledger_count,(to_regclass('public.sbg_approved_property_agreement_versions') IS NOT NULL) AS approval_exists,(to_regclass('public.sbg_organisations_one_founding_creator_uidx') IS NOT NULL) AS creator_index_exists,(to_regclass('public.sbg_approved_property_agreement_versions_one_effective_uidx') IS NOT NULL) AS effective_index_exists,(SELECT count(*) FROM public.sbg_approved_property_agreement_versions)::int AS approved_versions")).rows[0];
  if(post.ledger_count!==36||!post.approval_exists||!post.creator_index_exists||!post.effective_index_exists||post.approved_versions!==0)return {verdict:"BLOCKED",failures:["postcondition"]};
  await db.query("ROLLBACK");open=false;
  return {verdict:"PASS — DISPOSABLE COMBINED REHEARSAL ROLLED BACK",migrationCount:36,productionModified:false};
 }catch{return {verdict:"BLOCKED",failures:["transaction-error-redacted"]};}
 finally{if(open){try{await db.query("ROLLBACK")}catch{}}await db.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 rehearsal().then(r=>{console.log(JSON.stringify(r));if(r.verdict.startsWith("BLOCKED"))process.exitCode=2}).catch(()=>{console.error("BLOCKED — REHEARSAL ERROR");process.exitCode=2});
}
