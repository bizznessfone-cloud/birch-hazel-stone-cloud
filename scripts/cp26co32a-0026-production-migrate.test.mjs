import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { BLOCKED_OWNER_URL, evaluatePreflight, isAuthorisedPending } from "./production-db-preflight.mjs";
import { evaluateMigrationBaseline } from "./production-db-migrate.mjs";
import { buildHotelSnapshot } from "./cp26a2-0023-production-migrate.mjs";
import { EXPECTED_FUNCTIONS as OWNER_FUNCTIONS } from "./cp26co2a-0025-production-migrate.mjs";
import {
  ACCEPTED_LEDGER,
  ACTIVE_OWNER_BLOCKED,
  ALREADY_APPLIED,
  APPLIED_VERIFIED,
  AUTHORISED,
  AUTHORISED_PENDING,
  CATALOGUE_FUNCTION_NAMES,
  CATALOGUE_TABLES,
  CONFIRM_BLOCKED,
  DIGEST_BLOCKED,
  EXPECTED_FUNCTIONS,
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  OWNER_CONTRACT_BLOCKED,
  PARTIAL_BLOCKED,
  PLAN_SEEDS,
  POST_BLOCKED,
  REQUIRED_CONFIRMATION,
  REQUIRED_CONSTRAINTS,
  REQUIRED_INDEXES,
  REQUIRED_LEDGER,
  REQUIRED_TRIGGERS,
  REVIEWED_DIGEST_BLOCKED,
  REVIEWED_DIGESTS,
  ROLE_BLOCKED,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNAUTHORISED_MIGRATION,
  UNEXPECTED_PLAN,
  absentCatalogue,
  apply0026Transaction,
  applyExact0026,
  assertConfirmation,
  assertMigrationFile,
  assertReviewedChecksums,
  catalogueInstalledContractFailures,
  cataloguePresentNames,
  evaluate0026Aftermath,
  evaluate0026Baseline,
  ownerUrlFromEnv,
  runSingleUse0026,
  seedAuditFailures,
  sha256,
} from "./cp26co32a-0026-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "cp26co32a-0026-production-migrate.mjs"), "utf8");
const workflowPath = join(here, "../.github/workflows/cp26co32a-0026-production-migrate.yml");
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
const migrationBytes = readFileSync(join(here, "../migrations", TARGET_MIGRATION));
const migrationDigest = createHash("sha256").update(migrationBytes).digest("hex");
const sql0026 = migrationBytes.toString("utf8");
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
    selectPublic: false,
    insertPublic: false,
    updatePublic: false,
    deletePublic: false,
    truncatePublic: false,
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
    selectPublic: false,
    insertPublic: false,
    updatePublic: false,
    deletePublic: false,
    truncatePublic: false,
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
    definition: "",
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
    securityDefiner: expected.securityDefiner,
    searchPath: expected.searchPath,
    executeAetherApp: expected.executeAetherApp,
    executePublic: false,
    definition: expected.bodyIncludes ?? "ok",
  };
}

function installedOwnerSchema(overrides = {}) {
  return {
    tables: {
      sbg_platform_owners: installedTable(),
      sbg_owner_audit_events: installedTable(),
    },
    functions: Object.fromEntries(OWNER_FUNCTIONS.map((expected) => [expected.name, installedFn({ ...expected, securityDefiner: true, bodyIncludes: null })])),
    stripeEventsSelectApp: true,
    grantCount: 1,
    auditCount: 1,
    ...overrides,
  };
}

