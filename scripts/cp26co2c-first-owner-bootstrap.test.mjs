import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING, BLOCKED_OWNER_URL } from "./production-db-preflight.mjs";
import { buildHotelSnapshot } from "./cp26a2-0023-production-migrate.mjs";
import {
  EXPECTED_FUNCTIONS,
  TARGET_DIGEST,
  TARGET_MIGRATION,
} from "./cp26co2a-0025-production-migrate.mjs";
import {
  ALREADY_BOOTSTRAPPED,
  AMBIGUOUS_USER,
  APPLY_FAILED,
  AUTHORISED,
  BOOTSTRAPPED_VERIFIED,
  CONFIRM_BLOCKED,
  CONTRACT_INVALID,
  DEMO_BLOCKED,
  DIGEST_BLOCKED,
  DUP_HOTEL,
  HOTEL_NOT_CONFIGURED,
  IDENTITY_BLOCKED,
  MIGRATION_0025_DIGEST,
  MULTI_OWNERSHIP,
  NO_HOTEL,
  NO_OWNERSHIP,
  NO_USER,
  NOTE_BLOCKED,
  OWNERS_NOT_ZERO,
  PENDING_BLOCKED,
  POST_BLOCKED,
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  REQUIRED_NOTE,
  ROLE_BLOCKED,
  TARGET_HOTEL_CODE,
  TARGET_USER_REDACTED,
  TOO_MANY_OWNERS,
  UNEXPECTED_PLAN,
  WRONG_OWNER,
  applyExactBootstrap,
  assertBootstrapCall,
  assertConfirmation,
  evaluateFirstOwnerAftermath,
  evaluateFirstOwnerBaseline,
  evaluateTargetDiscovery,
  ownerUrlFromEnv,
  publicTargetReport,
  runSingleUseFirstOwner,
} from "./cp26co2c-first-owner-bootstrap.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "cp26co2c-first-owner-bootstrap.mjs"), "utf8");
const workflowPath = join(here, "../.github/workflows/cp26co2c-first-owner-bootstrap.yml");
const pkgJson = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));

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
const VERIFY_ID = "22222222-2222-2222-2222-222222222222";
const TARGET_USER = "user-verify-operator";
const OTHER_USER = "user-someone-else";

const hotelSnapshot = buildHotelSnapshot({
  hotelCount: 4,
  statusRows: [
    { status: "configured", n: 1 },
    { status: "live", n: 1 },
    { status: "draft", n: 2 },
  ],
  demoKos: { id: DEMO_ID, code: "demo-kos", status: "live" },
  liveHotels: [{ id: DEMO_ID, code: "demo-kos", status: "live" }],
});
const billingSnapshot = { accountCount: 0, statusCounts: {}, eventCount: 0 };
const verifyHotel = { code: TARGET_HOTEL_CODE, status: "configured" };

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
    activeGrantCount: 0,
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
    sourceMigrations: [...REQUIRED_LEDGER],
    sourceDigest0025: MIGRATION_0025_DIGEST,
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
    hotelSnapshot: {
      hotelCount: hotelSnapshot.hotelCount,
      statusCounts: { ...hotelSnapshot.statusCounts },
      demoKos: { ...hotelSnapshot.demoKos },
      liveHotels: hotelSnapshot.liveHotels.map((row) => ({ ...row })),
    },
    billingSnapshot: { ...billingSnapshot, statusCounts: {} },
    verifyHotel: { ...verifyHotel },
    ownerSchema: installedOwnerSchema(),
    targetHotels: [{ id: VERIFY_ID, code: TARGET_HOTEL_CODE, status: "configured", name: "SBG Verification Hotel" }],
    targetMappings: [{ userId: TARGET_USER, hotelId: VERIFY_ID }],
    targetUserExists: true,
    activeOwnerUserIds: [],
    lastAudit: null,
    ...overrides,
  };
}

