import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  ENTITLEMENT_PROOF_FAILED,
  FUNCTION_LEDGER_SPLIT,
  FUNCTION_NOT_COUPLED,
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  P0002_NOT_PROVEN,
  POST_BLOCKED,
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  REVIEWED_DIGESTS,
  REVIEWED_DIGEST_BLOCKED,
  REVIEWED_MIGRATION_SOURCE_SHA,
  ROLE_BLOCKED,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNAUTHORISED_MIGRATION,
  UNEXPECTED_PLAN,
  applyExact0023,
  assertAuthorisedMigrationName,
  assertConfirmation,
  assertMigrationFile,
  assertReviewedChecksums,
  buildHotelSnapshot,
  classifyEntitlementFunction,
  evaluate0023Aftermath,
  evaluate0023Baseline,
  evaluateEntitlementProof,
  hotelSnapshotKey,
  ownerUrlFromEnv,
  plpgsqlBody,
  runSingleUse0023,
  sha256,
} from "./cp26a2-0023-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "cp26a2-0023-production-migrate.mjs"), "utf8");
const workflowPath = join(here, "../.github/workflows/cp26a2-0023-production-migrate.yml");
const workflow0022Path = join(here, "../.github/workflows/cp25g3-0022-production-migrate.yml");
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
const migrationBytes = readFileSync(join(here, "../migrations", TARGET_MIGRATION));
const migrationDigest = createHash("sha256").update(migrationBytes).digest("hex");
const sql0020 = readFileSync(join(here, "../migrations/0020_cp24_stripe_billing.sql"), "utf8");
const sql0023 = migrationBytes.toString("utf8");

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

function canonicalFile(overrides = {}) {
  return {
    name: TARGET_MIGRATION,
    bytes: migrationBytes,
    digest: migrationDigest,
    sql: sql0023,
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
    schemaPhase: "16",
    checkpoint: "23",
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
    functionDefinition: sql0020,
    functionOwner: "neondb_owner",
    functionExecuteAetherApp: true,
    ...overrides,
  };
}

function appliedFacts(overrides = {}) {
  return authorisedFacts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    functionDefinition: sql0023,
    functionExecuteAetherApp: true,
    ...overrides,
  });
}

function passingProof(status = "live") {
  return {
    beforeStatus: status,
    returnedStatus: status,
    afterStatus: status,
    missingHotel: { raised: true, code: "P0002" },
  };
}

test("canonical 0023 digest is pinned and unmodified", () => {
  assert.equal(migrationDigest, TARGET_DIGEST);
  assert.equal(sha256(migrationBytes), TARGET_DIGEST);
  assert.equal(assertMigrationFile(canonicalFile()).ok, true);
  assert.equal(REVIEWED_MIGRATION_SOURCE_SHA, "71cc457df26a91f111357ca2e091e2af0dc3cf14");
});

test("reviewed 0020-0023 source checksums are pinned", () => {
  for (const [name, expected] of Object.entries(REVIEWED_DIGESTS)) {
    const bytes = readFileSync(join(here, "../migrations", name));
    assert.equal(sha256(bytes), expected, name);
  }
  assert.equal(assertReviewedChecksums(reviewedChecksums()).ok, true);
  const tampered = assertReviewedChecksums(
    reviewedChecksums({ "0020_cp24_stripe_billing.sql": "0".repeat(64) }),
  );
  assert.equal(tampered.ok, false);
  assert.equal(tampered.verdict, REVIEWED_DIGEST_BLOCKED);
  assert.equal(tampered.name, "0020_cp24_stripe_billing.sql");
});

test("0020 source classifies coupled; 0023 source classifies decoupled", () => {
  assert.equal(classifyEntitlementFunction(sql0020), "coupled");
  assert.equal(classifyEntitlementFunction(sql0023), "decoupled");
  const body23 = plpgsqlBody(sql0023);
  assert.doesNotMatch(body23, /update\s+hotels/i);
  assert.doesNotMatch(body23, /sbg_billing_accounts/);
  assert.match(body23, /P0002/);
  assert.equal(classifyEntitlementFunction(""), "missing");
  assert.equal(classifyEntitlementFunction("select 1"), "unexpected");
});