function installedCatalogue(overrides = {}) {
  const base = absentCatalogue();
  base.tables = Object.fromEntries(CATALOGUE_TABLES.map((name) => [name, installedTable()]));
  base.functions = Object.fromEntries(EXPECTED_FUNCTIONS.map((expected) => [expected.name, installedFn(expected)]));
  base.constraints = [...REQUIRED_CONSTRAINTS];
  base.indexes = {
    sbg_saas_price_versions_one_purchasable_idx: {
      present: true,
      unique: true,
      predicate: "purchasable",
      def: "CREATE UNIQUE INDEX sbg_saas_price_versions_one_purchasable_idx",
    },
    sbg_saas_price_versions_history_idx: {
      present: true,
      unique: false,
      predicate: null,
      def: "CREATE INDEX sbg_saas_price_versions_history_idx",
    },
    sbg_saas_mapping_one_verified_idx: {
      present: true,
      unique: true,
      predicate: "(status = 'verified'::text)",
      def: "CREATE UNIQUE INDEX sbg_saas_mapping_one_verified_idx",
    },
  };
  base.triggers = Object.fromEntries(
    REQUIRED_TRIGGERS.map((trigger) => [
      trigger.name,
      {
        present: true,
        table: trigger.table,
        fn: trigger.fn,
        def: `CREATE TRIGGER ${trigger.name} ${trigger.bits.join(" ")} ON ${trigger.table} EXECUTE FUNCTION ${trigger.fn}()`,
      },
    ]),
  );
  base.plans = PLAN_SEEDS.map((plan) => ({ ...plan }));
  base.priceVersionCount = 0;
  base.mappingCount = 0;
  base.lockCount = 1;
  base.lock = { id: 1, liveMappingEnabled: false, liveCheckoutEnabled: false };
  base.seedAudits = PLAN_SEEDS.map((plan) => ({
    actorUserId: null,
    action: "catalogue.plan.created",
    targetType: "commercial_plan",
    targetId: plan.code,
    source: "migration:0026",
  }));
  return { ...base, ...overrides };
}

function canonicalFile(overrides = {}) {
  return {
    name: TARGET_MIGRATION,
    bytes: migrationBytes,
    digest: migrationDigest,
    sql: sql0026,
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
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
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
    billingSnapshot: { accountCount: 0, statusCounts: {}, eventCount: 0 },
    verifyHotel: { ...verifyHotel },
    activeOwnerCount: 1,
    ownerSchema: installedOwnerSchema(),
    catalogue: absentCatalogue(),
    ...overrides,
  };
}

function appliedFacts(overrides = {}) {
  const ownerSchema = installedOwnerSchema({ auditCount: 4 });
  return authorisedFacts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    ownerSchema,
    catalogue: installedCatalogue(),
    ...overrides,
  });
}

function runOpts(overrides = {}) {
  return {
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@host/neondb" },
    confirmation: REQUIRED_CONFIRMATION,
    file: canonicalFile(),
    sourceChecksums: reviewedChecksums(),
    loadFacts: async () => authorisedFacts(),
    mutate: async () => {
      throw new Error("mutate should not run");
    },
    ...overrides,
  };
}

