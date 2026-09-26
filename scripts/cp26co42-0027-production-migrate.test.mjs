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
  CATALOGUE_TABLES,
  EXPECTED_FUNCTIONS as CATALOGUE_FUNCTIONS,
  PLAN_SEEDS,
  REQUIRED_CONSTRAINTS as CATALOGUE_CONSTRAINTS,
  REQUIRED_INDEXES as CATALOGUE_INDEXES,
  REQUIRED_TRIGGERS as CATALOGUE_TRIGGERS,
  REVIEWED_DIGESTS as CATALOGUE_DIGESTS,
  absentCatalogue,
} from "./cp26co32a-0026-production-migrate.mjs";
import {
  ACCEPTED_LEDGER,
  ACTIVE_OWNER_BLOCKED,
  ALREADY_APPLIED,
  APPLIED_VERIFIED,
  AUTHORISED,
  AUTHORISED_PENDING,
  CATALOGUE_CONTRACT_BLOCKED,
  CONFIRM_BLOCKED,
  DIGEST_BLOCKED,
  DOMAIN_B_BLOCKED,
  EXPECTED_APPLY_ARG_NAMES,
  EXPECTED_APPLY_ARG_TYPES,
  EXPECTED_APPLY_NARGS,
  EXPECTED_FUNCTIONS,
  HOTEL_APPLY_BLOCKED,
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  OWNER_CONTRACT_BLOCKED,
  PARTIAL_BLOCKED,
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
  absentOrganisation,
  apply0027Transaction,
  applyExact0027,
  assertConfirmation,
  assertMigrationFile,
  assertReviewedChecksums,
  evaluate0027Aftermath,
  evaluate0027Baseline,
  freshApplyZeroRowFailures,
  hotelApplyContractFailures,
  licenceBalanceViewFailures,
  organisationInstalledContractFailures,
  ownerUrlFromEnv,
  runSingleUse0027,
  sha256,
} from "./cp26co42-0027-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "cp26co42-0027-production-migrate.mjs"), "utf8");
const workflowPath = join(here, "../.github/workflows/cp26co42-0027-production-migrate.yml");
const workflow = readFileSync(workflowPath, "utf8");
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
const migrationBytes = readFileSync(join(here, "../migrations", TARGET_MIGRATION));
const migrationDigest = createHash("sha256").update(migrationBytes).digest("hex");
const sql0027 = migrationBytes.toString("utf8");
const SOURCE = [...REQUIRED_LEDGER, TARGET_MIGRATION];
const VIEW_DEF =
  " SELECT o.id AS organisation_id,\n" +
  "    COALESCE(b.licensed_quantity, 0) AS licensed_quantity,\n" +
  "    COALESCE(a.active_allocations, 0) AS active_allocations,\n" +
  "    COALESCE(b.licensed_quantity, 0) - COALESCE(a.active_allocations, 0) AS available_licences\n" +
  "   FROM sbg_organisations o";

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
const domain = { paymentFunctionPresent: true, bookingPaymentCount: 0, hotelAccountCount: 0 };

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

function installedFn(expected) {
  const snippets = [...(expected.snippets ?? [])];
  if (expected.bodyIncludes && !snippets.includes(expected.bodyIncludes)) snippets.push(expected.bodyIncludes);
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
    definition: snippets.join("\n") || "ok",
  };
}

function installedOwnerSchema(overrides = {}) {
  return {
    tables: {
      sbg_platform_owners: installedTable(),
      sbg_owner_audit_events: installedTable(),
    },
    functions: Object.fromEntries(
      OWNER_FUNCTIONS.map((expected) => [
        expected.name,
        installedFn({ ...expected, securityDefiner: true, bodyIncludes: null, snippets: [] }),
      ]),
    ),
    stripeEventsSelectApp: true,
    grantCount: 1,
    auditCount: 4,
    ...overrides,
  };
}

