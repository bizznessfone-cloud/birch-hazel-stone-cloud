#!/usr/bin/env node
/**
 * CP26C-O4.2 — single-use production controller for 0027 only.
 *
 * Applies migrations/0027_cp26co41_organisation_property_licence.sql and nothing else.
 * Never uses DATABASE_URL. Never prints secrets. Never calls Stripe.
 * Does not invoke the generic production migrator.
 * Does not create organisations, members, billing rows, allocations, prices, or mappings.
 * Does not attach hotels. Does not write hotels.status. Does not enable commerce.
 *
 * BUILD COMPLETE. Do not dispatch until a later authorised checkpoint.
 * REQUIRED_LEDGER is the frozen pre-apply pin (0001–0026). It must not follow Gate B.
 * Re-running against an already-applied valid 0027 contract must not mutate.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";
import {
  ACCEPTED_LEDGER,
  AUTHORISED_PENDING,
  BLOCKED_OWNER_URL,
  EXPECTED_DATABASE,
  EXPECTED_OWNER,
  EXPECTED_RUNTIME,
  REVIEWED_DIGESTS as PRIOR_REVIEWED_DIGESTS,
  redact,
} from "./production-db-preflight.mjs";
import {
  AUTH_TABLES,
  OCCUPANCY,
  hotelSnapshotKey,
  roleIsSafe,
  evaluateOwnerIdentity,
} from "./cp26a2-0023-production-migrate.mjs";
import {
  EXPECTED_APPLY_ARG_NAMES,
  EXPECTED_APPLY_ARG_TYPES,
  EXPECTED_APPLY_NARGS,
  EXPECTED_APPLY_RETURN_TYPE,
  billingSnapshotKey,
  classifyBillingApplyFunction,
  orderedBillingApplyContractFailures,
} from "./cp26b2-0024-production-migrate.mjs";
import {
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  ownerInstalledContractFailures,
  verifyHotelKey,
} from "./cp26co2a-0025-production-migrate.mjs";
import {
  catalogueFunctionContractFailures,
  catalogueInstalledContractFailures,
  inspect0026State,
} from "./cp26co32a-0026-production-migrate.mjs";

export {
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  EXPECTED_DATABASE,
  EXPECTED_OWNER,
  EXPECTED_RUNTIME,
  ACCEPTED_LEDGER,
  AUTHORISED_PENDING,
  EXPECTED_APPLY_NARGS,
  EXPECTED_APPLY_ARG_TYPES,
  EXPECTED_APPLY_ARG_NAMES,
  EXPECTED_APPLY_RETURN_TYPE,
};

export const TARGET_MIGRATION = "0027_cp26co41_organisation_property_licence.sql";
export const TARGET_DIGEST =
  "1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef";
export const REQUIRED_CONFIRMATION = "APPLY-0027";
/** Frozen pre-apply ledger. Do not replace this with ACCEPTED_LEDGER. */
export const REQUIRED_LEDGER = [
  "0001_auth.sql",
  "0002_foundation.sql",
  "0003_occupancy.sql",
  "0004_ops_auth.sql",
  "0005_time_domain.sql",
  "0006_booking_engine.sql",
  "0007_inventory.sql",
  "0008_guest_ux.sql",
  "0009_ops_desk.sql",
  "0010_hotel_white_label.sql",
  "0011_production_hardening.sql",
  "0012_cp12_tenancy.sql",
  "0013_cp12b_runtime_login.sql",
  "0014_cp13a_production_app_role.sql",
  "0015_cp14_hotel_configuration.sql",
  "0016_cp14_hotel_timezone.sql",
  "0017_cp16_runtime_privilege_hardening.sql",
  "0018_cp22_saas_onboarding.sql",
  "0019_cp23_public_hotel_slug.sql",
  "0020_cp24_stripe_billing.sql",
  "0021_cp25_hotel_guest_payments.sql",
  "0022_cp25g3_better_auth_runtime_privileges.sql",
  "0023_cp26a2_entitlement_publication_decoupling.sql",
  "0024_cp26b2_ordered_billing_events.sql",
  "0025_cp26co2_platform_owners.sql",
  "0026_cp26co3_commercial_catalogue.sql",
];

export const REVIEWED_DIGESTS = {
  ...PRIOR_REVIEWED_DIGESTS,
  [TARGET_MIGRATION]: TARGET_DIGEST,
};

export const ORG_TABLES = [
  "sbg_organisations",
  "sbg_organisation_members",
  "sbg_organisation_billing",
  "sbg_property_licence_allocations",
];

export const LICENCE_BALANCE_VIEW = "sbg_organisation_licence_balance";

export const REQUIRED_CONSTRAINTS = [
  "sbg_organisations_pkey",
  "sbg_organisations_name_present",
  "sbg_organisations_created_by_user_id_fkey",
  "sbg_organisation_members_pkey",
  "sbg_organisation_members_role_token",
  "sbg_organisation_members_organisation_id_fkey",
  "sbg_organisation_members_user_id_fkey",
  "hotels_organisation_id_fkey",
  "sbg_organisation_billing_pkey",
  "sbg_organisation_billing_organisation_id_fkey",
  "sbg_organisation_billing_price_version_id_fkey",
  "sbg_organisation_billing_status_check",
  "sbg_organisation_billing_interval_v1",
  "sbg_organisation_billing_quantity_nonnegative",
  "sbg_organisation_billing_ordering_pair_check",
  "sbg_property_licence_allocations_pkey",
  "sbg_property_licence_allocations_organisation_id_fkey",
  "sbg_property_licence_allocations_hotel_id_fkey",
  "sbg_property_licence_allocations_allocated_by_user_id_fkey",
  "sbg_property_licence_allocations_released_by_user_id_fkey",
  "sbg_stripe_events_organisation_id_fkey",
  "sbg_stripe_events_identity_exclusive",
];

export const REQUIRED_INDEXES = [
  {
    name: "sbg_organisation_members_active_uidx",
    unique: true,
    predicate: /removed_at is null/i,
  },
  {
    name: "sbg_organisation_members_user_active_idx",
    unique: false,
    predicate: /removed_at is null/i,
  },
  {
    name: "hotels_organisation_id_idx",
    unique: false,
    predicate: /organisation_id is not null/i,
  },
  {
    name: "sbg_organisation_billing_customer_uidx",
    unique: true,
    predicate: /stripe_customer_id is not null/i,
  },
  {
    name: "sbg_organisation_billing_subscription_uidx",
    unique: true,
    predicate: /stripe_subscription_id is not null/i,
  },
  {
    name: "sbg_property_licence_one_active_idx",
    unique: true,
    predicate: /released_at is null/i,
  },
  {
    name: "sbg_property_licence_org_active_idx",
    unique: false,
    predicate: /released_at is null/i,
  },
];

