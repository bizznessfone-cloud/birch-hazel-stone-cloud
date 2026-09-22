import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { BLOCKED_OWNER_URL, ACCEPTED_LEDGER, evaluatePreflight, isAuthorisedPending } from "./production-db-preflight.mjs";
import { evaluateMigrationBaseline, GENERIC_MIGRATE_BLOCKED } from "./production-db-migrate.mjs";
import {
  ALREADY_APPLIED,
  APPLIED_VERIFIED,
  AUTHORISED,
  CONFIRM_BLOCKED,
  DIGEST_BLOCKED,
  FUNCTION_LEDGER_SPLIT,
  FUNCTION_NOT_HISTORICAL,
  POST_BLOCKED,
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  REVIEWED_DIGESTS,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNAUTHORISED_MIGRATION,
  UNEXPECTED_PLAN,
  applyExact0024,
  assertAuthorisedMigrationName,
  assertConfirmation,
  assertMigrationFile,
  assertReviewedChecksums,
  billingSnapshotKey,
  classifyBillingApplyFunction,
  evaluate0024Aftermath,
  evaluate0024Baseline,
  ownerUrlFromEnv,
  runSingleUse0024,
  sha256,
} from "./cp26b2-0024-production-migrate.mjs";
import { buildHotelSnapshot, classifyEntitlementFunction } from "./cp26a2-0023-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "cp26b2-0024-production-migrate.mjs"), "utf8");
const workflowPath = join(here, "../.github/workflows/cp26b2-0024-production-migrate.yml");
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
const migrationBytes = readFileSync(join(here, "../migrations", TARGET_MIGRATION));
const migrationDigest = createHash("sha256").update(migrationBytes).digest("hex");
const sql0020 = readFileSync(join(here, "../migrations/0020_cp24_stripe_billing.sql"), "utf8");
const sql0023 = readFileSync(
  join(here, "../migrations/0023_cp26a2_entitlement_publication_decoupling.sql"),
  "utf8",
);
const sql0024 = migrationBytes.toString("utf8");
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
  hotelCount: 1,
  statusRows: [{ status: "live", n: 1 }],
  demoKos: { id: DEMO_ID, code: "demo-kos", status: "live" },
  liveHotels: [{ id: DEMO_ID, code: "demo-kos", status: "live" }],
});
const billingSnapshot = { accountCount: 0, statusCounts: {}, eventCount: 0 };

function canonicalFile(overrides = {}) {
  return {
    name: TARGET_MIGRATION,
    bytes: migrationBytes,
    digest: migrationDigest,
    sql: sql0024,
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
    functionDefinition: sql0020,
    functionIdentity: "text, text, uuid, text, text, text, text, timestamp with time zone",
    functionCount: 1,
    functionOwner: "neondb_owner",
    functionExecuteAetherApp: true,
    entitlementDefinition: sql0023,
    paymentFunctionPresent: true,
    billingColumns: ["current_period_end", "hotel_id", "status", "stripe_customer_id"],
    eventColumns: ["event_id", "event_type", "processed_at"],
    ...overrides,
  };
}

function appliedFacts(overrides = {}) {
  return authorisedFacts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    functionDefinition: sql0024,
    functionIdentity: "text, text, bigint, uuid, text, text, text, text, timestamp with time zone, boolean",
    functionCount: 1,
    billingColumns: [
      "cancel_at_period_end",
      "current_period_end",
      "hotel_id",
      "last_stripe_event_created",
      "last_stripe_event_id",
      "status",
    ],
    eventColumns: ["event_id", "event_type", "hotel_id", "outcome", "processed_at", "stripe_created"],
    ...overrides,
  });
}

test("canonical 0024 digest is pinned and unmodified", () => {
  assert.equal(migrationDigest, TARGET_DIGEST);
  assert.equal(sha256(migrationBytes), TARGET_DIGEST);
  assert.equal(assertMigrationFile(canonicalFile()).ok, true);
  assert.equal(REQUIRED_CONFIRMATION, "APPLY-0024");
});