test("missing owner URL blocks and DATABASE_URL cannot substitute", async () => {
  assert.equal(ownerUrlFromEnv({}), "");
  assert.equal(ownerUrlFromEnv({ DATABASE_URL: "postgres://runtime@host/neondb" }), "");
  let loaded = 0;
  let applied = 0;
  const result = await runSingleUse0023({
    env: { DATABASE_URL: "postgres://runtime:secret@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyMigration: async () => {
      applied += 1;
    },
    proveEntitlement: async () => passingProof(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, BLOCKED_OWNER_URL);
  assert.equal(loaded, 0);
  assert.equal(applied, 0);
});

test("wrong confirmation phrase blocks before connecting", async () => {
  let loaded = 0;
  const result = await runSingleUse0023({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: "APPLY-CP25G3-0022-PRODUCTION",
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyMigration: async () => {},
    proveEntitlement: async () => passingProof(),
  });
  assert.equal(assertConfirmation("APPLY-0023").ok, true);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, CONFIRM_BLOCKED);
  assert.equal(loaded, 0);
});

test("wrong database or owner identity blocks", () => {
  const file = canonicalFile();
  assert.equal(
    evaluate0023Baseline(authorisedFacts({ database: "postgres" }), file).verdict,
    IDENTITY_BLOCKED,
  );
  assert.equal(
    evaluate0023Baseline(
      authorisedFacts({ currentUser: "aether_app", sessionUser: "aether_app" }),
      file,
    ).verdict,
    OWNER_BLOCKED,
  );
  assert.equal(
    evaluate0023Baseline(
      authorisedFacts({ currentUser: "aether_runtime", sessionUser: "aether_runtime" }),
      file,
    ).verdict,
    OWNER_BLOCKED,
  );
});

test("modified 0023 digest is rejected", () => {
  const tampered = canonicalFile({ digest: "0".repeat(64), sql: "-- tampered\n" });
  assert.equal(assertMigrationFile(tampered).verdict, DIGEST_BLOCKED);
  assert.equal(evaluate0023Baseline(authorisedFacts(), tampered).verdict, DIGEST_BLOCKED);
});

test("reviewed checksum mismatch blocks before connecting", async () => {
  let loaded = 0;
  const result = await runSingleUse0023({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums({
      "0022_cp25g3_better_auth_runtime_privileges.sql": "abc",
    }),
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyMigration: async () => {},
    proveEntitlement: async () => passingProof(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, REVIEWED_DIGEST_BLOCKED);
  assert.equal(loaded, 0);
});

test("missing historical 0022 blocks", () => {
  const ledger = REQUIRED_LEDGER.filter(
    (name) => name !== "0022_cp25g3_better_auth_runtime_privileges.sql",
  );
  const result = evaluate0023Baseline(authorisedFacts({ ledger }), canonicalFile());
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "BLOCKED — MISSING HISTORICAL MIGRATION");
  assert.deepEqual(result.missingHistorical, ["0022_cp25g3_better_auth_runtime_privileges.sql"]);
});

test("unexpected pending migration blocks", () => {
  const result = evaluate0023Baseline(
    authorisedFacts({
      sourceMigrations: [...SOURCE, "0024_future.sql"],
    }),
    canonicalFile(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(result.pending, [TARGET_MIGRATION, "0024_future.sql"]);
});

test("pending exactly 0023 is authorised when installed function is still coupled", () => {
  const result = evaluate0023Baseline(authorisedFacts(), canonicalFile());
  assert.equal(result.ok, true);
  assert.equal(result.authorised, true);
  assert.equal(result.verdict, AUTHORISED);
  assert.equal(result.functionKind, "coupled");
  assert.deepEqual(result.pending, [TARGET_MIGRATION]);
});

test("already-decoupled function with 0023 still pending is refused", () => {
  const result = evaluate0023Baseline(
    authorisedFacts({ functionDefinition: sql0023 }),
    canonicalFile(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, FUNCTION_NOT_COUPLED);
  assert.equal(result.functionKind, "decoupled");
});

test("0023 already applied with empty pending and decoupled function is a safe no-op", async () => {
  let applied = 0;
  let proved = 0;
  const result = await runSingleUse0023({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => appliedFacts(),
    applyMigration: async () => {
      applied += 1;
    },
    proveEntitlement: async () => {
      proved += 1;
      return passingProof();
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.verdict, ALREADY_APPLIED);
  assert.equal(applied, 0);
  assert.equal(proved, 0);
});

test("ledger claims 0023 applied but function still coupled is refused", () => {
  const result = evaluate0023Baseline(
    authorisedFacts({
      ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
      functionDefinition: sql0020,
    }),
    canonicalFile(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, FUNCTION_LEDGER_SPLIT);
});

test("mutation executor cannot apply 0022 or 0024", async () => {
  let executed = 0;
  await assert.rejects(
    () =>
      applyExact0023({
        name: "0024_future.sql",
        sql: "select 1",
        execute: async () => {
          executed += 1;
        },
      }),
    /UNAUTHORISED MIGRATION/,
  );
  await assert.rejects(
    () =>
      applyExact0023({
        name: "0022_cp25g3_better_auth_runtime_privileges.sql",
        sql: "select 1",
        execute: async () => {
          executed += 1;
        },
      }),
    /UNAUTHORISED MIGRATION/,
  );
  assert.equal(executed, 0);
  assert.equal(assertAuthorisedMigrationName("0024_future.sql").verdict, UNAUTHORISED_MIGRATION);
  assert.equal(assertAuthorisedMigrationName(TARGET_MIGRATION).ok, true);
});

test("authorised 0023 applies once and post-state must include 0023 exactly once", async () => {
  let applied = 0;
  const result = await runSingleUse0023({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => (applied === 0 ? authorisedFacts() : appliedFacts()),
    applyMigration: async (sql) => {
      applied += 1;
      assert.match(sql, /create or replace function sbg_sync_hotel_entitlement/);
      assert.doesNotMatch(plpgsqlBody(sql), /update\s+hotels/i);
      assert.doesNotMatch(sql, /0024/);
    },
    proveEntitlement: async () => passingProof("live"),
  });
  assert.equal(applied, 1);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, APPLIED_VERIFIED);
  const after = evaluate0023Aftermath(appliedFacts(), hotelSnapshot);
  assert.equal(after.ok, true);
  const duplicate = evaluate0023Aftermath(
    appliedFacts({ ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION, TARGET_MIGRATION] }),
    hotelSnapshot,
  );
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.verdict, POST_BLOCKED);
});

test("pre/post hotel mismatch fails aftermath", () => {
  const changed = buildHotelSnapshot({
    hotelCount: 1,
    statusRows: [{ status: "configured", n: 1 }],
    demoKos: { id: DEMO_ID, code: "demo-kos", status: "configured" },
    liveHotels: [],
  });
  const result = evaluate0023Aftermath(appliedFacts({ hotelSnapshot: changed, hotel: {
    code: "demo-kos",
    name: "Aether Demo Hotel",
    status: "configured",
    providerCount: 1,
    destinationCount: 4,
  } }), hotelSnapshot);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, POST_BLOCKED);
  assert.equal(result.failures.includes("hotel-invariance"), true);
});

test("post-state requires decoupled function and execute grant", () => {
  const stillCoupled = evaluate0023Aftermath(
    appliedFacts({ functionDefinition: sql0020 }),
    hotelSnapshot,
  );
  assert.equal(stillCoupled.ok, false);
  assert.equal(stillCoupled.failures.includes("function-not-decoupled"), true);
  const noGrant = evaluate0023Aftermath(
    appliedFacts({ functionExecuteAetherApp: false }),
    hotelSnapshot,
  );
  assert.equal(noGrant.ok, false);
  assert.equal(noGrant.failures.includes("execute-grant"), true);
});

test("aether_app privilege escalation is rejected", () => {
  const escalated = evaluate0023Baseline(
    authorisedFacts({ aetherAppRole: { ...safeRole, superuser: true } }),
    canonicalFile(),
  );
  assert.equal(escalated.ok, false);
  assert.equal(escalated.verdict, ROLE_BLOCKED);
  const post = evaluate0023Aftermath(
    appliedFacts({ aetherAppRole: { ...safeRole, bypassrls: true } }),
    hotelSnapshot,
  );
  assert.equal(post.ok, false);
  assert.equal(post.failures.includes("role-escalation"), true);
});

test("entitlement proof requires before = returned = after and P0002", () => {
  assert.equal(evaluateEntitlementProof(passingProof("live")).ok, true);
  assert.equal(
    evaluateEntitlementProof({
      beforeStatus: "live",
      returnedStatus: "configured",
      afterStatus: "live",
      missingHotel: { raised: true, code: "P0002" },
    }).verdict,
    ENTITLEMENT_PROOF_FAILED,
  );
  assert.equal(
    evaluateEntitlementProof({
      beforeStatus: "live",
      returnedStatus: "live",
      afterStatus: "live",
      missingHotel: { raised: false, code: null },
    }).verdict,
    P0002_NOT_PROVEN,
  );
});

test("hotel snapshot key is stable for identical publication state", () => {
  const copy = buildHotelSnapshot({
    hotelCount: 1,
    statusRows: [{ status: "live", n: 1 }],
    demoKos: { id: DEMO_ID, code: "demo-kos", status: "live" },
    liveHotels: [{ id: DEMO_ID, code: "demo-kos", status: "live" }],
  });
  assert.equal(hotelSnapshotKey(copy), hotelSnapshotKey(hotelSnapshot));
});

test("build and Vercel cannot invoke this controller", () => {
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkg.scripts.build, /cp26a2-0023/);
  assert.doesNotMatch(pkg.scripts.build, /production-db-migrate/);
  assert.equal(pkg.scripts["db:migrate:0023"], "node scripts/cp26a2-0023-production-migrate.mjs");
  assert.equal(pkg.scripts["db:migrate:0022"], "node scripts/cp25g3-0022-production-migrate.mjs");
});

test("0023 workflow_dispatch mutation surface is retired", () => {
  assert.equal(existsSync(workflowPath), false);
});

test("0022 workflow_dispatch mutation surface is retired", () => {
  assert.equal(existsSync(workflow0022Path), false);
});

test("controller source never emits secrets and never uses DATABASE_URL", () => {
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*process\.env/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*ownerUrl/);
  assert.doesNotMatch(src, /BETTER_AUTH_SECRET/);
  assert.doesNotMatch(src, /STRIPE_SECRET/);
  assert.doesNotMatch(src, /provision-hotel/);
  assert.doesNotMatch(src, /migrate\.mjs/);
  assert.doesNotMatch(src, /printenv/);
  assert.doesNotMatch(src, /set -x/);
  assert.match(src, /BEGIN READ ONLY/);
  assert.match(src, /ROLLBACK/);
  assert.match(src, /INSERT INTO _migrations/);
  assert.match(src, /AETHER_DATABASE_OWNER_URL: \$\{ownerUrl \? "PRESENT" : "ABSENT"\}/);
  assert.match(src, /sbg_sync_hotel_entitlement/);
});

test("apply failure rolls back decision as failed and does not claim success", async () => {
  let applied = 0;
  const result = await runSingleUse0023({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => authorisedFacts(),
    applyMigration: async () => {
      applied += 1;
      throw new Error("permission denied postgres://owner:secret@host/neondb");
    },
    proveEntitlement: async () => passingProof(),
  });
  assert.equal(applied, 1);
  assert.equal(result.ok, false);
  assert.match(result.verdict, /0023 APPLICATION FAILED|UNAUTHORISED/);
  assert.doesNotMatch(result.error, /secret/);
});

test("controller script is syntactically valid", async () => {
  await execFileAsync("node", ["--check", join(here, "cp26a2-0023-production-migrate.mjs")]);
});

test("direct invocation without secret exits before connecting", async () => {
  let threw = null;
  try {
    await execFileAsync("node", [join(here, "cp26a2-0023-production-migrate.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH,
        CP26A2_CONFIRMATION: "APPLY-0023",
        DATABASE_URL: "postgres://runtime:secret@host/neondb",
      },
    });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw);
  const output = `${threw.stdout ?? ""}${threw.stderr ?? ""}`;
  assert.match(output, /AETHER_DATABASE_OWNER_URL: ABSENT/);
  assert.match(output, /AETHER_DATABASE_OWNER_URL is not configured/);
  assert.doesNotMatch(output, /secret/);
  assert.doesNotMatch(output, /postgres:\/\//);
});
