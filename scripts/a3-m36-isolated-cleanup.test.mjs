/**
 * A3-M36 fixture cleanup. No database is opened.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  CLEANUP_ORDER,
  EXPECTED_EDGES,
  FIXTURE_EFFECTIVE,
  REQUIRED_TRIGGERS,
  cleanupFixtures,
  dependencyViolations,
  foreignKeyReview,
  graphFailures,
  unexpectedReferenceVerdict,
} from "./a3-m36-isolated-cleanup.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cleanupSrc = readFileSync(join(root, "scripts/a3-m36-isolated-cleanup.mjs"), "utf8");
const migration27 = readFileSync(join(root, "migrations/0027_cp26co41_organisation_property_licence.sql"), "utf8");
const migration32 = readFileSync(join(root, "migrations/0032_cp3005e2c1_organisation_acceptance.sql"), "utf8");
const migration18 = readFileSync(join(root, "migrations/0018_cp22_saas_onboarding.sql"), "utf8");
const migration12 = readFileSync(join(root, "migrations/0012_cp12_tenancy.sql"), "utf8");

const userId = "a3m36-11111111-1111-4111-8111-111111111111";
const orgId = "11111111-1111-4111-8111-111111111111";
const hotelId = "22222222-2222-4222-8222-222222222222";
const providerId = "33333333-3333-4333-8333-333333333333";
const agreementId = "44444444-4444-4444-8444-444444444444";
const memberId = "55555555-5555-4555-8555-555555555555";
const acceptanceId = "66666666-6666-4666-8666-666666666666";

function markerUser(id = userId) {
  return { id, name: "A3M36 Holder", email: `a3m36-proof-${id}@invalid.scanbookgo.test` };
}

function catalog(extra = []) {
  return [
    ...EXPECTED_EDGES.map((edge) => ({
      child_schema: "public",
      child_table: edge.child,
      parent_table: edge.parent,
      constraint_name: `${edge.child}_${edge.column}_fkey`,
      delete_action: edge.child === "app_hotel_accounts" ? "c" : "r",
      child_columns: [edge.column],
      parent_columns: ["id"],
    })),
    ...extra,
  ];
}

function bookingEdge() {
  return {
    child_schema: "public",
    child_table: "bookings",
    parent_table: "hotels",
    constraint_name: "bookings_hotel_id_fkey",
    delete_action: "a",
    child_columns: ["hotel_id"],
    parent_columns: ["id"],
  };
}

function fakeDb({ acceptanceError = false, bookingOnSecondCatalog = false, triggersEnabled = true } = {}) {
  const queries = [];
  let catalogs = 0;
  const db = {
    queries,
    async query(text) {
      const sql = String(text);
      queries.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql.includes("a3m36-trigger-guard")) {
        return { rows: REQUIRED_TRIGGERS.map((tgname) => ({ tgname, tgenabled: triggersEnabled ? "O" : "D" })) };
      }
      if (sql.includes("a3m36-load-users")) return { rows: [markerUser()] };
      if (sql.includes("a3m36-load-orgs")) return { rows: [{ id: orgId, name: "A3M36 Holder", created_by_user_id: userId }] };
      if (sql.includes("a3m36-load-hotels")) {
        return { rows: [{ id: hotelId, name: "A3M36 Property", code: "a3m36-property", organisation_id: orgId, user_id: userId }] };
      }
      if (sql.includes("a3m36-load-providers")) return { rows: [{ id: providerId, name: "A3M36 Property Transfers", hotel_ids: [hotelId] }] };
      if (sql.includes("a3m36-load-agreements")) return { rows: [{ id: agreementId, hotel_id: hotelId, provider_id: providerId }] };
      if (sql.includes("a3m36-load-accounts")) return { rows: [{ user_id: userId, hotel_id: hotelId }] };
      if (sql.includes("a3m36-load-members")) return { rows: [{ id: memberId, organisation_id: orgId, user_id: userId }] };
      if (sql.includes("a3m36-load-acceptances")) return { rows: [{ id: acceptanceId, organisation_id: orgId, user_id: userId }] };
      if (sql.includes("a3m36-load-approvals")) return { rows: [{ agreement_version: FIXTURE_EFFECTIVE }] };
      if (sql.includes("a3m36-foreign-keys")) {
        catalogs += 1;
        return { rows: catalog(bookingOnSecondCatalog && catalogs > 1 ? [bookingEdge()] : []) };
      }
      if (sql.includes("a3m36-residual")) return { rows: [{ n: sql.includes("bookings hotels") ? 1 : 0 }] };
      if (sql.includes("a3m36-lock")) return { rows: [{ id: "locked" }], rowCount: 1 };
      if (sql.includes("a3m36-delete acceptances") && acceptanceError) {
        const error = new Error("organisation acceptance evidence is immutable");
        error.code = "42501";
        error.table = "sbg_organisation_acceptances";
        error.constraint = "sbg_organisation_acceptances_immutable";
        throw error;
      }
      if (sql.includes("a3m36-delete")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected sql ${sql.split("\n")[0]}`);
    },
  };
  return db;
}

test("cleanup order follows the migration foreign keys and keeps safeguards", () => {
  assert.deepEqual(dependencyViolations(), []);
  assert.equal(CLEANUP_ORDER.indexOf("hotel_provider_agreements") < CLEANUP_ORDER.indexOf("hotels"), true);
  assert.equal(CLEANUP_ORDER.indexOf("app_hotel_accounts") < CLEANUP_ORDER.indexOf("hotels"), true);
  assert.equal(CLEANUP_ORDER.indexOf("hotel_provider_agreements") < CLEANUP_ORDER.indexOf("providers"), true);
  assert.equal(CLEANUP_ORDER.indexOf("hotels") < CLEANUP_ORDER.indexOf("sbg_organisations"), true);
  assert.equal(CLEANUP_ORDER.indexOf("sbg_organisation_acceptances") < CLEANUP_ORDER.indexOf("sbg_organisations"), true);
  assert.equal(CLEANUP_ORDER.indexOf("sbg_organisation_members") < CLEANUP_ORDER.indexOf("user"), true);
  assert.equal(CLEANUP_ORDER.indexOf("sbg_organisations") < CLEANUP_ORDER.indexOf("user"), true);
  assert.match(migration12, /hotel_id uuid not null references hotels \(id\) on delete restrict/);
  assert.match(migration12, /provider_id uuid not null references providers \(id\) on delete restrict/);
  assert.match(migration18, /references "user" \("id"\) on delete cascade/);
  assert.match(migration18, /references hotels \(id\) on delete cascade/);
  assert.match(migration18, /insert into hotel_provider_agreements/);
  assert.match(migration18, /insert into app_hotel_accounts/);
  const attachStart = migration27.indexOf("function sbg_attach_hotel_to_organisation");
  const attachEnd = migration27.indexOf("function sbg_allocate_property_licence");
  const attach = migration27.slice(attachStart, attachEnd);
  assert.match(attach, /set organisation_id/);
  assert.doesNotMatch(attach, /insert into sbg_property_licence_allocations/);
  assert.match(migration27, /organisation commercial history cannot be deleted/);
  assert.match(migration27, /before delete on sbg_organisations/);
  assert.match(migration27, /before delete on sbg_organisation_members/);
  assert.match(migration27, /references sbg_organisations \(id\) on delete restrict/);
  assert.match(migration32, /organisation acceptance evidence is immutable/);
  assert.match(migration32, /before update or delete on sbg_organisation_acceptances/);
  assert.doesNotMatch(migration32, /references sbg_approved_property_agreement_versions/);
  assert.doesNotMatch(cleanupSrc, /disable trigger/i);
  assert.doesNotMatch(cleanupSrc, /enable trigger/i);
  assert.doesNotMatch(cleanupSrc, /alter table/i);
  assert.doesNotMatch(cleanupSrc, /session_replication_role/);
  assert.doesNotMatch(cleanupSrc, /terms-v1'\)/);
});

test("fixture selection refuses mixed, non-marker, and terms-v1 rows", () => {
  const user = markerUser();
  assert.deepEqual(graphFailures({
    users: [user],
    orgs: [{ id: orgId, name: "A3M36 Holder", created_by_user_id: userId }],
    members: [{ id: memberId, organisation_id: orgId, user_id: userId }],
    acceptances: [],
    hotels: [],
    providers: [],
    agreements: [],
    accounts: [],
    approvals: [{ agreement_version: FIXTURE_EFFECTIVE }],
  }), []);
  assert.match(graphFailures({ users: [{ id: userId, name: "A3M36 Holder", email: "owner@example.com" }], orgs: [], members: [], acceptances: [], hotels: [], providers: [], agreements: [], accounts: [], approvals: [] }).join("\n"), /NON-MARKER USER/);
  assert.match(graphFailures({
    users: [user],
    orgs: [{ id: orgId, name: "A3M36 Holder", created_by_user_id: userId }],
    members: [{ id: memberId, organisation_id: orgId, user_id: "real-user" }],
    acceptances: [],
    hotels: [],
    providers: [],
    agreements: [],
    accounts: [],
    approvals: [],
  }).join("\n"), /MEMBERSHIP/);
  assert.match(graphFailures({
    users: [],
    orgs: [],
    members: [],
    acceptances: [],
    hotels: [],
    providers: [],
    agreements: [],
    accounts: [],
    approvals: [{ agreement_version: "terms-v1" }],
  }).join("\n"), /NON-FIXTURE APPROVAL/);
});

test("an unplanned reference or a missing expected foreign key blocks before deletion", () => {
  const hotelsOnly = { users: [], orgs: [], members: [], acceptances: [], hotels: [{ id: hotelId }], providers: [], agreements: [], accounts: [], approvals: [] };
  assert.match(foreignKeyReview([], hotelsOnly).failures.join("\n"), /EXPECTED FOREIGN KEY ABSENT hotel_provider_agreements→hotels/);
  const review = foreignKeyReview([{
    childSchema: "public",
    childTable: "bookings",
    parentTable: "hotels",
    constraint: "bookings_hotel_id_fkey",
    deleteAction: "a",
    childColumns: ["hotel_id"],
    parentColumns: ["id"],
  }], {
    users: [],
    orgs: [],
    members: [],
    acceptances: [],
    hotels: [{ id: hotelId }],
    providers: [],
    agreements: [],
    accounts: [],
    approvals: [],
  });
  assert.equal(review.unexpected.length, 1);
  assert.match(unexpectedReferenceVerdict([{ ...review.unexpected[0], count: 2 }]), /UNEXPECTED REFERENCE bookings.hotel_id -> hotels/);
  assert.match(unexpectedReferenceVerdict([{ ...review.unexpected[0], count: 2 }]), /rows=2/);
});

test("a trigger refusal rolls back the whole cleanup and preserves the rows", async () => {
  const db = fakeDb({ acceptanceError: true });
  const result = await cleanupFixtures(db, { userIds: [userId], approvals: true });
  assert.equal(result.ok, false);
  assert.equal(result.preserved, true);
  assert.equal(result.transaction, "rolled-back");
  assert.match(result.verdict, /sbg_organisation_acceptances/);
  assert.match(result.verdict, /42501/);
  assert.match(result.verdict, /organisation acceptance evidence is immutable/);
  assert.equal(result.removed.hotels, 0);
  assert.equal(result.removed.user, 0);
  assert.equal(result.identified.hotels, 1);
  assert.equal(result.identified.sbg_organisation_acceptances, 1);
  const joined = db.queries.join("\n");
  const begin = joined.indexOf("\nbegin");
  const agreements = joined.indexOf("a3m36-delete hotel_provider_agreements");
  const accounts = joined.indexOf("a3m36-delete app_hotel_accounts");
  const hotels = joined.indexOf("a3m36-delete hotels");
  const providers = joined.indexOf("a3m36-delete providers");
  const approvals = joined.indexOf("a3m36-delete approvals");
  const acceptances = joined.indexOf("a3m36-delete acceptances");
  const rollback = joined.lastIndexOf("\nrollback");
  assert.ok(begin < agreements && agreements < accounts && accounts < hotels && hotels < providers && providers < approvals && approvals < acceptances && acceptances < rollback);
  assert.equal(joined.includes("a3m36-delete members"), false);
  assert.equal(joined.includes("\ncommit"), false);
  assert.doesNotMatch(joined, /disable trigger/i);
});

test("a reference found after locking rolls back before any delete", async () => {
  const db = fakeDb({ bookingOnSecondCatalog: true });
  const result = await cleanupFixtures(db, { userIds: [userId], approvals: true });
  assert.equal(result.ok, false);
  assert.equal(result.preserved, true);
  assert.equal(result.transaction, "rolled-back");
  assert.match(result.verdict, /UNEXPECTED REFERENCE bookings/);
  const joined = db.queries.join("\n");
  assert.match(joined, /\nbegin/);
  assert.match(joined, /\nrollback/);
  assert.doesNotMatch(joined, /a3m36-delete/);
  assert.doesNotMatch(joined, /\ncommit/);
});

test("an unexpected reference or a disabled trigger does not start a transaction", async () => {
  const referenced = fakeDb();
  referenced.query = async function query(text) {
    const sql = String(text);
    this.queries.push(sql);
    if (sql.includes("a3m36-trigger-guard")) return { rows: REQUIRED_TRIGGERS.map((tgname) => ({ tgname, tgenabled: "O" })) };
    if (sql.includes("a3m36-load-users")) return { rows: [markerUser()] };
    if (sql.includes("a3m36-load-orgs")) return { rows: [{ id: orgId, name: "A3M36 Holder", created_by_user_id: userId }] };
    if (sql.includes("a3m36-load-hotels")) return { rows: [{ id: hotelId, name: "A3M36 Property", code: "a3m36-property", organisation_id: orgId, user_id: userId }] };
    if (sql.includes("a3m36-load-providers")) return { rows: [{ id: providerId, name: "A3M36 Property Transfers", hotel_ids: [hotelId] }] };
    if (sql.includes("a3m36-load-agreements")) return { rows: [{ id: agreementId, hotel_id: hotelId, provider_id: providerId }] };
    if (sql.includes("a3m36-load-accounts")) return { rows: [{ user_id: userId, hotel_id: hotelId }] };
    if (sql.includes("a3m36-load-members")) return { rows: [{ id: memberId, organisation_id: orgId, user_id: userId }] };
    if (sql.includes("a3m36-load-acceptances")) return { rows: [{ id: acceptanceId, organisation_id: orgId, user_id: userId }] };
    if (sql.includes("a3m36-load-approvals")) return { rows: [] };
    if (sql.includes("a3m36-foreign-keys")) return { rows: catalog([bookingEdge()]) };
    if (sql.includes("a3m36-residual")) return { rows: [{ n: sql.includes("bookings hotels") ? 1 : 0 }] };
    throw new Error(`unexpected sql ${sql.split("\n")[0]}`);
  };
  const blocked = await cleanupFixtures(referenced, { userIds: [userId], approvals: true });
  assert.match(blocked.verdict, /UNEXPECTED REFERENCE/);
  assert.equal(blocked.transaction, "not-started");
  assert.doesNotMatch(referenced.queries.join("\n"), /\nbegin/);
  const disabled = fakeDb({ triggersEnabled: false });
  const guarded = await cleanupFixtures(disabled, { userIds: [userId], approvals: true });
  assert.match(guarded.verdict, /REQUIRED TRIGGER NOT ENABLED/);
  assert.equal(guarded.transaction, "not-started");
  assert.doesNotMatch(disabled.queries.join("\n"), /\nbegin/);
});

test("approval fixtures with no immutable rows commit in one transaction", async () => {
  const queries = [];
  const db = {
    queries,
    async query(text) {
      const sql = String(text);
      queries.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql.includes("a3m36-trigger-guard")) return { rows: REQUIRED_TRIGGERS.map((tgname) => ({ tgname, tgenabled: "O" })) };
      if (sql.includes("a3m36-load-approvals")) return { rows: [{ agreement_version: FIXTURE_EFFECTIVE }] };
      if (sql.includes("a3m36-foreign-keys")) return { rows: [] };
      if (sql.includes("a3m36-lock")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("a3m36-delete approvals")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected sql ${sql.split("\n")[0]}`);
    },
  };
  const result = await cleanupFixtures(db, { userIds: [], approvals: true });
  assert.equal(result.ok, true);
  assert.equal(result.preserved, false);
  assert.equal(result.transaction, "committed");
  assert.equal(result.removed.sbg_approved_property_agreement_versions, 1);
  assert.equal(result.removed.user, 0);
  const joined = queries.join("\n");
  assert.match(joined, /\nbegin/);
  assert.match(joined, /\ncommit/);
  assert.match(joined, /agreement_version <> 'terms-v1'/);
  assert.doesNotMatch(joined, /a3m36-delete acceptances|a3m36-delete users/);
});