test("reviewed 0020-0024 source checksums are pinned", () => {
  for (const [name, expected] of Object.entries(REVIEWED_DIGESTS)) {
    const bytes = readFileSync(join(here, "../migrations", name));
    assert.equal(sha256(bytes), expected, name);
  }
  assert.equal(assertReviewedChecksums(reviewedChecksums()).ok, true);
});

test("0020 classifies historical; 0024 classifies ordered; 0023 entitlement stays decoupled", () => {
  assert.equal(classifyBillingApplyFunction(sql0020), "historical");
  assert.equal(classifyBillingApplyFunction(sql0024), "ordered");
  assert.equal(classifyEntitlementFunction(sql0023), "decoupled");
  assert.doesNotMatch(sql0024, /update\s+hotels/i);
  assert.match(sql0024, /bigint/);
  assert.match(sql0024, /cancel_at_period_end/);
});

test("missing owner URL blocks and DATABASE_URL cannot substitute", async () => {
  assert.equal(ownerUrlFromEnv({}), "");
  assert.equal(ownerUrlFromEnv({ DATABASE_URL: "postgres://runtime@host/neondb" }), "");
  let loaded = 0;
  const result = await runSingleUse0024({
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
  const result = await runSingleUse0024({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: "APPLY-0023",
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyMigration: async () => {},
  });
  assert.equal(assertConfirmation("APPLY-0024").ok, true);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, CONFIRM_BLOCKED);
  assert.equal(loaded, 0);
});

test("modified 0024 digest is rejected", () => {
  const tampered = canonicalFile({ digest: "0".repeat(64), sql: "-- tampered\n" });
  assert.equal(assertMigrationFile(tampered).verdict, DIGEST_BLOCKED);
});

test("unexpected pending 0025 blocks", () => {
  const result = evaluate0024Baseline(
    authorisedFacts({ sourceMigrations: [...SOURCE, "0025_later.sql"] }),
    canonicalFile(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, UNEXPECTED_PLAN);
});

test("pending exactly 0024 is authorised when function is historical last-write-wins", () => {
  const result = evaluate0024Baseline(authorisedFacts(), canonicalFile());
  assert.equal(result.ok, true);
  assert.equal(result.verdict, AUTHORISED);
  assert.equal(result.functionKind, "historical");
  assert.deepEqual(result.pending, [TARGET_MIGRATION]);
});

test("already-ordered function with 0024 still pending is refused", () => {
  const result = evaluate0024Baseline(authorisedFacts({ functionDefinition: sql0024 }), canonicalFile());
  assert.equal(result.ok, false);
  assert.equal(result.verdict, FUNCTION_NOT_HISTORICAL);
});

test("0024 already applied with empty pending is a safe no-op", async () => {
  let applied = 0;
  const result = await runSingleUse0024({
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

test("ledger claims 0024 applied but function still historical is refused", () => {
  const result = evaluate0024Baseline(
    authorisedFacts({
      ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
      functionDefinition: sql0020,
    }),
    canonicalFile(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, FUNCTION_LEDGER_SPLIT);
});

test("mutation executor cannot apply 0023 or 0025", async () => {
  let executed = 0;
  await assert.rejects(
    () => applyExact0024({ name: "0025_later.sql", sql: "select 1", execute: async () => { executed += 1; } }),
    /UNAUTHORISED MIGRATION/,
  );
  await assert.rejects(
    () =>
      applyExact0024({
        name: "0023_cp26a2_entitlement_publication_decoupling.sql",
        sql: "select 1",
        execute: async () => {
          executed += 1;
        },
      }),
    /UNAUTHORISED MIGRATION/,
  );
  assert.equal(executed, 0);
  assert.equal(assertAuthorisedMigrationName("0025_later.sql").verdict, UNAUTHORISED_MIGRATION);
});

test("authorised 0024 applies once and aftermath requires ordered function plus hotel/billing invariance", async () => {
  let applied = 0;
  const result = await runSingleUse0024({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => (applied === 0 ? authorisedFacts() : appliedFacts()),
    applyMigration: async (sql) => {
      applied += 1;
      assert.match(sql, /last_stripe_event_created/);
      assert.match(sql, /p_event_created/);
      assert.doesNotMatch(sql, /update\s+hotels/i);
    },
  });
  assert.equal(applied, 1);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, APPLIED_VERIFIED);
  const after = evaluate0024Aftermath(appliedFacts(), hotelSnapshot, billingSnapshot);
  assert.equal(after.ok, true);
  const changedHotel = evaluate0024Aftermath(
    appliedFacts({
      hotelSnapshot: buildHotelSnapshot({
        hotelCount: 1,
        statusRows: [{ status: "configured", n: 1 }],
        demoKos: { id: DEMO_ID, code: "demo-kos", status: "configured" },
        liveHotels: [],
      }),
    }),
    hotelSnapshot,
    billingSnapshot,
  );
  assert.equal(changedHotel.ok, false);
  assert.equal(changedHotel.verdict, POST_BLOCKED);
});

test("Gate B and generic migrator still refuse 0024 pending", () => {
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.ok(ACCEPTED_LEDGER.includes("0023_cp26a2_entitlement_publication_decoupling.sql"));
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), false);
  const preflight = evaluatePreflight({
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...ACCEPTED_LEDGER, TARGET_MIGRATION],
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    aetherAppExists: true,
    occupancy,
    tableOwners: { hotels: "neondb_owner", bookings: "neondb_owner" },
  });
  assert.equal(preflight.ok, false);
  assert.deepEqual(preflight.unexpectedPending, [TARGET_MIGRATION]);
  const generic = evaluateMigrationBaseline(preflight);
  assert.equal(generic.ok, false);
  assert.match(generic.verdict, /NO GENERIC PRODUCTION MIGRATION AUTHORISED|MIGRATION LEDGER INCONSISTENT/);
  assert.equal(GENERIC_MIGRATE_BLOCKED.includes("GENERIC"), true);
});

test("workflow is dispatch-only with APPLY-0024 and production-database-mutation lock", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /APPLY-0024/);
  assert.match(workflow, /production-database-mutation/);
  assert.match(workflow, /AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(workflow, /DATABASE_URL/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /push:/);
});

test("build and Vercel cannot invoke this controller", () => {
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkg.scripts.build, /cp26b2-0024/);
  assert.equal(pkg.scripts["db:migrate:0024"], "node scripts/cp26b2-0024-production-migrate.mjs");
});

test("controller source never emits secrets and never uses DATABASE_URL", () => {
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*ownerUrl/);
  assert.doesNotMatch(src, /STRIPE_SECRET/);
  assert.match(src, /BEGIN READ ONLY/);
  assert.match(src, /ROLLBACK/);
  assert.match(src, /INSERT INTO _migrations/);
  assert.match(src, /AETHER_DATABASE_OWNER_URL: \$\{ownerUrl \? "PRESENT" : "ABSENT"\}/);
});

test("apply failure rolls back decision as failed and does not claim success", async () => {
  const result = await runSingleUse0024({
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
  assert.match(result.verdict, /0024 APPLICATION FAILED|UNAUTHORISED/);
  assert.doesNotMatch(result.error, /secret/);
});

test("controller script is syntactically valid", async () => {
  await execFileAsync("node", ["--check", join(here, "cp26b2-0024-production-migrate.mjs")]);
});

test("direct invocation without secret exits before connecting", async () => {
  let threw = null;
  try {
    await execFileAsync("node", [join(here, "cp26b2-0024-production-migrate.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH,
        CP26B2_CONFIRMATION: "APPLY-0024",
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

test("workflow file exists (created, not dispatched)", () => {
  assert.equal(existsSync(workflowPath), true);
  assert.equal(billingSnapshotKey(billingSnapshot), billingSnapshotKey({ accountCount: 0, statusCounts: {}, eventCount: 0 }));
});
