#!/usr/bin/env node
/**
 * CP29.2A disposable fixture publication and the CP29.2 phases skipped
 * because those hotels were still configured.
 *
 * Runtime work uses AETHER_CP29_DATABASE_URL as aether_app.
 * Publication uses AETHER_CP29_OWNER_DATABASE_URL only, and only
 * promoteHotelToLive on the four existing fixture hotels.
 * Does not migrate, grant, SET ROLE, call Stripe, or call Resend.
 * Never prints a connection string.
 */
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING } from "./production-db-preflight.mjs";

const BASELINE = "3b343bc23ca383fbc676e87523e486b81a630f90";
const CONFIRMATION = "RUN-CP29-2A";
const EXPECTED_BRANCH = "br-mute-sky-b1tnej2d";
const EXPECTED_ENDPOINT = "ep-fancy-star-b1324ikc";
const FORBIDDEN_BRANCHES = ["br-green-darkness-b1k7wkue", "br-icy-shadow-b1fh96gk"];
const EXPECTED_PROJECT = "quiet-sound-53513710";
const EXPECTED_DB = "neondb";
const EXPECTED_ROLE = "aether_app";
const EXPECTED_OWNER = "neondb_owner";
const FIXTURE_CODES = [
  "cp29-load-05af6a0",
  "cp29-load-05af6a1",
  "cp29-load-05af6a2",
  "cp29-load-05af6a3",
];
const FIXTURE_PREFIX = "cp29-load-05af6a";
const EMAIL_LIKE = "cp29-load-%@example.test";
const KEY_PREFIX = "cp29-2a-";
const ALLOWED_DIFF = [
  ".github/workflows/cp292a-disposable-publication.yml",
  "scripts/cp292a-disposable-publication.mjs",
];
const MAX_CLIENTS = 8;
const DEADLINE_MS = 14 * 60 * 1000;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const report = { phases: {}, correctness: {}, publication: null };
let exitCode = 0;
const startedAt = Date.now();

function say(message) {
  console.log(`CP292A ${message}`);
}

function redact(value) {
  let text = String(value ?? "");
  for (const raw of [process.env.AETHER_CP29_DATABASE_URL, process.env.AETHER_CP29_OWNER_DATABASE_URL]) {
    if (!raw) continue;
    text = text.split(raw).join("postgres://redacted");
    try {
      const parsed = new URL(raw);
      if (parsed.password) {
        text = text.split(decodeURIComponent(parsed.password)).join("redacted");
        text = text.split(parsed.password).join("redacted");
      }
    } catch {
      /* best-effort */
    }
  }
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted");
}

function blocked(message) {
  console.error(`CP292A BLOCKED ${redact(message)}`);
  if (exitCode === 0) exitCode = 2;
}

function failed(message) {
  console.error(`CP292A FAIL ${redact(message)}`);
  if (exitCode === 0) exitCode = 1;
}

function failCode(err) {
  if (!err) return "";
  if (err.name === "BookingError" || err.name === "ProvisionError" || err.name === "InventoryError") {
    return String(err.code || "");
  }
  return String(err.code || err.name || "");
}

function pastDeadline() {
  return Date.now() - startedAt > DEADLINE_MS;
}

function dist(samples) {
  const xs = samples.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const pick = (p) => {
    if (!xs.length) return null;
    const index = Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1));
    return Math.round(xs[index]);
  };
  return {
    n: xs.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: xs.length ? Math.round(xs[xs.length - 1]) : null,
  };
}

function assertConfirmation() {
  if (process.env.CP292A_CONFIRMATION !== CONFIRMATION) {
    blocked("confirmation rejected; database not opened");
    return false;
  }
  say("confirmation=accepted");
  return true;
}

function assertNoLiveCommerce() {
  const commerce = String(process.env.SBG_SAAS_COMMERCE || "");
  const domainB = String(process.env.SBG_DOMAIN_B_LIVE_CHECKOUT || "");
  const stripe = String(process.env.STRIPE_SECRET_KEY || "");
  if (commerce === "live" || domainB === "true") {
    blocked("live commerce flag is set; database not opened");
    return false;
  }
  if (stripe.startsWith("sk_live_") || stripe.startsWith("rk_live_")) {
    blocked("live stripe key is set; database not opened");
    return false;
  }
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.DATABASE_URL;
  delete process.env.AETHER_DATABASE_OWNER_URL;
  say("live_commerce=absent");
  say("stripe_network=disabled");
  say("resend_network=disabled");
  return true;
}