export const REQUIRED_TRIGGERS = [
  {
    name: "sbg_organisations_no_delete",
    table: "sbg_organisations",
    fn: "sbg_organisation_reject_delete",
    bits: ["BEFORE", "DELETE", "FOR EACH ROW"],
  },
  {
    name: "sbg_organisations_no_truncate",
    table: "sbg_organisations",
    fn: "sbg_organisation_reject_delete",
    bits: ["BEFORE", "TRUNCATE", "FOR EACH STATEMENT"],
  },
  {
    name: "sbg_organisation_members_no_delete",
    table: "sbg_organisation_members",
    fn: "sbg_organisation_reject_delete",
    bits: ["BEFORE", "DELETE", "FOR EACH ROW"],
  },
  {
    name: "sbg_organisation_members_no_truncate",
    table: "sbg_organisation_members",
    fn: "sbg_organisation_reject_delete",
    bits: ["BEFORE", "TRUNCATE", "FOR EACH STATEMENT"],
  },
  {
    name: "sbg_organisation_billing_no_delete",
    table: "sbg_organisation_billing",
    fn: "sbg_organisation_reject_delete",
    bits: ["BEFORE", "DELETE", "FOR EACH ROW"],
  },
  {
    name: "sbg_organisation_billing_no_truncate",
    table: "sbg_organisation_billing",
    fn: "sbg_organisation_reject_delete",
    bits: ["BEFORE", "TRUNCATE", "FOR EACH STATEMENT"],
  },
  {
    name: "sbg_property_licence_no_delete",
    table: "sbg_property_licence_allocations",
    fn: "sbg_organisation_reject_delete",
    bits: ["BEFORE", "DELETE", "FOR EACH ROW"],
  },
  {
    name: "sbg_property_licence_no_truncate",
    table: "sbg_property_licence_allocations",
    fn: "sbg_organisation_reject_delete",
    bits: ["BEFORE", "TRUNCATE", "FOR EACH STATEMENT"],
  },
  {
    name: "sbg_property_licence_allocation_guard",
    table: "sbg_property_licence_allocations",
    fn: "sbg_property_licence_allocation_guard",
    bits: ["BEFORE", "INSERT", "UPDATE", "FOR EACH ROW"],
  },
  {
    name: "sbg_organisation_billing_stripe_identity",
    table: "sbg_organisation_billing",
    fn: "sbg_reject_cross_aggregate_stripe_identity",
    bits: ["BEFORE", "INSERT", "UPDATE", "FOR EACH ROW"],
    columns: ["stripe_customer_id", "stripe_subscription_id"],
  },
  {
    name: "sbg_billing_accounts_stripe_identity",
    table: "sbg_billing_accounts",
    fn: "sbg_reject_cross_aggregate_stripe_identity",
    bits: ["BEFORE", "INSERT", "UPDATE", "FOR EACH ROW"],
    columns: ["stripe_customer_id", "stripe_subscription_id"],
  },
];

const SEARCH_PATH = "public, pg_temp";

export const EXPECTED_FUNCTIONS = [
  {
    name: "sbg_organisation_reject_delete",
    nargs: 0,
    argTypes: [],
    argNames: [],
    returnType: "trigger",
    securityDefiner: false,
    searchPath: SEARCH_PATH,
    executeAetherApp: false,
    bodyIncludes: "organisation commercial history cannot be deleted",
  },
  {
    name: "sbg_organisation_member_billing",
    nargs: 2,
    argTypes: ["text", "uuid"],
    argNames: ["p_user_id", "p_organisation_id"],
    returnType: "boolean",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: false,
    bodyIncludes: "billing_authority",
  },
  {
    name: "sbg_reject_cross_aggregate_stripe_identity",
    nargs: 0,
    argTypes: [],
    argNames: [],
    returnType: "trigger",
    securityDefiner: false,
    searchPath: SEARCH_PATH,
    executeAetherApp: false,
    bodyIncludes: "stripe customer already belongs to an organisation",
    snippets: [
      "stripe customer already belongs to a hotel billing account",
      "stripe customer already belongs to an organisation",
      "stripe subscription already belongs to a hotel billing account",
      "stripe subscription already belongs to an organisation",
    ],
  },
  {
    name: "sbg_property_licence_allocation_guard",
    nargs: 0,
    argTypes: [],
    argNames: [],
    returnType: "trigger",
    securityDefiner: false,
    searchPath: SEARCH_PATH,
    executeAetherApp: false,
    bodyIncludes: "no available property licence",
    snippets: ["property is not attached to this organisation", "no available property licence"],
  },
  {
    name: "sbg_create_organisation_for_user",
    nargs: 2,
    argTypes: ["text", "text"],
    argNames: ["p_user_id", "p_name"],
    returnType: "uuid",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: "invalid organisation name",
  },
  {
    name: "sbg_add_organisation_member",
    nargs: 5,
    argTypes: ["text", "uuid", "text", "text", "boolean"],
    argNames: ["p_actor_user_id", "p_organisation_id", "p_user_id", "p_role", "p_billing_authority"],
    returnType: "uuid",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: "invalid organisation membership",
  },
  {
    name: "sbg_remove_organisation_member",
    nargs: 3,
    argTypes: ["text", "uuid", "text"],
    argNames: ["p_actor_user_id", "p_organisation_id", "p_user_id"],
    returnType: "void",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: "last organisation billing member",
  },
  {
    name: "sbg_attach_hotel_to_organisation",
    nargs: 3,
    argTypes: ["text", "uuid", "uuid"],
    argNames: ["p_actor_user_id", "p_organisation_id", "p_hotel_id"],
    returnType: "void",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: "hotel is already attached",
  },
  {
    name: "sbg_allocate_property_licence",
    nargs: 3,
    argTypes: ["text", "uuid", "uuid"],
    argNames: ["p_actor_user_id", "p_organisation_id", "p_hotel_id"],
    returnType: "uuid",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: "allocation changed hotel publication",
  },
  {
    name: "sbg_release_property_licence",
    nargs: 2,
    argTypes: ["text", "uuid"],
    argNames: ["p_actor_user_id", "p_allocation_id"],
    returnType: "void",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: "licence allocation already released",
  },
  {
    name: "sbg_apply_organisation_billing_event",
    nargs: 13,
    argTypes: [
      "text",
      "text",
      "bigint",
      "uuid",
      "text",
      "text",
      "text",
      "text",
      "timestamp with time zone",
      "boolean",
      "integer",
      "text",
      "uuid",
    ],
    argNames: [
      "p_event_id",
      "p_event_type",
      "p_event_created",
      "p_organisation_id",
      "p_customer_id",
      "p_subscription_id",
      "p_price_id",
      "p_status",
      "p_current_period_end",
      "p_cancel_at_period_end",
      "p_licensed_quantity",
      "p_billing_interval",
      "p_price_version_id",
    ],
    returnType: "text",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: "on conflict (organisation_id) do update",
  },
];

export const ORG_FUNCTION_NAMES = EXPECTED_FUNCTIONS.map((fn) => fn.name);

