/**
 * CP19D temporary production runtime identity diagnostic — source contract.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

function readRel(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const IMMUTABLE = {
  "0011_production_hardening.sql":
    "fbb2cd518f1f9b7795a5b4e4ec6577126218ece691ec249cee79484f9ef8a686",
  "0012_cp12_tenancy.sql":
    "b97d03c6c59dde476a5b5afa4b6b99cf71c5652c01a450f5051a565dc42151c3",
  "0013_cp12b_runtime_login.sql":
    "112995194d0933179cc5ad2ed6c29297b53c1cf371871c35f6c1a105c30775ad",
  "0014_cp13a_production_app_role.sql":
    "387ac532999f1eebf8041e3b43afa33b1a253b0a779265fe42d9300bbbc2f7d8",
  "0015_cp14_hotel_configuration.sql":
    "052ef58cbd728a4dc8435f3cbd0eb5769fdcb6debab02d97d2959d46b6bac02c",
  "0016_cp14_hotel_timezone.sql":
    "a227cb4c40d261ef55d4e6ce11e23f5fc6cb6611259316a768ec277d3ae045ca",
  "0017_cp16_runtime_privilege_hardening.sql":
    "98f5ab213ca214d6bbade354544b15c0c1bd30c81cf7e54a582257a86313a0bb",
} as const;

describe("CP19D temporary runtime identity diagnostic", () => {
  const server = readRel("./runtime-identity.server.ts");
  const fns = readRel("./runtime-identity-fns.ts");
  const route = readRel("../../routes/ops.internal.runtime-identity.tsx");
  const cliRuntime = readRel("../../../scripts/verify-neon-runtime.mjs");
  const cliFull = readRel("../../../scripts/verify-neon-production.mjs");
  const pkg = JSON.parse(readRel("../../../package.json"));
  const combined = `${server}\n${fns}\n${route}`;

  test("requires requireOps and uses the application neon pool", () => {
    assert.match(fns, /requireOps\(\{\s*csrf:\s*false\s*\}\)/);
    assert.match(fns, /createServerFn\(\{\s*method:\s*"GET"\s*\}\)/);
    assert.match(route, /createFileRoute\("\/ops\/internal\/runtime-identity"\)/);
    assert.match(route, /handlers:\s*\{/);
    assert.match(route, /GET:/);
    assert.match(route, /runRuntimeIdentityDiagnostic/);
    assert.match(server, /getDbSource\(\)/);
    assert.match(server, /!== "neon"/);
    assert.match(server, /getPgPool\(\)/);
    assert.match(server, /client\.release\(\)/);
    assert.doesNotMatch(combined, /AETHER_DATABASE_OWNER_URL/);
    assert.doesNotMatch(combined, /new\s+(?:pg\.)?Pool\b/);
    assert.doesNotMatch(combined, /pool\.end\(/);
    assert.doesNotMatch(combined, /getPglite\(/);
    assert.doesNotMatch(combined, /SET\s+ROLE/i);
    assert.doesNotMatch(combined, /SET\s+SESSION\s+AUTHORIZATION/i);
  });

  test("contains no mutating SQL and does not expose secrets", () => {
    const sql = [...combined.matchAll(/`([^`]+)`/g)].map((m) => m[1]).join("\n");
    assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
    assert.doesNotMatch(sql, /\bUPDATE\s+[a-z_]+\s+SET\b/i);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(sql, /\bALTER\s+(TABLE|ROLE|FUNCTION|TRIGGER)\b/i);
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|TRIGGER|FUNCTION|CONSTRAINT|EXTENSION)\b/i);
    assert.doesNotMatch(sql, /\bCREATE\s+TABLE\b/i);
    assert.doesNotMatch(sql, /\bGRANT\b/i);
    assert.doesNotMatch(sql, /\bREVOKE\b/i);
    assert.match(sql, /has_table_privilege/);
    assert.match(sql, /has_column_privilege/);
    assert.match(sql, /has_schema_privilege/);
    assert.match(sql, /has_function_privilege/);
    assert.match(sql, /session_user/);
    assert.match(sql, /current_user/);
    assert.match(server, /neondb/);
    assert.match(server, /AETHER_APP_ROLE/);
    assert.match(server, /EXPECTED_OWNER = "neondb_owner"/);
    assert.match(fns, /unauthorized/);
    assert.match(fns, /runtime identity verification failed/);
    assert.doesNotMatch(combined, /process\.env\.DATABASE_URL/);
    assert.doesNotMatch(combined, /console\.(?:log|error|info)\(/);
  });

  test("guest routes do not import the diagnostic", () => {
    const guestBook = readRel("../../routes/book.$hotelCode.tsx");
    const confirmed = readRel("../../routes/confirmed.$token.tsx");
    const index = readRel("../../routes/index.tsx");
    for (const src of [guestBook, confirmed, index]) {
      assert.doesNotMatch(src, /runtime-identity/);
      assert.doesNotMatch(src, /ops\/internal\/runtime-identity/);
    }
    const opsIndex = readRel("../../routes/ops.index.tsx");
    assert.doesNotMatch(opsIndex, /runtime-identity/);
  });

  test("canonical CLI verifiers remain unchanged and 0011–0017 stay immutable", () => {
    assert.equal(pkg.scripts["verify:neon"], "node scripts/verify-neon-runtime.mjs");
    assert.equal(pkg.scripts["verify:neon:full"], "node scripts/verify-neon-production.mjs");
    assert.match(cliRuntime, /PRODUCTION RUNTIME VERIFICATION: PASS/);
    assert.match(cliFull, /AETHER_DATABASE_OWNER_URL/);
    assert.doesNotMatch(cliRuntime, /runtime-identity/);
    assert.doesNotMatch(cliFull, /runtime-identity/);
    for (const [name, expected] of Object.entries(IMMUTABLE)) {
      const text = readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
      assert.equal(sha256(text), expected, name);
    }
    assert.equal(existsSync(new URL("../../../migrations/0018_cp19.sql", import.meta.url)), false);
  });
});
