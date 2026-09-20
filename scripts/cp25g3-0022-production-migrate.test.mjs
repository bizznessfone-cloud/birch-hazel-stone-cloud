import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { BLOCKED_OWNER_URL } from "./production-db-preflight.mjs";
import {
  ALREADY_APPLIED,
  APPLIED_VERIFIED,
  AUTHORISED,
  CONFIRM_BLOCKED,
  DIGEST_BLOCKED,
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  POST_BLOCKED,
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  ROLE_BLOCKED,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNAUTHORISED_MIGRATION,
  UNEXPECTED_PLAN,
  applyExact0022,
  assertAuthorisedMigrationName,
  assertConfirmation,
  assertMigrationFile,
  dmlGranted,
  evaluate0022Aftermath,
  evaluate0022Baseline,
  forbiddenAbsent,
  ownerUrlFromEnv,
  runSingleUse0022,
  sha256,
} from "./cp25g3-0022-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "cp25g3-0022-production-migrate.mjs"), "utf8");
const workflow = readFileSync(
  join(here, "../.github/workflows/cp25g3-0022-production-migrate.yml"),
  "utf8",
);
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
const migrationBytes = readFileSync(join(here, "../migrations", TARGET_MIGRATION));
const migrationDigest = createHash("sha256").update(migrationBytes).digest("hex");

const SOURCE = [
  ...REQUIRED_LEDGER,
  TARGET_MIGRATION,
];

const occupancy = [
  {
    name: "bookings_driver_occupancy_excl",
    definition: "EXCLUDE USING gist (driver_id WITH =, occupies WITH &&)",
    owner: "neondb_owner",
  },
  {
    name: "bookings_vehicle_occupancy_excl",
    definition: "EXCLUDE USING gist (vehicle_id WITH =, occupies WITH &&)",
    owner: "neondb_owner",
  },
];

const safeRole = {
  login: true,
  superuser: false,
  createdb: false,
  createrole: false,
  replication: false,
  bypassrls: false,
};

const noDml = {
  select: false,
  insert: false,
  update: false,
  delete: false,
  truncate: false,
  references: false,
  trigger: false,
};

const grantedDml = {
  select: true,
  insert: true,
  update: true,
  delete: true,
  truncate: false,
  references: false,
  trigger: false,
};

function privileges(template) {
  return {
    user: { ...template },
    session: { ...template },
    account: { ...template },
    verification: { ...template },
  };
}

function canonicalFile(overrides = {}) {
  return {
    name: TARGET_MIGRATION,
    bytes: migrationBytes,
    digest: migrationDigest,
    sql: migrationBytes.toString("utf8"),
    ...overrides,
  };
}

function authorisedFacts(overrides = {}) {
  return {
    confirmation: REQUIRED_CONFIRMATION,
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    ownerUrl: "postgres://owner@host/neondb",
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...REQUIRED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: SOURCE,
    authTables: {
      user: "PRESENT",
      session: "PRESENT",
      account: "PRESENT",
      verification: "PRESENT",
    },
    authTableOwners: {
      user: "neondb_owner",
      session: "neondb_owner",
      account: "neondb_owner",
      verification: "neondb_owner",
    },
    aetherAppExists: true,
    aetherAppRole: { ...safeRole },
    privileges: privileges(noDml),
    schemaCreate: false,
    occupancy,
    tableOwners: { hotels: "neondb_owner", bookings: "neondb_owner" },
    schemaPhase: "16",
    checkpoint: "23",
    hotel: {
      code: "demo-kos",
      name: "Aether Demo Hotel",
      status: "live",
      providerCount: 1,
      destinationCount: 4,
    },
    ...overrides,
  };
}

function appliedFacts(overrides = {}) {
  return authorisedFacts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    privileges: privileges(grantedDml),
    ...overrides,
  });
}

test("canonical 0022 digest is pinned and unmodified", () => {
  assert.equal(migrationDigest, TARGET_DIGEST);
  assert.equal(sha256(migrationBytes), TARGET_DIGEST);
  assert.equal(assertMigrationFile(canonicalFile()).ok, true);
});