export const AUTHORISED = "GATE PASS — 0027 AUTHORISED";
export const ALREADY_APPLIED = "0027 ALREADY APPLIED — NO MUTATION";
export const APPLIED_VERIFIED = "GATE PASS — 0027 APPLIED AND VERIFIED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const DIGEST_BLOCKED = "BLOCKED — 0027 DIGEST MISMATCH";
export const REVIEWED_DIGEST_BLOCKED = "BLOCKED — REVIEWED MIGRATION DIGEST MISMATCH";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const APPLY_FAILED = "BLOCKED — 0027 APPLICATION FAILED";
export const UNAUTHORISED_MIGRATION = "BLOCKED — UNAUTHORISED MIGRATION";
export const PARTIAL_BLOCKED = "BLOCKED — 0027 PARTIAL / LEDGER SPLIT";
export const ROLE_BLOCKED = "BLOCKED — AETHER_APP ROLE ESCALATED";
export const ACTIVE_OWNER_BLOCKED = "BLOCKED — ACTIVE OWNER COUNT INVALID";
export const OWNER_CONTRACT_BLOCKED = "BLOCKED — 0025 OWNER CONTRACT INVALID";
export const CATALOGUE_CONTRACT_BLOCKED = "BLOCKED — 0026 CATALOGUE CONTRACT INVALID";
export const HOTEL_APPLY_BLOCKED = "BLOCKED — HOTEL BILLING APPLY CONTRACT INVALID";
export const DOMAIN_B_BLOCKED = "BLOCKED — DOMAIN B INVARIANT NOT PROVEN";

const ALLOWED_LEDGER = new Set([...REQUIRED_LEDGER, TARGET_MIGRATION]);
const VIEW_DERIVED =
  /licensed_quantity,\s*0\)\s*-\s*coalesce\([\s\S]{0,80}active_allocations/i;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertConfirmation(value) {
  if (String(value ?? "") !== REQUIRED_CONFIRMATION) {
    return { ok: false, verdict: CONFIRM_BLOCKED, migrated: false };
  }
  return { ok: true };
}

export function assertMigrationFile(file) {
  const name = String(file?.name ?? "");
  const digest = String(file?.digest ?? sha256(Buffer.from(file?.bytes ?? file?.text ?? "")));
  if (name !== TARGET_MIGRATION) {
    return { ok: false, verdict: UNAUTHORISED_MIGRATION, migrated: false, name };
  }
  if (digest !== TARGET_DIGEST) {
    return { ok: false, verdict: DIGEST_BLOCKED, migrated: false, digest };
  }
  return { ok: true, name, digest };
}

export function assertAuthorisedMigrationName(name) {
  if (name !== TARGET_MIGRATION) {
    return { ok: false, verdict: UNAUTHORISED_MIGRATION, migrated: false, name };
  }
  return { ok: true, name };
}

export function assertReviewedChecksums(checksums) {
  for (const [name, expected] of Object.entries(REVIEWED_DIGESTS)) {
    const actual = String(checksums?.[name] ?? "");
    if (actual !== expected) {
      return {
        ok: false,
        verdict: name === TARGET_MIGRATION ? DIGEST_BLOCKED : REVIEWED_DIGEST_BLOCKED,
        name,
        digest: actual,
        expected,
        migrated: false,
      };
    }
  }
  return { ok: true };
}

export function ownerUrlFromEnv(env) {
  return String(env?.AETHER_DATABASE_OWNER_URL ?? "").trim();
}

export function normalizePgType(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^pg_catalog\./, "");
  if (raw === "timestamptz") return "timestamp with time zone";
  if (raw === "bool") return "boolean";
  if (raw === "int4") return "integer";
  if (raw === "int2") return "smallint";
  if (raw === "int8") return "bigint";
  return raw;
}

