import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  BLOCKED_OWNER_URL,
  ACCEPTED_LEDGER,
  AUTHORISED_PENDING,
  evaluatePreflight,
  isAuthorisedPending,
} from "./production-db-preflight.mjs";
import { evaluateMigrationBaseline, GENERIC_MIGRATE_BLOCKED } from "./production-db-migrate.mjs";
import { buildHotelSnapshot } from "./cp26a2-0023-production-migrate.mjs";
import {
  ALREADY_APPLIED,
  APPLIED_VERIFIED,
  AUTHORISED,
  CONFIRM_BLOCKED,
  CONTRACT_INVALID,
  DIGEST_BLOCKED,
  EXPECTED_FUNCTIONS,
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  OWNER_FUNCTION_NAMES,
  OWNER_TABLES,
  PARTIAL_BLOCKED,
  POST_BLOCKED,
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  REVIEWED_DIGESTS,
  REVIEWED_DIGEST_BLOCKED,
  ROLE_BLOCKED,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNAUTHORISED_MIGRATION,
  UNEXPECTED_PLAN,
  applyExact0025,
  assertAuthorisedMigrationName,
  assertConfirmation,
  assertMigrationFile,
  assertReviewedChecksums,
  evaluate0025Aftermath,
  evaluate0025Baseline,
  ownerFunctionContractFailures,
  ownerInstalledContractFailures,
  ownerSchemaPresentNames,
  ownerUrlFromEnv,
  runSingleUse0025,
  sha256,
} from "./cp26co2a-0025-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "cp26co2a-0025-production-migrate.mjs"), "utf8");
const workflowPath = join(here, "../.github/workflows/cp26co2a-0025-production-migrate.yml");
const workflow = readFileSync(workflowPath, "utf8");
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
const migrationBytes = readFileSync(join(here, "../migrations", TARGET_MIGRATION));
const migrationDigest = createHash("sha256").update(migrationBytes).digest("hex");
const sql0025 = migrationBytes.toString("utf8");
const SOURCE = [...REQUIRED_LEDGER, TARGET_MIGRATION];

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

const DEMO_ID = "11111111-1111-1111-1111-111111111111";
const hotelSnapshot = buildHotelSnapshot({
  hotelCount: 2,
  statusRows: [
    { status: "configured", n: 1 },
    { status: "live", n: 1 },
  ],
  demoKos: { id: DEMO_ID, code: "demo-kos", status: "live" },
  liveHotels: [{ id: DEMO_ID, code: "demo-kos", status: "live" }],
});
const billingSnapshot = { accountCount: 0, statusCounts: {}, eventCount: 0 };
const verifyHotel = { code: "sbg-verify-a5", status: "configured" };

function emptyTable() {
  return {
    present: false,
    owner: null,
    selectApp: false,
    insertApp: false,
    updateApp: false,
    deleteApp: false,
    truncateApp: false,
  };
}

function installedTable() {
  return {
    present: true,
    owner: "neondb_owner",
    selectApp: true,
    insertApp: false,
    updateApp: false,
    deleteApp: false,
    truncateApp: false,
  };
}

function emptyFn() {
  return {
    count: 0,
    nargs: null,
    argTypes: [],
    argNames: [],
    returnType: null,
    owner: null,
    securityDefiner: false,
    searchPath: "",
    executeAetherApp: false,
    executePublic: false,
  };
}

function installedFn(expected) {
  return {
    count: 1,
    nargs: expected.nargs,
    argTypes: [...expected.argTypes],
    argNames: [...expected.argNames],
    returnType: expected.returnType,
    owner: "neondb_owner",
    securityDefiner: true,
    searchPath: expected.searchPath,
    executeAetherApp: expected.executeAetherApp,
    executePublic: false,
  };
}

function absentOwnerSchema() {
  return {
    tables: {
      sbg_platform_owners: emptyTable(),
      sbg_owner_audit_events: emptyTable(),
    },
    functions: {
      sbg_bootstrap_platform_owner: emptyFn(),
      sbg_grant_platform_owner: emptyFn(),
      sbg_revoke_platform_owner: emptyFn(),
    },
    stripeEventsSelectApp: false,
    grantCount: 0,
    auditCount: 0,
  };
}