function assertGitBaseline() {
  const names = execFileSync("git", ["diff", "--name-only", BASELINE, "HEAD"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const allowed = [...ALLOWED_DIFF].sort();
  say(`diff_from_baseline=${names.join(",") || "(none)"}`);
  if (names.length !== allowed.length || names.some((name, index) => name !== allowed[index])) {
    blocked("tree differs from the authorised baseline by more than the temporary CP29.2A harness; database not opened");
    return false;
  }
  execFileSync("git", ["merge-base", "--is-ancestor", BASELINE, "HEAD"], { cwd: root });
  say("git_baseline=temporary_harness_only");
  return true;
}

async function assertSourceLedger() {
  const files = (await readdir(join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
  const same = files.length === ACCEPTED_LEDGER.length && files.every((name, index) => name === ACCEPTED_LEDGER[index]);
  say(`source_migrations=${files.length}`);
  say(`source_last=${files.at(-1) ?? "(none)"}`);
  say(`authorised_pending=${JSON.stringify(AUTHORISED_PENDING)}`);
  if (!same || files.some((name) => name.startsWith("0031")) || AUTHORISED_PENDING.length !== 0) {
    blocked("source ledger is not exactly 0001-0030 with an empty pending list; database not opened");
    return false;
  }
  say("source_ledger=0001-0030");
  return true;
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

function makeClient(connectionString, name) {
  return new pg.Client({
    connectionString,
    application_name: name,
    connectionTimeoutMillis: 20000,
    statement_timeout: 20000,
    query_timeout: 20000,
  });
}

async function readIdentity(client) {
  const row = (
    await client.query(`
      select
        current_user,
        session_user,
        current_database() as database,
        pg_backend_pid() as pid,
        current_setting('neon.branch_id', true) as branch_id,
        current_setting('neon.project_id', true) as project_id,
        current_setting('neon.endpoint_id', true) as endpoint_id
    `)
  ).rows[0];
  return {
    currentUser: String(row.current_user ?? ""),
    sessionUser: String(row.session_user ?? ""),
    database: String(row.database ?? ""),
    pid: Number(row.pid),
    branchId: String(row.branch_id ?? "").trim(),
    projectId: String(row.project_id ?? "").trim(),
    endpointId: String(row.endpoint_id ?? "").trim(),
  };
}

function branchOk(label, id) {
  say(`${label}_current_user=${id.currentUser}`);
  say(`${label}_session_user=${id.sessionUser}`);
  say(`${label}_database=${id.database}`);
  say(`${label}_pid=${id.pid}`);
  say(`${label}_branch_id=${id.branchId || "(empty)"}`);
  say(`${label}_project_id=${id.projectId || "(empty)"}`);
  say(`${label}_endpoint_id=${id.endpointId || "(empty)"}`);
  if (FORBIDDEN_BRANCHES.includes(id.branchId)) {
    blocked(`${label} is a forbidden branch; no writes`);
    return false;
  }
  if (id.branchId !== EXPECTED_BRANCH || id.projectId !== EXPECTED_PROJECT || id.endpointId !== EXPECTED_ENDPOINT) {
    blocked(`${label} is not the authorised CP29 branch; no writes`);
    return false;
  }
  if (id.database !== EXPECTED_DB || id.currentUser !== id.sessionUser) {
    blocked(`${label} database or role identity is not stable; no writes`);
    return false;
  }
  if (!Number.isInteger(id.pid) || id.pid <= 0) {
    blocked(`${label} backend pid missing; no writes`);
    return false;
  }
  say(`${label}_production_branch_connected=false`);
  say(`${label}_cp28_branch_connected=false`);
  return true;
}

function adapter(client) {
  return {
    async query(text, params = []) {
      const result = await client.query(text, params);
      return result.rows;
    },
    async transaction(fn) {
      await client.query("BEGIN");
      try {
        const value = await fn(adapter(client));
        await client.query("COMMIT");
        return value;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* already aborted */
        }
        throw err;
      }
    },
  };
}

async function expectDenied(client, sql, label) {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("ROLLBACK");
    failed(`${label} unexpectedly succeeded`);
    return false;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* aborted */
    }
    const code = err?.code || "";
    say(`${label}_sqlstate=${code || "(none)"}`);
    if (code !== "42501") {
      failed(`${label} expected 42501, got ${code || redact(err?.message)}`);
      return false;
    }
    return true;
  }
}

const DENIALS = [
  ["alter table bookings disable trigger bookings_occupies_before", "disable_occupancy_trigger"],
  ["alter table bookings drop constraint bookings_vehicle_occupancy_excl", "drop_vehicle_exclude"],
  ["alter table bookings drop constraint bookings_driver_occupancy_excl", "drop_driver_exclude"],
  ["delete from bookings where false", "delete_bookings"],
  ["set role neondb_owner", "set_role_owner"],
  ["insert into _migrations (name) values ('0031_cp292a_forbidden')", "insert_migration"],
  ["update hotels set status = 'live' where code = 'cp29-not-authorised-hotel'", "publish_unauthorised_hotel"],
];

async function assertSchema(client) {
  const constraints = (
    await client.query(
      `select c.conname
         from pg_constraint c
         join pg_class r on r.oid = c.conrelid
         join pg_namespace n on n.oid = r.relnamespace
        where n.nspname = 'public'
          and r.relname = 'bookings'
          and c.conname in ('bookings_vehicle_occupancy_excl', 'bookings_driver_occupancy_excl')
        order by c.conname`,
    )
  ).rows.map((row) => row.conname);
  const trigger = (
    await client.query(
      `select tgname, tgenabled
         from pg_trigger
        where tgrelid = 'public.bookings'::regclass
          and tgname = 'bookings_occupies_before'
          and not tgisinternal`,
    )
  ).rows[0];
  say(`occupancy_constraints=${constraints.join(",") || "(none)"}`);
  say(`occupancy_trigger=${trigger ? `${trigger.tgname}:${trigger.tgenabled}` : "(missing)"}`);
  if (constraints.length !== 2 || !trigger || trigger.tgenabled === "D") {
    blocked("occupancy protection is missing; no further writes");
    return null;
  }
  try {
    await client.query("select name from _migrations order by name");
    blocked("runtime can read _migrations; no further writes");
    return null;
  } catch (err) {
    if (err?.code !== "42501") {
      blocked(`migration ledger read failed ${err?.code || ""} ${redact(err?.message)}`);
      return null;
    }
    say("migrations_table_select=denied");
  }
  return { constraints, trigger: trigger.tgenabled };
}

async function hotelSnapshot(client) {
  const rows = (
    await client.query(`select code, status from hotels order by code`)
  ).rows.map((row) => ({ code: String(row.code), status: String(row.status) }));
  return rows;
}

async function fixtureState(client) {
  const hotels = (
    await client.query(
      `select code, status
         from hotels
        where code like 'cp29-load-%'
        order by code`,
    )
  ).rows;
  const bookings = (
    await client.query(`select count(*)::int as n from bookings where guest_email like $1`, [EMAIL_LIKE])
  ).rows[0].n;
  const prefixes = [...new Set(hotels.map((row) => String(row.code).slice(0, FIXTURE_PREFIX.length)))];
  return {
    hotels,
    bookings: Number(bookings),
    prefixes,
  };
}

async function overlapCount(client, column) {
  const row = (
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
        where a.guest_email like $1
          and b.guest_email like $1`,
      [EMAIL_LIKE],
    )
  ).rows[0];
  return Number(row.n);
}

async function invariants(client, pids) {
  const vehicleOverlaps = await overlapCount(client, "vehicle_id");
  const driverOverlaps = await overlapCount(client, "driver_id");
  const dupTokens = Number(
    (
      await client.query(
        `select count(*)::int as n from (
           select confirmation_token from bookings group by confirmation_token having count(*) > 1
         ) d`,
      )
    ).rows[0].n,
  );
  const bookings = Number(
    (await client.query(`select count(*)::int as n from bookings where guest_email like $1`, [EMAIL_LIKE])).rows[0].n,
  );
  const stuck = Number(
    (
      await client.query(
        `select count(*)::int as n
           from pg_stat_activity
          where datname = current_database()
            and state = 'idle in transaction'
            and pid <> all($1::int[])`,
        [pids],
      )
    ).rows[0].n,
  );
  const crossTenant = Number(
    (
      await client.query(
        `select count(*)::int as n
           from bookings b
           join idempotency_keys k on k.booking_id = b.id
          where k.key like $1
            and (
              b.vehicle_id is not null
              or b.driver_id is not null
              or b.hotel_id not in (select id from hotels where code = any($2::text[]))
              or not exists (
                select 1 from hotel_provider_agreements a
                 where a.hotel_id = b.hotel_id
                   and a.provider_id = b.executing_provider_id
                   and a.active
              )
            )`,
        [`${KEY_PREFIX}%`, FIXTURE_CODES],
      )
    ).rows[0].n,
  );
  return { vehicleOverlaps, driverOverlaps, dupTokens, bookings, stuck, crossTenant };
}

async function privilegeHash(client) {
  const table = (
    await client.query(
      `select md5(coalesce(string_agg(table_name || ':' || privilege_type, ',' order by table_name, privilege_type), '')) as h
         from information_schema.role_table_grants
        where grantee = current_user`,
    )
  ).rows[0].h;
  const column = (
    await client.query(
      `select md5(coalesce(string_agg(table_name || '.' || column_name || ':' || privilege_type, ',' order by table_name, column_name, privilege_type), '')) as h
         from information_schema.column_privileges
        where grantee = current_user`,
    )
  ).rows[0].h;
  const roles = Number((await client.query(`select count(*)::int as n from pg_roles`)).rows[0].n);
  return { table, column, roles };
}

function bookingInput(hotel, when, key, guestName = "CP29 Load Guest") {
  return {
    hotelCode: hotel.code,
    destinationId: hotel.destinationId,
    transferDate: when.date,
    pickupTime: when.time,
    durationMinutes: when.minutes,
    guestName,
    guestPhone: "+30000000000",
    guestEmail: `cp29-load-05af6a-${key}@example.test`,
    passengerCount: 1,
    luggageCount: 0,
    pickupText: "cp29-load lobby",
    destinationText: "cp29-load destination",
    idempotencyKey: key,
  };
}

async function mapPool(clients, items, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker(client) {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const t0 = performance.now();
      try {
        const value = await fn(client, items[index], index);
        out[index] = { ok: true, ms: performance.now() - t0, value };
      } catch (err) {
        out[index] = {
          ok: false,
          ms: performance.now() - t0,
          code: failCode(err),
          status: err?.status || null,
          message: redact(err?.message || "").slice(0, 180),
        };
      }
    }
  }
  await Promise.all(clients.map((client) => worker(client)));
  return out;
}

function summarise(label, rows, elapsedMs) {
  const ok = rows.filter((row) => row?.ok);
  const bad = rows.filter((row) => row && !row.ok);
  const classes = {};
  for (const row of bad) classes[row.code || "(none)"] = (classes[row.code || "(none)"] || 0) + 1;
  const latency = dist(ok.map((row) => row.ms));
  const seconds = elapsedMs / 1000;
  const throughput = seconds > 0 ? Number((ok.length / seconds).toFixed(2)) : 0;
  say(`${label}_attempted=${rows.length}`);
  say(`${label}_success=${ok.length}`);
  say(`${label}_failed=${bad.length}`);
  say(`${label}_failure_classes=${JSON.stringify(classes)}`);
  say(`${label}_p50=${latency.p50}`);
  say(`${label}_p95=${latency.p95}`);
  say(`${label}_p99=${latency.p99}`);
  say(`${label}_max=${latency.max}`);
  say(`${label}_elapsed_ms=${Math.round(elapsedMs)}`);
  say(`${label}_throughput_per_s=${throughput}`);
  const emailClasses = {};
  for (const row of ok) {
    const status = row.value?.confirmationEmailStatus || "(none)";
    emailClasses[status] = (emailClasses[status] || 0) + 1;
  }
  if (ok.length) say(`${label}_email=${JSON.stringify(emailClasses)}`);
  report.phases[label] = {
    attempted: rows.length,
    success: ok.length,
    failed: bad.length,
    classes,
    latency,
    elapsedMs: Math.round(elapsedMs),
    throughput,
    email: emailClasses,
  };
  return { ok, bad, classes, latency, throughput };
}

async function main() {
  if (!assertConfirmation() || !assertNoLiveCommerce()) return;
  try {
    if (!assertGitBaseline()) return;
  } catch (err) {
    blocked(`git baseline check failed ${redact(err?.message)}; database not opened`);
    return;
  }
  if (!(await assertSourceLedger())) return;

  const runtimeUrl = process.env.AETHER_CP29_DATABASE_URL || "";
  const ownerUrl = process.env.AETHER_CP29_OWNER_DATABASE_URL || "";
  if (!runtimeUrl.startsWith("postgres")) {
    blocked("runtime database URL is missing; database not opened");
    return;
  }
  if (!hostOk(runtimeUrl)) {
    blocked("runtime URL is not the authorised direct compute; database not opened");
    return;
  }
  say("runtime_transport=direct_host_allowlisted");
  say("owner_secret=" + (ownerUrl ? "present" : "absent"));
  if (ownerUrl && !hostOk(ownerUrl)) {
    blocked("owner URL is not the authorised direct compute; database not opened");
    return;
  }
  if (ownerUrl && ownerUrl === runtimeUrl) {
    blocked("owner URL matches the runtime URL; publication not opened");
    return;
  }

  const clients = Array.from({ length: MAX_CLIENTS }, (_, index) => makeClient(runtimeUrl, `cp292a-runtime-${index}`));
  let owner = null;
  try {
    await Promise.all(clients.map((client) => client.connect()));
    const ids = await Promise.all(clients.map((client) => readIdentity(client)));
    const pids = [];
    for (let index = 0; index < ids.length; index += 1) {
      if (!branchOk(`session_${index}`, ids[index])) return;
      if (ids[index].currentUser !== EXPECTED_ROLE) {
        blocked(`session ${index} is not ${EXPECTED_ROLE}; no writes`);
        return;
      }
      pids.push(ids[index].pid);
    }
    if (new Set(pids).size !== pids.length) {
      blocked("runtime sessions did not get distinct backends; no writes");
      return;
    }
    say(`distinct_pids=${pids.join(",")}`);
    say(`open_sessions=${pids.length}`);

    const schemaBefore = await assertSchema(clients[0]);
    if (!schemaBefore) return;
    const before = await fixtureState(clients[0]);
    say(`fixture_hotels=${before.hotels.length}`);
    say(`fixture_hotel_rows=${before.hotels.map((row) => `${row.code}:${row.status}`).join(",")}`);
    say(`fixture_prefixes=${before.prefixes.join(",") || "(none)"}`);
    say(`fixture_bookings_before=${before.bookings}`);
    const codes = before.hotels.map((row) => row.code);
    const expectedCodes = [...FIXTURE_CODES];
    const codesMatch = codes.length === expectedCodes.length && codes.every((code, index) => code === expectedCodes[index]);
    const allConfigured = before.hotels.every((row) => row.status === "configured");
    if (!codesMatch || before.prefixes.length !== 1 || before.prefixes[0] !== FIXTURE_PREFIX || !allConfigured || before.bookings !== 13) {
      blocked("existing fixture set differs from CP29.2; publication not opened");
      return;
    }
    const invBefore = await invariants(clients[0], pids);
    say(`vehicle_overlaps_before=${invBefore.vehicleOverlaps}`);
    say(`driver_overlaps_before=${invBefore.driverOverlaps}`);
    say(`duplicate_tokens_before=${invBefore.dupTokens}`);
    say(`stuck_before=${invBefore.stuck}`);
    if (invBefore.vehicleOverlaps || invBefore.driverOverlaps || invBefore.dupTokens || invBefore.stuck) {
      blocked("pre-publication invariants are not clean; publication not opened");
      return;
    }
    const newKeys = Number(
      (await clients[0].query(`select count(*)::int as n from idempotency_keys where key like $1`, [`${KEY_PREFIX}%`])).rows[0].n,
    );
    say(`new_keys_before=${newKeys}`);
    if (newKeys !== 0) {
      blocked("cp29-2a keys already exist; publication not opened");
      return;
    }

    for (const [sql, label] of DENIALS) {
      if (!(await expectDenied(clients[1], sql, `before_${label}`))) return;
    }

    if (!ownerUrl) {
      blocked("AETHER_CP29_OWNER_DATABASE_URL is absent; fixture publication not opened. Do not grant aether_app UPDATE on hotels.");
      report.publication = "owner_secret_absent";
      return;
    }

    owner = makeClient(ownerUrl, "cp292a-owner");
    await owner.connect();
    const ownerId = await readIdentity(owner);
    if (!branchOk("owner", ownerId)) return;
    if (ownerId.currentUser !== EXPECTED_OWNER || ownerId.sessionUser !== EXPECTED_OWNER) {
      blocked(`owner identity is not ${EXPECTED_OWNER}; publication not opened`);
      return;
    }
    say("owner_transport=direct");
    const ownerMigrations = (
      await owner.query(`select name from _migrations order by name`)
    ).rows.map((row) => String(row.name));
    say(`owner_migration_count=${ownerMigrations.length}`);
    say(`owner_migration_last=${ownerMigrations.at(-1) || "(none)"}`);
    if (ownerMigrations.length !== 30 || ownerMigrations.some((name) => name.startsWith("0031"))) {
      blocked("owner sees a ledger other than 0001-0030; publication not opened");
      return;
    }
    const ownerHotels = (
      await owner.query(
        `select id::text, code, status from hotels where code = any($1::text[]) order by code`,
        [FIXTURE_CODES],
      )
    ).rows;
    if (
      ownerHotels.length !== 4 ||
      ownerHotels.some((row, index) => row.code !== FIXTURE_CODES[index] || row.status !== "configured")
    ) {
      blocked("owner fixture rows are not the four configured hotels; publication not opened");
      return;
    }
    const snapshotBefore = await hotelSnapshot(owner);
    const bookingsAtPublish = Number(
      (await owner.query(`select count(*)::int as n from bookings where guest_email like $1`, [EMAIL_LIKE])).rows[0].n,
    );
    say(`bookings_at_publication=${bookingsAtPublish}`);

    const { promoteHotelToLive } = await import("../src/lib/aether/provision.ts");
    say("publication_path=promoteHotelToLive");
    for (const row of ownerHotels) {
      try {
        const published = await promoteHotelToLive(adapter(owner), row.id);
        say(`published_${published.code}=${published.status}`);
        if (published.code !== row.code || published.status !== "live") {
          failed(`promoteHotelToLive did not return live for ${row.code}`);
          return;
        }
      } catch (err) {
        blocked(`promoteHotelToLive failed for ${row.code}: ${failCode(err)} ${redact(err?.message)} ${(err?.issues || []).join("; ")}`);
        report.publication = failCode(err) || "promote_failed";
        return;
      }
    }
    const snapshotAfter = await hotelSnapshot(owner);
    const changed = [];
    const beforeMap = new Map(snapshotBefore.map((row) => [row.code, row.status]));
    for (const row of snapshotAfter) {
      const prior = beforeMap.get(row.code);
      if (prior !== row.status) changed.push(`${row.code}:${prior}->${row.status}`);
    }
    for (const row of snapshotBefore) {
      if (!snapshotAfter.some((next) => next.code === row.code)) changed.push(`${row.code}:removed`);
    }
    say(`status_changes=${changed.join(",") || "(none)"}`);
    const expectedChanges = FIXTURE_CODES.map((code) => `${code}:configured->live`);
    if (changed.length !== expectedChanges.length || changed.some((item, index) => item !== expectedChanges[index])) {
      failed("publication changed hotel status outside the four fixture hotels");
      report.publication = "unexpected_status_change";
      return;
    }
    const ownerMigrationsAfter = (await owner.query(`select name from _migrations order by name`)).rows.map((row) => String(row.name));
    if (ownerMigrationsAfter.join() !== ownerMigrations.join()) {
      failed("migration ledger changed during publication");
      return;
    }
    const bookingsAfterPublish = Number(
      (await owner.query(`select count(*)::int as n from bookings where guest_email like $1`, [EMAIL_LIKE])).rows[0].n,
    );
    say(`bookings_after_publication=${bookingsAfterPublish}`);
    if (bookingsAfterPublish !== bookingsAtPublish) {
      failed("publication changed booking rows");
      return;
    }
    report.publication = "live";
    say("publication=live");
    await owner.end();
    owner = null;
    say("owner_connection=closed");

    const runtimeAgain = await readIdentity(clients[0]);
    if (!branchOk("runtime_after_publication", runtimeAgain) || runtimeAgain.currentUser !== EXPECTED_ROLE) {
      blocked("runtime identity changed after publication; load not opened");
      return;
    }
    const liveRows = (
      await clients[0].query(`select code, status from hotels where code = any($1::text[]) order by code`, [FIXTURE_CODES])
    ).rows;
    say(`runtime_fixture_statuses=${liveRows.map((row) => `${row.code}:${row.status}`).join(",")}`);
    if (liveRows.length !== 4 || liveRows.some((row) => row.status !== "live")) {
      failed("runtime does not see the four fixture hotels as live");
      return;
    }
    for (const [sql, label] of DENIALS) {
      if (!(await expectDenied(clients[2], sql, `after_${label}`))) return;
    }
    const schemaMid = await assertSchema(clients[2]);
    if (!schemaMid) return;
    const grantsBefore = await privilegeHash(clients[2]);
    say(`grants_before_table=${grantsBefore.table}`);
    say(`grants_before_column=${grantsBefore.column}`);
    say(`roles_before=${grantsBefore.roles}`);

    const destinations = (
      await clients[0].query(
        `select h.code, d.id::text as destination_id
           from hotels h
           join hotel_destinations d on d.hotel_id = h.id and d.active
          where h.code = any($1::text[])
          order by h.code, d.sort_order, d.name`,
        [FIXTURE_CODES],
      )
    ).rows;
    const hotels = FIXTURE_CODES.map((code) => {
      const dest = destinations.find((row) => row.code === code);
      return dest ? { code, destinationId: dest.destination_id } : null;
    });
    if (hotels.some((hotel) => !hotel)) {
      failed("a live fixture hotel has no active destination");
      return;
    }

    const { createLimitedGuestBooking } = await import("../src/lib/aether/guest-create.ts");
    const guestCreate = (client, hotel, when, key, hint, guestName) =>
      createLimitedGuestBooking(adapter(client), bookingInput(hotel, when, key, guestName), hint);

    say("limiter_prior_serial_allowed=20");
    say("limiter_prior_21st=rate_limited:429");
    say("limiter_prior_concurrent_accepted=24");
    say("limiter_prior_overshoot=4");
    say("limiter_prior_class=acceptable_bounded_hardening_debt");
    say("limiter_retest=not_rerun");

    if (pastDeadline()) {
      blocked("deadline exceeded before load");
      return;
    }

    const normalSerialItems = Array.from({ length: 8 }, (_, index) => ({
      hotel: hotels[index % 4],
      when: { date: "2026-12-02", time: `08:${String(index).padStart(2, "0")}`, minutes: 30 },
      key: `${KEY_PREFIX}normal-s-${index}`,
      hint: `${KEY_PREFIX}hint-normal-s-${index}`,
    }));
    const serialStarted = Date.now();
    const serial = await mapPool(clients.slice(0, 1), normalSerialItems, (client, item) =>
      guestCreate(client, item.hotel, item.when, item.key, item.hint),
    );
    const serialSummary = summarise("normal_serial", serial, Date.now() - serialStarted);
    if (serialSummary.bad.length) failed("normal serial guest create had failures");

    const normalParallelItems = Array.from({ length: 8 }, (_, index) => ({
      hotel: hotels[index % 4],
      when: { date: "2026-12-02", time: `09:${String(index).padStart(2, "0")}`, minutes: 30 },
      key: `${KEY_PREFIX}normal-p-${index}`,
      hint: `${KEY_PREFIX}hint-normal-p-${index}`,
    }));
    const parallelStarted = Date.now();
    const parallel = await mapPool(clients.slice(0, 2), normalParallelItems, (client, item) =>
      guestCreate(client, item.hotel, item.when, item.key, item.hint),
    );
    const parallelSummary = summarise("normal_parallel", parallel, Date.now() - parallelStarted);
    if (parallelSummary.bad.length) failed("normal parallel guest create had failures");
    const emailBad = [...serial, ...parallel].some((row) => row.ok && row.value.confirmationEmailStatus !== "not_configured");
    if (emailBad) failed("guest create sent or failed email; Resend must stay disabled");

    let inv = await invariants(clients[3], pids);
    say(`invariants_after_normal=${JSON.stringify(inv)}`);
    if (inv.vehicleOverlaps || inv.driverOverlaps || inv.dupTokens || inv.crossTenant || inv.stuck) {
      failed("invariant failed after normal guest create");
      return;
    }

    const stormKey = `${KEY_PREFIX}storm`;
    const stormWhen = { date: "2026-12-03", time: "10:00", minutes: 45 };
    const stormHotel = hotels[1];
    const stormStarted = Date.now();
    const storm = await mapPool(clients, Array.from({ length: 8 }, () => 0), (client, _item, index) =>
      guestCreate(client, stormHotel, stormWhen, stormKey, `${KEY_PREFIX}hint-storm-${index}`),
    );
    const stormSummary = summarise("idempotency", storm, Date.now() - stormStarted);
    const references = new Set(storm.filter((row) => row.ok).map((row) => row.value.humanReference));
    const tokens = new Set(storm.filter((row) => row.ok).map((row) => row.value.confirmationToken));
    const stormKeys = Number(
      (await clients[0].query(`select count(*)::int as n from idempotency_keys where scope = 'booking.create' and key = $1`, [stormKey])).rows[0].n,
    );
    const stormBookings = Number(
      (
        await clients[0].query(
          `select count(*)::int as n from bookings b join idempotency_keys k on k.booking_id = b.id where k.key = $1`,
          [stormKey],
        )
      ).rows[0].n,
    );
    say(`idempotency_concurrency=8`);
    say(`idempotency_distinct_references=${references.size}`);
    say(`idempotency_distinct_tokens=${tokens.size}`);
    say(`idempotency_keys=${stormKeys}`);
    say(`idempotency_bookings=${stormBookings}`);
    report.phases.idempotency_contract = {
      requests: 8,
      concurrency: 8,
      success: stormSummary.ok.length,
      references: references.size,
      tokens: tokens.size,
      keys: stormKeys,
      bookings: stormBookings,
    };
    if (stormSummary.ok.length !== 8 || references.size !== 1 || tokens.size !== 1 || stormKeys !== 1 || stormBookings !== 1) {
      failed("idempotency storm did not collapse to one booking");
    }
    const conflictStarted = Date.now();
    const conflict = await guestCreate(
      clients[0],
      stormHotel,
      stormWhen,
      stormKey,
      `${KEY_PREFIX}hint-storm-conflict`,
      "CP29 Conflict",
    ).then(
      () => ({ ok: true, code: "" }),
      (err) => ({ ok: false, code: failCode(err), status: err?.status || null }),
    );
    const afterConflict = Number(
      (
        await clients[0].query(
          `select count(*)::int as n from bookings b join idempotency_keys k on k.booking_id = b.id where k.key = $1`,
          [stormKey],
        )
      ).rows[0].n,
    );
    say(`idempotency_conflict=${conflict.ok ? "created" : conflict.code}`);
    say(`idempotency_conflict_status=${conflict.status || ""}`);
    say(`idempotency_conflict_ms=${Date.now() - conflictStarted}`);
    say(`idempotency_bookings_after_conflict=${afterConflict}`);
    if (conflict.code !== "idempotency_conflict" || afterConflict !== 1) {
      failed("conflicting idempotency replay did not preserve one booking");
    }

    inv = await invariants(clients[3], pids);
    say(`invariants_after_idempotency=${JSON.stringify(inv)}`);
    if (inv.vehicleOverlaps || inv.driverOverlaps || inv.dupTokens || inv.crossTenant || inv.stuck) {
      failed("invariant failed after idempotency storm");
      return;
    }

    const burstItems = Array.from({ length: 24 }, (_, index) => ({
      hotel: hotels[index % 4],
      when: { date: "2026-12-04", time: `10:${String(index).padStart(2, "0")}`, minutes: 20 },
      key: `${KEY_PREFIX}burst-${index}`,
      hint: `${KEY_PREFIX}hint-burst-${index}`,
    }));
    const observed = { done: false, peak: 0, states: {} };
    const observer = (async () => {
      while (!observed.done) {
        try {
          const rows = (
            await clients[6].query(
              `select coalesce(state, 'null') as state, count(*)::int as n
                 from pg_stat_activity
                where datname = current_database()
                group by state`,
            )
          ).rows;
          let total = 0;
          for (const row of rows) {
            total += Number(row.n);
            observed.states[row.state] = Math.max(observed.states[row.state] || 0, Number(row.n));
          }
          observed.peak = Math.max(observed.peak, total);
        } catch (err) {
          observed.states.error = redact(err?.message || err?.code || "observer");
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();
    const burstStarted = Date.now();
    const burst = await mapPool(clients.slice(0, 6), burstItems, (client, item) =>
      guestCreate(client, item.hotel, item.when, item.key, item.hint),
    );
    observed.done = true;
    await observer;
    const burstSummary = summarise("burst", burst, Date.now() - burstStarted);
    say(`burst_concurrency=6`);
    say(`burst_peak_backends=${observed.peak}`);
    say(`burst_state_peaks=${JSON.stringify(observed.states)}`);
    report.phases.burst_sessions = { concurrency: 6, peakBackends: observed.peak, states: observed.states };
    const unexpected = burstSummary.bad.filter((row) => !["rate_limited"].includes(row.code));
    if (unexpected.length) failed(`burst unexpected failures=${unexpected.length}`);
    if (burstSummary.bad.some((row) => row.code === "rate_limited")) {
      say("limiter_observed_during_burst=true");
    }
    if (burst.some((row) => row.ok && row.value.confirmationEmailStatus !== "not_configured")) {
      failed("burst email was not not_configured");
    }

    inv = await invariants(clients[7], pids);
    say(`invariants_after_burst=${JSON.stringify(inv)}`);
    if (inv.vehicleOverlaps || inv.driverOverlaps || inv.dupTokens || inv.crossTenant) {
      failed("invariant failed after burst");
      return;
    }
    if (inv.stuck) {
      failed("stuck transactions after burst");
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    const settled = await invariants(clients[7], pids);
    say(`invariants_settled=${JSON.stringify(settled)}`);
    if (settled.stuck) {
      failed("stuck transactions after settle");
      return;
    }

    const recoveryItems = Array.from({ length: 5 }, (_, index) => ({
      hotel: hotels[2],
      when: { date: "2026-12-05", time: `08:${String(index * 10).padStart(2, "0")}`, minutes: 30 },
      key: `${KEY_PREFIX}recovery-${index}`,
      hint: `${KEY_PREFIX}hint-recovery-${index}`,
    }));
    const recoveryStarted = Date.now();
    const recovery = await mapPool(clients.slice(0, 1), recoveryItems, (client, item) =>
      guestCreate(client, item.hotel, item.when, item.key, item.hint),
    );
    const recoverySummary = summarise("recovery", recovery, Date.now() - recoveryStarted);
    say(`recovery_first_ms=${recovery[0]?.ok ? Math.round(recovery[0].ms) : "failed"}`);
    say(`normal_serial_p50=${serialSummary.latency.p50}`);
    say(`recovery_p50=${recoverySummary.latency.p50}`);
    if (recoverySummary.ok.length !== 5) failed("recovery creates did not all succeed");
    if (recovery.some((row) => row.ok && row.value.confirmationEmailStatus !== "not_configured")) {
      failed("recovery email was not not_configured");
    }

    for (const [sql, label] of DENIALS) {
      if (!(await expectDenied(clients[4], sql, `final_${label}`))) return;
    }
    const schemaAfter = await assertSchema(clients[4]);
    if (!schemaAfter) return;
    if (schemaAfter.trigger !== schemaBefore.trigger || schemaAfter.constraints.join() !== schemaBefore.constraints.join()) {
      failed("schema protection changed during the run");
    }
    const grantsAfter = await privilegeHash(clients[4]);
    say(`grants_after_table=${grantsAfter.table}`);
    say(`grants_after_column=${grantsAfter.column}`);
    say(`roles_after=${grantsAfter.roles}`);
    if (grantsAfter.table !== grantsBefore.table || grantsAfter.column !== grantsBefore.column || grantsAfter.roles !== grantsBefore.roles) {
      failed("grants or roles changed during the load");
    }
    const finalInv = await invariants(clients[4], pids);
    say(`fixture_bookings_after=${finalInv.bookings}`);
    say(`vehicle_overlaps=${finalInv.vehicleOverlaps}`);
    say(`driver_overlaps=${finalInv.driverOverlaps}`);
    say(`duplicate_tokens=${finalInv.dupTokens}`);
    say(`stuck_other_transactions=${finalInv.stuck}`);
    say(`cross_tenant_new_bookings=${finalInv.crossTenant}`);
    report.correctness = finalInv;
    const expectedBookings = 13 + serialSummary.ok.length + parallelSummary.ok.length + 1 + burstSummary.ok.length + recoverySummary.ok.length;
    say(`expected_bookings=${expectedBookings}`);
    if (finalInv.bookings !== expectedBookings) failed("booking count does not match successful creates");
    if (finalInv.vehicleOverlaps || finalInv.driverOverlaps || finalInv.dupTokens || finalInv.stuck || finalInv.crossTenant) {
      failed("final invariant failed");
    }
    const stillLive = (
      await clients[4].query(`select code, status from hotels where code = any($1::text[]) order by code`, [FIXTURE_CODES])
    ).rows;
    say(`final_fixture_statuses=${stillLive.map((row) => `${row.code}:${row.status}`).join(",")}`);
    if (stillLive.some((row) => row.status !== "live")) failed("fixture hotel left live during the load");
  } finally {
    if (owner) await owner.end().catch(() => {});
    await Promise.allSettled(clients.map((client) => client.end()));
  }
  say(`CP292A_JSON=${JSON.stringify(report)}`);
}

main()
  .then(() => process.exit(exitCode))
  .catch((err) => {
    console.error(`CP292A FAIL ${redact(err?.stack || err?.message || err)}`);
    process.exit(1);
  });