function installedCatalogue(overrides = {}) {
  const base = absentCatalogue();
  base.tables = Object.fromEntries(CATALOGUE_TABLES.map((name) => [name, installedTable()]));
  base.functions = Object.fromEntries(
    CATALOGUE_FUNCTIONS.map((expected) => [expected.name, installedFn(expected)]),
  );
  base.constraints = [...CATALOGUE_CONSTRAINTS];
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
    CATALOGUE_TRIGGERS.map((trigger) => [
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

function installedOrganisation(overrides = {}) {
  const base = absentOrganisation();
  base.tables = Object.fromEntries(Object.keys(base.tables).map((name) => [name, installedTable()]));
  base.functions = Object.fromEntries(EXPECTED_FUNCTIONS.map((expected) => [expected.name, installedFn(expected)]));
  base.view = {
    present: true,
    relkind: "v",
    owner: "neondb_owner",
    definition: VIEW_DEF,
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
  base.constraints = [...REQUIRED_CONSTRAINTS];
  base.indexes = Object.fromEntries(
    REQUIRED_INDEXES.map((index) => [
      index.name,
      {
        present: true,
        unique: index.unique,
        predicate: index.predicate.source.replace(/\\s\*/g, " ").replace(/is null/i, "IS NULL"),
        def: `CREATE INDEX ${index.name}`,
      },
    ]),
  );
  base.indexes.sbg_organisation_members_active_uidx.predicate = "(removed_at IS NULL)";
  base.indexes.sbg_organisation_members_user_active_idx.predicate = "(removed_at IS NULL)";
  base.indexes.hotels_organisation_id_idx.predicate = "(organisation_id IS NOT NULL)";
  base.indexes.sbg_organisation_billing_customer_uidx.predicate = "(stripe_customer_id IS NOT NULL)";
  base.indexes.sbg_organisation_billing_subscription_uidx.predicate = "(stripe_subscription_id IS NOT NULL)";
  base.indexes.sbg_property_licence_one_active_idx.predicate = "(released_at IS NULL)";
  base.indexes.sbg_property_licence_org_active_idx.predicate = "(released_at IS NULL)";
  base.triggers = Object.fromEntries(
    REQUIRED_TRIGGERS.map((trigger) => [
      trigger.name,
      {
        present: true,
        table: trigger.table,
        fn: trigger.fn,
        def: `CREATE TRIGGER ${trigger.name} ${trigger.bits.join(" ")} ON ${trigger.table} ${(trigger.columns ?? []).length ? `OF ${trigger.columns.join(", ")} ` : ""}FOR EACH ${trigger.bits.includes("FOR EACH STATEMENT") ? "STATEMENT" : "ROW"} EXECUTE FUNCTION ${trigger.fn}()`,
      },
    ]),
  );
  base.columns = {
    hotelsOrganisationId: { present: true, dataType: "uuid", nullable: true },
    stripeEventsOrganisationId: { present: true, dataType: "uuid", nullable: true },
  };
  base.counts = {
    organisations: 0,
    members: 0,
    billing: 0,
    allocations: 0,
    attachedHotels: 0,
    propertyLicencePlans: 0,
  };
  return { ...base, ...overrides };
}

const HOTEL_APPLY_DEF = `function sbg_apply_billing_event(p_event_id text, p_event_created bigint)
as $function$
begin
  return 'stale';
  return 'ambiguous';
end
$function$`;

function canonicalFile(overrides = {}) {
  return {
    name: TARGET_MIGRATION,
    bytes: migrationBytes,
    digest: migrationDigest,
    sql: sql0027,
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
    catalogue: installedCatalogue(),
    organisation: absentOrganisation(),
    functionDefinition: HOTEL_APPLY_DEF,
    functionCount: 1,
    functionArgCount: EXPECTED_APPLY_NARGS,
    functionArgNames: [...EXPECTED_APPLY_ARG_NAMES],
    functionArgTypes: [...EXPECTED_APPLY_ARG_TYPES],
    functionReturnType: "text",
    domain: { ...domain },
    ...overrides,
  };
}

function appliedFacts(overrides = {}) {
  return authorisedFacts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    sourceMigrations: SOURCE,
    organisation: installedOrganisation(),
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

test("canonical 0027 digest is pinned and the prerequisite digest chain matches", () => {
  assert.equal(migrationDigest, TARGET_DIGEST);
  assert.equal(sha256(migrationBytes), TARGET_DIGEST);
  assert.equal(assertMigrationFile(canonicalFile()).ok, true);
  assert.equal(REQUIRED_CONFIRMATION, "APPLY-0027");
  assert.equal(REQUIRED_LEDGER.at(-1), "0026_cp26co3_commercial_catalogue.sql");
  assert.equal(REQUIRED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.equal(REQUIRED_LEDGER.length, 26);
  assert.deepEqual(REQUIRED_LEDGER, [...ACCEPTED_LEDGER]);
  assert.doesNotMatch(src, /REQUIRED_LEDGER\s*=\s*\[\s*\.\.\.ACCEPTED_LEDGER/);
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  for (const [name, expected] of Object.entries(REVIEWED_DIGESTS)) {
    const bytes = readFileSync(join(here, "../migrations", name));
    assert.equal(sha256(bytes), expected, name);
  }
  for (const [name, expected] of Object.entries(CATALOGUE_DIGESTS)) {
    assert.equal(REVIEWED_DIGESTS[name], expected, name);
  }
  const files = readdirSync(join(here, "../migrations")).filter((name) => name.startsWith("0027"));
  assert.deepEqual(files, [TARGET_MIGRATION]);
  assert.equal(assertReviewedChecksums(reviewedChecksums()).ok, true);
  assert.equal(CATALOGUE_INDEXES.length, 3);
});

test("exact confirmation is required and a wrong phrase never connects", async () => {
  for (const value of [undefined, "", "apply-0027", " APPLY-0027", "APPLY-0027 ", "APPLY-0026", "APPLY-0027\n"]) {
    assert.equal(assertConfirmation(value).ok, false);
    assert.equal(assertConfirmation(value).verdict, CONFIRM_BLOCKED);
  }
  assert.equal(assertConfirmation("APPLY-0027").ok, true);
  let loaded = 0;
  const result = await runSingleUse0027(
    runOpts({
      confirmation: "apply-0027",
      loadFacts: async () => {
        loaded += 1;
        return authorisedFacts();
      },
    }),
  );
  assert.equal(loaded, 0);
  assert.equal(result.verdict, CONFIRM_BLOCKED);
  assert.equal(result.migrated, false);
});

test("owner URL is required and DATABASE_URL cannot substitute", async () => {
  assert.equal(ownerUrlFromEnv({}), "");
  assert.equal(ownerUrlFromEnv({ DATABASE_URL: "postgres://runtime@host/neondb" }), "");
  assert.equal(ownerUrlFromEnv({ AETHER_DATABASE_OWNER_URL: "  " }), "");
  let loaded = 0;
  const result = await runSingleUse0027(
    runOpts({
      env: { DATABASE_URL: "postgres://runtime:secret@host/neondb" },
      loadFacts: async () => {
        loaded += 1;
        return authorisedFacts();
      },
    }),
  );
  assert.equal(loaded, 0);
  assert.equal(result.verdict, BLOCKED_OWNER_URL);
  assert.equal(result.migrated, false);
});

test("exact filename and 0027 digest are required before connect", async () => {
  let loaded = 0;
  const wrongName = await runSingleUse0027(
    runOpts({
      file: canonicalFile({ name: "0028_later.sql" }),
      loadFacts: async () => {
        loaded += 1;
        return authorisedFacts();
      },
    }),
  );
  assert.equal(wrongName.verdict, UNAUTHORISED_MIGRATION);
  const tampered = await runSingleUse0027(
    runOpts({
      file: canonicalFile({ digest: "0".repeat(64), sql: "select 1" }),
      loadFacts: async () => {
        loaded += 1;
        return authorisedFacts();
      },
    }),
  );
  assert.equal(tampered.verdict, DIGEST_BLOCKED);
  assert.equal(loaded, 0);
  assert.equal(evaluate0027Baseline(authorisedFacts(), canonicalFile({ name: "0026_cp26co3_commercial_catalogue.sql" })).verdict, UNAUTHORISED_MIGRATION);
});

test("prerequisite digest mismatch blocks before connect", async () => {
  let loaded = 0;
  const reviewed = await runSingleUse0027(
    runOpts({
      sourceChecksums: reviewedChecksums({
        "0026_cp26co3_commercial_catalogue.sql": "f".repeat(64),
      }),
      loadFacts: async () => {
        loaded += 1;
        return authorisedFacts();
      },
    }),
  );
  assert.equal(loaded, 0);
  assert.equal(reviewed.verdict, REVIEWED_DIGEST_BLOCKED);
  assert.equal(reviewed.name, "0026_cp26co3_commercial_catalogue.sql");
});

test("production identity, owner role, and runtime role safety block", () => {
  const file = canonicalFile();
  assert.equal(evaluate0027Baseline(authorisedFacts({ database: "postgres" }), file).verdict, IDENTITY_BLOCKED);
  assert.equal(
    evaluate0027Baseline(authorisedFacts({ currentUser: "aether_app", sessionUser: "aether_app" }), file).verdict,
    OWNER_BLOCKED,
  );
  assert.equal(
    evaluate0027Baseline(authorisedFacts({ aetherAppRole: { ...safeRole, superuser: true } }), file).verdict,
    ROLE_BLOCKED,
  );
  assert.equal(evaluate0027Baseline(authorisedFacts({ activeOwnerCount: 0 }), file).verdict, ACTIVE_OWNER_BLOCKED);
  assert.equal(evaluate0027Baseline(authorisedFacts({ activeOwnerCount: 2 }), file).verdict, ACTIVE_OWNER_BLOCKED);
});

test("pre-ledger must be exactly 0001-0026 and pending exactly 0027", () => {
  const file = canonicalFile();
  assert.equal(evaluate0027Baseline(authorisedFacts(), file).verdict, AUTHORISED);
  const missing = evaluate0027Baseline(
    authorisedFacts({ ledger: REQUIRED_LEDGER.filter((name) => !name.startsWith("0026")) }),
    file,
  );
  assert.equal(missing.verdict, "BLOCKED — MISSING HISTORICAL MIGRATION");
  const unexpected = evaluate0027Baseline(
    authorisedFacts({ sourceMigrations: [...SOURCE, "0028_later.sql"] }),
    file,
  );
  assert.equal(unexpected.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(unexpected.pending, [TARGET_MIGRATION, "0028_later.sql"]);
  const onlyLater = evaluate0027Baseline(
    authorisedFacts({ sourceMigrations: [...REQUIRED_LEDGER, "0028_later.sql"] }),
    file,
  );
  assert.equal(onlyLater.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(onlyLater.pending, ["0028_later.sql"]);
});

test("partial objects, ledger split, and invalid already-applied state block with no mutation", async () => {
  const present = absentOrganisation();
  present.tables.sbg_organisations = installedTable();
  const partial = await runSingleUse0027(
    runOpts({
      loadFacts: async () => authorisedFacts({ organisation: present }),
      mutate: async () => {
        throw new Error("must not mutate");
      },
    }),
  );
  assert.equal(partial.verdict, PARTIAL_BLOCKED);
  assert.equal(partial.migrated, false);
  assert.ok(partial.present.includes("sbg_organisations"));

  const split = evaluate0027Baseline(
    authorisedFacts({
      ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
      organisation: absentOrganisation(),
    }),
    canonicalFile(),
  );
  assert.equal(split.verdict, PARTIAL_BLOCKED);

  const extraLedger = evaluate0027Baseline(
    appliedFacts({ ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION, "0028_later.sql"] }),
    canonicalFile(),
  );
  assert.equal(extraLedger.verdict, PARTIAL_BLOCKED);

  const broken = installedOrganisation();
  broken.constraints = broken.constraints.filter((name) => name !== "sbg_stripe_events_identity_exclusive");
  assert.equal(
    evaluate0027Baseline(appliedFacts({ organisation: broken }), canonicalFile()).verdict,
    PARTIAL_BLOCKED,
  );
});

test("valid already-applied state, including later organisation rows, does not mutate", async () => {
  let mutated = 0;
  const clean = await runSingleUse0027(
    runOpts({
      loadFacts: async () => appliedFacts(),
      mutate: async () => {
        mutated += 1;
        return { ok: true, migrated: true };
      },
    }),
  );
  assert.equal(clean.verdict, ALREADY_APPLIED);
  assert.equal(clean.migrated, false);
  const later = installedOrganisation();
  later.counts = { ...later.counts, organisations: 1, members: 1 };
  const reused = await runSingleUse0027(
    runOpts({
      loadFacts: async () => appliedFacts({ organisation: later }),
      mutate: async () => {
        mutated += 1;
        return { ok: true, migrated: true };
      },
    }),
  );
  assert.equal(reused.verdict, ALREADY_APPLIED);
  assert.equal(mutated, 0);
});

test("installed organisation contract covers tables, view, columns, constraints, indexes, triggers, and functions", () => {
  assert.deepEqual(organisationInstalledContractFailures(appliedFacts()), []);
  assert.deepEqual(licenceBalanceViewFailures(installedOrganisation().view), []);
  const stored = installedOrganisation();
  stored.view = { ...stored.view, relkind: "r", definition: "available_licences integer" };
  assert.ok(licenceBalanceViewFailures(stored.view).includes("view-stored-balance"));
  assert.ok(organisationInstalledContractFailures(appliedFacts({ organisation: stored })).includes("view-derived"));

  const nullable = installedOrganisation();
  nullable.columns.hotelsOrganisationId = { present: true, dataType: "uuid", nullable: false };
  assert.ok(
    organisationInstalledContractFailures(appliedFacts({ organisation: nullable })).includes(
      "hotels-organisation-id-nullable",
    ),
  );
  const eventType = installedOrganisation();
  eventType.columns.stripeEventsOrganisationId = { present: true, dataType: "text", nullable: true };
  assert.ok(
    organisationInstalledContractFailures(appliedFacts({ organisation: eventType })).includes(
      "stripe-events-organisation-id-type",
    ),
  );

  const guard = installedOrganisation();
  delete guard.triggers.sbg_billing_accounts_stripe_identity;
  assert.ok(
    organisationInstalledContractFailures(appliedFacts({ organisation: guard })).includes(
      "trigger-sbg_billing_accounts_stripe_identity",
    ),
  );
  const index = installedOrganisation();
  index.indexes.sbg_property_licence_one_active_idx = {
    ...index.indexes.sbg_property_licence_one_active_idx,
    unique: false,
  };
  assert.ok(
    organisationInstalledContractFailures(appliedFacts({ organisation: index })).includes(
      "index-unique-sbg_property_licence_one_active_idx",
    ),
  );
  const fn = installedOrganisation();
  fn.functions.sbg_apply_organisation_billing_event = {
    ...fn.functions.sbg_apply_organisation_billing_event,
    nargs: 10,
  };
  assert.ok(
    organisationInstalledContractFailures(appliedFacts({ organisation: fn })).includes(
      "sbg_apply_organisation_billing_event-nargs",
    ),
  );
  const bypass = installedOrganisation();
  bypass.functions.sbg_organisation_member_billing = {
    ...bypass.functions.sbg_organisation_member_billing,
    executeAetherApp: true,
  };
  assert.ok(
    organisationInstalledContractFailures(appliedFacts({ organisation: bypass })).includes(
      "sbg_organisation_member_billing-execute-app",
    ),
  );
  const writable = installedOrganisation();
  writable.tables.sbg_organisations = { ...installedTable(), insertApp: true };
  assert.ok(
    organisationInstalledContractFailures(appliedFacts({ organisation: writable })).includes(
      "sbg_organisations-insert",
    ),
  );
});

test("legacy 10-arg hotel apply must stay ordered and must not become the organisation function", () => {
  assert.deepEqual(hotelApplyContractFailures(authorisedFacts()), []);
  const replaced = `function sbg_apply_billing_event(p_event_created bigint, p_organisation_id uuid, p_licensed_quantity integer)
as $function$
begin
  return 'stale';
  return 'ambiguous';
end
$function$`;
  const facts = authorisedFacts({
    functionDefinition: replaced,
    functionArgCount: 13,
    functionArgTypes: EXPECTED_FUNCTIONS.find((fn) => fn.name === "sbg_apply_organisation_billing_event").argTypes,
  });
  assert.equal(evaluate0027Baseline(facts, canonicalFile()).verdict, HOTEL_APPLY_BLOCKED);
  assert.ok(hotelApplyContractFailures(facts).includes("hotel-apply-replaced"));
});

test("catalogue, price, mapping, lock, and Domain B baselines block when drifted", () => {
  const priced = evaluate0027Baseline(
    authorisedFacts({ catalogue: installedCatalogue({ priceVersionCount: 1 }) }),
    canonicalFile(),
  );
  assert.equal(priced.verdict, CATALOGUE_CONTRACT_BLOCKED);
  assert.ok(priced.failures.includes("price-version-count"));
  const mapped = evaluate0027Baseline(
    authorisedFacts({ catalogue: installedCatalogue({ mappingCount: 1 }) }),
    canonicalFile(),
  );
  assert.ok(mapped.failures.includes("stripe-mapping-count"));
  const unlocked = installedCatalogue();
  unlocked.lock = { id: 1, liveMappingEnabled: true, liveCheckoutEnabled: false };
  assert.ok(
    evaluate0027Baseline(authorisedFacts({ catalogue: unlocked }), canonicalFile()).failures.includes(
      "lock-live-mapping",
    ),
  );
  const plans = installedCatalogue({
    plans: [...PLAN_SEEDS, { code: "property_licence", name: "Property", description: "", sortOrder: 40, active: true }],
  });
  assert.equal(evaluate0027Baseline(authorisedFacts({ catalogue: plans }), canonicalFile()).verdict, CATALOGUE_CONTRACT_BLOCKED);
  assert.equal(
    evaluate0027Baseline(authorisedFacts({ domain: { ...domain, paymentFunctionPresent: false } }), canonicalFile())
      .verdict,
    DOMAIN_B_BLOCKED,
  );
  assert.equal(
    evaluate0027Baseline(authorisedFacts({ ownerSchema: installedOwnerSchema({ stripeEventsSelectApp: false }) }), canonicalFile())
      .verdict,
    OWNER_CONTRACT_BLOCKED,
  );
});

test("authorised apply commits once only after zero-row and invariant checks pass", async () => {
  const calls = [];
  let mutated = 0;
  const result = await runSingleUse0027(
    runOpts({
      mutate: async ({ sql, before }) => {
        mutated += 1;
        return apply0027Transaction({
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
  assert.equal(result.migrated, true);
  assert.equal(calls[0].text, "BEGIN");
  assert.equal(calls[1].text, sql0027);
  assert.equal(calls[2].text, "INSERT INTO _migrations (name) VALUES ($1)");
  assert.deepEqual(calls[2].params, [TARGET_MIGRATION]);
  assert.equal(calls[3].text, "COMMIT");
  assert.deepEqual(freshApplyZeroRowFailures(appliedFacts().organisation), []);
});

test("failed aftermath rolls back organisation, attachment, billing, catalogue, and Domain B drift", async () => {
  const cases = [
    { organisation: installedOrganisation({ counts: { organisations: 1, members: 0, billing: 0, allocations: 0, attachedHotels: 0, propertyLicencePlans: 0 } }), failure: "organisation-count" },
    { organisation: installedOrganisation({ counts: { organisations: 0, members: 1, billing: 0, allocations: 0, attachedHotels: 0, propertyLicencePlans: 0 } }), failure: "member-count" },
    { organisation: installedOrganisation({ counts: { organisations: 0, members: 0, billing: 1, allocations: 0, attachedHotels: 0, propertyLicencePlans: 0 } }), failure: "billing-count" },
    { organisation: installedOrganisation({ counts: { organisations: 0, members: 0, billing: 0, allocations: 1, attachedHotels: 0, propertyLicencePlans: 0 } }), failure: "allocation-count" },
    { organisation: installedOrganisation({ counts: { organisations: 0, members: 0, billing: 0, allocations: 0, attachedHotels: 1, propertyLicencePlans: 0 } }), failure: "attached-hotels" },
    { organisation: installedOrganisation({ counts: { organisations: 0, members: 0, billing: 0, allocations: 0, attachedHotels: 0, propertyLicencePlans: 1 } }), failure: "property-licence-plan" },
    { catalogue: installedCatalogue({ priceVersionCount: 1 }), failure: "price-version-count" },
    { catalogue: installedCatalogue({ mappingCount: 2 }), failure: "stripe-mapping-count" },
    { billingSnapshot: { accountCount: 3, statusCounts: {}, eventCount: 0 }, failure: "billing-invariance" },
    { billingSnapshot: { accountCount: 0, statusCounts: {}, eventCount: 4 }, failure: "billing-invariance" },
    { activeOwnerCount: 2, failure: "owner-invariance" },
    { domain: { ...domain, bookingPaymentCount: 9 }, failure: "domain-b-invariance" },
    { domain: { ...domain, hotelAccountCount: 2 }, failure: "domain-b-invariance" },
    {
      hotelSnapshot: { ...hotelSnapshot, demoKos: { ...hotelSnapshot.demoKos, status: "configured" } },
      failure: "hotel-invariance",
    },
  ];
  for (const item of cases) {
    const calls = [];
    const result = await apply0027Transaction({
      sql: sql0027,
      before: {
        hotelSnapshot,
        billingSnapshot,
        verifyHotel,
        activeOwnerCount: 1,
        auditCount: 4,
        domain,
      },
      query: async (text) => {
        calls.push(text);
      },
      inspect: async () => appliedFacts(item),
    });
    assert.equal(result.ok, false, item.failure);
    assert.equal(result.committed, false, item.failure);
    assert.equal(result.migrated, false, item.failure);
    assert.equal(result.verdict, POST_BLOCKED, item.failure);
    assert.ok(result.failures.includes(item.failure), `${item.failure} missing from ${result.failures}`);
    assert.equal(calls.at(-1), "ROLLBACK", item.failure);
    assert.equal(calls.includes("COMMIT"), false, item.failure);
  }
});

test("executor cannot apply any other migration or arbitrary SQL", async () => {
  let executed = 0;
  await assert.rejects(
    () =>
      applyExact0027({
        name: "0028_later.sql",
        sql: "drop table hotels",
        execute: async () => {
          executed += 1;
        },
      }),
    /UNAUTHORISED MIGRATION/,
  );
  await assert.rejects(
    () =>
      applyExact0027({
        name: "0026_cp26co3_commercial_catalogue.sql",
        sql: sql0027,
        execute: async () => {
          executed += 1;
        },
      }),
    /UNAUTHORISED MIGRATION/,
  );
  await assert.rejects(
    () =>
      applyExact0027({
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
      apply0027Transaction({
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
});

test("apply failure rolls back and redacts secrets", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      apply0027Transaction({
        sql: sql0027,
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
  const result = await runSingleUse0027(
    runOpts({
      mutate: async () => {
        throw new Error("permission denied postgres://owner:secret@host/neondb");
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.verdict, /0027 APPLICATION FAILED|DIGEST/);
  assert.doesNotMatch(result.error, /secret/);
  assert.match(result.error, /redacted/);
});

test("Gate B still refuses 0027 and build does not invoke this controller", () => {
  assert.equal(ACCEPTED_LEDGER.at(-1), "0026_cp26co3_commercial_catalogue.sql");
  assert.deepEqual(AUTHORISED_PENDING, []);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  const current = evaluatePreflight({
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...ACCEPTED_LEDGER, TARGET_MIGRATION],
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    aetherAppExists: true,
    occupancy,
  });
  assert.equal(current.ok, false);
  assert.deepEqual(current.unexpectedPending, [TARGET_MIGRATION]);
  const generic = evaluateMigrationBaseline(current);
  assert.equal(generic.ok, false);
  assert.equal(generic.migrated, false);
  const genericSrc = readFileSync(join(here, "production-db-migrate.mjs"), "utf8");
  assert.doesNotMatch(genericSrc, new RegExp(TARGET_MIGRATION));
  assert.match(genericSrc, /0001–0026/);
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkg.scripts.build, /cp26co42/);
  assert.equal(pkg.scripts["db:migrate:0027"], undefined);
  for (const [name, value] of Object.entries(pkg.scripts)) {
    if (name === "test" || name === "test:aether") continue;
    assert.doesNotMatch(String(value), /cp26co42-0027-production-migrate\.mjs/, name);
  }
  assert.match(pkg.scripts["test:aether"], /cp26co42-0027-production-migrate\.test\.mjs/);
});

test("workflow is dispatch-only, confirms APPLY-0027, and cannot target another migrator", () => {
  assert.equal(existsSync(workflowPath), true);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /description: Type APPLY-0027/);
  assert.match(workflow, /CP26CO42_CONFIRMATION: \$\{\{ inputs\.confirmation \}\}/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /group: production-database-mutation/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: "22"/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /node scripts\/cp26co42-0027-production-migrate\.mjs/);
  assert.match(workflow, /secrets\.AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(workflow, /\bpush\s*:/);
  assert.doesNotMatch(workflow, /\bpull_request\s*:/);
  assert.doesNotMatch(workflow, /\bschedule\s*:/);
  assert.doesNotMatch(workflow, /\bworkflow_run\s*:/);
  assert.doesNotMatch(workflow, /DATABASE_URL/);
  assert.doesNotMatch(workflow, /scripts\/migrate\.mjs/);
  assert.doesNotMatch(workflow, /production-db-migrate/);
  assert.doesNotMatch(workflow, /stripe/i);
  assert.doesNotMatch(workflow, /vercel/i);
  assert.doesNotMatch(workflow, /0026/);
  assert.doesNotMatch(workflow, /gh workflow run/);
  const workflows = readdirSync(join(here, "../.github/workflows")).sort();
  assert.deepEqual(workflows, [
    "cp26co2a-0025-production-migrate.yml",
    "cp26co42-0027-production-migrate.yml",
    "production-database.yml",
  ]);
});

test("controller source never uses DATABASE_URL, Stripe, commerce, or the generic migrator", () => {
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /console\.(?:log|error|info)\([^)]*ownerUrl/);
  assert.doesNotMatch(src, /STRIPE_SECRET|sk_live|sk_test|api\.stripe\.com/);
  assert.doesNotMatch(src, /SBG_SAAS_COMMERCE\s*=/);
  assert.doesNotMatch(src, /SBG_SAAS_TEST_HOTEL_IDS/);
  assert.doesNotMatch(src, /production-db-migrate/);
  assert.doesNotMatch(src, /scripts\/migrate\.mjs/);
  assert.doesNotMatch(src, /gh workflow/);
  assert.doesNotMatch(src, /\b179\b/);
  assert.match(src, /BEGIN READ ONLY/);
  assert.match(src, /ROLLBACK/);
  assert.match(src, /COMMIT/);
  assert.match(src, /INSERT INTO _migrations \(name\) VALUES \(\$1\)/);
  assert.match(src, /AETHER_DATABASE_OWNER_URL: \$\{ownerUrl \? "PRESENT" : "ABSENT"\}/);
  assert.match(src, /REQUIRED_LEDGER is the frozen pre-apply pin/);
  assert.doesNotMatch(src, /select[^;]*amount_minor/i);
  assert.doesNotMatch(sql0027, /\b179\b/);
});

test("controller script is syntactically valid", async () => {
  await execFileAsync("node", ["--check", join(here, "cp26co42-0027-production-migrate.mjs")]);
});

test("direct invocation without the owner secret exits before connecting", async () => {
  let threw = null;
  try {
    await execFileAsync("node", [join(here, "cp26co42-0027-production-migrate.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH,
        CP26CO42_CONFIRMATION: "APPLY-0027",
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