function bootstrappedFacts(overrides = {}) {
  return authorisedFacts({
    ownerSchema: installedOwnerSchema({ grantCount: 1, auditCount: 1, activeGrantCount: 1 }),
    activeOwnerUserIds: [TARGET_USER],
    lastAudit: { action: "owner.granted", bootstrap: true },
    ...overrides,
  });
}

test("confirmation phrase is BOOTSTRAP-FIRST-OWNER", () => {
  assert.equal(REQUIRED_CONFIRMATION, "BOOTSTRAP-FIRST-OWNER");
  assert.equal(assertConfirmation(REQUIRED_CONFIRMATION).ok, true);
  assert.equal(assertConfirmation("APPLY-0025").verdict, CONFIRM_BLOCKED);
});

test("0025 digest remains pinned", () => {
  assert.equal(MIGRATION_0025_DIGEST, TARGET_DIGEST);
  assert.equal(REQUIRED_LEDGER.at(-1), TARGET_MIGRATION);
  assert.equal(REQUIRED_LEDGER.length, 25);
});

test("target hotel is hard-coded as sbg-verify-a5", () => {
  assert.equal(TARGET_HOTEL_CODE, "sbg-verify-a5");
  assert.match(src, /sbg-verify-a5/);
  assert.doesNotMatch(src, /@scanbookgo|@gmail\.com/i);
  assert.equal(existsSync(workflowPath), false);
});

test("correct owner DB identity is required", () => {
  assert.equal(evaluateFirstOwnerBaseline(authorisedFacts({ database: "postgres" })).verdict, IDENTITY_BLOCKED);
  assert.equal(evaluateFirstOwnerBaseline(authorisedFacts({ currentUser: "aether_app" })).ok, false);
});

