/**
 * CP27.2 — 0029 controller contract. No Production connection. No apply.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING, isAuthorisedPending } from "./production-db-preflight.mjs";
import { evaluateMigrationBaseline } from "./production-db-migrate.mjs";
import { evaluatePreflight } from "./production-db-preflight.mjs";
import {
  ALREADY_APPLIED,
  APPLIED_VERIFIED,
  AUTHORISED,
  CONFIRM_BLOCKED,
  CONTRACT_BLOCKED,
  POST_BLOCKED,
  REQUIRED_CONFIRMATION,
  REQUIRED_LEDGER,
  REVIEWED_DIGESTS,
  TARGET_DIGEST,
  TARGET_MIGRATION,
  UNEXPECTED_PLAN,
  apply0029Transaction,
  evaluate0029Aftermath,
  evaluate0029Baseline,
  runSingleUse0029,
} from "./cp272-0029-production-migrate.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sql = readFileSync(join(root, "migrations", TARGET_MIGRATION), "utf8");
const src = readFileSync(join(here, "cp272-0029-production-migrate.mjs"), "utf8");
const file = { name: TARGET_MIGRATION, sql, digest: TARGET_DIGEST };

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

function installedClaim(overrides = {}) {
  return {
    tablePresent: true,
    claimFunction: true,
    attachFunction: true,
    releaseFunction: true,
    appSelect: true,
    appInsert: false,
    appUpdate: false,
    appDelete: false,
    publicExecute: false,
    appExecute: true,
    claimRows: 0,
    ...overrides,
  };
}

function facts(overrides = {}) {
  return {
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...REQUIRED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    hotels: [{ code: "demo-kos", status: "live" }],
    licensedQuantity: 3,
    allocationCount: 4,
    bookingPaymentCount: 0,
    claim: {
      tablePresent: false,
      claimFunction: false,
      attachFunction: false,
      releaseFunction: false,
      appSelect: false,
      appInsert: false,
      appUpdate: false,
      appDelete: false,
      publicExecute: false,
      appExecute: false,
      claimRows: 0,
    },
    confirmation: REQUIRED_CONFIRMATION,
    ownerUrl: "postgres://owner@localhost/neondb",
    ...overrides,
  };
}

test("0029 digest is pinned and 0001-0028 are not edited by this controller", () => {
  const hash = createHash("sha256").update(sql).digest("hex");
  assert.equal(hash, TARGET_DIGEST);
  assert.equal(REVIEWED_DIGESTS[TARGET_MIGRATION], TARGET_DIGEST);
  assert.deepEqual(
    REQUIRED_LEDGER,
    ACCEPTED_LEDGER.filter(
      (name) =>
        name !== TARGET_MIGRATION &&
        name !== "0030_cp272_fix_prepare_booking_payment.sql" &&
        name !== "0031_cp3005e2c_organisation_type.sql",
    ),
  );
  assert.equal(ACCEPTED_LEDGER.includes(TARGET_MIGRATION), true);
  assert.equal(ACCEPTED_LEDGER.at(-1), "0031_cp3005e2c_organisation_type.sql");
  assert.equal(REQUIRED_LEDGER.includes(TARGET_MIGRATION), false);
  assert.deepEqual(AUTHORISED_PENDING, ["0032_cp3005e2c1_organisation_acceptance.sql"]);
  assert.equal(isAuthorisedPending(TARGET_MIGRATION), false);
  assert.equal(isAuthorisedPending("0030_later.sql"), false);
  assert.doesNotMatch(src, /from "\.\/migrate\.mjs"/);
  assert.doesNotMatch(src, /from "\.\/production-db-migrate\.mjs"/);
  assert.doesNotMatch(src, /db:migrate/);
  assert.equal(existsSync(join(root, ".github/workflows/cp272-0029-production-apply.yml")), false);
  const workflows = readdirSync(join(root, ".github/workflows")).sort();
  assert.deepEqual(workflows, ["cp3005e2c1-0032-production-apply.yml", "production-database.yml"]);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["db:migrate:0029"], undefined);
  assert.doesNotMatch(pkg.scripts.build, /0029|cp272/);
});

test("0029 baseline authorises only the reviewed pending file", () => {
  const ready = evaluate0029Baseline(facts(), file);
  assert.equal(ready.ok, true);
  assert.equal(ready.verdict, AUTHORISED);
  assert.equal(ready.migrated, false);
  assert.deepEqual(ready.pending, [TARGET_MIGRATION]);

  const missingPhrase = evaluate0029Baseline(facts({ confirmation: "nope" }), file);
  assert.equal(missingPhrase.ok, false);
  assert.equal(missingPhrase.verdict, CONFIRM_BLOCKED);

  const extra = evaluate0029Baseline(
    facts({ sourceMigrations: [...REQUIRED_LEDGER, TARGET_MIGRATION, "0030_later.sql"] }),
    file,
  );
  assert.equal(extra.ok, false);
  assert.equal(extra.verdict, UNEXPECTED_PLAN);
  assert.deepEqual(extra.unexpectedPending, ["0030_later.sql"]);
});

test("0029 already applied is a no-mutation success only when the contract holds", () => {
  const applied = evaluate0029Baseline(
    facts({
      ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
      claim: installedClaim(),
    }),
    file,
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.alreadyApplied, true);
  assert.equal(applied.verdict, ALREADY_APPLIED);
  assert.equal(applied.migrated, false);

  const broken = evaluate0029Baseline(
    facts({
      ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
      claim: installedClaim({ appInsert: true }),
    }),
    file,
  );
  assert.equal(broken.ok, false);
  assert.equal(broken.verdict, CONTRACT_BLOCKED);
});

test("0029 aftermath refuses hotel, licence, allocation, or payment drift", () => {
  const before = facts();
  const after = facts({
    ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
    claim: installedClaim(),
  });
  const ok = evaluate0029Aftermath(after, before);
  assert.equal(ok.ok, true);
  assert.equal(ok.verdict, APPLIED_VERIFIED);
  assert.equal(ok.committed, true);

  const drifted = evaluate0029Aftermath(
    facts({
      ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
      claim: installedClaim(),
      licensedQuantity: 50,
      hotels: [{ code: "demo-kos", status: "configured" }],
    }),
    before,
  );
  assert.equal(drifted.ok, false);
  assert.equal(drifted.verdict, POST_BLOCKED);
  assert.ok(drifted.failures.includes("licensed-quantity"));
  assert.ok(drifted.failures.includes("hotel-status"));
});

test("0029 apply transaction rolls back when verification fails", async () => {
  const queries = [];
  const result = await apply0029Transaction({
    sql,
    before: facts(),
    query: async (text) => {
      queries.push(String(text));
      return { rows: [] };
    },
    inspect: async () =>
      facts({
        ledger: [...REQUIRED_LEDGER, TARGET_MIGRATION],
        claim: installedClaim({ appDelete: true }),
      }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.committed, false);
  assert.equal(result.migrated, false);
  assert.ok(queries.includes("BEGIN"));
  assert.ok(queries.includes("ROLLBACK"));
  assert.equal(queries.includes("COMMIT"), false);
});

test("runSingleUse0029 does not call mutate when confirmation or the plan fails", async () => {
  let calls = 0;
  const blocked = await runSingleUse0029({
    env: { AETHER_DATABASE_OWNER_URL: "postgres://owner@localhost/neondb" },
    confirmation: "APPLY-0030",
    file,
    loadFacts: async () => facts(),
    mutate: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  assert.equal(blocked.verdict, CONFIRM_BLOCKED);
  assert.equal(calls, 0);
  assert.equal(blocked.migrated, false);
});

test("Gate B accepts applied 0029 and the generic migrator still will not apply SQL", () => {
  const gate = evaluatePreflight({
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...ACCEPTED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...ACCEPTED_LEDGER],
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    aetherAppExists: true,
    occupancy,
    tableOwners: { hotels: "neondb_owner", bookings: "neondb_owner" },
    hotel: { code: "demo-kos", status: "live" },
  });
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.pending, []);
  assert.equal(gate.ledger.includes(TARGET_MIGRATION), true);
  const generic = evaluateMigrationBaseline(gate);
  assert.equal(generic.ok, true);
  assert.equal(generic.migrated, false);

  const stale = evaluatePreflight({
    database: "neondb",
    currentUser: "neondb_owner",
    sessionUser: "neondb_owner",
    ledger: [...REQUIRED_LEDGER],
    ledgerReadable: true,
    sourceMigrations: [...ACCEPTED_LEDGER],
    authTables: { user: "PRESENT", session: "PRESENT", account: "PRESENT", verification: "PRESENT" },
    aetherAppExists: true,
    occupancy,
    tableOwners: { hotels: "neondb_owner", bookings: "neondb_owner" },
    hotel: { code: "demo-kos", status: "live" },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.verdict, "BLOCKED — MIGRATION LEDGER INCONSISTENT");
});

test("controller entry refuses to run without the confirmation phrase", async () => {
  const { stdout, stderr, code } = await execFileAsync(
    process.execPath,
    [join(here, "cp272-0029-production-migrate.mjs")],
    {
      env: {
        PATH: process.env.PATH,
        AETHER_DATABASE_OWNER_URL: "postgres://owner:secret@host/neondb",
      },
    },
  ).catch((err) => err);
  const out = `${stdout || ""}${stderr || ""}`;
  assert.match(out, new RegExp(CONFIRM_BLOCKED));
  assert.doesNotMatch(out, /secret/);
  assert.doesNotMatch(out, /postgres:\/\/owner/);
  assert.equal(code === 0, false);
});