export function normalizeSearchPath(value) {
  return String(value ?? "")
    .replace(/^search_path=/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sameList(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function blocked(verdict, extra = {}) {
  return { ok: false, verdict, migrated: false, ...extra };
}

function hotelMatches(hotel) {
  return Boolean(
    hotel &&
      hotel.code === "demo-kos" &&
      hotel.status === "live" &&
      Number(hotel.providerCount) === 1 &&
      Number(hotel.destinationCount) === 4,
  );
}

function occupancyIntact(occupancy) {
  const names = new Set((occupancy ?? []).map((row) => row.name));
  return (
    OCCUPANCY.every((name) => names.has(name)) &&
    (occupancy ?? []).every((row) => /EXCLUDE/i.test(String(row.definition ?? "")))
  );
}

function authPresent(tables) {
  return AUTH_TABLES.every((name) => tables?.[name] === "PRESENT");
}

function authOwnersAreOwner(owners) {
  return AUTH_TABLES.every((name) => owners?.[name] === EXPECTED_OWNER);
}

function verifyConfigured(hotel) {
  return Boolean(hotel && hotel.code === "sbg-verify-a5" && hotel.status === "configured");
}

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

function emptyView() {
  return {
    present: false,
    relkind: null,
    owner: null,
    definition: "",
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

function emptyColumn() {
  return { present: false, dataType: null, nullable: null };
}

function emptyCounts() {
  return {
    organisations: 0,
    members: 0,
    billing: 0,
    allocations: 0,
    attachedHotels: 0,
    propertyLicencePlans: 0,
  };
}

export function absentOrganisation() {
  return {
    tables: Object.fromEntries(ORG_TABLES.map((name) => [name, emptyTable()])),
    view: emptyView(),
    functions: Object.fromEntries(ORG_FUNCTION_NAMES.map((name) => [name, emptyFn()])),
    constraints: [],
    indexes: {},
    triggers: {},
    columns: {
      hotelsOrganisationId: emptyColumn(),
      stripeEventsOrganisationId: emptyColumn(),
    },
    counts: emptyCounts(),
  };
}

function tableState(schema, name) {
  return schema?.tables?.[name] ?? emptyTable();
}

function functionState(schema, name) {
  return schema?.functions?.[name] ?? emptyFn();
}

export function organisationPresentNames(schema) {
  const present = [];
  for (const name of ORG_TABLES) {
    if (tableState(schema, name).present) present.push(name);
  }
  for (const name of ORG_FUNCTION_NAMES) {
    if (Number(functionState(schema, name).count ?? 0) > 0) present.push(name);
  }
  if (schema?.view?.present) present.push(LICENCE_BALANCE_VIEW);
  if (schema?.columns?.hotelsOrganisationId?.present) present.push("hotels.organisation_id");
  if (schema?.columns?.stripeEventsOrganisationId?.present) present.push("sbg_stripe_events.organisation_id");
  const counts = schema?.counts ?? {};
  if (Number(counts.organisations ?? 0) > 0) present.push("organisation-rows");
  if (Number(counts.members ?? 0) > 0) present.push("member-rows");
  if (Number(counts.billing ?? 0) > 0) present.push("billing-rows");
  if (Number(counts.allocations ?? 0) > 0) present.push("allocation-rows");
  if (Number(counts.attachedHotels ?? 0) > 0) present.push("attached-hotels");
  if (Number(counts.propertyLicencePlans ?? 0) > 0) present.push("property-licence-plan");
  return present;
}

function privilegeFailures(relation, name) {
  const failures = [];
  if (relation?.selectApp !== true) failures.push(`${name}-select`);
  if (relation?.insertApp !== false) failures.push(`${name}-insert`);
  if (relation?.updateApp !== false) failures.push(`${name}-update`);
  if (relation?.deleteApp !== false) failures.push(`${name}-delete`);
  if (relation?.truncateApp !== false) failures.push(`${name}-truncate`);
  if (relation?.selectPublic !== false) failures.push(`${name}-public-select`);
  if (relation?.insertPublic !== false) failures.push(`${name}-public-insert`);
  if (relation?.updatePublic !== false) failures.push(`${name}-public-update`);
  if (relation?.deletePublic !== false) failures.push(`${name}-public-delete`);
  if (relation?.truncatePublic !== false) failures.push(`${name}-public-truncate`);
  return failures;
}

function tableContractFailures(table, name) {
  const failures = [];
  if (table?.present !== true) failures.push(`${name}-missing`);
  if (String(table?.owner ?? "") !== EXPECTED_OWNER) failures.push(`${name}-owner`);
  failures.push(...privilegeFailures(table, name));
  return failures;
}

function columnFailures(column, name) {
  const failures = [];
  if (column?.present !== true) failures.push(`${name}-missing`);
  if (column?.nullable !== true) failures.push(`${name}-nullable`);
  if (normalizePgType(column?.dataType) !== "uuid") failures.push(`${name}-type`);
  return failures;
}

export function licenceBalanceViewFailures(view) {
  const failures = [];
  if (view?.present !== true || view?.relkind !== "v") failures.push("view-missing");
  if (view?.relkind === "r") failures.push("view-stored-balance");
  if (String(view?.owner ?? "") !== EXPECTED_OWNER) failures.push("view-owner");
  const definition = String(view?.definition ?? "");
  if (!VIEW_DERIVED.test(definition)) failures.push("view-derived");
  if (!/available_licences/i.test(definition)) failures.push("view-available");
  failures.push(...privilegeFailures(view, "view"));
  return failures;
}

function indexFailures(indexes) {
  const failures = [];
  for (const expected of REQUIRED_INDEXES) {
    const index = indexes?.[expected.name];
    if (!index?.present) {
      failures.push(`index-${expected.name}`);
      continue;
    }
    if (Boolean(index.unique) !== expected.unique) failures.push(`index-unique-${expected.name}`);
    const predicate = `${index.predicate ?? ""} ${index.def ?? ""}`.trim();
    if (expected.predicate) {
      if (!expected.predicate.test(predicate)) failures.push(`index-predicate-${expected.name}`);
    } else if (String(index.predicate ?? "").trim() !== "") {
      failures.push(`index-predicate-${expected.name}`);
    }
  }
  return failures;
}

function triggerFailures(triggers) {
  const failures = [];
  for (const expected of REQUIRED_TRIGGERS) {
    const trigger = triggers?.[expected.name];
    const def = String(trigger?.def ?? "");
    if (!trigger?.present || !def) {
      failures.push(`trigger-${expected.name}`);
      continue;
    }
    if (String(trigger.table ?? "") !== expected.table) failures.push(`trigger-table-${expected.name}`);
    if (String(trigger.fn ?? "") !== expected.fn) failures.push(`trigger-fn-${expected.name}`);
    const upper = def.toUpperCase();
    for (const bit of expected.bits) {
      if (!upper.includes(bit)) failures.push(`trigger-def-${expected.name}`);
    }
    if (!/EXECUTE\s+(FUNCTION|PROCEDURE)/i.test(def)) failures.push(`trigger-execute-${expected.name}`);
    for (const column of expected.columns ?? []) {
      if (!def.toLowerCase().includes(column)) failures.push(`trigger-column-${expected.name}`);
    }
  }
  return failures;
}

export function organisationInstalledContractFailures(facts) {
  const failures = [];
  const schema = facts?.organisation ?? {};
  for (const name of ORG_TABLES) {
    failures.push(...tableContractFailures(tableState(schema, name), name));
  }
  failures.push(...licenceBalanceViewFailures(schema.view));
  for (const expected of EXPECTED_FUNCTIONS) {
    failures.push(...catalogueFunctionContractFailures(functionState(schema, expected.name), expected));
    for (const snippet of expected.snippets ?? []) {
      if (!String(functionState(schema, expected.name).definition ?? "").includes(snippet)) {
        failures.push(`${expected.name}-snippet`);
      }
    }
  }
  const constraints = new Set((schema.constraints ?? []).map(String));
  for (const name of REQUIRED_CONSTRAINTS) {
    if (!constraints.has(name)) failures.push(`constraint-${name}`);
  }
  failures.push(...indexFailures(schema.indexes));
  failures.push(...triggerFailures(schema.triggers));
  failures.push(...columnFailures(schema.columns?.hotelsOrganisationId, "hotels-organisation-id"));
  failures.push(
    ...columnFailures(schema.columns?.stripeEventsOrganisationId, "stripe-events-organisation-id"),
  );
  return failures;
}

export function freshApplyZeroRowFailures(schema) {
  const counts = schema?.counts ?? {};
  const failures = [];
  if (Number(counts.organisations ?? -1) !== 0) failures.push("organisation-count");
  if (Number(counts.members ?? -1) !== 0) failures.push("member-count");
  if (Number(counts.billing ?? -1) !== 0) failures.push("billing-count");
  if (Number(counts.allocations ?? -1) !== 0) failures.push("allocation-count");
  if (Number(counts.attachedHotels ?? -1) !== 0) failures.push("attached-hotels");
  if (Number(counts.propertyLicencePlans ?? -1) !== 0) failures.push("property-licence-plan");
  return failures;
}

export function hotelApplyContractFailures(facts) {
  const failures = orderedBillingApplyContractFailures(facts);
  if (classifyBillingApplyFunction(facts?.functionDefinition) !== "ordered") {
    failures.push("hotel-apply-kind");
  }
  const definition = String(facts?.functionDefinition ?? "");
  if (/p_organisation_id/i.test(definition) && /function sbg_apply_billing_event/i.test(definition)) {
    failures.push("hotel-apply-replaced");
  }
  if (/p_licensed_quantity/i.test(definition) && /function sbg_apply_billing_event/i.test(definition)) {
    failures.push("hotel-apply-replaced");
  }
  return failures;
}

export function domainSnapshotKey(domain) {
  return JSON.stringify({
    paymentFunctionPresent: domain?.paymentFunctionPresent === true,
    bookingPaymentCount: Number(domain?.bookingPaymentCount ?? -1),
    hotelAccountCount: Number(domain?.hotelAccountCount ?? -1),
  });
}

function domainContractFailures(facts) {
  if (facts?.domain?.paymentFunctionPresent !== true) return ["domain-b-payment-fn"];
  return [];
}

function snapshotOf(facts) {
  return {
    hotelSnapshot: facts?.hotelSnapshot ?? null,
    billingSnapshot: facts?.billingSnapshot ?? null,
    verifyHotel: facts?.verifyHotel ?? null,
    activeOwnerCount: Number(facts?.activeOwnerCount ?? -1),
    auditCount: Number(facts?.ownerSchema?.auditCount ?? -1),
    domain: facts?.domain ?? null,
  };
}

function environmentFailures(facts) {
  const failures = [];
  const identity = evaluateOwnerIdentity(facts);
  if (!identity.ok) failures.push(identity.verdict);
  if (!facts?.ledgerReadable) failures.push("ledger-unreadable");
  if (!facts?.aetherAppExists) failures.push("aether-app-missing");
  if (!roleIsSafe(facts?.aetherAppRole)) failures.push("role-escalation");
  if (!authPresent(facts?.authTables)) failures.push("auth-tables");
  if (!authOwnersAreOwner(facts?.authTableOwners)) failures.push("auth-owners");
  if (facts?.schemaCreate === true) failures.push("schema-create");
  if (!occupancyIntact(facts?.occupancy)) failures.push("occupancy");
  if (!hotelMatches(facts?.hotel)) failures.push("demo-kos");
  if (facts?.hotelSnapshot?.demoKos?.code !== "demo-kos" || facts?.hotelSnapshot?.demoKos?.status !== "live") {
    failures.push("demo-kos");
  }
  if (String(facts?.tableOwners?.hotels ?? "") !== EXPECTED_OWNER) failures.push("hotels-owner");
  if (!verifyConfigured(facts?.verifyHotel)) failures.push("verify-hotel");
  if (Number(facts?.activeOwnerCount ?? -1) !== 1) failures.push("active-owners");
  return [...new Set(failures)];
}

function environmentVerdict(failures) {
  if (failures.includes(IDENTITY_BLOCKED)) return IDENTITY_BLOCKED;
  if (failures.includes(OWNER_BLOCKED)) return OWNER_BLOCKED;
  if (failures.includes("role-escalation")) return ROLE_BLOCKED;
  if (failures.includes("active-owners")) return ACTIVE_OWNER_BLOCKED;
  if (failures.includes("verify-hotel")) return "BLOCKED — VERIFY HOTEL INVARIANT NOT PROVEN";
  if (failures.includes("demo-kos")) return "BLOCKED — DEMO-KOS INVARIANT NOT PROVEN";
  if (failures.includes("ledger-unreadable")) return "BLOCKED — PRODUCTION MIGRATION LEDGER CANNOT BE READ";
  if (failures.includes("aether-app-missing")) return "BLOCKED — AETHER_APP ROLE MISSING";
  if (failures.includes("auth-tables")) return "BLOCKED — AUTH TABLES MISSING";
  if (failures.includes("auth-owners")) return "BLOCKED — AUTH TABLE OWNERSHIP INVALID";
  if (failures.includes("schema-create")) return "BLOCKED — SCHEMA CREATE GRANTED";
  if (failures.includes("occupancy")) return "BLOCKED — OCCUPANCY INVARIANT NOT PROVEN";
  if (failures.includes("hotels-owner")) return "BLOCKED — HOTELS OWNERSHIP INVALID";
  return "BLOCKED — PRODUCTION BASELINE FAILED";
}

function installedStackFailures(facts) {
  return [
    ...ownerInstalledContractFailures(facts),
    ...catalogueInstalledContractFailures(facts),
    ...organisationInstalledContractFailures(facts),
    ...hotelApplyContractFailures(facts),
    ...domainContractFailures(facts),
  ];
}

export function evaluate0027Baseline(facts, file) {
  const confirm = assertConfirmation(facts?.confirmation);
  if (!confirm.ok) return confirm;
  if (!ownerUrlFromEnv(facts?.env ?? { AETHER_DATABASE_OWNER_URL: facts?.ownerUrl })) {
    return blocked(BLOCKED_OWNER_URL);
  }
  const fileGate = assertMigrationFile(file);
  if (!fileGate.ok) return fileGate;
  const environment = environmentFailures(facts);
  if (environment.length) return blocked(environmentVerdict(environment), { failures: environment });

  const ledger = [...(facts?.ledger ?? [])].map(String);
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  const unexpectedApplied = ledger.filter((name) => !ALLOWED_LEDGER.has(name));
  const present = organisationPresentNames(facts?.organisation);
  const missingHistorical = REQUIRED_LEDGER.filter((name) => !ledger.includes(name));

  if (appliedCount > 1 || unexpectedApplied.length) {
    return blocked(PARTIAL_BLOCKED, { pending, appliedCount, unexpectedApplied, present });
  }
  if (appliedCount === 1) {
    if (pending.length) return blocked(UNEXPECTED_PLAN, { pending, alreadyApplied: true });
    const contract = installedStackFailures(facts);
    if (contract.length || missingHistorical.length) {
      return blocked(PARTIAL_BLOCKED, { pending: [], failures: contract, missingHistorical });
    }
    return {
      ok: true,
      alreadyApplied: true,
      verdict: ALREADY_APPLIED,
      pending: [],
      migrated: false,
    };
  }
  if (present.length) return blocked(PARTIAL_BLOCKED, { pending, present });
  if (missingHistorical.length) {
    return blocked("BLOCKED — MISSING HISTORICAL MIGRATION", { missingHistorical });
  }
  const ownerContract = ownerInstalledContractFailures(facts);
  if (ownerContract.length) return blocked(OWNER_CONTRACT_BLOCKED, { failures: ownerContract });
  const catalogueContract = catalogueInstalledContractFailures(facts);
  if (catalogueContract.length) return blocked(CATALOGUE_CONTRACT_BLOCKED, { failures: catalogueContract });
  const hotelApply = hotelApplyContractFailures(facts);
  if (hotelApply.length) return blocked(HOTEL_APPLY_BLOCKED, { failures: hotelApply });
  const domain = domainContractFailures(facts);
  if (domain.length) return blocked(DOMAIN_B_BLOCKED, { failures: domain });
  if (sameList(pending, [TARGET_MIGRATION])) {
    return {
      ok: true,
      authorised: true,
      alreadyApplied: false,
      verdict: AUTHORISED,
      pending,
      migrated: false,
      snapshot: snapshotOf(facts),
    };
  }
  return blocked(UNEXPECTED_PLAN, { pending });
}

export function evaluate0027Aftermath(facts, before) {
  const failures = [];
  for (const name of environmentFailures(facts)) {
    if (!failures.includes(name)) failures.push(name);
  }
  const ledger = [...(facts?.ledger ?? [])].map(String);
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  if (appliedCount !== 1) failures.push("0027-ledger");
  if (ledger.some((name) => !ALLOWED_LEDGER.has(name))) failures.push("unexpected-ledger");
  if (pending.length > 0) failures.push("pending-remain");
  for (const failure of installedStackFailures(facts)) {
    if (!failures.includes(failure)) failures.push(failure);
  }
  for (const failure of freshApplyZeroRowFailures(facts?.organisation)) {
    if (!failures.includes(failure)) failures.push(failure);
  }
  if (hotelSnapshotKey(facts?.hotelSnapshot) !== hotelSnapshotKey(before?.hotelSnapshot)) {
    failures.push("hotel-invariance");
  }
  if (billingSnapshotKey(facts?.billingSnapshot) !== billingSnapshotKey(before?.billingSnapshot)) {
    failures.push("billing-invariance");
  }
  if (verifyHotelKey(facts?.verifyHotel) !== verifyHotelKey(before?.verifyHotel)) {
    failures.push("verify-hotel-invariance");
  }
  if (Number(facts?.activeOwnerCount ?? -1) !== 1) failures.push("active-owners");
  if (Number(facts?.activeOwnerCount ?? -1) !== Number(before?.activeOwnerCount ?? -2)) {
    failures.push("owner-invariance");
  }
  const auditCount = Number(facts?.ownerSchema?.auditCount ?? -1);
  if (auditCount !== Number(before?.auditCount ?? -2)) failures.push("audit-delta");
  if (domainSnapshotKey(facts?.domain) !== domainSnapshotKey(before?.domain)) {
    failures.push("domain-b-invariance");
  }
  if (failures.length) {
    return { ok: false, verdict: POST_BLOCKED, failures, pending, migrated: false, committed: false };
  }
  return { ok: true, verdict: APPLIED_VERIFIED, pending: [], migrated: true, committed: true };
}

export async function applyExact0027({ name, sql, execute }) {
  const gate = assertAuthorisedMigrationName(name);
  if (!gate.ok) {
    const err = new Error(gate.verdict);
    err.verdict = gate.verdict;
    throw err;
  }
  if (sha256(Buffer.from(String(sql ?? ""))) !== TARGET_DIGEST) {
    const err = new Error(DIGEST_BLOCKED);
    err.verdict = DIGEST_BLOCKED;
    throw err;
  }
  if (typeof execute !== "function") {
    throw new Error("BLOCKED — 0027 EXECUTOR MISSING");
  }
  return execute(sql);
}

export async function apply0027Transaction({ sql, before, query, inspect }) {
  if (typeof query !== "function" || typeof inspect !== "function") {
    throw new Error("BLOCKED — 0027 EXECUTOR MISSING");
  }
  if (sha256(Buffer.from(String(sql ?? ""))) !== TARGET_DIGEST) {
    const err = new Error(DIGEST_BLOCKED);
    err.verdict = DIGEST_BLOCKED;
    throw err;
  }
  let began = false;
  try {
    await query("BEGIN");
    began = true;
    await query(sql);
    await query("INSERT INTO _migrations (name) VALUES ($1)", [TARGET_MIGRATION]);
    const after = await inspect();
    const aftermath = evaluate0027Aftermath(after, before);
    if (!aftermath.ok) {
      await query("ROLLBACK");
      began = false;
      return { ...aftermath, committed: false, migrated: false, postflight: after };
    }
    await query("COMMIT");
    began = false;
    return { ...aftermath, committed: true, migrated: true, postflight: after };
  } catch (err) {
    if (began) {
      try {
        await query("ROLLBACK");
      } catch {
        // keep original error
      }
    }
    throw err;
  }
}

export async function runSingleUse0027({
  env,
  confirmation,
  file,
  sourceChecksums,
  loadFacts,
  mutate,
}) {
  const ownerUrl = ownerUrlFromEnv(env);
  const confirm = assertConfirmation(confirmation);
  if (!confirm.ok) return confirm;
  if (!ownerUrl) return blocked(BLOCKED_OWNER_URL);
  const fileGate = assertMigrationFile(file);
  if (!fileGate.ok) return fileGate;
  if (sourceChecksums) {
    const checksums = assertReviewedChecksums(sourceChecksums);
    if (!checksums.ok) return checksums;
  }

  const before = await loadFacts();
  const baseline = evaluate0027Baseline({ ...before, confirmation, env, ownerUrl }, file);
  if (!baseline.ok || baseline.alreadyApplied) {
    return { ...baseline, preflight: before, migrated: false };
  }

  if (typeof mutate !== "function") {
    return blocked("BLOCKED — 0027 EXECUTOR MISSING");
  }
  try {
    const applied = await mutate({
      sql: file.sql ?? file.text,
      before: baseline.snapshot ?? snapshotOf(before),
    });
    return { ...applied, preflight: before };
  } catch (err) {
    return {
      ok: false,
      verdict: err?.verdict || APPLY_FAILED,
      migrated: false,
      committed: false,
      error: redact(err?.message || err),
      preflight: before,
    };
  }
}

function say(line) {
  console.log(line);
}

function fail(verdict, extra = "") {
  say(verdict);
  if (extra) say(redact(extra));
  process.exitCode = 1;
}

function reportFacts(label, facts) {
  const counts = facts?.organisation?.counts ?? {};
  say(label);
  say(`database: ${facts?.database ?? ""}`);
  say(`current_user: ${facts?.currentUser ?? ""}`);
  say(`session_user: ${facts?.sessionUser ?? ""}`);
  say("ledger:");
  for (const name of facts?.ledger ?? []) say(`  ${name}`);
  if (!(facts?.ledger ?? []).length) say("  (empty)");
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], facts?.ledger ?? []).map(
    (row) => row.name,
  );
  say("pending:");
  for (const name of pending) say(`  ${name}`);
  if (!pending.length) say("  (none)");
  say(`organisation.present: ${organisationPresentNames(facts?.organisation).join(",") || "(none)"}`);
  say(`organisations: ${counts.organisations ?? "UNKNOWN"}`);
  say(`organisation_members: ${counts.members ?? "UNKNOWN"}`);
  say(`organisation_billing: ${counts.billing ?? "UNKNOWN"}`);
  say(`property_allocations: ${counts.allocations ?? "UNKNOWN"}`);
  say(`attached_hotels: ${counts.attachedHotels ?? "UNKNOWN"}`);
  say(`property_licence_plans: ${counts.propertyLicencePlans ?? "UNKNOWN"}`);
  say(`hotel_apply.nargs: ${facts?.functionArgCount ?? "UNKNOWN"}`);
  say(`hotel_apply.kind: ${classifyBillingApplyFunction(facts?.functionDefinition)}`);
  const codes = (facts?.catalogue?.plans ?? []).map((row) => row.code).join(",") || "(none)";
  say(`plans: ${codes}`);
  say(`price_versions: ${facts?.catalogue?.priceVersionCount ?? "UNKNOWN"}`);
  say(`stripe_mappings: ${facts?.catalogue?.mappingCount ?? "UNKNOWN"}`);
  say(
    `locks: live_mapping=${String(facts?.catalogue?.lock?.liveMappingEnabled ?? "UNKNOWN")} live_checkout=${String(facts?.catalogue?.lock?.liveCheckoutEnabled ?? "UNKNOWN")}`,
  );
  say(`active_owners: ${facts?.activeOwnerCount ?? "UNKNOWN"}`);
  say(`owner.audits: ${facts?.ownerSchema?.auditCount ?? "UNKNOWN"}`);
  say(`hotels.total: ${facts?.hotelSnapshot?.hotelCount ?? "UNKNOWN"}`);
  say(`demo-kos.status: ${facts?.hotelSnapshot?.demoKos?.status ?? "UNKNOWN"}`);
  say(`verify-a5.status: ${facts?.verifyHotel?.status ?? "ABSENT"}`);
  say(`billing.accounts: ${facts?.billingSnapshot?.accountCount ?? "UNKNOWN"}`);
  say(`stripe.events: ${facts?.billingSnapshot?.eventCount ?? "UNKNOWN"}`);
  say(`hotel_accounts: ${facts?.domain?.hotelAccountCount ?? "UNKNOWN"}`);
  say(`domain_b.payment_fn: ${facts?.domain?.paymentFunctionPresent === true ? "PRESENT" : "ABSENT"}`);
  say(`domain_b.booking_payments: ${facts?.domain?.bookingPaymentCount ?? "UNKNOWN"}`);
  say("commerce: OFF (controller does not read or set SBG_SAAS_COMMERCE)");
  say("stripe: UNTOUCHED");
}

async function privilege(client, who, regclass, priv) {
  return (
    await client.query("select has_table_privilege($1, $2::regclass, $3) as ok", [who, regclass, priv])
  ).rows[0]?.ok === true;
}

async function inspectRelation(client, name, kinds) {
  const found = (
    await client.query(
      `select c.relkind,
              r.rolname as owner,
              case when c.relkind = 'v' then pg_get_viewdef(c.oid, true) else null end as definition
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r on r.oid = c.relowner
        where n.nspname = 'public'
          and c.relkind::text = any($2::text[])
          and c.relname = $1`,
      [name, kinds],
    )
  ).rows[0];
  if (!found) return null;
  const regclass = `public.${name}`;
  return {
    present: true,
    relkind: String(found.relkind),
    owner: found.owner,
    definition: found.definition == null ? "" : String(found.definition),
    selectApp: await privilege(client, EXPECTED_RUNTIME, regclass, "SELECT"),
    insertApp: await privilege(client, EXPECTED_RUNTIME, regclass, "INSERT"),
    updateApp: await privilege(client, EXPECTED_RUNTIME, regclass, "UPDATE"),
    deleteApp: await privilege(client, EXPECTED_RUNTIME, regclass, "DELETE"),
    truncateApp: await privilege(client, EXPECTED_RUNTIME, regclass, "TRUNCATE"),
    selectPublic: await privilege(client, "public", regclass, "SELECT"),
    insertPublic: await privilege(client, "public", regclass, "INSERT"),
    updatePublic: await privilege(client, "public", regclass, "UPDATE"),
    deletePublic: await privilege(client, "public", regclass, "DELETE"),
    truncatePublic: await privilege(client, "public", regclass, "TRUNCATE"),
  };
}

async function inspectTable(client, name) {
  const found = await inspectRelation(client, name, ["r"]);
  if (!found) return emptyTable();
  return {
    present: true,
    owner: found.owner,
    selectApp: found.selectApp,
    insertApp: found.insertApp,
    updateApp: found.updateApp,
    deleteApp: found.deleteApp,
    truncateApp: found.truncateApp,
    selectPublic: found.selectPublic,
    insertPublic: found.insertPublic,
    updatePublic: found.updatePublic,
    deletePublic: found.deletePublic,
    truncatePublic: found.truncatePublic,
  };
}

async function inspectView(client, name) {
  const found = await inspectRelation(client, name, ["r", "v"]);
  if (!found) return emptyView();
  return { ...emptyView(), ...found, present: true };
}

async function inspectFunctions(client) {
  const rows = (
    await client.query(
      `select p.oid,
              p.proname as name,
              p.pronargs as nargs,
              p.proargnames as arg_names,
              p.prorettype::regtype::text as return_type,
              p.prosecdef as security_definer,
              p.proconfig as config,
              r.rolname as owner,
              pg_get_functiondef(p.oid) as definition,
              (select coalesce(array_agg(format_type(u.t, null) order by u.ord), '{}'::text[])
                 from unnest(p.proargtypes) with ordinality as u(t, ord)
              ) as arg_types
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_roles r on r.oid = p.proowner
        where n.nspname = 'public'
          and p.proname = any($1::text[])`,
      [ORG_FUNCTION_NAMES],
    )
  ).rows;

  const grouped = Object.fromEntries(ORG_FUNCTION_NAMES.map((name) => [name, emptyFn()]));
  for (const row of rows) {
    const name = String(row.name);
    const current = grouped[name];
    if (!current) continue;
    current.count += 1;
    if (current.count !== 1) continue;
    current.nargs = Number(row.nargs ?? 0);
    current.argNames = Array.isArray(row.arg_names) ? row.arg_names : [];
    current.argTypes = Array.isArray(row.arg_types) ? row.arg_types : [];
    current.returnType = row.return_type ?? "";
    current.owner = row.owner;
    current.securityDefiner = row.security_definer === true;
    const config = Array.isArray(row.config) ? row.config : [];
    const search = config.find((item) => /^search_path=/i.test(String(item ?? "")));
    current.searchPath = normalizeSearchPath(search ?? "");
    current.definition = String(row.definition ?? "");
    current.executeAetherApp =
      (
        await client.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [
          EXPECTED_RUNTIME,
          row.oid,
        ])
      ).rows[0]?.ok === true;
    current.executePublic =
      (
        await client.query("select has_function_privilege('public', $1::oid, 'EXECUTE') as ok", [row.oid])
      ).rows[0]?.ok === true;
  }
  return grouped;
}

async function relationExists(client, name) {
  return (
    await client.query("select to_regclass($1) is not null as ok", [`public.${name}`])
  ).rows[0]?.ok === true;
}

async function columnFact(client, table) {
  const row = (
    await client.query(
      `select data_type, is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and table_name = $1
          and column_name = 'organisation_id'`,
      [table],
    )
  ).rows[0];
  if (!row) return emptyColumn();
  return {
    present: true,
    dataType: String(row.data_type ?? ""),
    nullable: String(row.is_nullable ?? "") === "YES",
  };
}

async function countIf(client, exists, sql) {
  if (!exists) return 0;
  return Number((await client.query(sql)).rows[0]?.n ?? 0);
}

async function inspectHotelApply(client) {
  const fnRows = (
    await client.query(
      `select p.oid,
              pg_get_functiondef(p.oid) as definition,
              p.pronargs as nargs,
              p.proargnames as arg_names,
              p.prorettype::regtype::text as return_type,
              (select coalesce(array_agg(format_type(u.t, null) order by u.ord), '{}'::text[])
                 from unnest(p.proargtypes) with ordinality as u(t, ord)
              ) as arg_types
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'sbg_apply_billing_event'`,
    )
  ).rows;
  if (fnRows.length !== 1) {
    return {
      functionDefinition: fnRows[0]?.definition ?? "",
      functionCount: fnRows.length,
      functionArgCount: null,
      functionArgNames: [],
      functionArgTypes: [],
      functionReturnType: null,
    };
  }
  const row = fnRows[0];
  return {
    functionDefinition: String(row.definition ?? ""),
    functionCount: 1,
    functionArgCount: Number(row.nargs ?? 0),
    functionArgNames: Array.isArray(row.arg_names) ? row.arg_names : [],
    functionArgTypes: Array.isArray(row.arg_types) ? row.arg_types : [],
    functionReturnType: row.return_type ?? "",
  };
}

export async function inspect0027State(client, sourceMigrations) {
  const base = await inspect0026State(client, sourceMigrations);
  const tables = {};
  for (const name of ORG_TABLES) tables[name] = await inspectTable(client, name);
  const view = await inspectView(client, LICENCE_BALANCE_VIEW);
  const functions = await inspectFunctions(client);
  const hotelsOrganisationId = await columnFact(client, "hotels");
  const stripeEventsOrganisationId = await columnFact(client, "sbg_stripe_events");

  const constraints = (
    await client.query(
      `select c.conname as name
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and c.conname = any($1::text[])
        order by c.conname`,
      [REQUIRED_CONSTRAINTS],
    )
  ).rows.map((row) => String(row.name));

  const indexRows = (
    await client.query(
      `select i.relname as name,
              ix.indisunique as unique,
              pg_get_expr(ix.indpred, ix.indrelid) as predicate,
              pg_get_indexdef(ix.indexrelid) as def
         from pg_index ix
         join pg_class i on i.oid = ix.indexrelid
         join pg_class t on t.oid = ix.indrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and i.relname = any($1::text[])`,
      [REQUIRED_INDEXES.map((index) => index.name)],
    )
  ).rows;
  const indexes = {};
  for (const row of indexRows) {
    indexes[String(row.name)] = {
      present: true,
      unique: row.unique === true,
      predicate: row.predicate,
      def: row.def,
    };
  }

  const triggerRows = (
    await client.query(
      `select t.tgname as name,
              c.relname as table_name,
              p.proname as fn,
              pg_get_triggerdef(t.oid) as def
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_proc p on p.oid = t.tgfoid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and not t.tgisinternal
          and t.tgname = any($1::text[])`,
      [REQUIRED_TRIGGERS.map((trigger) => trigger.name)],
    )
  ).rows;
  const triggers = {};
  for (const row of triggerRows) {
    triggers[String(row.name)] = {
      present: true,
      table: row.table_name,
      fn: row.fn,
      def: row.def,
    };
  }

  const organisationsPresent = tables.sbg_organisations.present === true;
  const membersPresent = tables.sbg_organisation_members.present === true;
  const billingPresent = tables.sbg_organisation_billing.present === true;
  const allocationsPresent = tables.sbg_property_licence_allocations.present === true;
  const plansPresent = await relationExists(client, "sbg_saas_plans");
  const counts = {
    organisations: await countIf(
      client,
      organisationsPresent,
      "select count(*)::int as n from sbg_organisations",
    ),
    members: await countIf(
      client,
      membersPresent,
      "select count(*)::int as n from sbg_organisation_members",
    ),
    billing: await countIf(
      client,
      billingPresent,
      "select count(*)::int as n from sbg_organisation_billing",
    ),
    allocations: await countIf(
      client,
      allocationsPresent,
      "select count(*)::int as n from sbg_property_licence_allocations",
    ),
    attachedHotels: hotelsOrganisationId.present
      ? Number(
          (await client.query("select count(*)::int as n from hotels where organisation_id is not null"))
            .rows[0]?.n ?? 0,
        )
      : 0,
    propertyLicencePlans: plansPresent
      ? Number(
          (
            await client.query(
              "select count(*)::int as n from sbg_saas_plans where code = 'property_licence'",
            )
          ).rows[0]?.n ?? 0,
        )
      : 0,
  };

  const hotelApply = await inspectHotelApply(client);
  const paymentFunctionPresent =
    (
      await client.query(
        `select exists(
            select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname = 'sbg_apply_payment_event'
          ) as ok`,
      )
    ).rows[0]?.ok === true;
  const bookingPaymentsPresent = await relationExists(client, "sbg_booking_payments");
  const hotelAccountsPresent = await relationExists(client, "app_hotel_accounts");
  const domain = {
    paymentFunctionPresent,
    bookingPaymentCount: await countIf(
      client,
      bookingPaymentsPresent,
      "select count(*)::int as n from sbg_booking_payments",
    ),
    hotelAccountCount: await countIf(
      client,
      hotelAccountsPresent,
      "select count(*)::int as n from app_hotel_accounts",
    ),
  };

  return {
    ...base,
    ...hotelApply,
    organisation: {
      tables,
      view,
      functions,
      constraints,
      indexes,
      triggers,
      columns: { hotelsOrganisationId, stripeEventsOrganisationId },
      counts,
    },
    domain,
  };
}

async function loadSourceMigrations(rootDir) {
  const entries = await readdir(join(rootDir, "migrations"));
  return entries.filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
}

async function loadReviewedChecksums(rootDir) {
  const checksums = {};
  for (const name of Object.keys(REVIEWED_DIGESTS)) {
    checksums[name] = sha256(await readFile(join(rootDir, "migrations", name)));
  }
  return checksums;
}

async function inspectWithOwner(ownerUrl, sourceMigrations) {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN READ ONLY");
    began = true;
    return await inspect0027State(client, sourceMigrations);
  } finally {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (err) {
        say(redact(err?.message || err));
      }
    }
    client.release();
    await pool.end();
  }
}