function installedOwnerSchema(overrides = {}) {
  const functions = Object.fromEntries(
    EXPECTED_FUNCTIONS.map((expected) => [expected.name, installedFn(expected)]),
  );
  return {
    tables: {
      sbg_platform_owners: installedTable(),
      sbg_owner_audit_events: installedTable(),
    },
    functions,
    stripeEventsSelectApp: true,
    grantCount: 0,
    auditCount: 0,
    ...overrides,
  };
}

function canonicalFile(overrides = {}) {
  return {
    name: TARGET_MIGRATION,
    bytes: migrationBytes,
    digest: migrationDigest,
    sql: sql0025,
    ...overrides,
  };
}

function reviewedChecksums(overrides = {}) {
  return { ...REVIEWED_DIGESTS, ...overrides };
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
    schemaCreate: false,
    occupancy,
    tableOwners: { hotels: "neondb_owner", bookings: "neondb_owner" },
    hotel: {
      code: "demo-kos",
      name: "Aether Demo Hotel",
      status: "live",
      providerCount: 1,
      destinationCount: 4,
    },
    hotelSnapshot: {
      hotelCount: hotelSnapshot.hotelCount,
      statusCounts: { ...hotelSnapshot.statusCounts },
      demoKos: { ...hotelSnapshot.demoKos },
      liveHotels: hotelSnapshot.liveHotels.map((row) => ({ ...row })),
    },
    billingSnapshot: { ...billingSnapshot, statusCounts: {} },
    verifyHotel: { ...verifyHotel },
    ownerSchema: absentOwnerSchema(),
    ...overrides,
  };
}

function appliedFacts(overrides = {}) {
  return authorisedFacts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    ownerSchema: installedOwnerSchema(),
    ...overrides,
  });
}

test("canonical 0025 digest is pinned and unmodified", () => {
  assert.equal(migrationDigest, TARGET_DIGEST);
  assert.equal(sha256(migrationBytes), TARGET_DIGEST);
  assert.equal(assertMigrationFile(canonicalFile()).ok, true);
  assert.equal(REQUIRED_CONFIRMATION, "APPLY-0025");
});

test("reviewed 0020-0025 source checksums are pinned", () => {
  for (const [name, expected] of Object.entries(REVIEWED_DIGESTS)) {
    const bytes = readFileSync(join(here, "../migrations", name));
    assert.equal(sha256(bytes), expected, name);
  }
  assert.equal(assertReviewedChecksums(reviewedChecksums()).ok, true);
});

test("0025 SQL is Owner schema only and does not grant an Owner", () => {
  assert.match(sql0025, /create table if not exists sbg_platform_owners/);
  assert.match(sql0025, /create table if not exists sbg_owner_audit_events/);
  assert.match(sql0025, /sbg_bootstrap_platform_owner/);
  assert.match(sql0025, /cannot revoke the last platform owner/);
  assert.doesNotMatch(sql0025, /grant execute on function sbg_bootstrap_platform_owner/i);
  assert.match(sql0025, /grant execute on function sbg_grant_platform_owner/);
  assert.doesNotMatch(sql0025, /sbg_saas_plans/);
  assert.doesNotMatch(sql0025, /update\s+hotels/i);
  assert.doesNotMatch(sql0025, /SBG_SAAS_COMMERCE/);
  assert.doesNotMatch(sql0025, /@scanbookgo|@gmail\.com|allowlist/i);
});

