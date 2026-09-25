#!/usr/bin/env node
/**
 * CP26C-O3.2A — single-use production controller for 0026 only.
 *
 * Applies migrations/0026_cp26co3_commercial_catalogue.sql and nothing else.
 * Never uses DATABASE_URL. Never prints secrets. Never calls Stripe.
 * Does not invoke the generic production migrator.
 * Does not create prices, mappings, hotels, billing rows, or Owner grants.
 *
 * Historical evidence of the spent CP26C-O3.2A controller.
 * Production apply completed once in CP26C-O3.2B (GHA 36135836457).
 * The workflow_dispatch surface and npm alias were retired in CP26C-O3.2C.
 * REQUIRED_LEDGER is the frozen pre-apply pin (0001–0025). It must not follow Gate B.
 * Re-running against an already-applied 0001–0026 ledger must not mutate.
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
import { billingSnapshotKey } from "./cp26b2-0024-production-migrate.mjs";
import {
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  inspect0025State,
  ownerInstalledContractFailures,
  verifyHotelKey,
} from "./cp26co2a-0025-production-migrate.mjs";

export {
  IDENTITY_BLOCKED,
  OWNER_BLOCKED,
  EXPECTED_DATABASE,
  EXPECTED_OWNER,
  EXPECTED_RUNTIME,
  ACCEPTED_LEDGER,
  AUTHORISED_PENDING,
};

export const TARGET_MIGRATION = "0026_cp26co3_commercial_catalogue.sql";
export const TARGET_DIGEST =
  "4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446";
export const REQUIRED_CONFIRMATION = "APPLY-0026";
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
];

export const REVIEWED_DIGESTS = {
  ...PRIOR_REVIEWED_DIGESTS,
  [TARGET_MIGRATION]: TARGET_DIGEST,
};

export const CATALOGUE_TABLES = [
  "sbg_saas_plans",
  "sbg_saas_price_versions",
  "sbg_saas_stripe_mappings",
  "sbg_saas_commerce_locks",
];

export const PLAN_SEEDS = [
  { code: "basic", name: "Basic", description: "", sortOrder: 10, active: true },
  { code: "pro", name: "Pro", description: "", sortOrder: 20, active: true },
  { code: "premium", name: "Premium", description: "", sortOrder: 30, active: true },
];

export const SEED_AUDIT_SOURCE = "migration:0026";
export const SEED_AUDIT_ACTION = "catalogue.plan.created";

export const REQUIRED_CONSTRAINTS = [
  "sbg_saas_plans_pkey",
  "sbg_saas_plans_code_check",
  "sbg_saas_plans_name_present",
  "sbg_saas_price_versions_pkey",
  "sbg_saas_price_versions_plan_code_fkey",
  "sbg_saas_price_versions_created_by_user_id_fkey",
  "sbg_saas_price_currency_v1",
  "sbg_saas_price_amount_positive",
  "sbg_saas_price_interval_v1",
  "sbg_saas_price_interval_count_v1",
  "sbg_saas_price_retired_not_purchasable",
  "sbg_saas_stripe_mappings_pkey",
  "sbg_saas_stripe_mappings_price_version_id_fkey",
  "sbg_saas_stripe_mappings_actor_user_id_fkey",
  "sbg_saas_mapping_environment",
  "sbg_saas_mapping_product_id",
  "sbg_saas_mapping_price_id",
  "sbg_saas_mapping_status",
  "sbg_saas_mapping_price_unique",
  "sbg_saas_commerce_locks_pkey",
  "sbg_saas_commerce_locks_singleton",
];

export const REQUIRED_INDEXES = [
  {
    name: "sbg_saas_price_versions_one_purchasable_idx",
    unique: true,
    predicate: /purchasable/i,
  },
  {
    name: "sbg_saas_price_versions_history_idx",
    unique: false,
    predicate: null,
  },
  {
    name: "sbg_saas_mapping_one_verified_idx",
    unique: true,
    predicate: /verified/i,
  },
];

export const REQUIRED_TRIGGERS = [
  {
    name: "sbg_saas_plans_no_delete",
    table: "sbg_saas_plans",
    fn: "sbg_catalogue_reject_delete",
    bits: ["BEFORE", "DELETE", "FOR EACH ROW"],
  },
  {
    name: "sbg_saas_plans_no_truncate",
    table: "sbg_saas_plans",
    fn: "sbg_catalogue_reject_delete",
    bits: ["BEFORE", "TRUNCATE", "FOR EACH STATEMENT"],
  },
  {
    name: "sbg_saas_plans_code_guard",
    table: "sbg_saas_plans",
    fn: "sbg_catalogue_plan_guard",
    bits: ["BEFORE", "UPDATE", "FOR EACH ROW"],
  },
  {
    name: "sbg_saas_price_versions_guard",
    table: "sbg_saas_price_versions",
    fn: "sbg_catalogue_price_version_guard",
    bits: ["BEFORE", "UPDATE", "FOR EACH ROW"],
  },
  {
    name: "sbg_saas_price_versions_no_delete",
    table: "sbg_saas_price_versions",
    fn: "sbg_catalogue_reject_delete",
    bits: ["BEFORE", "DELETE", "FOR EACH ROW"],
  },
  {
    name: "sbg_saas_price_versions_no_truncate",
    table: "sbg_saas_price_versions",
    fn: "sbg_catalogue_reject_delete",
    bits: ["BEFORE", "TRUNCATE", "FOR EACH STATEMENT"],
  },
  {
    name: "sbg_saas_stripe_mappings_no_delete",
    table: "sbg_saas_stripe_mappings",
    fn: "sbg_catalogue_reject_delete",
    bits: ["BEFORE", "DELETE", "FOR EACH ROW"],
  },
  {
    name: "sbg_saas_stripe_mappings_no_truncate",
    table: "sbg_saas_stripe_mappings",
    fn: "sbg_catalogue_reject_delete",
    bits: ["BEFORE", "TRUNCATE", "FOR EACH STATEMENT"],
  },
  {
    name: "sbg_owner_audit_immutable",
    table: "sbg_owner_audit_events",
    fn: "sbg_owner_audit_immutable",
    bits: ["BEFORE", "UPDATE", "DELETE", "FOR EACH ROW"],
  },
  {
    name: "sbg_owner_audit_no_truncate",
    table: "sbg_owner_audit_events",
    fn: "sbg_owner_audit_immutable",
    bits: ["BEFORE", "TRUNCATE", "FOR EACH STATEMENT"],
  },
];

const SEARCH_PATH = "public, pg_temp";

export const EXPECTED_FUNCTIONS = [
  {
    name: "sbg_catalogue_require_owner",
    nargs: 1,
    argTypes: ["text"],
    argNames: ["p_actor_user_id"],
    returnType: "void",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: false,
    bodyIncludes: "not a platform owner",
  },
  {
    name: "sbg_catalogue_reject_delete",
    nargs: 0,
    argTypes: [],
    argNames: [],
    returnType: "trigger",
    securityDefiner: false,
    searchPath: SEARCH_PATH,
    executeAetherApp: false,
    bodyIncludes: "catalogue history cannot be deleted",
  },
  {
    name: "sbg_catalogue_plan_guard",
    nargs: 0,
    argTypes: [],
    argNames: [],
    returnType: "trigger",
    securityDefiner: false,
    searchPath: SEARCH_PATH,
    executeAetherApp: false,
    bodyIncludes: "plan code is immutable",
  },
  {
    name: "sbg_catalogue_price_version_guard",
    nargs: 0,
    argTypes: [],
    argNames: [],
    returnType: "trigger",
    securityDefiner: false,
    searchPath: SEARCH_PATH,
    executeAetherApp: false,
    bodyIncludes: "commercial price terms are immutable",
  },
  {
    name: "sbg_owner_audit_immutable",
    nargs: 0,
    argTypes: [],
    argNames: [],
    returnType: "trigger",
    securityDefiner: false,
    searchPath: SEARCH_PATH,
    executeAetherApp: false,
    bodyIncludes: "owner audit is append-only",
  },
  {
    name: "sbg_catalogue_update_plan",
    nargs: 6,
    argTypes: ["text", "text", "text", "text", "integer", "boolean"],
    argNames: ["p_actor_user_id", "p_plan_code", "p_name", "p_description", "p_sort_order", "p_active"],
    returnType: "void",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: null,
  },
  {
    name: "sbg_catalogue_create_price_version",
    nargs: 6,
    argTypes: ["text", "text", "integer", "text", "text", "smallint"],
    argNames: [
      "p_actor_user_id",
      "p_plan_code",
      "p_amount_minor",
      "p_currency",
      "p_billing_interval",
      "p_interval_count",
    ],
    returnType: "uuid",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: null,
  },
  {
    name: "sbg_catalogue_activate_price_version",
    nargs: 2,
    argTypes: ["text", "uuid"],
    argNames: ["p_actor_user_id", "p_price_version_id"],
    returnType: "void",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: null,
  },
  {
    name: "sbg_catalogue_retire_price_version",
    nargs: 2,
    argTypes: ["text", "uuid"],
    argNames: ["p_actor_user_id", "p_price_version_id"],
    returnType: "void",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: null,
  },
  {
    name: "sbg_catalogue_record_stripe_mapping",
    nargs: 5,
    argTypes: ["text", "uuid", "text", "text", "text"],
    argNames: [
      "p_actor_user_id",
      "p_price_version_id",
      "p_environment",
      "p_stripe_product_id",
      "p_stripe_price_id",
    ],
    returnType: "uuid",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: false,
    bodyIncludes: "live Stripe mapping is locked",
  },
  {
    name: "sbg_resolve_domain_a_checkout_price",
    nargs: 2,
    argTypes: ["text", "text"],
    argNames: ["p_plan_code", "p_environment"],
    returnType: "text",
    securityDefiner: true,
    searchPath: SEARCH_PATH,
    executeAetherApp: true,
    bodyIncludes: "live checkout is locked",
  },
];

export const CATALOGUE_FUNCTION_NAMES = EXPECTED_FUNCTIONS.map((fn) => fn.name);

export const AUTHORISED = "GATE PASS — 0026 AUTHORISED";
export const ALREADY_APPLIED = "0026 ALREADY APPLIED — NO MUTATION";
export const APPLIED_VERIFIED = "GATE PASS — 0026 APPLIED AND VERIFIED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const DIGEST_BLOCKED = "BLOCKED — 0026 DIGEST MISMATCH";
export const REVIEWED_DIGEST_BLOCKED = "BLOCKED — REVIEWED MIGRATION DIGEST MISMATCH";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const APPLY_FAILED = "BLOCKED — 0026 APPLICATION FAILED";
export const UNAUTHORISED_MIGRATION = "BLOCKED — UNAUTHORISED MIGRATION";
export const PARTIAL_BLOCKED = "BLOCKED — 0026 PARTIAL / LEDGER SPLIT";
export const ROLE_BLOCKED = "BLOCKED — AETHER_APP ROLE ESCALATED";
export const ACTIVE_OWNER_BLOCKED = "BLOCKED — ACTIVE OWNER COUNT INVALID";
export const OWNER_CONTRACT_BLOCKED = "BLOCKED — 0025 OWNER CONTRACT INVALID";

const ALLOWED_LEDGER = new Set([...REQUIRED_LEDGER, TARGET_MIGRATION]);

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

export function absentCatalogue() {
  return {
    tables: Object.fromEntries(CATALOGUE_TABLES.map((name) => [name, emptyTable()])),
    functions: Object.fromEntries(CATALOGUE_FUNCTION_NAMES.map((name) => [name, emptyFn()])),
    constraints: [],
    indexes: {},
    triggers: {},
    plans: [],
    priceVersionCount: 0,
    mappingCount: 0,
    lockCount: 0,
    lock: null,
    seedAudits: [],
  };
}

function tableState(schema, name) {
  return schema?.tables?.[name] ?? emptyTable();
}

function functionState(schema, name) {
  return schema?.functions?.[name] ?? emptyFn();
}

export function cataloguePresentNames(schema) {
  const present = [];
  for (const name of CATALOGUE_TABLES) {
    if (tableState(schema, name).present) present.push(name);
  }
  for (const name of CATALOGUE_FUNCTION_NAMES) {
    if (Number(functionState(schema, name).count ?? 0) > 0) present.push(name);
  }
  if ((schema?.plans ?? []).length) present.push("plans");
  if (Number(schema?.priceVersionCount ?? 0) > 0) present.push("price-versions");
  if (Number(schema?.mappingCount ?? 0) > 0) present.push("stripe-mappings");
  if (Number(schema?.lockCount ?? 0) > 0) present.push("commerce-locks");
  if ((schema?.seedAudits ?? []).length) present.push("seed-audits");
  return present;
}

function snapshotOf(facts) {
  return {
    hotelSnapshot: facts?.hotelSnapshot ?? null,
    billingSnapshot: facts?.billingSnapshot ?? null,
    verifyHotel: facts?.verifyHotel ?? null,
    activeOwnerCount: Number(facts?.activeOwnerCount ?? -1),
    auditCount: Number(facts?.ownerSchema?.auditCount ?? -1),
  };
}

export function catalogueFunctionContractFailures(fn, expected) {
  const failures = [];
  const prefix = expected.name;
  if (Number(fn?.count ?? 0) !== 1) failures.push(`${prefix}-count`);
  if (Number(fn?.nargs ?? -1) !== expected.nargs) failures.push(`${prefix}-nargs`);
  const types = [...(fn?.argTypes ?? [])].map(normalizePgType);
  if (
    types.length !== expected.nargs ||
    expected.argTypes.some((want, index) => types[index] !== want)
  ) {
    failures.push(`${prefix}-arg-types`);
  }
  const names = Array.isArray(fn?.argNames) ? fn.argNames.map((name) => String(name ?? "")) : [];
  if (expected.argNames.length === 0) {
    if (names.length > 0) failures.push(`${prefix}-arg-names`);
  } else if (
    names.length !== expected.nargs ||
    expected.argNames.some((want, index) => names[index] !== want)
  ) {
    failures.push(`${prefix}-arg-names`);
  }
  if (normalizePgType(fn?.returnType) !== expected.returnType) failures.push(`${prefix}-return-type`);
  if (String(fn?.owner ?? "") !== EXPECTED_OWNER) failures.push(`${prefix}-owner`);
  if (Boolean(fn?.securityDefiner) !== expected.securityDefiner) {
    failures.push(`${prefix}-security-definer`);
  }
  if (normalizeSearchPath(fn?.searchPath) !== normalizeSearchPath(expected.searchPath)) {
    failures.push(`${prefix}-search-path`);
  }
  if (Boolean(fn?.executeAetherApp) !== expected.executeAetherApp) failures.push(`${prefix}-execute-app`);
  if (fn?.executePublic !== false) failures.push(`${prefix}-execute-public`);
  if (expected.bodyIncludes && !String(fn?.definition ?? "").includes(expected.bodyIncludes)) {
    failures.push(`${prefix}-body`);
  }
  return failures;
}

function catalogueTableContractFailures(table, name) {
  const failures = [];
  if (table?.present !== true) failures.push(`${name}-missing`);
  if (String(table?.owner ?? "") !== EXPECTED_OWNER) failures.push(`${name}-owner`);
  if (table?.selectApp !== true) failures.push(`${name}-select`);
  if (table?.insertApp !== false) failures.push(`${name}-insert`);
  if (table?.updateApp !== false) failures.push(`${name}-update`);
  if (table?.deleteApp !== false) failures.push(`${name}-delete`);
  if (table?.truncateApp !== false) failures.push(`${name}-truncate`);
  if (table?.selectPublic !== false) failures.push(`${name}-public-select`);
  if (table?.insertPublic !== false) failures.push(`${name}-public-insert`);
  if (table?.updatePublic !== false) failures.push(`${name}-public-update`);
  if (table?.deletePublic !== false) failures.push(`${name}-public-delete`);
  if (table?.truncatePublic !== false) failures.push(`${name}-public-truncate`);
  return failures;
}

export function seedAuditFailures(audits) {
  const failures = [];
  const rows = [...(audits ?? [])];
  if (rows.length !== PLAN_SEEDS.length) failures.push("seed-audit-count");
  const byId = new Map(rows.map((row) => [String(row?.targetId ?? ""), row]));
  for (const plan of PLAN_SEEDS) {
    const row = byId.get(plan.code);
    if (!row) {
      failures.push(`seed-audit-${plan.code}`);
      continue;
    }
    if (row.actorUserId != null) failures.push(`seed-actor-${plan.code}`);
    if (row.action !== SEED_AUDIT_ACTION) failures.push(`seed-action-${plan.code}`);
    if (row.targetType !== "commercial_plan") failures.push(`seed-target-${plan.code}`);
    if (row.source !== SEED_AUDIT_SOURCE) failures.push(`seed-source-${plan.code}`);
  }
  return failures;
}

export function planSeedFailures(plans) {
  const failures = [];
  const rows = [...(plans ?? [])];
  if (rows.length !== PLAN_SEEDS.length) failures.push("plan-count");
  const byCode = new Map(rows.map((row) => [String(row?.code ?? ""), row]));
  if (byCode.size !== rows.length) failures.push("plan-duplicate");
  for (const expected of PLAN_SEEDS) {
    const row = byCode.get(expected.code);
    if (!row) {
      failures.push(`plan-${expected.code}`);
      continue;
    }
    if (String(row.name ?? "") !== expected.name) failures.push(`plan-name-${expected.code}`);
    if (String(row.description ?? "") !== expected.description) failures.push(`plan-description-${expected.code}`);
    if (Number(row.sortOrder) !== expected.sortOrder) failures.push(`plan-sort-${expected.code}`);
    if (row.active !== true) failures.push(`plan-active-${expected.code}`);
  }
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
  }
  return failures;
}

export function catalogueInstalledContractFailures(facts) {
  const failures = [];
  const schema = facts?.catalogue ?? {};
  for (const name of CATALOGUE_TABLES) {
    failures.push(...catalogueTableContractFailures(tableState(schema, name), name));
  }
  for (const expected of EXPECTED_FUNCTIONS) {
    failures.push(...catalogueFunctionContractFailures(functionState(schema, expected.name), expected));
  }
  const constraints = new Set((schema.constraints ?? []).map(String));
  for (const name of REQUIRED_CONSTRAINTS) {
    if (!constraints.has(name)) failures.push(`constraint-${name}`);
  }
  failures.push(...indexFailures(schema.indexes));
  failures.push(...triggerFailures(schema.triggers));
  failures.push(...planSeedFailures(schema.plans));
  if (Number(schema.priceVersionCount ?? -1) !== 0) failures.push("price-version-count");
  if (Number(schema.mappingCount ?? -1) !== 0) failures.push("stripe-mapping-count");
  if (Number(schema.lockCount ?? -1) !== 1) failures.push("lock-count");
  if (Number(schema.lock?.id ?? -1) !== 1) failures.push("lock-id");
  if (schema.lock?.liveMappingEnabled !== false) failures.push("lock-live-mapping");
  if (schema.lock?.liveCheckoutEnabled !== false) failures.push("lock-live-checkout");
  failures.push(...seedAuditFailures(schema.seedAudits));
  return failures;
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

export function evaluate0026Baseline(facts, file) {
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
  const present = cataloguePresentNames(facts?.catalogue);
  const missingHistorical = REQUIRED_LEDGER.filter((name) => !ledger.includes(name));

  if (appliedCount > 1 || unexpectedApplied.length) {
    return blocked(PARTIAL_BLOCKED, { pending, appliedCount, unexpectedApplied, present });
  }
  if (appliedCount === 1) {
    if (pending.length) return blocked(UNEXPECTED_PLAN, { pending, alreadyApplied: true });
    const contract = [
      ...ownerInstalledContractFailures(facts),
      ...catalogueInstalledContractFailures(facts),
    ];
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
  if (ownerContract.length) {
    return blocked(OWNER_CONTRACT_BLOCKED, { failures: ownerContract });
  }
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

export function evaluate0026Aftermath(facts, before) {
  const failures = [];
  for (const name of environmentFailures(facts)) {
    if (!failures.includes(name)) failures.push(name);
  }
  const ledger = [...(facts?.ledger ?? [])].map(String);
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  if (appliedCount !== 1) failures.push("0026-ledger");
  if (ledger.some((name) => !ALLOWED_LEDGER.has(name))) failures.push("unexpected-ledger");
  if (pending.length > 0) failures.push("pending-remain");
  for (const failure of ownerInstalledContractFailures(facts)) {
    if (!failures.includes(failure)) failures.push(failure);
  }
  for (const failure of catalogueInstalledContractFailures(facts)) {
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
  if (auditCount !== Number(before?.auditCount ?? -2) + PLAN_SEEDS.length) {
    failures.push("audit-delta");
  }
  if (failures.length) {
    return { ok: false, verdict: POST_BLOCKED, failures, pending, migrated: false, committed: false };
  }
  return { ok: true, verdict: APPLIED_VERIFIED, pending: [], migrated: true, committed: true };
}

export async function applyExact0026({ name, sql, execute }) {
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
    throw new Error("BLOCKED — 0026 EXECUTOR MISSING");
  }
  return execute(sql);
}

export async function apply0026Transaction({ sql, before, query, inspect }) {
  if (typeof query !== "function" || typeof inspect !== "function") {
    throw new Error("BLOCKED — 0026 EXECUTOR MISSING");
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
    const aftermath = evaluate0026Aftermath(after, before);
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

export async function runSingleUse0026({
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
  const baseline = evaluate0026Baseline({ ...before, confirmation, env, ownerUrl }, file);
  if (!baseline.ok || baseline.alreadyApplied) {
    return { ...baseline, preflight: before, migrated: false };
  }

  if (typeof mutate !== "function") {
    return blocked("BLOCKED — 0026 EXECUTOR MISSING");
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
  say(`catalogue.present: ${cataloguePresentNames(facts?.catalogue).join(",") || "(none)"}`);
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
  say("commerce: OFF (controller does not read or set SBG_SAAS_COMMERCE)");
  say("stripe: UNTOUCHED");
}

async function privilege(client, who, regclass, priv) {
  return (
    await client.query("select has_table_privilege($1, $2::regclass, $3) as ok", [who, regclass, priv])
  ).rows[0]?.ok === true;
}

async function inspectTable(client, name) {
  const found = (
    await client.query(
      `select r.rolname as owner
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r on r.oid = c.relowner
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname = $1`,
      [name],
    )
  ).rows[0];
  if (!found) return emptyTable();
  const regclass = `public.${name}`;
  return {
    present: true,
    owner: found.owner,
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
      [CATALOGUE_FUNCTION_NAMES],
    )
  ).rows;

  const grouped = Object.fromEntries(CATALOGUE_FUNCTION_NAMES.map((name) => [name, emptyFn()]));
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

export async function inspect0026State(client, sourceMigrations) {
  const base = await inspect0025State(client, sourceMigrations);
  const tables = {};
  for (const name of CATALOGUE_TABLES) tables[name] = await inspectTable(client, name);
  const functions = await inspectFunctions(client);

  const constraints = (
    await client.query(
      `select c.conname as name
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname = any($1::text[])
        order by c.conname`,
      [CATALOGUE_TABLES],
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

  let plans = [];
  let priceVersionCount = 0;
  let mappingCount = 0;
  let lockCount = 0;
  let lock = null;
  let seedAudits = [];
  if (await relationExists(client, "sbg_saas_plans")) {
    plans = (
      await client.query(
        `select code, name, description, sort_order, active
           from sbg_saas_plans
          order by code`,
      )
    ).rows.map((row) => ({
      code: String(row.code),
      name: String(row.name ?? ""),
      description: String(row.description ?? ""),
      sortOrder: Number(row.sort_order),
      active: row.active === true,
    }));
  }
  if (await relationExists(client, "sbg_saas_price_versions")) {
    priceVersionCount = Number(
      (await client.query("select count(*)::int as n from sbg_saas_price_versions")).rows[0]?.n ?? 0,
    );
  }
  if (await relationExists(client, "sbg_saas_stripe_mappings")) {
    mappingCount = Number(
      (await client.query("select count(*)::int as n from sbg_saas_stripe_mappings")).rows[0]?.n ?? 0,
    );
  }
  if (await relationExists(client, "sbg_saas_commerce_locks")) {
    const rows = (
      await client.query(
        `select id, live_mapping_enabled, live_checkout_enabled
           from sbg_saas_commerce_locks
          order by id`,
      )
    ).rows;
    lockCount = rows.length;
    if (rows[0]) {
      lock = {
        id: Number(rows[0].id),
        liveMappingEnabled: rows[0].live_mapping_enabled === true,
        liveCheckoutEnabled: rows[0].live_checkout_enabled === true,
      };
    }
  }
  if (base.ownerSchema?.tables?.sbg_owner_audit_events?.present) {
    seedAudits = (
      await client.query(
        `select actor_user_id, action, target_type, target_id, metadata->>'source' as source
           from sbg_owner_audit_events
          where action = $1
          order by target_id`,
        [SEED_AUDIT_ACTION],
      )
    ).rows.map((row) => ({
      actorUserId: row.actor_user_id,
      action: String(row.action),
      targetType: String(row.target_type),
      targetId: String(row.target_id),
      source: row.source == null ? null : String(row.source),
    }));
  }

  let activeOwnerCount = 0;
  if (base.ownerSchema?.tables?.sbg_platform_owners?.present) {
    activeOwnerCount = Number(
      (
        await client.query(
          "select count(*)::int as n from sbg_platform_owners where revoked_at is null",
        )
      ).rows[0]?.n ?? 0,
    );
  }

  return {
    ...base,
    activeOwnerCount,
    catalogue: {
      tables,
      functions,
      constraints,
      indexes,
      triggers,
      plans,
      priceVersionCount,
      mappingCount,
      lockCount,
      lock,
      seedAudits,
    },
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
    return await inspect0026State(client, sourceMigrations);
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

async function apply0026OnOwner(ownerUrl, sql, sourceMigrations, before) {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  try {
    return await apply0026Transaction({
      sql,
      before,
      query: (text, params) => client.query(text, params),
      inspect: () => inspect0026State(client, sourceMigrations),
    });
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const ownerUrl = ownerUrlFromEnv(process.env);
  const confirmation = process.env.CP26CO32A_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  const dispatched = String(process.env.GITHUB_SHA ?? "").trim();
  if (dispatched) say(`dispatched sha: ${dispatched}`);
  say("note: this controller is build-complete; dispatch is a later authorised checkpoint");
  say("note: catalogue persistence only — no prices, no Stripe, no commerce activation");

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
  say(`0026 digest: ${file.digest}`);

  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUse0026({
    env: process.env,
    confirmation,
    file,
    sourceChecksums,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    mutate: ({ sql, before }) => apply0026OnOwner(ownerUrl, sql, sourceMigrations, before),
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