async function apply0027OnOwner(ownerUrl, sql, sourceMigrations, before) {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  try {
    return await apply0027Transaction({
      sql,
      before,
      query: (text, params) => client.query(text, params),
      inspect: () => inspect0027State(client, sourceMigrations),
    });
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const ownerUrl = ownerUrlFromEnv(process.env);
  const confirmation = process.env.CP26CO42_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  const dispatched = String(process.env.GITHUB_SHA ?? "").trim();
  if (dispatched) say(`dispatched sha: ${dispatched}`);
  say("note: this controller is build-complete; dispatch is a later authorised checkpoint");
  say("note: organisation persistence only — no organisations, no prices, no Stripe, no commerce activation");

  const confirm = assertConfirmation(confirmation);
  if (!confirm.ok) {
    fail(confirm.verdict);
    return;
  }
  if (!ownerUrl) {
    fail(BLOCKED_OWNER_URL);
    return;
  }

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sourceChecksums = await loadReviewedChecksums(rootDir);
  const checksumGate = assertReviewedChecksums(sourceChecksums);
  if (!checksumGate.ok) {
    say(`checksum name: ${checksumGate.name}`);
    say(`checksum digest: ${checksumGate.digest}`);
    fail(checksumGate.verdict);
    return;
  }
  for (const [name, digest] of Object.entries(sourceChecksums)) {
    say(`${name} digest: ${digest}`);
  }

  const migrationPath = join(rootDir, "migrations", TARGET_MIGRATION);
  const bytes = await readFile(migrationPath);
  const file = {
    name: TARGET_MIGRATION,
    bytes,
    digest: sha256(bytes),
    sql: bytes.toString("utf8"),
  };
  say(`0027 digest: ${file.digest}`);

  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUse0027({
    env: process.env,
    confirmation,
    file,
    sourceChecksums,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    mutate: ({ sql, before }) => apply0027OnOwner(ownerUrl, sql, sourceMigrations, before),
  });
  if (result.preflight) reportFacts("pre-migration:", result.preflight);
  if (result.failures?.length) {
    say("gate failures:");
    for (const name of result.failures) say(`  ${name}`);
  }
  if (result.postflight) reportFacts("post-migration:", result.postflight);
  if (result.error) say(redact(result.error));
  say(result.verdict);
  if (!result.ok) process.exitCode = 1;
}

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    fail(APPLY_FAILED, err?.message || err);
    process.exit(1);
  });
}
