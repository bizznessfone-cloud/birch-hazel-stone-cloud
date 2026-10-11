/**
 * Read-only plan for the inactive fixture-not-legal approval row.
 * Does not connect to a database and does not emit a write statement.
 * The recorded facts are the verified isolated-branch observations.
 * A later cleanup must re-read them and abort unless they still match.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_BRANCH, EXPECTED_DATABASE, EXPECTED_PROJECT, EXPECTED_ROLE } from "./a3-m36-isolated-preflight.mjs";
import { EXPECTED_ENDPOINT } from "./a3-m36-0035-equivalence.mjs";
import { FIXTURE_VERSIONS } from "./a3-m36-isolated-cleanup.mjs";

export const NOT_LEGAL = "fixture-not-legal";
export const ACCEPTANCE_ID = "af7cb88d-4d40-4516-a9e6-0fbfc5fe6e87";
export const ORGANISATION_ID = "2d7849af-91b9-49c4-9e1c-0aebd5a793fc";
export const USER_ID = "sbg-m35-test-user-20261010";
export const RECOVERY_BRANCH = "br-proud-field-b1tymqgc";
export const VERDICT_A = "AGREEMENT FIXTURE PLAN — OPTION A, NOT AUTHORISED";
export const VERDICT_NONE = "AGREEMENT FIXTURE PLAN — NO OPTION";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const VERIFIED_FACTS = {
  approvalCount: 1,
  effectiveCount: 0,
  approvalVersion: NOT_LEGAL,
  approvalEffective: false,
  acceptanceCount: 1,
  acceptanceId: ACCEPTANCE_ID,
  organisationId: ORGANISATION_ID,
  userId: USER_ID,
  markerUser: false,
  markerOrganisation: false,
  orgAcceptances: 1,
  orgMembers: 1,
  orgHotels: 3,
  userOrganisations: 1,
  userAccounts: 3,
  userMemberships: 1,
  userAcceptances: 1,
};

export function catalogueInvariants({ acceptanceSql, propertySql, approvalSql, concurrencySql }) {
  const acceptance = String(acceptanceSql ?? "");
  const property = String(propertySql ?? "");
  const approval = String(approvalSql ?? "");
  const concurrency = String(concurrencySql ?? "");
  return {
    acceptanceHasNoCatalogueForeignKey: !/references\s+sbg_approved_property_agreement_versions/i.test(acceptance),
    acceptanceDeleteIsRejected: /before update or delete on sbg_organisation_acceptances/i.test(acceptance)
      && /organisation acceptance evidence is immutable/.test(acceptance),
    propertyRequiresEffective: /join\s+public\.sbg_approved_property_agreement_versions[\s\S]{0,240}and\s+v\.effective/i.test(property),
    approvalHasNoDeleteTrigger: !/before\s+delete\s+on\s+sbg_approved_property_agreement_versions/i.test(approval),
    falseRowIsRetainedHistory: /A false row is retained history and does not authorise creation/.test(approval),
    catalogueStartsEmpty: /No row means none are approved/.test(approval),
    emptyCatalogueGate: /Number\(approvals\.n\) !== 0 \|\| Number\(approvals\.effective_n\) !== 0/.test(concurrency)
      && /APPROVAL TABLE IS NOT EMPTY/.test(concurrency)
      && !concurrency.includes(NOT_LEGAL),
    outsideRecoveryFixtureList: !FIXTURE_VERSIONS.includes(NOT_LEGAL),
  };
}

function invariantFailures(invariants) {
  return Object.entries(invariants).filter(([, ok]) => ok !== true).map(([name]) => name);
}

export function compareOptions(facts, invariants) {
  const broken = invariantFailures(invariants);
  const shape = [];
  if (facts?.approvalCount !== 1) shape.push("approval-count");
  if (facts?.effectiveCount !== 0) shape.push("effective-count");
  if (facts?.approvalVersion !== NOT_LEGAL) shape.push("approval-version");
  if (facts?.approvalEffective !== false) shape.push("approval-effective");
  if (facts?.acceptanceCount !== 1) shape.push("acceptance-count");
  if (facts?.acceptanceId !== ACCEPTANCE_ID) shape.push("acceptance-id");
  if (facts?.organisationId !== ORGANISATION_ID) shape.push("organisation-id");
  if (facts?.userId !== USER_ID) shape.push("user-id");
  if (facts?.markerUser !== false || facts?.markerOrganisation !== false) shape.push("marker");
  if (facts?.orgAcceptances !== 1 || facts?.orgMembers !== 1 || facts?.orgHotels !== 3) shape.push("organisation-graph");
  if (facts?.userOrganisations !== 1 || facts?.userAccounts !== 3 || facts?.userMemberships !== 1 || facts?.userAcceptances !== 1) {
    shape.push("user-graph");
  }
  const optionA = broken.length === 0 && shape.length === 0;
  return {
    A: {
      name: "remove-only-inactive-approval-row",
      allowed: optionA,
      reason: optionA
        ? "No foreign key ties the acceptance to the catalogue. The row is inactive, so property creation already ignores it. The acceptance trigger keeps the historical evidence."
        : `Refused until ${[...broken, ...shape].join(",") || "the shape"} matches.`,
    },
    B: {
      name: "retain-approval-and-change-concurrency",
      allowed: false,
      reason: "The concurrency gate requires an empty catalogue before it inserts fixtures. Tolerating fixture-not-legal would weaken that gate.",
    },
    C: {
      name: "fresh-isolated-branch",
      allowed: false,
      reason: `A child of ${EXPECTED_BRANCH} copies this row. A different branch or endpoint fails the pinned identity checks. ${RECOVERY_BRANCH} must not be modified, and Production must not be branched for this test.`,
    },
    failures: [...broken, ...shape],
    recommendation: optionA ? "A" : "NONE",
  };
}

export function removalSpecification() {
  return {
    authorised: false,
    writes: false,
    identity: {
      project: EXPECTED_PROJECT,
      branch: EXPECTED_BRANCH,
      endpoint: EXPECTED_ENDPOINT,
      database: EXPECTED_DATABASE,
      role: EXPECTED_ROLE,
      refusedBranch: RECOVERY_BRANCH,
    },
    preconditions: [
      "re-read the catalogue and abort unless it is exactly one inactive fixture-not-legal row",
      "re-read the acceptance and abort unless it is still the recorded id, organisation, and user",
      "abort if that acceptance, organisation, or user is absent or if the hotel or account counts differ",
      "abort if a foreign key from sbg_organisation_acceptances to the approval catalogue exists",
      "abort unless the acceptance delete trigger is enabled and the approval table has no delete trigger",
      "use only the isolated owner role; aether_app cannot write the catalogue",
    ],
    affected: [{ table: "sbg_approved_property_agreement_versions", agreementVersion: NOT_LEGAL, effective: false, count: 1 }],
    preserved: [
      { table: "sbg_organisation_acceptances", id: ACCEPTANCE_ID },
      { table: "sbg_organisations", id: ORGANISATION_ID },
      { table: "user", id: USER_ID },
      { table: "hotels", organisationId: ORGANISATION_ID, count: 3 },
      { table: "app_hotel_accounts", userId: USER_ID, count: 3 },
    ],
    transaction: "one",
    expectedRowCount: 1,
    rollbackUnless: [
      "the statement reports exactly one affected catalogue row",
      "the recorded acceptance row is still present and unchanged",
      "the approval catalogue count is then zero and the effective count is zero",
      "organisation, membership, hotel, and account counts are unchanged",
    ],
    postconditions: [
      "approval count is zero",
      "the historical acceptance remains",
      "the organisation, user, three hotels, and three hotel accounts remain",
      "the unchanged concurrency gate can then observe an empty catalogue",
    ],
    failureHandling: "Any mismatched predicate or count rolls the transaction back and leaves every row in place.",
    audit: "The acceptance row is the immutable evidence. The catalogue row is only an authorization flag. A false flag is retained history for a real superseded version; fixture-not-legal is a non-legal test token and is not a seeded legal version. Removing the flag does not erase the acceptance. Do not do this on Production.",
  };
}

export function planAgreementFixture({ acceptanceSql, propertySql, approvalSql, concurrencySql, facts = VERIFIED_FACTS }) {
  const invariants = catalogueInvariants({ acceptanceSql, propertySql, approvalSql, concurrencySql });
  const options = compareOptions(facts, invariants);
  const specification = removalSpecification();
  return {
    verdict: options.recommendation === "A" ? VERDICT_A : VERDICT_NONE,
    options,
    specification: options.recommendation === "A" ? specification : { ...specification, affected: [] },
    existingRecovery: "clean; fixture-not-legal is outside the recovery fixture list and would be left in place",
  };
}

export function planFromRepository(facts = VERIFIED_FACTS) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  return planAgreementFixture({
    acceptanceSql: read("migrations/0032_cp3005e2c1_organisation_acceptance.sql"),
    propertySql: read("migrations/0036_cp3005e2d2d_founding_integrity.sql"),
    approvalSql: `${read("migrations/0035_cp3005e2d2d_founding_property.sql")}\n${read("migrations/0036_cp3005e2d2d_founding_integrity.sql")}`,
    concurrencySql: read("scripts/a3-m36-isolated-concurrency.mjs"),
    facts,
  });
}

const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const plan = planFromRepository();
  console.log(plan.verdict);
  console.log(`recommendation: ${plan.options.recommendation}`);
  console.log(`option_b: refused`);
  console.log(`option_c: refused`);
  console.log(`existing_recovery: ${plan.existingRecovery}`);
  console.log("writes: none");
  process.exitCode = plan.verdict === VERDICT_A ? 0 : 1;
}