test("DATABASE_URL cannot substitute", async () => {
  assert.equal(ownerUrlFromEnv({}), "");
  assert.equal(ownerUrlFromEnv({ DATABASE_URL: "postgres://runtime@host/neondb" }), "");
  let loaded = 0;
  const result = await runSingleUseFirstOwner({
    env: { DATABASE_URL: "postgres://runtime:secret@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    sourceDigest0025: MIGRATION_0025_DIGEST,
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyBootstrap: async () => {
      throw new Error("should not run");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, BLOCKED_OWNER_URL);
  assert.equal(loaded, 0);
});

test("ledger 0001-0025 is required", () => {
  const missing = evaluateFirstOwnerBaseline(
    authorisedFacts({ ledger: REQUIRED_LEDGER.filter((name) => name !== TARGET_MIGRATION) }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.verdict, UNEXPECTED_PLAN);
});

test("pending migration rejection", () => {
  const result = evaluateFirstOwnerBaseline(
    authorisedFacts({
      sourceMigrations: [...REQUIRED_LEDGER, "0026_future.sql"],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, PENDING_BLOCKED);
});

test("zero Owner initial state is authorised", () => {
  const result = evaluateFirstOwnerBaseline(authorisedFacts());
  assert.equal(result.ok, true);
  assert.equal(result.verdict, AUTHORISED);
  assert.equal(result.userId, TARGET_USER);
  assert.equal(result.alreadyBootstrapped, false);
});

test("one exact hotel match is required", () => {
  const result = evaluateTargetDiscovery(authorisedFacts());
  assert.equal(result.ok, true);
  assert.equal(result.ownershipMatch, 1);
});

test("zero hotel match blocks", () => {
  assert.equal(
    evaluateFirstOwnerBaseline(authorisedFacts({ targetHotels: [], verifyHotel: null })).verdict,
    NO_HOTEL,
  );
});

test("duplicate hotel match blocks", () => {
  const hotels = [
    { id: VERIFY_ID, code: TARGET_HOTEL_CODE, status: "configured" },
    { id: "33333333-3333-3333-3333-333333333333", code: TARGET_HOTEL_CODE, status: "configured" },
  ];
  assert.equal(evaluateTargetDiscovery(authorisedFacts({ targetHotels: hotels })).verdict, DUP_HOTEL);
});

test("zero ownership mapping blocks", () => {
  assert.equal(
    evaluateFirstOwnerBaseline(authorisedFacts({ targetMappings: [], targetUserExists: false })).verdict,
    NO_OWNERSHIP,
  );
});

test("multiple ownership mappings block", () => {
  const mappings = [
    { userId: TARGET_USER, hotelId: VERIFY_ID },
    { userId: OTHER_USER, hotelId: VERIFY_ID },
  ];
  assert.equal(evaluateFirstOwnerBaseline(authorisedFacts({ targetMappings: mappings })).verdict, MULTI_OWNERSHIP);
});

test("zero Better Auth user blocks", () => {
  assert.equal(
    evaluateFirstOwnerBaseline(authorisedFacts({ targetUserExists: false })).verdict,
    NO_USER,
  );
});

test("multiple or ambiguous user result blocks", () => {
  const mappings = [
    { userId: TARGET_USER, hotelId: VERIFY_ID },
    { userId: OTHER_USER, hotelId: VERIFY_ID },
  ];
  assert.equal(evaluateTargetDiscovery({ targetHotels: authorisedFacts().targetHotels, targetMappings: mappings }).verdict, MULTI_OWNERSHIP);
  assert.equal(
    evaluateTargetDiscovery({
      targetHotels: authorisedFacts().targetHotels,
      targetMappings: [{ userId: TARGET_USER, hotelId: VERIFY_ID }],
      targetUserExists: true,
    }).ok,
    true,
  );
});

test("configured verification hotel required", () => {
  assert.equal(
    evaluateFirstOwnerBaseline(
      authorisedFacts({
        targetHotels: [{ id: VERIFY_ID, code: TARGET_HOTEL_CODE, status: "live" }],
        verifyHotel: { code: TARGET_HOTEL_CODE, status: "live" },
      }),
    ).verdict,
    HOTEL_NOT_CONFIGURED,
  );
});

test("demo-kos live required", () => {
  const snapshot = {
    ...authorisedFacts().hotelSnapshot,
    demoKos: { id: DEMO_ID, code: "demo-kos", status: "configured" },
  };
  assert.equal(evaluateFirstOwnerBaseline(authorisedFacts({ hotelSnapshot: snapshot })).verdict, DEMO_BLOCKED);
});

test("function contract valid", () => {
  const result = evaluateFirstOwnerBaseline(authorisedFacts());
  assert.equal(result.ok, true);
  const broken = installedOwnerSchema();
  broken.functions.sbg_bootstrap_platform_owner.nargs = 3;
  assert.equal(evaluateFirstOwnerBaseline(authorisedFacts({ ownerSchema: broken })).verdict, CONTRACT_INVALID);
});

test("bootstrap runtime EXECUTE forbidden", () => {
  const broken = installedOwnerSchema();
  broken.functions.sbg_bootstrap_platform_owner.executeAetherApp = true;
  assert.equal(evaluateFirstOwnerBaseline(authorisedFacts({ ownerSchema: broken })).verdict, CONTRACT_INVALID);
});

test("PUBLIC EXECUTE forbidden", () => {
  const broken = installedOwnerSchema();
  broken.functions.sbg_bootstrap_platform_owner.executePublic = true;
  assert.equal(evaluateFirstOwnerBaseline(authorisedFacts({ ownerSchema: broken })).verdict, CONTRACT_INVALID);
});

test("runtime role escalation blocks", () => {
  assert.equal(
    evaluateFirstOwnerBaseline(authorisedFacts({ aetherAppRole: { ...safeRole, superuser: true } })).verdict,
    ROLE_BLOCKED,
  );
});

test("successful single bootstrap", async () => {
  let calls = 0;
  const result = await runSingleUseFirstOwner({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    sourceDigest0025: MIGRATION_0025_DIGEST,
    loadFacts: async () => authorisedFacts(),
    applyBootstrap: async ({ userId, note }) => {
      calls += 1;
      assert.equal(userId, TARGET_USER);
      assert.equal(note, REQUIRED_NOTE);
      return evaluateFirstOwnerAftermath(bootstrappedFacts(), authorisedFacts(), TARGET_USER);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, BOOTSTRAPPED_VERIFIED);
  assert.equal(result.migrated, true);
});

test("exactly one audit event and Owner count 1 with matching identity", () => {
  const aftermath = evaluateFirstOwnerAftermath(bootstrappedFacts(), authorisedFacts(), TARGET_USER);
  assert.equal(aftermath.ok, true);
  assert.equal(aftermath.verdict, BOOTSTRAPPED_VERIFIED);
});

test("target identity mismatch fails aftermath", () => {
  const after = bootstrappedFacts({ activeOwnerUserIds: [OTHER_USER] });
  const result = evaluateFirstOwnerAftermath(after, authorisedFacts(), TARGET_USER);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, POST_BLOCKED);
  assert.ok(result.failures.includes("owner-identity"));
});

test("hotel invariance required", () => {
  const after = bootstrappedFacts({
    hotelSnapshot: { ...hotelSnapshot, hotelCount: 99, statusCounts: { live: 1 }, demoKos: hotelSnapshot.demoKos, liveHotels: hotelSnapshot.liveHotels },
  });
  const result = evaluateFirstOwnerAftermath(after, authorisedFacts(), TARGET_USER);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("hotel-invariance"));
});

test("billing invariance required", () => {
  const after = bootstrappedFacts({
    billingSnapshot: { accountCount: 7, statusCounts: {}, eventCount: 0 },
  });
  const result = evaluateFirstOwnerAftermath(after, authorisedFacts(), TARGET_USER);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("billing-invariance"));
});

test("Stripe-event invariance required", () => {
  const after = bootstrappedFacts({
    billingSnapshot: { accountCount: 0, statusCounts: {}, eventCount: 3 },
  });
  const result = evaluateFirstOwnerAftermath(after, authorisedFacts(), TARGET_USER);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("billing-invariance"));
});

test("re-dispatch same Owner is a safe no-op", async () => {
  let calls = 0;
  const result = await runSingleUseFirstOwner({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    sourceDigest0025: MIGRATION_0025_DIGEST,
    loadFacts: async () => bootstrappedFacts(),
    applyBootstrap: async () => {
      calls += 1;
      throw new Error("must not bootstrap again");
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, ALREADY_BOOTSTRAPPED);
  assert.equal(result.migrated, false);
});

test("re-dispatch wrong Owner is blocked", () => {
  const facts = bootstrappedFacts({ activeOwnerUserIds: [OTHER_USER] });
  assert.equal(evaluateFirstOwnerBaseline(facts).verdict, WRONG_OWNER);
});

test(">1 active Owners is blocked", () => {
  const facts = bootstrappedFacts({
    activeOwnerUserIds: [TARGET_USER, OTHER_USER],
    ownerSchema: installedOwnerSchema({ grantCount: 2, auditCount: 2, activeGrantCount: 2 }),
  });
  assert.equal(evaluateFirstOwnerBaseline(facts).verdict, TOO_MANY_OWNERS);
});

test("executor cannot run arbitrary SQL", async () => {
  let seen = null;
  await applyExactBootstrap({
    userId: TARGET_USER,
    note: REQUIRED_NOTE,
    execute: async (userId, note, extra) => {
      seen = { userId, note, extra };
      return true;
    },
  });
  assert.deepEqual(seen, { userId: TARGET_USER, note: REQUIRED_NOTE, extra: undefined });
  assert.equal(assertBootstrapCall({ userId: TARGET_USER, note: "drop table hotels" }).verdict, NOTE_BLOCKED);
  await assert.rejects(
    () =>
      applyExactBootstrap({
        userId: TARGET_USER,
        note: "select 1",
        execute: async () => {
          throw new Error("must not run");
        },
      }),
    /BOOTSTRAP NOTE INVALID/,
  );
});

test("public report never includes the user id", () => {
  const report = publicTargetReport({ ownershipMatch: 1, userId: TARGET_USER });
  assert.equal(report["target.user"], TARGET_USER_REDACTED);
  assert.equal(report["ownership.match"], 1);
  assert.equal(report["hotel.code"], TARGET_HOTEL_CODE);
  assert.equal(JSON.stringify(report).includes(TARGET_USER), false);
});

test("modified 0025 digest blocks before connecting", async () => {
  let loaded = 0;
  const result = await runSingleUseFirstOwner({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    sourceDigest0025: "0".repeat(64),
    loadFacts: async () => {
      loaded += 1;
      return authorisedFacts();
    },
    applyBootstrap: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(loaded, 0);
  assert.equal(result.verdict, DIGEST_BLOCKED);
});

test("apply failure rolls back decision as failed", async () => {
  const result = await runSingleUseFirstOwner({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    sourceDigest0025: MIGRATION_0025_DIGEST,
    loadFacts: async () => authorisedFacts(),
    applyBootstrap: async () => {
      throw new Error("permission denied postgres://owner:secret@host/neondb");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.verdict, /BOOTSTRAP APPLICATION FAILED|UNAUTHORISED/);
  assert.doesNotMatch(result.error, /secret/);
});

test("first-Owner dispatch surface is retired", () => {
  assert.equal(existsSync(workflowPath), false);
  assert.equal(pkgJson.scripts["db:bootstrap:first-owner"], undefined);
  assert.doesNotMatch(pkgJson.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkgJson.scripts.build, /cp26co2c-first-owner/);
  assert.doesNotMatch(pkgJson.scripts.build, /bootstrap:first-owner/);
  const yaml = readdirSync(join(here, "../.github/workflows"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  assert.equal(yaml.includes("cp26co2c-first-owner-bootstrap.yml"), false);
  assert.deepEqual(yaml, [
    "cp26co2a-0025-production-migrate.yml",
    "production-database.yml",
  ]);
});

test("controller source never emits secrets, never uses DATABASE_URL, never grants", () => {
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*ownerUrl/);
  assert.doesNotMatch(src, /STRIPE_SECRET/);
  assert.match(src, /BEGIN READ ONLY/);
  assert.match(src, /ROLLBACK/);
  assert.match(src, /sbg_bootstrap_platform_owner\(\$1::text, \$2::text\)/);
  assert.doesNotMatch(src, /sbg_grant_platform_owner\(\$|sbg_revoke_platform_owner\(\$/);
  assert.doesNotMatch(src, /insert into sbg_platform_owners/i);
  assert.match(src, /AETHER_DATABASE_OWNER_URL: \$\{ownerUrl \? "PRESENT" : "ABSENT"\}/);
  assert.match(src, /OPERATOR CONTROLLED \/ REDACTED/);
});

test("controller script is syntactically valid", async () => {
  await execFileAsync("node", ["--check", join(here, "cp26co2c-first-owner-bootstrap.mjs")]);
});

test("direct invocation without secret exits before connecting", async () => {
  let threw = null;
  try {
    await execFileAsync("node", [join(here, "cp26co2c-first-owner-bootstrap.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH,
        CP26CO2C_CONFIRMATION: "BOOTSTRAP-FIRST-OWNER",
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
  assert.equal(output.includes(TARGET_USER), false);
});

test("Gate B accepts applied 0025 and does not authorise another bootstrap", () => {
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0028_cp26fin_property_licence_catalogue.sql");
});

test("catalog identity still uses 0025 function contract", () => {
  assert.doesNotMatch(src, /pg_get_function_identity_arguments/);
  assert.equal(EXPECTED_FUNCTIONS[0].executeAetherApp, false);
});
