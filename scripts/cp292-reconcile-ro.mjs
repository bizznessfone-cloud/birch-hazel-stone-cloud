#!/usr/bin/env node
/**
 * CP29.2 read-only reconcile of the disposable load branch.
 * SELECT only. No INSERT, UPDATE, DELETE, migration, grant, or SET ROLE.
 * Never prints the connection string.
 */
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING } from "./production-db-preflight.mjs";

const BASELINE = "30cdf18065c9f019e4ded5e75b57b15bde5407fe";
const CONFIRMATION = "RUN-CP29-2";
const EXPECTED_BRANCH = "br-mute-sky-b1tnej2d";
const EXPECTED_ENDPOINT = "ep-fancy-star-b1324ikc";
const FORBIDDEN_BRANCHES = ["br-green-darkness-b1k7wkue", "br-icy-shadow-b1fh96gk"];
const EXPECTED_PROJECT = "quiet-sound-53513710";
const EXPECTED_DB = "neondb";
const EXPECTED_ROLE = "aether_app";
const ALLOWED_DIFF = [
  ".github/workflows/cp292-reconcile-ro.yml",
  "scripts/cp292-reconcile-ro.mjs",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function say(message) {
  console.log(`CP292R ${message}`);
}

function redact(value) {
  let text = String(value ?? "");
  const raw = process.env.AETHER_CP29_DATABASE_URL;
  if (raw) {
    text = text.split(raw).join("postgres://redacted");
    try {
      const parsed = new URL(raw);
      if (parsed.password) {
        text = text.split(decodeURIComponent(parsed.password)).join("redacted");
        text = text.split(parsed.password).join("redacted");
      }
      if (parsed.username) text = text.split(parsed.username).join("redacted-user");
    } catch {
      /* best-effort */
    }
  }
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted");
}

function blocked(message) {
  console.error(`CP292R BLOCKED ${redact(message)}`);
  process.exitCode = 2;
}

function hostOk(connectionString) {
  let hostname = "";
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    return false;
  }
  if (!hostname.endsWith(".neon.tech")) return false;
  if (hostname.includes("-pooler")) return false;
  if (hostname.includes("green-darkness") || hostname.includes("icy-shadow")) return false;
  return hostname === EXPECTED_ENDPOINT || hostname.startsWith(`${EXPECTED_ENDPOINT}.`);
}

