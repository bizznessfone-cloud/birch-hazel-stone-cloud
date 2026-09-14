import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("./verify-neon-runtime.mjs", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("verify:neon is the read-only runtime verifier; full gate remains separate", () => {
  assert.equal(pkg.scripts["verify:neon"], "node scripts/verify-neon-runtime.mjs");
  assert.equal(pkg.scripts["verify:neon:full"], "node scripts/verify-neon-production.mjs");
  assert.match(pkg.scripts.build, /vite build/);
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.equal(pkg.scripts["db:migrate"], "node scripts/migrate.mjs");
  assert.equal(pkg.scripts["db:provision"], "node --experimental-strip-types scripts/provision-hotel.mjs");
});

test("runtime verifier requires DATABASE_URL only and stays read-only", () => {
  assert.match(src, /DATABASE_URL/);
  assert.match(src, /credentials unavailable/);
  assert.doesNotMatch(src, /process\.env\.AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(src, /ownerUrl/);
  assert.doesNotMatch(src, /migration-plan\.mjs/);
  assert.doesNotMatch(src, /migrate\.mjs/);
  assert.doesNotMatch(src, /pendingMigrations/);
  assert.doesNotMatch(src, /\bCREATE\s+TABLE\b/i);
  assert.doesNotMatch(src, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(src, /\bUPDATE\s+[a-z_]+\s+SET\b/i);
  assert.doesNotMatch(src, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(src, /\bALTER\s+(TABLE|ROLE|FUNCTION|TRIGGER)\b/i);
  assert.doesNotMatch(src, /\bDROP\s+(TABLE|TRIGGER|FUNCTION|CONSTRAINT|EXTENSION)\b/i);
  const sql = [...src.matchAll(/\.query\(\s*`([^`]+)`/g)].map((m) => m[1]).join("\n");
  assert.doesNotMatch(sql, /SET\s+ROLE/i);
  assert.doesNotMatch(src, /options:\s*[`'"].*-c role=/);
});

test("runtime verifier proves aether_app identity, role attributes, and catalog checks", () => {
  assert.match(src, /session_user/);
  assert.match(src, /current_user/);
  assert.match(src, /aether_app/);
  assert.match(src, /rolcanlogin/);
  assert.match(src, /rolsuper/);
  assert.match(src, /rolcreatedb/);
  assert.match(src, /rolcreaterole/);
  assert.match(src, /rolreplication/);
  assert.match(src, /rolbypassrls/);
  assert.match(src, /neon_superuser/);
  assert.match(src, /pg_has_role/);
  assert.match(src, /current_database/);
  assert.match(src, /neondb/);
  assert.match(src, /aether_meta/);
  assert.match(src, /schema_phase/);
  assert.match(src, /runtime_login/);
  assert.match(src, /has_table_privilege/);
  assert.match(src, /has_column_privilege/);
  assert.match(src, /aether_civil_instant/);
  assert.match(src, /aether_athens_instant/);
  assert.match(src, /PRODUCTION RUNTIME VERIFICATION: PASS/);
  assert.match(src, /PRODUCTION RUNTIME VERIFICATION: BLOCKED/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*runtimeUrl/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*process\.env/);
  assert.match(src, /DATABASE_URL: SET/);
  assert.match(src, /postgres:\/\/redacted/);
});