test("missing owner URL blocks and DATABASE_URL cannot substitute", async () => {
  assert.equal(ownerUrlFromEnv({}), "");
  assert.equal(ownerUrlFromEnv({ DATABASE_URL: "postgres://runtime@host/neondb" }), "");
  let loaded = 0;
  let applied = 0;
  const result = await runSingleUse0022({
    env: { DATABASE_URL: "postgres://runtime:secret@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyMigration: async () => {
      applied += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, BLOCKED_OWNER_URL);
  assert.equal(loaded, 0);
  assert.equal(applied, 0);
});

test("wrong confirmation phrase blocks before connecting", async () => {
  let loaded = 0;
  const result = await runSingleUse0022({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: "apply-please",
    file: canonicalFile(),
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyMigration: async () => {},
  });
  assert.equal(assertConfirmation("APPLY-CP25G3-0022-PRODUCTION").ok, true);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, CONFIRM_BLOCKED);
  assert.equal(loaded, 0);
});

test("wrong database or owner identity blocks", () => {
  const file = canonicalFile();
  assert.equal(evaluate0022Baseline(authorisedFacts({ database: "postgres" }), file).verdict, IDENTITY_BLOCKED);
  assert.equal(
    evaluate0022Baseline(authorisedFacts({ currentUser: "aether_app", sessionUser: "aether_app" }), file)
      .verdict,
    OWNER_BLOCKED,
  );
});

test("modified 0022 digest is rejected", () => {
  const tampered = canonicalFile({ digest: "0".repeat(64), sql: "-- tampered\n" });
  assert.equal(assertMigrationFile(tampered).verdict, DIGEST_BLOCKED);
  assert.equal(evaluate0022Baseline(authorisedFacts(), tampered).verdict, DIGEST_BLOCKED);
});

test("missing historical migration blocks", () => {
  const ledger = REQUIRED_LEDGER.filter((name) => name !== "0017_cp16_runtime_privilege_hardening.sql");
  const result = evaluate0022Baseline(authorisedFacts({ ledger }), canonicalFile());
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "BLOCKED — MISSING HISTORICAL MIGRATION");
  assert.deepEqual(result.missingHistorical, ["0017_cp16_runtime_privilege_hardening.sql"]);
});