test("canonical 0026 digest is pinned and 0001-0025 digests match", () => {
  assert.equal(migrationDigest, TARGET_DIGEST);
  assert.equal(sha256(migrationBytes), TARGET_DIGEST);
  assert.equal(assertMigrationFile(canonicalFile()).ok, true);
  assert.equal(REQUIRED_CONFIRMATION, "APPLY-0026");
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0027_cp26co41_organisation_property_licence.sql");
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.equal(REQUIRED_LEDGER.at(-1), "0025_cp26co2_platform_owners.sql");
  assert.equal(REQUIRED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.ok(ACCEPTED_LEDGER.length > REQUIRED_LEDGER.length + 1 || ACCEPTED_LEDGER.at(-1) !== TARGET_MIGRATION);
  for (const [name, expected] of Object.entries(REVIEWED_DIGESTS)) {
    const bytes = readFileSync(join(here, "../migrations", name));
    assert.equal(sha256(bytes), expected, name);
  }
  const files = readdirSync(join(here, "../migrations")).filter((name) => name.startsWith("0026"));
  assert.deepEqual(files, [TARGET_MIGRATION]);
  assert.equal(assertReviewedChecksums(reviewedChecksums()).ok, true);
});

test("missing owner URL blocks and DATABASE_URL cannot substitute", async () => {
  assert.equal(ownerUrlFromEnv({}), "");
  assert.equal(ownerUrlFromEnv({ DATABASE_URL: "postgres://runtime@host/neondb" }), "");
  let loaded = 0;
  const result = await runSingleUse0026(
    runOpts({
      env: { DATABASE_URL: "postgres://runtime:secret@host/neondb" },
      loadFacts: async () => {
        loaded += 1;
        return authorisedFacts();
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, BLOCKED_OWNER_URL);
  assert.equal(loaded, 0);
});

test("confirmation mismatch blocks before connecting", async () => {
  let loaded = 0;
  const result = await runSingleUse0026(
    runOpts({
      confirmation: "APPLY-0025",
      loadFacts: async () => {
        loaded += 1;
        return authorisedFacts();
      },
    }),
  );
  assert.equal(assertConfirmation("APPLY-0026").ok, true);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, CONFIRM_BLOCKED);
  assert.equal(loaded, 0);
});

test("wrong target filename and digest mismatch block", async () => {
  const wrongName = canonicalFile({ name: "0025_cp26co2_platform_owners.sql" });
  assert.equal(assertMigrationFile(wrongName).verdict, UNAUTHORISED_MIGRATION);
  assert.equal(evaluate0026Baseline(authorisedFacts(), wrongName).verdict, UNAUTHORISED_MIGRATION);
  const tampered = canonicalFile({ digest: "0".repeat(64), sql: "select 1" });
  assert.equal(assertMigrationFile(tampered).verdict, DIGEST_BLOCKED);
  assert.equal(evaluate0026Baseline(authorisedFacts(), tampered).verdict, DIGEST_BLOCKED);
  let loaded = 0;
  const reviewed = await runSingleUse0026(
    runOpts({
      sourceChecksums: reviewedChecksums({
        "0025_cp26co2_platform_owners.sql": "abc",
      }),
      loadFacts: async () => {
        loaded += 1;
        return authorisedFacts();
      },
    }),
  );
  assert.equal(reviewed.verdict, REVIEWED_DIGEST_BLOCKED);
  assert.equal(loaded, 0);
});

test("wrong database identity and unsafe runtime role block", () => {
  const file = canonicalFile();
  assert.equal(evaluate0026Baseline(authorisedFacts({ database: "postgres" }), file).verdict, IDENTITY_BLOCKED);
  assert.equal(
    evaluate0026Baseline(authorisedFacts({ currentUser: "aether_app", sessionUser: "aether_app" }), file).verdict,
    OWNER_BLOCKED,
  );
  assert.equal(
    evaluate0026Baseline(authorisedFacts({ aetherAppRole: { ...safeRole, superuser: true } }), file).verdict,
    ROLE_BLOCKED,
  );
});

test("ledger not exactly 0001-0025 before first apply blocks", () => {
  const missing = evaluate0026Baseline(
    authorisedFacts({
      ledger: REQUIRED_LEDGER.filter((name) => name !== "0024_cp26b2_ordered_billing_events.sql"),
    }),
    canonicalFile(),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.verdict, "BLOCKED — MISSING HISTORICAL MIGRATION");
  assert.deepEqual(missing.missingHistorical, ["0024_cp26b2_ordered_billing_events.sql"]);

  const unexpected = evaluate0026Baseline(
    authorisedFacts({ sourceMigrations: [...SOURCE, "0027_later.sql"] }),
    canonicalFile(),
  );
  assert.equal(unexpected.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(unexpected.pending, [TARGET_MIGRATION, "0027_later.sql"]);
});

test("partial catalogue object state blocks without mutation", async () => {
  let mutated = 0;
  const catalogue = absentCatalogue();
  catalogue.tables.sbg_saas_plans = installedTable();
  const result = await runSingleUse0026(
    runOpts({
      loadFacts: async () => authorisedFacts({ catalogue }),
      mutate: async () => {
        mutated += 1;
      },
    }),
  );
  assert.equal(result.verdict, PARTIAL_BLOCKED);
  assert.equal(result.migrated, false);
  assert.equal(mutated, 0);
  assert.ok(cataloguePresentNames(catalogue).includes("sbg_saas_plans"));
});

test("already-applied valid contract does not mutate", async () => {
  let mutated = 0;
  const result = await runSingleUse0026(
    runOpts({
      loadFacts: async () => appliedFacts(),
      mutate: async () => {
        mutated += 1;
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.verdict, ALREADY_APPLIED);
  assert.equal(result.migrated, false);
  assert.equal(mutated, 0);
  assert.deepEqual(catalogueInstalledContractFailures(appliedFacts()), []);
});

test("already-applied invalid contract is blocked without mutation", async () => {
  let mutated = 0;
  const catalogue = installedCatalogue();
  catalogue.lock = { id: 1, liveMappingEnabled: true, liveCheckoutEnabled: false };
  const result = await runSingleUse0026(
    runOpts({
      loadFacts: async () => appliedFacts({ catalogue }),
      mutate: async () => {
        mutated += 1;
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, PARTIAL_BLOCKED);
  assert.equal(result.migrated, false);
  assert.equal(mutated, 0);
  assert.ok(result.failures.includes("lock-live-mapping"));
});

test("active owner count must be exactly 1", () => {
  assert.equal(evaluate0026Baseline(authorisedFacts({ activeOwnerCount: 0 }), canonicalFile()).verdict, ACTIVE_OWNER_BLOCKED);
  assert.equal(evaluate0026Baseline(authorisedFacts({ activeOwnerCount: 2 }), canonicalFile()).verdict, ACTIVE_OWNER_BLOCKED);
});

test("hotel, billing, and stripe-event invariants gate apply and aftermath", () => {
  const file = canonicalFile();
  const hotel = evaluate0026Baseline(
    authorisedFacts({
      hotel: { code: "demo-kos", status: "configured", providerCount: 1, destinationCount: 4 },
    }),
    file,
  );
  assert.equal(hotel.verdict, "BLOCKED — DEMO-KOS INVARIANT NOT PROVEN");
  const verify = evaluate0026Baseline(
    authorisedFacts({ verifyHotel: { code: "sbg-verify-a5", status: "live" } }),
    file,
  );
  assert.equal(verify.verdict, "BLOCKED — VERIFY HOTEL INVARIANT NOT PROVEN");
  const brokenOwner = installedOwnerSchema();
  brokenOwner.tables.sbg_platform_owners = emptyTable();
  assert.equal(
    evaluate0026Baseline(authorisedFacts({ ownerSchema: brokenOwner }), file).verdict,
    OWNER_CONTRACT_BLOCKED,
  );

  const drifted = appliedFacts({
    billingSnapshot: { accountCount: 1, statusCounts: { active: 1 }, eventCount: 2 },
  });
  const aftermath = evaluate0026Aftermath(drifted, {
    hotelSnapshot,
    billingSnapshot,
    verifyHotel,
    activeOwnerCount: 1,
    auditCount: 1,
  });
  assert.equal(aftermath.ok, false);
  assert.equal(aftermath.verdict, POST_BLOCKED);
  assert.ok(aftermath.failures.includes("billing-invariance"));
});

test("expected post-0026 schema, seeds, locks, privileges, and audit contract", () => {
  const facts = appliedFacts();
  assert.deepEqual(catalogueInstalledContractFailures(facts), []);
  assert.deepEqual(
    facts.catalogue.plans.map((plan) => plan.code),
    ["basic", "pro", "premium"],
  );
  assert.equal(facts.catalogue.priceVersionCount, 0);
  assert.equal(facts.catalogue.mappingCount, 0);
  assert.equal(facts.catalogue.lock.liveMappingEnabled, false);
  assert.equal(facts.catalogue.lock.liveCheckoutEnabled, false);
  assert.deepEqual(seedAuditFailures(facts.catalogue.seedAudits), []);
  const recorder = facts.catalogue.functions.sbg_catalogue_record_stripe_mapping;
  assert.equal(recorder.executeAetherApp, false);
  assert.equal(recorder.executePublic, false);
  assert.equal(facts.catalogue.functions.sbg_catalogue_require_owner.executeAetherApp, false);
  assert.equal(facts.catalogue.functions.sbg_catalogue_plan_guard.securityDefiner, false);
  assert.equal(facts.catalogue.functions.sbg_resolve_domain_a_checkout_price.executeAetherApp, true);
  for (const name of CATALOGUE_TABLES) {
    assert.equal(facts.catalogue.tables[name].insertApp, false);
    assert.equal(facts.catalogue.tables[name].selectApp, true);
    assert.equal(facts.catalogue.tables[name].truncatePublic, false);
  }
  for (const name of CATALOGUE_FUNCTION_NAMES) assert.equal(facts.catalogue.functions[name].executePublic, false);

  const badPlans = installedCatalogue({ plans: PLAN_SEEDS.slice(0, 2) });
  assert.ok(catalogueInstalledContractFailures(appliedFacts({ catalogue: badPlans })).includes("plan-count"));
  const priced = installedCatalogue({ priceVersionCount: 1 });
  assert.ok(catalogueInstalledContractFailures(appliedFacts({ catalogue: priced })).includes("price-version-count"));
  const audits = facts.catalogue.seedAudits.filter((row) => row.targetId !== "premium");
  assert.ok(seedAuditFailures(audits).includes("seed-audit-count"));
  const named = installedCatalogue();
  named.functions.sbg_catalogue_update_plan = {
    ...named.functions.sbg_catalogue_update_plan,
    nargs: 1,
  };
  assert.ok(
    catalogueInstalledContractFailures(appliedFacts({ catalogue: named })).includes(
      "sbg_catalogue_update_plan-nargs",
    ),
  );
  const writable = installedCatalogue();
  writable.functions.sbg_catalogue_record_stripe_mapping = {
    ...writable.functions.sbg_catalogue_record_stripe_mapping,
    executeAetherApp: true,
  };
  assert.ok(
    catalogueInstalledContractFailures(appliedFacts({ catalogue: writable })).includes(
      "sbg_catalogue_record_stripe_mapping-execute-app",
    ),
  );
});

test("authorised apply commits only after aftermath passes", async () => {
  const calls = [];
  let mutated = 0;
  const result = await runSingleUse0026(
    runOpts({
      mutate: async ({ sql, before }) => {
        mutated += 1;
        return apply0026Transaction({
          sql,
          before,
          query: async (text, params) => {
            calls.push({ text, params });
          },
          inspect: async () => appliedFacts(),
        });
      },
    }),
  );
  assert.equal(mutated, 1);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, APPLIED_VERIFIED);
  assert.equal(result.committed, true);
  assert.equal(calls[0].text, "BEGIN");
  assert.equal(calls[1].text, sql0026);
  assert.equal(calls[2].text, "INSERT INTO _migrations (name) VALUES ($1)");
  assert.deepEqual(calls[2].params, [TARGET_MIGRATION]);
  assert.equal(calls[3].text, "COMMIT");
  assert.equal(evaluate0026Baseline(authorisedFacts(), canonicalFile()).verdict, AUTHORISED);
});

test("failed aftermath rolls back and does not commit", async () => {
  const calls = [];
  const result = await apply0026Transaction({
    sql: sql0026,
    before: {
      hotelSnapshot,
      billingSnapshot,
      verifyHotel,
      activeOwnerCount: 1,
      auditCount: 1,
    },
    query: async (text) => {
      calls.push(text);
    },
    inspect: async () => appliedFacts({ catalogue: installedCatalogue({ priceVersionCount: 1 }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.committed, false);
  assert.equal(result.migrated, false);
  assert.equal(result.verdict, POST_BLOCKED);
  assert.ok(result.failures.includes("price-version-count"));
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.includes("COMMIT"), false);
});

test("executor cannot run arbitrary SQL", async () => {
  let executed = 0;
  await assert.rejects(
    () =>
      applyExact0026({
        name: "0027_later.sql",
        sql: "drop table hotels",
        execute: async () => {
          executed += 1;
        },
      }),
    /UNAUTHORISED MIGRATION/,
  );
  await assert.rejects(
    () =>
      applyExact0026({
        name: TARGET_MIGRATION,
        sql: "select 1",
        execute: async () => {
          executed += 1;
        },
      }),
    /DIGEST MISMATCH/,
  );
  await assert.rejects(
    () =>
      apply0026Transaction({
        sql: "drop table hotels",
        before: {},
        query: async () => {
          executed += 1;
        },
        inspect: async () => appliedFacts(),
      }),
    /DIGEST MISMATCH/,
  );
  assert.equal(executed, 0);
  assert.equal(REQUIRED_INDEXES.length, 3);
});

test("apply failure rolls back the transaction and redacts secrets", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      apply0026Transaction({
        sql: sql0026,
        before: {},
        query: async (text) => {
          calls.push(text);
          if (text.startsWith("INSERT")) throw new Error("permission denied postgres://owner:secret@host/neondb");
        },
        inspect: async () => appliedFacts(),
      }),
    /permission denied/,
  );
  assert.equal(calls[0], "BEGIN");
  assert.equal(calls.at(-1), "ROLLBACK");
  const result = await runSingleUse0026(
    runOpts({
      mutate: async () => {
        throw new Error("permission denied postgres://owner:secret@host/neondb");
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.verdict, /0026 APPLICATION FAILED|DIGEST/);
  assert.doesNotMatch(result.error, /secret/);
  assert.match(result.error, /redacted/);
});

test("Gate B accepts applied 0026 inside 0001-0027; build and the npm alias do not apply 0026", () => {
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0027_cp26co41_organisation_property_licence.sql");
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.equal(isAuthorisedPending("0027_later.sql"), false);
  const current = evaluatePreflight({
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...ACCEPTED_LEDGER],
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    aetherAppExists: true,
    occupancy,
  });
  assert.equal(current.ok, true);
  assert.deepEqual(current.pending, []);
  const future = evaluatePreflight({
    ...current,
    ok: undefined,
    sourceMigrations: [...ACCEPTED_LEDGER, "0027_later.sql"],
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    aetherAppExists: true,
    occupancy,
  });
  assert.equal(future.ok, false);
  assert.deepEqual(future.unexpectedPending, ["0027_later.sql"]);
  const generic = evaluateMigrationBaseline(future);
  assert.equal(generic.ok, false);
  assert.equal(generic.migrated, false);
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkg.scripts.build, /cp26co32a-0026/);
  assert.equal(pkg.scripts["db:migrate:0026"], undefined);
  const genericSrc = readFileSync(join(here, "production-db-migrate.mjs"), "utf8");
  assert.match(genericSrc, /0001–0027/);
  assert.doesNotMatch(genericSrc, new RegExp(TARGET_MIGRATION));
});

test("spent 0026 workflow is absent and no workflow dispatches the controller", () => {
  assert.equal(existsSync(workflowPath), false);
  const workflows = readdirSync(join(here, "../.github/workflows"));
  assert.deepEqual(workflows.sort(), [
    "cp26co2a-0025-production-migrate.yml",
    "cp26fin-0028-production-migrate.yml",
    "production-database.yml",
  ]);
  for (const name of workflows) {
    const text = readFileSync(join(here, "../.github/workflows", name), "utf8");
    assert.equal(text.includes("cp26co32a-0026-production-migrate.mjs"), false, name);
    assert.equal(text.includes("APPLY-0026"), false, name);
    assert.equal(text.includes(TARGET_MIGRATION), false, name);
  }
});

test("controller source never uses DATABASE_URL, Stripe, or the generic migrator", () => {
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*ownerUrl/);
  assert.doesNotMatch(src, /STRIPE_SECRET|sk_live|sk_test|api\.stripe\.com/);
  assert.doesNotMatch(src, /SBG_SAAS_COMMERCE\s*=/);
  assert.doesNotMatch(src, /production-db-migrate/);
  assert.doesNotMatch(src, /sbg_grant_platform_owner\s*\(/);
  assert.doesNotMatch(src, /sbg_revoke_platform_owner\s*\(/);
  assert.doesNotMatch(src, /sbg_bootstrap_platform_owner\s*\(/);
  assert.doesNotMatch(src, /5900|6900|9900/);
  assert.match(src, /BEGIN READ ONLY/);
  assert.match(src, /ROLLBACK/);
  assert.match(src, /COMMIT/);
  assert.match(src, /INSERT INTO _migrations \(name\) VALUES \(\$1\)/);
  assert.match(src, /AETHER_DATABASE_OWNER_URL: \$\{ownerUrl \? "PRESENT" : "ABSENT"\}/);
  assert.match(src, /select count\(\*\)::int as n from sbg_saas_price_versions/);
  assert.doesNotMatch(src, /select[^;]*amount_minor/i);
});

test("controller script is syntactically valid", async () => {
  await execFileAsync("node", ["--check", join(here, "cp26co32a-0026-production-migrate.mjs")]);
});

test("direct invocation without secret exits before connecting", async () => {
  let threw = null;
  try {
    await execFileAsync("node", [join(here, "cp26co32a-0026-production-migrate.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH,
        CP26CO32A_CONFIRMATION: "APPLY-0026",
        DATABASE_URL: "postgres://runtime:secret@host/neondb",
      },
    });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw);
  const output = `${threw.stdout ?? ""}${threw.stderr ?? ""}`;
  assert.match(output, /AETHER_DATABASE_OWNER_URL: ABSENT/);
  assert.match(output, new RegExp(BLOCKED_OWNER_URL));
  assert.doesNotMatch(output, /secret/);
  assert.doesNotMatch(output, /postgres:\/\//);
});