test("missing owner URL blocks and DATABASE_URL cannot substitute", async () => {
  assert.equal(ownerUrlFromEnv({}), "");
  assert.equal(ownerUrlFromEnv({ DATABASE_URL: "postgres://runtime@host/neondb" }), "");
  let loaded = 0;
  const result = await runSingleUse0025({
    env: { DATABASE_URL: "postgres://runtime:secret@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyMigration: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, BLOCKED_OWNER_URL);
  assert.equal(loaded, 0);
});

test("wrong confirmation phrase blocks before connecting", async () => {
  let loaded = 0;
  const result = await runSingleUse0025({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: "APPLY-0024",
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyMigration: async () => {},
  });
  assert.equal(assertConfirmation("APPLY-0025").ok, true);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, CONFIRM_BLOCKED);
  assert.equal(loaded, 0);
});

test("wrong database or owner identity blocks", () => {
  const file = canonicalFile();
  assert.equal(
    evaluate0025Baseline(authorisedFacts({ database: "postgres" }), file).verdict,
    IDENTITY_BLOCKED,
  );
  assert.equal(
    evaluate0025Baseline(
      authorisedFacts({ currentUser: "aether_app", sessionUser: "aether_app" }),
      file,
    ).verdict,
    OWNER_BLOCKED,
  );
  assert.equal(
    evaluate0025Baseline(
      authorisedFacts({ currentUser: "aether_runtime", sessionUser: "aether_runtime" }),
      file,
    ).verdict,
    OWNER_BLOCKED,
  );
});

test("runtime role escalation blocks", () => {
  const result = evaluate0025Baseline(
    authorisedFacts({ aetherAppRole: { ...safeRole, superuser: true } }),
    canonicalFile(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, ROLE_BLOCKED);
});

test("modified 0025 digest is rejected", () => {
  const tampered = canonicalFile({ digest: "0".repeat(64), sql: "-- tampered\n" });
  assert.equal(assertMigrationFile(tampered).verdict, DIGEST_BLOCKED);
  assert.equal(evaluate0025Baseline(authorisedFacts(), tampered).verdict, DIGEST_BLOCKED);
});

test("reviewed checksum mismatch blocks before connecting", async () => {
  let loaded = 0;
  const result = await runSingleUse0025({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums({
      "0024_cp26b2_ordered_billing_events.sql": "abc",
    }),
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyMigration: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, REVIEWED_DIGEST_BLOCKED);
  assert.equal(loaded, 0);
});

test("missing historical 0024 blocks", () => {
  const ledger = REQUIRED_LEDGER.filter(
    (name) => name !== "0024_cp26b2_ordered_billing_events.sql",
  );
  const result = evaluate0025Baseline(authorisedFacts({ ledger }), canonicalFile());
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "BLOCKED — MISSING HISTORICAL MIGRATION");
  assert.deepEqual(result.missingHistorical, ["0024_cp26b2_ordered_billing_events.sql"]);
});

test("unexpected pending 0026 blocks", () => {
  const result = evaluate0025Baseline(
    authorisedFacts({ sourceMigrations: [...SOURCE, "0026_later.sql"] }),
    canonicalFile(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(result.pending, [TARGET_MIGRATION, "0026_later.sql"]);
});

test("pending set not exactly 0025 blocks", () => {
  const result = evaluate0025Baseline(
    authorisedFacts({ sourceMigrations: [...REQUIRED_LEDGER, "0026_later.sql"] }),
    canonicalFile(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, UNEXPECTED_PLAN);
});

test("partial Owner schema while 0025 pending is blocked", () => {
  const result = evaluate0025Baseline(
    authorisedFacts({
      ownerSchema: {
        ...absentOwnerSchema(),
        tables: {
          sbg_platform_owners: installedTable(),
          sbg_owner_audit_events: emptyTable(),
        },
      },
    }),
    canonicalFile(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, PARTIAL_BLOCKED);
  assert.ok(result.present.includes("sbg_platform_owners"));
});

test("pending exactly 0025 with absent Owner schema is authorised", () => {
  const result = evaluate0025Baseline(authorisedFacts(), canonicalFile());
  assert.equal(result.ok, true);
  assert.equal(result.verdict, AUTHORISED);
  assert.deepEqual(result.pending, [TARGET_MIGRATION]);
  assert.deepEqual(ownerSchemaPresentNames(authorisedFacts().ownerSchema), []);
});

test("mutation executor cannot apply 0024 or 0026", async () => {
  let executed = 0;
  await assert.rejects(
    () =>
      applyExact0025({
        name: "0024_cp26b2_ordered_billing_events.sql",
        sql: "select 1",
        execute: async () => {
          executed += 1;
        },
      }),
    /UNAUTHORISED MIGRATION/,
  );
  await assert.rejects(
    () => applyExact0025({ name: "0026_later.sql", sql: "select 1", execute: async () => { executed += 1; } }),
    /UNAUTHORISED MIGRATION/,
  );
  assert.equal(executed, 0);
  assert.equal(assertAuthorisedMigrationName("0024_cp26b2_ordered_billing_events.sql").verdict, UNAUTHORISED_MIGRATION);
});

test("authorised 0025 applies once and aftermath requires schema contract plus invariance", async () => {
  let applied = 0;
  const result = await runSingleUse0025({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => (applied === 0 ? authorisedFacts() : appliedFacts()),
    applyMigration: async (sql) => {
      applied += 1;
      assert.match(sql, /sbg_platform_owners/);
      assert.match(sql, /sbg_bootstrap_platform_owner/);
      assert.doesNotMatch(sql, /update\s+hotels/i);
    },
  });
  assert.equal(applied, 1);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, APPLIED_VERIFIED);
  const after = evaluate0025Aftermath(appliedFacts(), hotelSnapshot, billingSnapshot, verifyHotel);
  assert.equal(after.ok, true);
  const changedHotel = evaluate0025Aftermath(
    appliedFacts({
      hotelSnapshot: buildHotelSnapshot({
        hotelCount: 2,
        statusRows: [{ status: "configured", n: 2 }],
        demoKos: { id: DEMO_ID, code: "demo-kos", status: "configured" },
        liveHotels: [],
      }),
    }),
    hotelSnapshot,
    billingSnapshot,
    verifyHotel,
  );
  assert.equal(changedHotel.ok, false);
  assert.equal(changedHotel.verdict, POST_BLOCKED);
  assert.ok(changedHotel.failures.includes("hotel-invariance"));
});

test("post-ledger mismatch fails", () => {
  const aftermath = evaluate0025Aftermath(
    appliedFacts({ ledger: [...REQUIRED_LEDGER] }),
    hotelSnapshot,
    billingSnapshot,
    verifyHotel,
  );
  assert.equal(aftermath.ok, false);
  assert.ok(aftermath.failures.includes("0025-ledger"));
});

test("wrong table ownership fails aftermath", () => {
  const schema = installedOwnerSchema();
  schema.tables.sbg_platform_owners = { ...installedTable(), owner: "aether_app" };
  const aftermath = evaluate0025Aftermath(
    appliedFacts({ ownerSchema: schema }),
    hotelSnapshot,
    billingSnapshot,
    verifyHotel,
  );
  assert.equal(aftermath.ok, false);
  assert.ok(aftermath.failures.includes("sbg_platform_owners-owner"));
});

test("wrong function ownership fails aftermath", () => {
  const schema = installedOwnerSchema();
  schema.functions.sbg_grant_platform_owner = {
    ...installedFn(EXPECTED_FUNCTIONS[1]),
    owner: "aether_app",
  };
  const aftermath = evaluate0025Aftermath(
    appliedFacts({ ownerSchema: schema }),
    hotelSnapshot,
    billingSnapshot,
    verifyHotel,
  );
  assert.equal(aftermath.ok, false);
  assert.ok(aftermath.failures.includes("sbg_grant_platform_owner-owner"));
});

test("wrong function signature fails aftermath", () => {
  const schema = installedOwnerSchema();
  schema.functions.sbg_bootstrap_platform_owner = {
    ...installedFn(EXPECTED_FUNCTIONS[0]),
    nargs: 3,
    argTypes: ["text", "text", "text"],
  };
  const aftermath = evaluate0025Aftermath(
    appliedFacts({ ownerSchema: schema }),
    hotelSnapshot,
    billingSnapshot,
    verifyHotel,
  );
  assert.equal(aftermath.ok, false);
  assert.ok(aftermath.failures.includes("sbg_bootstrap_platform_owner-nargs"));
});

test("unsafe PUBLIC EXECUTE fails aftermath", () => {
  const schema = installedOwnerSchema();
  schema.functions.sbg_grant_platform_owner = {
    ...installedFn(EXPECTED_FUNCTIONS[1]),
    executePublic: true,
  };
  const aftermath = evaluate0025Aftermath(
    appliedFacts({ ownerSchema: schema }),
    hotelSnapshot,
    billingSnapshot,
    verifyHotel,
  );
  assert.equal(aftermath.ok, false);
  assert.ok(aftermath.failures.includes("sbg_grant_platform_owner-execute-public"));
});

test("aether_app bootstrap EXECUTE fails aftermath", () => {
  const schema = installedOwnerSchema();
  schema.functions.sbg_bootstrap_platform_owner = {
    ...installedFn(EXPECTED_FUNCTIONS[0]),
    executeAetherApp: true,
  };
  const aftermath = evaluate0025Aftermath(
    appliedFacts({ ownerSchema: schema }),
    hotelSnapshot,
    billingSnapshot,
    verifyHotel,
  );
  assert.equal(aftermath.ok, false);
  assert.ok(aftermath.failures.includes("sbg_bootstrap_platform_owner-execute-app"));
});

test("aether_app direct Owner-table write fails aftermath", () => {
  const schema = installedOwnerSchema();
  schema.tables.sbg_platform_owners = { ...installedTable(), insertApp: true };
  const aftermath = evaluate0025Aftermath(
    appliedFacts({ ownerSchema: schema }),
    hotelSnapshot,
    billingSnapshot,
    verifyHotel,
  );
  assert.equal(aftermath.ok, false);
  assert.ok(aftermath.failures.includes("sbg_platform_owners-insert"));
});

test("fresh apply that created an Owner grant fails aftermath", () => {
  const aftermath = evaluate0025Aftermath(
    appliedFacts({ ownerSchema: installedOwnerSchema({ grantCount: 1 }) }),
    hotelSnapshot,
    billingSnapshot,
    verifyHotel,
  );
  assert.equal(aftermath.ok, false);
  assert.ok(aftermath.failures.includes("owner-grant-created"));
});

test("already-applied valid contract is a safe no-op", async () => {
  let applied = 0;
  const result = await runSingleUse0025({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
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

test("already-applied invalid contract is blocked without mutation", async () => {
  let applied = 0;
  const schema = installedOwnerSchema();
  schema.functions.sbg_bootstrap_platform_owner = {
    ...installedFn(EXPECTED_FUNCTIONS[0]),
    executeAetherApp: true,
  };
  const result = await runSingleUse0025({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => appliedFacts({ ownerSchema: schema }),
    applyMigration: async () => {
      applied += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, CONTRACT_INVALID);
  assert.equal(result.migrated, false);
  assert.equal(applied, 0);
});

test("unnamed equivalent bootstrap types are accepted", () => {
  const schema = installedOwnerSchema();
  schema.functions.sbg_bootstrap_platform_owner = {
    ...installedFn(EXPECTED_FUNCTIONS[0]),
    argNames: [],
  };
  const failures = ownerFunctionContractFailures(
    schema.functions.sbg_bootstrap_platform_owner,
    EXPECTED_FUNCTIONS[0],
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(
    ownerInstalledContractFailures(appliedFacts({ ownerSchema: schema }), { requireZeroGrants: true }),
    [],
  );
});

test("Gate B accepts applied 0025 and still refuses generic pending", () => {
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0027_cp26co41_organisation_property_licence.sql");
  assert.deepEqual(AUTHORISED_PENDING, []);
  const currentFacts = {
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...ACCEPTED_LEDGER],
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    aetherAppExists: true,
    occupancy,
    tableOwners: { hotels: "neondb_owner", bookings: "neondb_owner" },
  };
  const current = evaluatePreflight(currentFacts);
  assert.equal(current.ok, true);
  assert.deepEqual(current.pending, []);

  const missing = evaluatePreflight({
    ...currentFacts,
    ledger: ACCEPTED_LEDGER.filter((name) => name !== TARGET_MIGRATION),
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.missingAccepted.includes(TARGET_MIGRATION));
  assert.deepEqual(missing.unexpectedPending, [TARGET_MIGRATION]);

  const pending0026 = evaluatePreflight({
    ...currentFacts,
    sourceMigrations: [...ACCEPTED_LEDGER, "0026_later.sql"],
  });
  assert.equal(pending0026.ok, false);
  assert.deepEqual(pending0026.unexpectedPending, ["0026_later.sql"]);
  const generic = evaluateMigrationBaseline(pending0026);
  assert.equal(generic.ok, false);
  assert.match(generic.verdict, /NO GENERIC PRODUCTION MIGRATION AUTHORISED|MIGRATION LEDGER INCONSISTENT/);
  assert.equal(GENERIC_MIGRATE_BLOCKED.includes("GENERIC"), true);
});

test("workflow is workflow_dispatch only with shared mutation lock", () => {
  assert.equal(existsSync(workflowPath), true);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /Type APPLY-0025/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /group: production-database-mutation/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /secrets\.AETHER_DATABASE_OWNER_URL/);
  assert.match(workflow, /CP26CO2A_CONFIRMATION/);
  assert.match(workflow, /scripts\/cp26co2a-0025-production-migrate\.mjs/);
  assert.doesNotMatch(workflow, /\bpull_request\b/);
  assert.doesNotMatch(workflow, /\bschedule\b/);
  assert.doesNotMatch(workflow, /\brepository_dispatch\b/);
  assert.doesNotMatch(workflow, /\bworkflow_run\b/);
  assert.doesNotMatch(workflow, /\brelease:/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
  assert.doesNotMatch(workflow, /DATABASE_URL/);
  assert.doesNotMatch(workflow, /vercel/i);
  assert.doesNotMatch(workflow, /migration filename|migration_number|MIGRATION_NAME/i);
});

test("build and Vercel cannot invoke this controller", () => {
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkg.scripts.build, /cp26co2a-0025/);
  assert.equal(pkg.scripts["db:migrate:0025"], "node scripts/cp26co2a-0025-production-migrate.mjs");
});

test("controller source never emits secrets, never uses DATABASE_URL, never bootstraps Owner", () => {
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*ownerUrl/);
  assert.doesNotMatch(src, /STRIPE_SECRET/);
  assert.match(src, /BEGIN READ ONLY/);
  assert.match(src, /ROLLBACK/);
  assert.match(src, /INSERT INTO _migrations/);
  assert.match(src, /AETHER_DATABASE_OWNER_URL: \$\{ownerUrl \? "PRESENT" : "ABSENT"\}/);
  assert.doesNotMatch(src, /sbg_bootstrap_platform_owner\s*\(/);
  assert.doesNotMatch(src, /sbg_grant_platform_owner\s*\(/);
  assert.doesNotMatch(src, /sbg_revoke_platform_owner\s*\(/);
  assert.doesNotMatch(src, /production-db-migrate/);
  assert.match(src, /schema only/);
});

test("apply failure rolls back decision as failed and does not claim success", async () => {
  const result = await runSingleUse0025({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => authorisedFacts(),
    applyMigration: async () => {
      throw new Error("permission denied postgres://owner:secret@host/neondb");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.verdict, /0025 APPLICATION FAILED|UNAUTHORISED/);
  assert.doesNotMatch(result.error, /secret/);
});

test("controller script is syntactically valid", async () => {
  await execFileAsync("node", ["--check", join(here, "cp26co2a-0025-production-migrate.mjs")]);
});

test("direct invocation without secret exits before connecting", async () => {
  let threw = null;
  try {
    await execFileAsync("node", [join(here, "cp26co2a-0025-production-migrate.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH,
        CP26CO2A_CONFIRMATION: "APPLY-0025",
        DATABASE_URL: "postgres://runtime:secret@host/neondb",
      },
    });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw);
  const output = `${threw.stdout ?? ""}${threw.stderr ?? ""}`;
  assert.match(output, /AETHER_DATABASE_OWNER_URL: ABSENT/);
  assert.doesNotMatch(output, /secret/);
  assert.doesNotMatch(output, /postgres:\/\//);
});

test("catalog identity does not use pg_get_function_identity_arguments equality", () => {
  assert.doesNotMatch(src, /pg_get_function_identity_arguments/);
  assert.match(src, /pronargs/);
  assert.match(src, /format_type/);
  assert.match(src, /prosecdef/);
  assert.equal(OWNER_TABLES.length, 2);
  assert.equal(OWNER_FUNCTION_NAMES.length, 3);
});