test("unexpected pending migration blocks", () => {
  const result = evaluate0022Baseline(
    authorisedFacts({
      sourceMigrations: [...SOURCE, "0023_unexpected.sql"],
    }),
    canonicalFile(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(result.pending, [TARGET_MIGRATION, "0023_unexpected.sql"]);
});

test("pending exactly 0022 is authorised even if DML is already partially present", () => {
  const result = evaluate0022Baseline(
    authorisedFacts({
      privileges: privileges({ ...noDml, select: true }),
    }),
    canonicalFile(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.authorised, true);
  assert.equal(result.verdict, AUTHORISED);
  assert.deepEqual(result.pending, [TARGET_MIGRATION]);
});

test("0022 already applied with empty pending is a safe no-op", async () => {
  let applied = 0;
  const result = await runSingleUse0022({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    loadFacts: async () => appliedFacts(),
    applyMigration: async () => {
      applied += 1;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.verdict, ALREADY_APPLIED);
  assert.equal(applied, 0);
});

test("mutation executor cannot apply 0023", async () => {
  let executed = 0;
  await assert.rejects(
    () =>
      applyExact0022({
        name: "0023_future.sql",
        sql: "select 1",
        execute: async () => {
          executed += 1;
        },
      }),
    /UNAUTHORISED MIGRATION/,
  );
  assert.equal(executed, 0);
  assert.equal(assertAuthorisedMigrationName("0023_future.sql").verdict, UNAUTHORISED_MIGRATION);
  assert.equal(assertAuthorisedMigrationName(TARGET_MIGRATION).ok, true);
});

test("authorised 0022 applies once and post-state must include 0022 exactly once", async () => {
  let applied = 0;
  const result = await runSingleUse0022({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    loadFacts: async () => (applied === 0 ? authorisedFacts() : appliedFacts()),
    applyMigration: async (sql) => {
      applied += 1;
      assert.match(sql, /grant select, insert, update, delete on table "user"/);
      assert.doesNotMatch(sql, /0023/);
    },
  });
  assert.equal(applied, 1);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, APPLIED_VERIFIED);
  const after = evaluate0022Aftermath(appliedFacts());
  assert.equal(after.ok, true);
  const duplicate = evaluate0022Aftermath(
    appliedFacts({ ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION, TARGET_MIGRATION] }),
  );
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.verdict, POST_BLOCKED);
});

test("post-state requires DML true and forbidden privileges false", () => {
  assert.equal(dmlGranted(privileges(grantedDml)), true);
  assert.equal(forbiddenAbsent(privileges(grantedDml)), true);
  const missingInsert = privileges(grantedDml);
  missingInsert.session.insert = false;
  assert.equal(evaluate0022Aftermath(appliedFacts({ privileges: missingInsert })).ok, false);
  const truncated = privileges(grantedDml);
  truncated.user.truncate = true;
  assert.equal(evaluate0022Aftermath(appliedFacts({ privileges: truncated })).ok, false);
});

test("aether_app privilege escalation is rejected", () => {
  const escalated = evaluate0022Baseline(
    authorisedFacts({ aetherAppRole: { ...safeRole, superuser: true } }),
    canonicalFile(),
  );
  assert.equal(escalated.ok, false);
  assert.equal(escalated.verdict, ROLE_BLOCKED);
  const post = evaluate0022Aftermath(
    appliedFacts({ aetherAppRole: { ...safeRole, bypassrls: true } }),
  );
  assert.equal(post.ok, false);
  assert.equal(post.failures.includes("role-escalation"), true);
});

test("build and Vercel cannot invoke this controller", () => {
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkg.scripts.build, /cp25g3-0022/);
  assert.doesNotMatch(pkg.scripts.build, /production-db-migrate/);
  assert.equal(pkg.scripts["db:migrate:0022"], "node scripts/cp25g3-0022-production-migrate.mjs");
  assert.doesNotMatch(workflow, /vercel/i);
  assert.doesNotMatch(workflow, /deploy/i);
});

test("workflow is manual-only with exact confirmation and concurrency protection", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bpush\s*:/);
  assert.doesNotMatch(workflow, /\bpull_request\s*:/);
  assert.doesNotMatch(workflow, /\bschedule\s*:/);
  assert.doesNotMatch(workflow, /\bworkflow_run\s*:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/s);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /node-version:\s*"22"/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /APPLY-CP25G3-0022-PRODUCTION/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /CP25G3_CONFIRMATION/);
  assert.match(workflow, /secrets\.AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(workflow, /DATABASE_URL/);
  assert.doesNotMatch(workflow, /set -x/);
  assert.doesNotMatch(workflow, /db:migrate/);
  assert.match(workflow, /node scripts\/cp25g3-0022-production-migrate\.mjs/);
});

test("controller source never emits secrets and never uses DATABASE_URL", () => {
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*process\.env/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*ownerUrl/);
  assert.doesNotMatch(src, /BETTER_AUTH_SECRET/);
  assert.doesNotMatch(src, /sbg_sync_hotel_entitlement/);
  assert.doesNotMatch(src, /provision-hotel/);
  assert.doesNotMatch(src, /migrate\.mjs/);
  assert.match(src, /BEGIN READ ONLY/);
  assert.match(src, /ROLLBACK/);
  assert.match(src, /INSERT INTO _migrations/);
  const redacted = "postgres://owner:secret@host/neondb";
  assert.doesNotMatch(
    src.includes("redact") ? "postgres://redacted" : redacted,
    /owner:secret/,
  );
});

test("apply failure rolls back decision as failed and does not claim success", async () => {
  let applied = 0;
  const result = await runSingleUse0022({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    loadFacts: async () => authorisedFacts(),
    applyMigration: async () => {
      applied += 1;
      throw new Error("permission denied postgres://owner:secret@host/neondb");
    },
  });
  assert.equal(applied, 1);
  assert.equal(result.ok, false);
  assert.match(result.verdict, /0022 APPLICATION FAILED|UNAUTHORISED/);
  assert.doesNotMatch(result.error, /secret/);
});