async function main() {
  if (process.env.CP292_CONFIRMATION !== CONFIRMATION) {
    blocked("confirmation rejected; database not opened");
    return;
  }
  say("confirmation=accepted");
  const commerce = String(process.env.SBG_SAAS_COMMERCE || "");
  const domainB = String(process.env.SBG_DOMAIN_B_LIVE_CHECKOUT || "");
  const stripe = String(process.env.STRIPE_SECRET_KEY || "");
  if (commerce === "live" || domainB === "true" || stripe.startsWith("sk_live_") || stripe.startsWith("rk_live_")) {
    blocked("live commerce or live stripe is set; database not opened");
    return;
  }
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RESEND_API_KEY;
  say("live_commerce=absent");

  const names = execFileSync("git", ["diff", "--name-only", BASELINE, "HEAD"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const allowed = [...ALLOWED_DIFF].sort();
  if (names.length !== allowed.length || names.some((name, index) => name !== allowed[index])) {
    blocked("tree differs from the authorised baseline by more than the read-only reconcile; database not opened");
    return;
  }
  execFileSync("git", ["merge-base", "--is-ancestor", BASELINE, "HEAD"], { cwd: root });
  say("git_baseline=readonly_reconcile_only");

  const files = (await readdir(join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
  if (
    files.length !== ACCEPTED_LEDGER.length ||
    files.some((name, index) => name !== ACCEPTED_LEDGER[index]) ||
    files.some((name) => name.startsWith("0031")) ||
    AUTHORISED_PENDING.length !== 0
  ) {
    blocked("source ledger is not exactly 0001-0030; database not opened");
    return;
  }
  say("source_ledger=0001-0030");

  const connectionString = process.env.AETHER_CP29_DATABASE_URL;
  if (!connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    blocked("CP29 database URL is missing or not postgres; database not opened");
    return;
  }
  if (!hostOk(connectionString)) {
    blocked("CP29 URL is not the authorised direct compute; database not opened");
    return;
  }
  say("transport=direct_host_allowlisted");

  const client = new pg.Client({
    connectionString,
    application_name: "cp292-reconcile-ro",
    connectionTimeoutMillis: 20000,
    statement_timeout: 20000,
    query_timeout: 20000,
  });
  await client.connect();
  try {
    const id = (
      await client.query(`
        select current_user, session_user, current_database() as database,
               pg_backend_pid() as pid,
               current_setting('neon.branch_id', true) as branch_id,
               current_setting('neon.project_id', true) as project_id,
               current_setting('neon.endpoint_id', true) as endpoint_id
      `)
    ).rows[0];
    const branchId = String(id.branch_id ?? "").trim();
    const projectId = String(id.project_id ?? "").trim();
    const endpointId = String(id.endpoint_id ?? "").trim();
    say(`current_user=${id.current_user}`);
    say(`session_user=${id.session_user}`);
    say(`database=${id.database}`);
    say(`pid=${id.pid}`);
    say(`branch_id=${branchId}`);
    say(`project_id=${projectId}`);
    say(`endpoint_id=${endpointId}`);
    const identityOk =
      id.current_user === EXPECTED_ROLE &&
      id.session_user === EXPECTED_ROLE &&
      id.database === EXPECTED_DB &&
      branchId === EXPECTED_BRANCH &&
      projectId === EXPECTED_PROJECT &&
      endpointId === EXPECTED_ENDPOINT &&
      !FORBIDDEN_BRANCHES.includes(branchId);
    say(`production_branch_connected=${branchId === FORBIDDEN_BRANCHES[0]}`);
    say(`cp28_branch_connected=${branchId === FORBIDDEN_BRANCHES[1]}`);
    if (!identityOk) {
      blocked("identity mismatch; no fixture query issued");
      return;
    }
    say("identity=exact");

    const hotels = await client.query(
      `select code, status::text as status
         from hotels
        where code like 'cp29-load-%'
        order by code`,
    );
    const statusCounts = {};
    const prefixes = new Set();
    for (const row of hotels.rows) {
      statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
      prefixes.add(String(row.code).slice(0, "cp29-load-".length + 6));
    }
    say(`fixture_hotels=${hotels.rows.length}`);
    say(`fixture_hotel_statuses=${JSON.stringify(statusCounts)}`);
    say(`fixture_prefixes=${[...prefixes].sort().join(",") || "(none)"}`);
    say(`fixture_hotel_codes=${hotels.rows.map((row) => row.code).join(",") || "(none)"}`);

    const bookings = (
      await client.query(
        `select count(*)::int as n,
                count(*) filter (where cancelled_at is not null)::int as cancelled,
                count(*) filter (where vehicle_id is not null)::int as with_vehicle,
                count(*) filter (where driver_id is not null)::int as with_driver
           from bookings
          where guest_email like 'cp29-load-%@example.test'`,
      )
    ).rows[0];
    say(`fixture_bookings=${bookings.n}`);
    say(`fixture_cancelled=${bookings.cancelled}`);
    say(`fixture_with_vehicle=${bookings.with_vehicle}`);
    say(`fixture_with_driver=${bookings.with_driver}`);

    const overlaps = async (column) =>
      (
        await client.query(
          `select count(*)::int as n
             from bookings a
             join bookings b
               on a.id < b.id
              and a.${column} = b.${column}
              and a.cancelled_at is null
              and b.cancelled_at is null
              and not isempty(a.occupies)
              and not isempty(b.occupies)
              and a.occupies && b.occupies
            where a.guest_email like 'cp29-load-%@example.test'
              and b.guest_email like 'cp29-load-%@example.test'`,
        )
      ).rows[0].n;
    say(`vehicle_overlaps=${await overlaps("vehicle_id")}`);
    say(`driver_overlaps=${await overlaps("driver_id")}`);

    const dup = (
      await client.query(
        `select count(*)::int as n from (
           select confirmation_token
             from bookings
            where guest_email like 'cp29-load-%@example.test'
            group by confirmation_token
           having count(*) > 1
         ) d`,
      )
    ).rows[0].n;
    say(`duplicate_tokens=${dup}`);

    const stuck = (
      await client.query(
        `select count(*)::int as n
           from pg_stat_activity
          where datname = current_database()
            and state = 'idle in transaction'
            and pid <> pg_backend_pid()`,
      )
    ).rows[0].n;
    say(`stuck_other_transactions=${stuck}`);

    const schema = (
      await client.query(`
        select
          (select string_agg(conname, ',' order by conname)
             from pg_constraint
            where conname in ('bookings_vehicle_occupancy_excl', 'bookings_driver_occupancy_excl')) as constraints,
          (select tgenabled::text
             from pg_trigger
            where tgname = 'bookings_occupies_before'
              and tgrelid = 'bookings'::regclass) as trigger
      `)
    ).rows[0];
    say(`occupancy_constraints=${schema.constraints}`);
    say(`occupancy_trigger=bookings_occupies_before:${schema.trigger}`);

    let migrations = "allowed";
    try {
      await client.query("select count(*) from _migrations");
    } catch (err) {
      migrations = err && err.code === "42501" ? "denied" : `other:${err?.code || "unknown"}`;
    }
    say(`migrations_table_select=${migrations}`);
    say("writes=none");
  } catch (err) {
    blocked(`read failed ${redact(err?.message)}`);
  } finally {
    await client.end();
  }
}

main();
