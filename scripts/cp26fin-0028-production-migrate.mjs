#!/usr/bin/env node
/**
 * CP26 FINALISATION — single-use production controller for 0028 only.
 *
 * Applies migrations/0028_cp26fin_property_licence_catalogue.sql and nothing else.
 * Never uses DATABASE_URL. Never prints secrets. Never calls Stripe.
 * Does not invoke the generic production migrator.
 * Does not seed a monetary amount. Does not create a Stripe mapping.
 * Does not create organisations, members, billing rows, or allocations.
 * Does not enable commerce. Does not write hotels.status.
 *
 * REQUIRED_LEDGER is the frozen pre-apply pin (0001–0027). It must not follow Gate B.
 * Re-running against an already-applied valid 0028 contract must not mutate.
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
  REVIEWED_DIGESTS as PRIOR_REVIEWED_DIGESTS,
  redact,
} from "./production-db-preflight.mjs";
import {
  catalogueInstalledContractFailures,
  inspect0026State,
} from "./cp26co32a-0026-production-migrate.mjs";
import {
  hotelApplyContractFailures,
  inspect0027State,
  organisationInstalledContractFailures,
} from "./cp26co42-0027-production-migrate.mjs";

export {
  ACCEPTED_LEDGER,
  AUTHORISED_PENDING,
  BLOCKED_OWNER_URL,
  EXPECTED_DATABASE,
  EXPECTED_OWNER,
};

export const TARGET_MIGRATION = "0028_cp26fin_property_licence_catalogue.sql";
export const TARGET_DIGEST =
  "35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d";
export const REQUIRED_CONFIRMATION = "APPLY-0028";
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
  "0027_cp26co41_organisation_property_licence.sql",
];

export const REVIEWED_DIGESTS = {
  ...PRIOR_REVIEWED_DIGESTS,
  [TARGET_MIGRATION]: TARGET_DIGEST,
};

export const HISTORICAL_PLANS = [
  { code: "basic", name: "Basic", description: "", sortOrder: 10 },
  { code: "pro", name: "Pro", description: "", sortOrder: 20 },
  { code: "premium", name: "Premium", description: "", sortOrder: 30 },
];

export const PROPERTY_LICENCE_PLAN = {
  code: "property_licence",
  name: "Property Licence",
  description: "SCAN. BOOK. GO. property licence. One active allocation consumes one licence.",
  sortOrder: 40,
};

export const AUTHORISED = "GATE PASS — 0028 AUTHORISED";
export const ALREADY_APPLIED = "0028 ALREADY APPLIED — NO MUTATION";
export const APPLIED_VERIFIED = "GATE PASS — 0028 APPLIED AND VERIFIED";
export const UNEXPECTED_PLAN = "BLOCKED — UNEXPECTED MIGRATION PLAN";
export const UNEXPECTED_COMMERCIAL = "BLOCKED — UNEXPECTED COMMERCIAL STATE";
export const DIGEST_BLOCKED = "BLOCKED — 0028 DIGEST MISMATCH";
export const REVIEWED_DIGEST_BLOCKED = "BLOCKED — REVIEWED MIGRATION DIGEST MISMATCH";
export const CONFIRM_BLOCKED = "BLOCKED — CONFIRMATION PHRASE INVALID";
export const POST_BLOCKED = "BLOCKED — POST-MIGRATION VERIFICATION FAILED";
export const APPLY_FAILED = "BLOCKED — 0028 APPLICATION FAILED";
export const UNAUTHORISED_MIGRATION = "BLOCKED — UNAUTHORISED MIGRATION";
export const PARTIAL_BLOCKED = "BLOCKED — 0028 PARTIAL / LEDGER SPLIT";
export const CATALOGUE_CONTRACT_BLOCKED = "BLOCKED — 0026 CATALOGUE CONTRACT INVALID";
export const ORGANISATION_CONTRACT_BLOCKED = "BLOCKED — 0027 ORGANISATION CONTRACT INVALID";
export const HOTEL_APPLY_BLOCKED = "BLOCKED — HOTEL BILLING APPLY CONTRACT INVALID";
export const DOMAIN_B_BLOCKED = "BLOCKED — DOMAIN B INVARIANT NOT PROVEN";
export const IDENTITY_BLOCKED = "BLOCKED — DATABASE IDENTITY MISMATCH";
export const OWNER_BLOCKED = "BLOCKED — OWNER IDENTITY MISMATCH";

const ALLOWED_LEDGER = new Set([...REQUIRED_LEDGER, TARGET_MIGRATION]);
const HISTORICAL_REJECTION = "historical plan cannot receive a price version";

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
  const text = String(file?.sql ?? file?.text ?? "");
  const digest = String(file?.digest ?? sha256(Buffer.from(file?.bytes ?? text)));
  if (name !== TARGET_MIGRATION) {
    return { ok: false, verdict: UNAUTHORISED_MIGRATION, migrated: false, name };
  }
  if (digest !== TARGET_DIGEST) {
    return { ok: false, verdict: DIGEST_BLOCKED, migrated: false, digest };
  }
  if (/\b179\b/.test(text) || text.includes("€")) {
    return { ok: false, verdict: UNEXPECTED_COMMERCIAL, migrated: false, digest };
  }
  return { ok: true, name, digest };
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

function blocked(verdict, extra = {}) {
  return { ok: false, verdict, migrated: false, ...extra };
}

function sameList(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function planMap(plans) {
  return new Map((plans ?? []).map((row) => [String(row?.code ?? ""), row]));
}

export function historicalPlanFailures(plans, active) {
  const failures = [];
  const rows = [...(plans ?? [])];
  const byCode = planMap(rows);
  if (byCode.size !== rows.length) failures.push("plan-duplicate");
  for (const expected of HISTORICAL_PLANS) {
    const row = byCode.get(expected.code);
    if (!row) {
      failures.push(`plan-${expected.code}`);
      continue;
    }
    if (String(row.name ?? "") !== expected.name) failures.push(`plan-name-${expected.code}`);
    if (String(row.description ?? "") !== expected.description) failures.push(`plan-description-${expected.code}`);
    if (Number(row.sortOrder) !== expected.sortOrder) failures.push(`plan-sort-${expected.code}`);
    if (Boolean(row.active) !== active) failures.push(`plan-active-${expected.code}`);
  }
  return failures;
}

export function propertyLicencePlanFailures(plans, present) {
  const row = planMap(plans).get(PROPERTY_LICENCE_PLAN.code);
  if (!present) {
    return row ? ["property-licence-present"] : [];
  }
  const failures = [];
  if (!row) return ["property-licence-missing"];
  if (String(row.name ?? "") !== PROPERTY_LICENCE_PLAN.name) failures.push("property-licence-name");
  if (String(row.description ?? "") !== PROPERTY_LICENCE_PLAN.description) failures.push("property-licence-description");
  if (Number(row.sortOrder) !== PROPERTY_LICENCE_PLAN.sortOrder) failures.push("property-licence-sort");
  if (row.active !== true) failures.push("property-licence-active");
  return failures;
}

function countFailures(facts) {
  const counts = facts?.organisation?.counts ?? {};
  const failures = [];
  if (Number(counts.organisations ?? -1) !== 0) failures.push("organisation-count");
  if (Number(counts.members ?? -1) !== 0) failures.push("member-count");
  if (Number(counts.billing ?? -1) !== 0) failures.push("billing-count");
  if (Number(counts.allocations ?? -1) !== 0) failures.push("allocation-count");
  if (Number(counts.attachedHotels ?? -1) !== 0) failures.push("attached-hotels");
  return failures;
}

function commercialEmptyFailures(facts) {
  const failures = [];
  const catalogue = facts?.catalogue ?? {};
  if (Number(catalogue.priceVersionCount ?? -1) !== 0) failures.push("price-version-count");
  if (Number(catalogue.mappingCount ?? -1) !== 0) failures.push("stripe-mapping-count");
  if (catalogue.lock?.liveMappingEnabled !== false) failures.push("lock-live-mapping");
  if (catalogue.lock?.liveCheckoutEnabled !== false) failures.push("lock-live-checkout");
  failures.push(...countFailures(facts));
  if (Number(facts?.billingSnapshot?.accountCount ?? -1) !== 0) failures.push("billing-accounts");
  if (Number(facts?.billingSnapshot?.eventCount ?? -1) !== 0) failures.push("stripe-events");
  return failures;
}

function platformFailures(facts) {
  const failures = [];
  if (facts?.database !== EXPECTED_DATABASE) failures.push(IDENTITY_BLOCKED);
  if (facts?.currentUser !== EXPECTED_OWNER || facts?.sessionUser !== EXPECTED_OWNER) {
    failures.push(OWNER_BLOCKED);
  }
  if (!facts?.ledgerReadable) failures.push("ledger-unreadable");
  if (Number(facts?.activeOwnerCount ?? -1) !== 1) failures.push("active-owners");
  if (Number(facts?.hotelSnapshot?.hotelCount ?? -1) !== 4) failures.push("hotel-count");
  if (facts?.hotelSnapshot?.demoKos?.code !== "demo-kos" || facts?.hotelSnapshot?.demoKos?.status !== "live") {
    failures.push("demo-kos");
  }
  if (facts?.verifyHotel?.code !== "sbg-verify-a5" || facts?.verifyHotel?.status !== "configured") {
    failures.push("verify-hotel");
  }
  if (facts?.domain?.paymentFunctionPresent !== true) failures.push("domain-b-payment-fn");
  if (Number(facts?.domain?.bookingPaymentCount ?? -1) !== 0) failures.push("domain-b-payments");
  if (Number(facts?.domain?.hotelAccountCount ?? -1) !== 1) failures.push("hotel-accounts");
  return failures;
}

function ledgerState(facts) {
  const ledger = [...(facts?.ledger ?? [])].map(String);
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], ledger).map((row) => row.name);
  const appliedCount = ledger.filter((name) => name === TARGET_MIGRATION).length;
  const unexpectedApplied = ledger.filter((name) => !ALLOWED_LEDGER.has(name));
  const missingHistorical = REQUIRED_LEDGER.filter((name) => !ledger.includes(name));
  return { ledger, pending, appliedCount, unexpectedApplied, missingHistorical };
}

export function annotateContracts(facts) {
  return {
    ...facts,
    catalogueContractFailures: catalogueInstalledContractFailures(facts),
    organisationContractFailures: organisationInstalledContractFailures(facts),
    hotelApplyFailures: hotelApplyContractFailures(facts),
  };
}

export function cutoverPlanFailures(facts, applied) {
  const plans = facts?.catalogue?.plans ?? [];
  const failures = [
    ...historicalPlanFailures(plans, applied ? false : true),
    ...propertyLicencePlanFailures(plans, applied),
  ];
  const expectedCount = applied ? 4 : 3;
  if ((plans ?? []).length !== expectedCount) failures.push("plan-count");
  if (applied && facts?.priceCreateRejectsHistorical !== true) failures.push("price-create-guard");
  if (!applied && facts?.priceCreateRejectsHistorical === true) failures.push("price-create-guard-early");
  return failures;
}

export function evaluate0028Baseline(facts, file) {
  const confirm = assertConfirmation(facts?.confirmation);
  if (!confirm.ok) return confirm;
  if (!ownerUrlFromEnv(facts?.env ?? { AETHER_DATABASE_OWNER_URL: facts?.ownerUrl })) {
    return blocked(BLOCKED_OWNER_URL);
  }
  const fileGate = assertMigrationFile(file);
  if (!fileGate.ok) return fileGate;
  const platform = platformFailures(facts);
  if (platform.includes(IDENTITY_BLOCKED)) return blocked(IDENTITY_BLOCKED, { failures: platform });
  if (platform.includes(OWNER_BLOCKED)) return blocked(OWNER_BLOCKED, { failures: platform });

  const { pending, appliedCount, unexpectedApplied, missingHistorical } = ledgerState(facts);
  if (appliedCount > 1 || unexpectedApplied.length || missingHistorical.length) {
    return blocked(PARTIAL_BLOCKED, { pending, appliedCount, unexpectedApplied, missingHistorical });
  }

  const commercial = commercialEmptyFailures(facts);
  const orgContract = facts?.organisationContractFailures ?? ["organisation-unproven"];
  const hotelApply = facts?.hotelApplyFailures ?? ["hotel-apply-unproven"];
  const plans = cutoverPlanFailures(facts, appliedCount === 1);

  if (appliedCount === 1) {
    if (pending.length || platform.length || commercial.length || orgContract.length || hotelApply.length || plans.length) {
      return blocked(pending.length ? UNEXPECTED_PLAN : PARTIAL_BLOCKED, {
        pending,
        failures: [...platform, ...commercial, ...orgContract, ...hotelApply, ...plans],
      });
    }
    if (facts?.domain?.paymentFunctionPresent !== true) return blocked(DOMAIN_B_BLOCKED);
    return { ok: true, alreadyApplied: true, verdict: ALREADY_APPLIED, pending: [], migrated: false };
  }

  if (commercial.length || plans.length) {
    return blocked(UNEXPECTED_COMMERCIAL, { failures: [...commercial, ...plans] });
  }
  if (platform.length) return blocked("BLOCKED — PRODUCTION BASELINE FAILED", { failures: platform });
  if ((facts?.catalogueContractFailures ?? ["catalogue-unproven"]).length) {
    return blocked(CATALOGUE_CONTRACT_BLOCKED, { failures: facts.catalogueContractFailures });
  }
  if (orgContract.length) return blocked(ORGANISATION_CONTRACT_BLOCKED, { failures: orgContract });
  if (hotelApply.length) return blocked(HOTEL_APPLY_BLOCKED, { failures: hotelApply });
  if (sameList(pending, [TARGET_MIGRATION])) {
    return { ok: true, authorised: true, alreadyApplied: false, verdict: AUTHORISED, pending, migrated: false };
  }
  return blocked(UNEXPECTED_PLAN, { pending });
}

export function evaluate0028Aftermath(facts, before) {
  const failures = [];
  const { pending, appliedCount, unexpectedApplied } = ledgerState(facts);
  if (appliedCount !== 1) failures.push("0028-ledger");
  if (unexpectedApplied.length) failures.push("unexpected-ledger");
  if (pending.length) failures.push("pending-remain");
  failures.push(...commercialEmptyFailures(facts));
  failures.push(...cutoverPlanFailures(facts, true));
  failures.push(...(facts?.organisationContractFailures ?? ["organisation-unproven"]));
  failures.push(...(facts?.hotelApplyFailures ?? ["hotel-apply-unproven"]));
  failures.push(...platformFailures(facts));
  if (Number(facts?.hotelSnapshot?.hotelCount ?? -1) !== Number(before?.hotelSnapshot?.hotelCount ?? -2)) {
    failures.push("hotel-invariance");
  }
  if (facts?.hotelSnapshot?.demoKos?.status !== before?.hotelSnapshot?.demoKos?.status) failures.push("demo-kos-invariance");
  if (facts?.verifyHotel?.status !== before?.verifyHotel?.status) failures.push("verify-hotel-invariance");
  if (Number(facts?.activeOwnerCount ?? -1) !== Number(before?.activeOwnerCount ?? -2)) failures.push("owner-invariance");
  if (Number(facts?.domain?.bookingPaymentCount ?? -1) !== Number(before?.domain?.bookingPaymentCount ?? -2)) {
    failures.push("domain-b-invariance");
  }
  if (Number(facts?.domain?.hotelAccountCount ?? -1) !== Number(before?.domain?.hotelAccountCount ?? -2)) {
    failures.push("hotel-account-invariance");
  }
  if (facts?.domain?.paymentFunctionPresent !== true) failures.push("domain-b-payment-fn");
  if (failures.length) return { ok: false, verdict: POST_BLOCKED, failures, pending, migrated: false, committed: false };
  return { ok: true, verdict: APPLIED_VERIFIED, pending: [], migrated: true, committed: true };
}

export async function apply0028Transaction({ sql, before, query, inspect }) {
  if (typeof query !== "function" || typeof inspect !== "function") {
    throw new Error("BLOCKED — 0028 EXECUTOR MISSING");
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
    const aftermath = evaluate0028Aftermath(after, before);
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
        // keep the original error
      }
    }
    throw err;
  }
}

export async function runSingleUse0028({ env, confirmation, file, sourceChecksums, loadFacts, mutate }) {
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
  const baseline = evaluate0028Baseline({ ...before, confirmation, env, ownerUrl }, file);
  if (!baseline.ok || baseline.alreadyApplied) {
    return { ...baseline, preflight: before, migrated: false };
  }
  if (typeof mutate !== "function") return blocked("BLOCKED — 0028 EXECUTOR MISSING");
  try {
    const applied = await mutate({ sql: file.sql ?? file.text, before });
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
  const pending = pendingMigrations(facts?.sourceMigrations ?? [], facts?.ledger ?? []).map((row) => row.name);
  say("pending:");
  for (const name of pending) say(`  ${name}`);
  if (!pending.length) say("  (none)");
  const codes = (facts?.catalogue?.plans ?? []).map((row) => `${row.code}:${row.active ? "active" : "inactive"}`).join(",") || "(none)";
  say(`plans: ${codes}`);
  say(`price_versions: ${facts?.catalogue?.priceVersionCount ?? "UNKNOWN"}`);
  say(`stripe_mappings: ${facts?.catalogue?.mappingCount ?? "UNKNOWN"}`);
  say(
    `locks: live_mapping=${String(facts?.catalogue?.lock?.liveMappingEnabled ?? "UNKNOWN")} live_checkout=${String(facts?.catalogue?.lock?.liveCheckoutEnabled ?? "UNKNOWN")}`,
  );
  say(`organisations: ${counts.organisations ?? "UNKNOWN"}`);
  say(`organisation_members: ${counts.members ?? "UNKNOWN"}`);
  say(`organisation_billing: ${counts.billing ?? "UNKNOWN"}`);
  say(`property_allocations: ${counts.allocations ?? "UNKNOWN"}`);
  say(`attached_hotels: ${counts.attachedHotels ?? "UNKNOWN"}`);
  say(`hotels.total: ${facts?.hotelSnapshot?.hotelCount ?? "UNKNOWN"}`);
  say(`demo-kos.status: ${facts?.hotelSnapshot?.demoKos?.status ?? "UNKNOWN"}`);
  say(`verify-a5.status: ${facts?.verifyHotel?.status ?? "ABSENT"}`);
  say(`active_owners: ${facts?.activeOwnerCount ?? "UNKNOWN"}`);
  say(`billing.accounts: ${facts?.billingSnapshot?.accountCount ?? "UNKNOWN"}`);
  say(`stripe.events: ${facts?.billingSnapshot?.eventCount ?? "UNKNOWN"}`);
  say(`domain_b.payment_fn: ${facts?.domain?.paymentFunctionPresent === true ? "PRESENT" : "ABSENT"}`);
  say(`domain_b.booking_payments: ${facts?.domain?.bookingPaymentCount ?? "UNKNOWN"}`);
  say("commerce: OFF (controller does not read or set SBG_SAAS_COMMERCE)");
  say("stripe: UNTOUCHED");
}

async function priceCreateRejectsHistorical(client) {
  const rows = (
    await client.query(
      `select pg_get_functiondef('sbg_catalogue_create_price_version(text,text,integer,text,text,smallint)'::regprocedure) as def`,
    )
  ).rows;
  return String(rows[0]?.def ?? "").includes(HISTORICAL_REJECTION);
}

export async function inspect0028State(client, sourceMigrations) {
  const base = await inspect0027State(client, sourceMigrations);
  const catalogueCarrier = await inspect0026State(client, sourceMigrations);
  const annotated = annotateContracts({ ...base, catalogue: catalogueCarrier.catalogue ?? base.catalogue });
  annotated.priceCreateRejectsHistorical = await priceCreateRejectsHistorical(client);
  return annotated;
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

async function withOwner(ownerUrl, fn) {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function inspectWithOwner(ownerUrl, sourceMigrations) {
  return withOwner(ownerUrl, async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      return await inspect0028State(client, sourceMigrations);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

async function apply0028OnOwner(ownerUrl, sql, sourceMigrations, before) {
  return withOwner(ownerUrl, (client) =>
    apply0028Transaction({
      sql,
      before,
      query: (text, params) => client.query(text, params),
      inspect: () => inspect0028State(client, sourceMigrations),
    }),
  );
}

async function main() {
  const ownerUrl = ownerUrlFromEnv(process.env);
  const confirmation = process.env.CP26FIN_CONFIRMATION;
  say(`AETHER_DATABASE_OWNER_URL: ${ownerUrl ? "PRESENT" : "ABSENT"}`);
  const dispatched = String(process.env.GITHUB_SHA ?? "").trim();
  if (dispatched) say(`dispatched sha: ${dispatched}`);
  say("note: catalogue cutover only — no amount, no Stripe object, no organisation rows, commerce untouched");

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

  const bytes = await readFile(join(rootDir, "migrations", TARGET_MIGRATION));
  const file = { name: TARGET_MIGRATION, bytes, digest: sha256(bytes), sql: bytes.toString("utf8") };
  say(`0028 digest: ${file.digest}`);
  const sourceMigrations = await loadSourceMigrations(rootDir);
  const result = await runSingleUse0028({
    env: process.env,
    confirmation,
    file,
    sourceChecksums,
    loadFacts: () => inspectWithOwner(ownerUrl, sourceMigrations),
    mutate: ({ sql, before }) => apply0028OnOwner(ownerUrl, sql, sourceMigrations, before),
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

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    fail(APPLY_FAILED, err?.message || err);
    process.exit(1);
  });
}
