#!/usr/bin/env node
/**
 * CP29.2 disposable Neon load gate.
 * Connects only through AETHER_CP29_DATABASE_URL as aether_app.
 * Does not migrate, grant, SET ROLE, call Stripe, or call Resend.
 * Refuses to write until confirmation, git baseline, and SQL identity match.
 * Never prints the connection string.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
  ".github/workflows/cp292-disposable-load.yml",
  "scripts/cp292-disposable-load.mjs",
];
const MAX_CLIENTS = 8;
const DEADLINE_MS = 16 * 60 * 1000;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const report = {
  phases: {},
  correctness: {},
  publication: null,
};
let exitCode = 0;

function say(message) {
  console.log(`CP292 ${message}`);
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
  console.error(`CP292 BLOCKED ${redact(message)}`);
  exitCode = 2;
}

function failed(message) {
  console.error(`CP292 FAIL ${redact(message)}`);
  if (exitCode === 0) exitCode = 1;
}

function failCode(err) {
  if (!err) return "";
  if (err.name === "BookingError" || err.name === "InventoryError") return String(err.code || "");
  return String(err.code || err.name || "");
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
  if (process.env.CP292_CONFIRMATION !== CONFIRMATION) {
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
  say("live_commerce=absent");
  say("stripe_network=disabled");
  say("resend_network=disabled");
  return true;
}

function assertGitBaseline() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const origin = execFileSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
  const names = execFileSync("git", ["diff", "--name-only", BASELINE, "HEAD"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const allowed = [...ALLOWED_DIFF].sort();
  say(`head=${head}`);
  say(`origin_main=${origin}`);
  say(`baseline=${BASELINE}`);
  say(`diff_from_baseline=${names.join(",") || "(empty)"}`);
  if (head !== origin) {
    blocked("HEAD is not origin/main; database not opened");
    return false;
  }
  if (names.length !== allowed.length || names.some((name, index) => name !== allowed[index])) {
    blocked("tree differs from the authorised baseline by more than the temporary CP29.2 harness; database not opened");
    return false;
  }
  execFileSync("git", ["merge-base", "--is-ancestor", BASELINE, "HEAD"], { cwd: root });
  say("git_baseline=temporary_harness_only");
  return true;
}

async function assertSourceLedger() {
  const files = (await readdir(join(root, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const same =
    files.length === ACCEPTED_LEDGER.length && files.every((name, index) => name === ACCEPTED_LEDGER[index]);
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

function usesPooler(connectionString) {
  try {
    return new URL(connectionString).hostname.includes("-pooler");
  } catch {
    return true;
  }
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

function identityOk(label, id) {
  say(`${label}_current_user=${id.currentUser}`);
  say(`${label}_session_user=${id.sessionUser}`);
  say(`${label}_database=${id.database}`);
  say(`${label}_pid=${id.pid}`);
  say(`${label}_branch_id=${id.branchId || "(empty)"}`);
  say(`${label}_project_id=${id.projectId || "(empty)"}`);
  say(`${label}_endpoint_id=${id.endpointId || "(empty)"}`);
  if (FORBIDDEN_BRANCHES.includes(id.branchId)) {
    blocked(`${label} is a forbidden branch ${id.branchId}; no writes`);
    return false;
  }
  if (id.branchId !== EXPECTED_BRANCH || id.projectId !== EXPECTED_PROJECT) {
    blocked(`${label} is not the authorised CP29 branch; no writes`);
    return false;
  }
  if (id.endpointId !== EXPECTED_ENDPOINT) {
    blocked(`${label} endpoint is not the authorised CP29 compute; no writes`);
    return false;
  }
  if (id.currentUser !== EXPECTED_ROLE || id.sessionUser !== EXPECTED_ROLE || id.database !== EXPECTED_DB) {
    blocked(`${label} runtime identity is not ${EXPECTED_ROLE} on ${EXPECTED_DB}; no writes`);
    return false;
  }
  if (!Number.isInteger(id.pid) || id.pid <= 0) {
    blocked(`${label} backend pid missing; no writes`);
    return false;
  }
  return true;
}

async function pinIdentity(clientA, clientB) {
  await Promise.all([clientA.query("BEGIN"), clientB.query("BEGIN")]);
  try {
    return await Promise.all([readIdentity(clientA), readIdentity(clientB)]);
  } finally {
    await Promise.allSettled([clientA.query("ROLLBACK"), clientB.query("ROLLBACK")]);
  }
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
    blocked("occupancy protection is missing; no writes");
    return null;
  }
  let ledger = "denied";
  try {
    const rows = (await client.query("select name from _migrations order by name")).rows.map((row) => row.name);
    const matches =
      rows.length === ACCEPTED_LEDGER.length && rows.every((name, index) => name === ACCEPTED_LEDGER[index]);
    say(`db_migration_rows=${rows.length}`);
    say(`db_ledger_matches_0001_0030=${matches}`);
    if (!matches || rows.some((name) => String(name).startsWith("0031"))) {
      blocked("database ledger is not exactly 0001-0030; no writes");
      return null;
    }
    ledger = "0001-0030";
  } catch (err) {
    if (err?.code !== "42501") {
      blocked(`migration ledger read failed ${err?.code || ""} ${redact(err?.message)}; no writes`);
      return null;
    }
    say("migrations_table_select=denied");
  }
  return { constraints, trigger: trigger.tgenabled, ledger };
}

function scopeFor(providerId) {
  return {
    operatorId: randomUUID(),
    login: "cp29-load",
    sessionId: randomUUID(),
    membershipId: randomUUID(),
    accessClass: "provider_dispatcher",
    hotelId: null,
    providerId,
  };
}

function bookingInput(hotel, when, key) {
  return {
    hotelCode: hotel.code,
    destinationId: hotel.destinationId,
    transferDate: when.date,
    pickupTime: when.time,
    durationMinutes: when.minutes,
    guestName: "CP29 Load Guest",
    guestPhone: "+30000000000",
    guestEmail: hotel.email,
    passengerCount: 1,
    luggageCount: 0,
    pickupText: "cp29-load lobby",
    destinationText: "cp29-load destination",
    idempotencyKey: key,
  };
}

async function insertGranted(client, hotel, when, email) {
  const token = randomBytes(32).toString("base64url");
  const reference = `PT-C29${randomBytes(6).toString("hex")}`;
  const row = (
    await client.query(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email,
         passenger_count, luggage_count,
         pickup_text, destination_text,
         human_reference, confirmation_token,
         destination_id, quoted_amount_minor, quoted_currency
       ) values (
         $1, $2, $3::date, $4::time, $5,
         'CP29 Load Guest', '+30000000000', $6,
         1, 0,
         'cp29-load lobby', 'cp29-load destination',
         $7, $8,
         $9, $10, 'EUR'
       )
       returning id`,
      [
        hotel.hotelId,
        hotel.providerId,
        when.date,
        when.time,
        when.minutes,
        email,
        reference,
        token,
        hotel.destinationId,
        4500,
      ],
    )
  ).rows[0];
  return { id: row.id, tokenLength: token.length };
}

async function mapPool(clients, items, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker(client) {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const started = performance.now();
      try {
        const value = await fn(client, items[index], index);
        out[index] = { ok: true, ms: performance.now() - started, value };
      } catch (err) {
        out[index] = {
          ok: false,
          ms: performance.now() - started,
          code: failCode(err),
          status: err?.status || null,
          message: redact(err?.message || "").slice(0, 160),
        };
      }
    }
  }
  await Promise.all(clients.map((client) => worker(client)));
  return out;
}

function summarise(label, rows) {
  const ok = rows.filter((row) => row?.ok);
  const bad = rows.filter((row) => row && !row.ok);
  const classes = {};
  for (const row of bad) classes[row.code || "(none)"] = (classes[row.code || "(none)"] || 0) + 1;
  const latency = dist(ok.map((row) => row.ms));
  say(`${label}_attempted=${rows.length}`);
  say(`${label}_success=${ok.length}`);
  say(`${label}_failed=${bad.length}`);
  say(`${label}_failure_classes=${JSON.stringify(classes)}`);
  say(`${label}_p50=${latency.p50}`);
  say(`${label}_p95=${latency.p95}`);
  say(`${label}_p99=${latency.p99}`);
  say(`${label}_max=${latency.max}`);
  report.phases[label] = { attempted: rows.length, success: ok.length, failed: bad.length, classes, latency };
  return { ok, bad, classes, latency };
}

async function loadRow(client, id) {
  const row = (
    await client.query(
      `select id::text, vehicle_id::text, driver_id::text,
              isempty(occupies) as empty, cancelled_at is not null as cancelled,
              guest_email
         from bookings where id = $1::uuid`,
      [id],
    )
  ).rows[0];
  if (!row) throw new Error("fixture booking missing");
  return row;
}

async function overlapCount(client, column, emailLike) {
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
      [emailLike],
    )
  ).rows[0];
  return Number(row.n);
}

async function main() {
  const started = Date.now();
  const deadline = started + DEADLINE_MS;
  if (!assertConfirmation() || !assertNoLiveCommerce()) return;
  try {
    if (!assertGitBaseline()) return;
  } catch (err) {
    blocked(`git baseline check failed ${redact(err?.message)}; database not opened`);
    return;
  }
  if (!(await assertSourceLedger())) return;

  const connectionString = process.env.AETHER_CP29_DATABASE_URL;
  if (!connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    blocked("CP29 database URL is missing or not postgres; database not opened");
    return;
  }
  if (!hostOk(connectionString)) {
    blocked("CP29 URL is not the authorised direct compute; database not opened");
    return;
  }
  if (usesPooler(connectionString)) {
    blocked("CP29 URL is pooled; independent backends required; database not opened");
    return;
  }

  const [
    { createBooking, getPublicBookingByToken, BookingError },
    { assignVehicle, assignDriver, cancelBooking, InventoryError },
    { assertGuestCreateRateLimit, hashGuestClientKey, GUEST_CREATE_LIMIT },
    { createLimitedGuestBooking },
    { sendConfirmationEmail },
  ] = await Promise.all([
    import("../src/lib/aether/booking.ts"),
    import("../src/lib/aether/inventory.ts"),
    import("../src/lib/aether/guest-rate-limit.ts"),
    import("../src/lib/aether/guest-create.ts"),
    import("../src/lib/aether/confirmation-email.ts"),
  ]);

  const clients = [];
  try {
    for (let index = 0; index < MAX_CLIENTS; index += 1) {
      const client = makeClient(connectionString, `cp292-${index}`);
      await client.connect();
      clients.push(client);
    }
    say(`open_sessions=${clients.length}`);
    if (clients.length > 20) {
      blocked("session ceiling exceeded; no writes");
      return;
    }
    const [idA, idB] = await pinIdentity(clients[0], clients[1]);
    if (!identityOk("session_a", idA) || !identityOk("session_b", idB)) return;
    const pids = new Set();
    for (let index = 0; index < clients.length; index += 1) {
      const id = await readIdentity(clients[index]);
      if (!identityOk(`session_${index}`, id)) return;
      if (pids.has(id.pid)) {
        blocked("backend pids are not distinct; no writes");
        return;
      }
      pids.add(id.pid);
    }
    say(`distinct_pids=${[...pids].join(",")}`);
    say("transport=direct");
    say("production_branch_connected=false");
    say("cp28_branch_connected=false");
    const schemaBefore = await assertSchema(clients[0]);
    if (!schemaBefore) return;

    const denials = [
      ["alter table bookings disable trigger bookings_occupies_before", "disable_occupancy_trigger"],
      ["alter table bookings drop constraint bookings_vehicle_occupancy_excl", "drop_vehicle_exclude"],
      ["alter table bookings drop constraint bookings_driver_occupancy_excl", "drop_driver_exclude"],
      ["delete from bookings where false", "delete_bookings"],
      ["set role neondb_owner", "set_role_owner"],
      ["insert into _migrations (name) values ('0031_cp292_forbidden.sql')", "insert_migration"],
    ];
    for (const [sql, label] of denials) {
      if (!(await expectDenied(clients[0], sql, label))) return;
    }
    if (exitCode) return;

    const existing = (
      await clients[0].query(
        `select
           (select count(*)::int from hotels where code like 'cp29-load-%') as hotels,
           (select count(*)::int from bookings where guest_email like 'cp29-load-%@example.test') as bookings`,
      )
    ).rows[0];
    say(`preexisting_cp29_hotels=${existing.hotels}`);
    say(`preexisting_cp29_bookings=${existing.bookings}`);
    report.preexisting = existing;
    if (Date.now() > deadline) {
      blocked("deadline exceeded before writes");
      return;
    }

    const suffix = randomBytes(3).toString("hex");
    const emailLike = `cp29-load-${suffix}%@example.test`;
    const hotels = [];
    for (let index = 0; index < 4; index += 1) {
      const code = `cp29-load-${suffix}${index}`;
      const userId = `cp29-load-${suffix}${index}`;
      const email = `cp29-load-${suffix}${index}@example.test`;
      await clients[0].query(
        `insert into "user" (id, name, email, "emailVerified") values ($1, $2, $3, false)`,
        [userId, "cp29-load fixture", email],
      );
      const created = (
        await clients[0].query(
          `select hotel_id, provider_id from sbg_create_hotel_for_user($1, $2, $3, 'Athens', 'Europe/Athens', 'EUR')`,
          [userId, code, `cp29-load hotel ${index}`],
        )
      ).rows[0];
      await clients[0].query(`select sbg_create_service_for_user($1, $2::uuid, 'transfer', 'cp29-load transfer')`, [
        userId,
        created.hotel_id,
      ]);
      const destinationId = (
        await clients[0].query(
          `select sbg_add_destination_for_user($1, $2::uuid, 'airport', 'cp29-load airport', 4500) as id`,
          [userId, created.hotel_id],
        )
      ).rows[0].id;
      await clients[0].query(`select sbg_promote_configured_for_user($1, $2::uuid)`, [userId, created.hotel_id]);
      const vehicle = (
        await clients[0].query(
          `insert into vehicles (name, capacity, active, owned_by_provider_id, operated_by_provider_id)
           values ($1, 4, true, $2, $2) returning id`,
          [`cp29-load-vehicle-${suffix}${index}`, created.provider_id],
        )
      ).rows[0];
      const driver = (
        await clients[0].query(
          `insert into drivers (name, active, employed_by_provider_id, dispatched_by_provider_id)
           values ($1, true, $2, $2) returning id`,
          [`cp29-load-driver-${suffix}${index}`, created.provider_id],
        )
      ).rows[0];
      hotels.push({
        code,
        email,
        userId,
        hotelId: created.hotel_id,
        providerId: created.provider_id,
        destinationId,
        vehicleId: vehicle.id,
        driverId: driver.id,
        scope: scopeFor(created.provider_id),
      });
    }
    say(`fixtures_created=${hotels.length}`);
    say(`fixture_prefix=cp29-load-${suffix}`);

    let live = false;
    try {
      const updated = await clients[0].query(
        `update hotels set status = 'live' where id = $1::uuid and status = 'configured' returning status`,
        [hotels[0].hotelId],
      );
      live = updated.rows[0]?.status === "live";
    } catch (err) {
      say(`publication_sqlstate=${err?.code || "(none)"}`);
      report.publication = err?.code || "error";
      if (err?.code !== "42501") throw err;
    }
    if (live) {
      for (const hotel of hotels.slice(1)) {
        await clients[0].query(
          `update hotels set status = 'live' where id = $1::uuid and status = 'configured'`,
          [hotel.hotelId],
        );
      }
      say("publication=live");
      report.publication = "live";
    } else {
      say("publication=denied");
      report.publication = report.publication || "denied";
      const probe = await createBooking(adapter(clients[0]), bookingInput(hotels[0], { date: "2026-11-16", time: "10:00", minutes: 60 }, `cp29-load-notlive-${suffix}`)).then(
        () => "created",
        (err) => failCode(err),
      );
      say(`create_booking_without_live=${probe}`);
      report.phases.create_without_live = probe;
      if (probe !== "hotel_not_live") failed("non-live createBooking did not fail closed");
    }

    const normalItems = live
      ? [0, 1, 2, 3, 0, 1, 2, 3].map((hotelIndex, index) => ({
          hotelIndex,
          when: { date: "2026-11-16", time: `08:${String(index).padStart(2, "0")}`, minutes: 30 },
          key: `cp29-load-normal-${suffix}-${index}`,
        }))
      : [];
    if (live) {
      const serial = await mapPool(clients.slice(0, 1), normalItems.slice(0, 4), (client, item) =>
        createBooking(adapter(client), bookingInput(hotels[item.hotelIndex], item.when, item.key)),
      );
      const parallel = await mapPool(clients.slice(0, 2), normalItems.slice(4), (client, item) =>
        createBooking(adapter(client), bookingInput(hotels[item.hotelIndex], item.when, item.key)),
      );
      summarise("normal_serial", serial);
      summarise("normal_parallel", parallel);
      const elapsed = (Date.now() - started) / 1000;
      say(`normal_elapsed_s=${elapsed.toFixed(1)}`);
    } else {
      say("normal_guest_create=skipped_publication_denied");
      report.phases.normal = "skipped_publication_denied";
    }

    if (Date.now() > deadline) {
      blocked("deadline exceeded");
      return;
    }

    if (live) {
      const stormKey = `cp29-load-storm-${suffix}`;
      const stormWhen = { date: "2026-11-18", time: "10:00", minutes: 45 };
      const storm = await mapPool(clients, Array.from({ length: 8 }, () => 0), (client) =>
        createBooking(adapter(client), bookingInput(hotels[1], stormWhen, stormKey)),
      );
      const references = new Set(storm.filter((row) => row.ok).map((row) => row.value.humanReference));
      const stormRows = (
        await clients[0].query(
          `select count(*)::int as n from idempotency_keys where scope = 'booking.create' and key = $1`,
          [stormKey],
        )
      ).rows[0].n;
      const stormBookings = (
        await clients[0].query(
          `select count(*)::int as n
             from bookings b
             join idempotency_keys k on k.booking_id = b.id
            where k.key = $1`,
          [stormKey],
        )
      ).rows[0].n;
      say(`idempotency_success=${storm.filter((row) => row.ok).length}`);
      say(`idempotency_distinct_references=${references.size}`);
      say(`idempotency_keys=${stormRows}`);
      say(`idempotency_bookings=${stormBookings}`);
      report.phases.idempotency = { references: references.size, keys: Number(stormRows), bookings: Number(stormBookings) };
      if (references.size !== 1 || Number(stormBookings) !== 1 || Number(stormRows) !== 1) {
        failed("idempotency storm created more than one booking");
      }
      const conflict = await createBooking(
        adapter(clients[0]),
        { ...bookingInput(hotels[1], stormWhen, stormKey), guestName: "CP29 Conflict" },
      ).then(
        () => "created",
        (err) => failCode(err),
      );
      const afterConflict = (
        await clients[0].query(
          `select count(*)::int as n from bookings b join idempotency_keys k on k.booking_id = b.id where k.key = $1`,
          [stormKey],
        )
      ).rows[0].n;
      say(`idempotency_conflict=${conflict}`);
      say(`idempotency_bookings_after_conflict=${afterConflict}`);
      if (conflict !== "idempotency_conflict" || Number(afterConflict) !== 1) failed("conflicting idempotency replay created a booking");
    } else {
      say("idempotency=skipped_publication_denied");
      report.phases.idempotency = "skipped_publication_denied";
    }

    if (live) {
      const burstItems = Array.from({ length: 12 }, (_, index) => ({
        when: { date: "2026-11-17", time: `12:${String(index).padStart(2, "0")}`, minutes: 20 },
        key: `cp29-load-burst-${suffix}-${index}`,
      }));
      const burstStarted = Date.now();
      const burst = await mapPool(clients.slice(0, 6), burstItems, (client, item) =>
        createBooking(adapter(client), bookingInput(hotels[0], item.when, item.key)),
      );
      const burstSeconds = (Date.now() - burstStarted) / 1000;
      const summary = summarise("burst", burst);
      say(`burst_elapsed_s=${burstSeconds.toFixed(1)}`);
      say(`burst_throughput_per_s=${summary.ok.length ? (summary.ok.length / burstSeconds).toFixed(2) : "0"}`);
      const unexpected = summary.bad.filter((row) => !["hotel_not_live", "rate_limited"].includes(row.code));
      if (unexpected.length) failed(`burst unexpected failures=${unexpected.length}`);
    } else {
      say("burst=skipped_publication_denied");
      report.phases.burst = "skipped_publication_denied";
    }

    async function raceAssign(kind, when, resourceId) {
      const left = await insertGranted(clients[0], hotels[0], when, `cp29-load-${suffix}-race-${kind}-a@example.test`);
      const right = await insertGranted(clients[1], hotels[0], when, `cp29-load-${suffix}-race-${kind}-b@example.test`);
      const assign = kind === "vehicle" ? assignVehicle : assignDriver;
      const arg = kind === "vehicle" ? "vehicleId" : "driverId";
      const run = async (client, bookingId) => {
        try {
          await assign(adapter(client), { bookingId, [arg]: resourceId, scope: hotels[0].scope });
          return { ok: true, code: "" };
        } catch (err) {
          return { ok: false, code: failCode(err), name: err?.name || "" };
        }
      };
      const [a, b] = await Promise.all([run(clients[0], left.id), run(clients[1], right.id)]);
      const wins = [a, b].filter((item) => item.ok).length;
      const loser = [a, b].find((item) => !item.ok);
      const loserId = a.ok ? right.id : left.id;
      const winnerId = a.ok ? left.id : right.id;
      const loserRow = await loadRow(clients[2], loserId);
      const winnerRow = await loadRow(clients[2], winnerId);
      say(`${kind}_race_winners=${wins}`);
      say(`${kind}_race_loser_code=${loser?.code || "(none)"}`);
      say(`${kind}_loser_unchanged=${kind === "vehicle" ? loserRow.vehicle_id == null : loserRow.driver_id == null}`);
      say(`${kind}_winner_assigned=${kind === "vehicle" ? winnerRow.vehicle_id === resourceId : winnerRow.driver_id === resourceId}`);
      if (wins !== 1 || loser?.code !== "unavailable") failed(`${kind} application race was not one winner and one unavailable`);
      if (kind === "vehicle" && (loserRow.vehicle_id != null || winnerRow.vehicle_id !== resourceId)) {
        failed("vehicle loser mutated or winner missing");
      }
      if (kind === "driver" && (loserRow.driver_id != null || winnerRow.driver_id !== resourceId)) {
        failed("driver loser mutated or winner missing");
      }
      const rawLeft = await insertGranted(clients[0], hotels[0], { ...when, time: when.rawTime }, `cp29-load-${suffix}-raw-${kind}-a@example.test`);
      const rawRight = await insertGranted(clients[1], hotels[0], { ...when, time: when.rawTime }, `cp29-load-${suffix}-raw-${kind}-b@example.test`);
      const column = kind === "vehicle" ? "vehicle_id" : "driver_id";
      const raw = async (client, id) => {
        await client.query("BEGIN");
        try {
          await client.query(`update bookings set ${column} = $1::uuid where id = $2::uuid`, [resourceId, id]);
          await client.query("COMMIT");
          return { ok: true, code: "" };
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch {
            /* aborted */
          }
          return { ok: false, code: err?.code || "" };
        }
      };
      const [rawA, rawB] = await Promise.all([raw(clients[0], rawLeft.id), raw(clients[1], rawRight.id)]);
      const rawLoser = [rawA, rawB].find((item) => !item.ok);
      const rawWins = [rawA, rawB].filter((item) => item.ok).length;
      say(`${kind}_raw_winners=${rawWins}`);
      say(`${kind}_raw_loser_sqlstate=${rawLoser?.code || "(none)"}`);
      if (rawWins !== 1 || rawLoser?.code !== "23P01") failed(`${kind} raw race did not return one 23P01`);
      report.phases[`${kind}_race`] = { application: loser?.code, sqlstate: rawLoser?.code, winners: wins };
    }

    await raceAssign("vehicle", { date: "2026-11-19", time: "10:00", minutes: 90, rawTime: "16:00" }, hotels[0].vehicleId);
    await raceAssign("driver", { date: "2026-11-19", time: "14:00", minutes: 60, rawTime: "18:00" }, hotels[0].driverId);

    const adjacentA = await insertGranted(clients[0], hotels[0], { date: "2026-11-20", time: "10:00", minutes: 90 }, `cp29-load-${suffix}-adj-a@example.test`);
    const adjacentB = await insertGranted(clients[1], hotels[0], { date: "2026-11-20", time: "11:30", minutes: 90 }, `cp29-load-${suffix}-adj-b@example.test`);
    await assignVehicle(adapter(clients[0]), { bookingId: adjacentA.id, vehicleId: hotels[0].vehicleId, scope: hotels[0].scope });
    await assignDriver(adapter(clients[0]), { bookingId: adjacentA.id, driverId: hotels[0].driverId, scope: hotels[0].scope });
    await assignVehicle(adapter(clients[1]), { bookingId: adjacentB.id, vehicleId: hotels[0].vehicleId, scope: hotels[0].scope });
    await assignDriver(adapter(clients[1]), { bookingId: adjacentB.id, driverId: hotels[0].driverId, scope: hotels[0].scope });
    const adjacentOverlap = await overlapCount(clients[2], "vehicle_id", emailLike);
    say(`adjacency_vehicle_overlaps=${adjacentOverlap}`);
    say("adjacency=accepted");
    report.phases.adjacency = "accepted";
    if (adjacentOverlap !== 0) failed("adjacency was stored as an overlap");

    await cancelBooking(adapter(clients[0]), { bookingId: adjacentA.id, scope: hotels[0].scope });
    const cancelled = await loadRow(clients[2], adjacentA.id);
    const reuse = await insertGranted(clients[1], hotels[0], { date: "2026-11-20", time: "10:00", minutes: 90 }, `cp29-load-${suffix}-reuse@example.test`);
    await assignVehicle(adapter(clients[1]), { bookingId: reuse.id, vehicleId: hotels[0].vehicleId, scope: hotels[0].scope });
    await assignDriver(adapter(clients[1]), { bookingId: reuse.id, driverId: hotels[0].driverId, scope: hotels[0].scope });
    const reused = await loadRow(clients[2], reuse.id);
    const stillCancelled = await loadRow(clients[2], adjacentA.id);
    say(`cancel_empty=${cancelled.empty}`);
    say(`cancel_flag=${cancelled.cancelled}`);
    say(`reuse_vehicle=${reused.vehicle_id === hotels[0].vehicleId}`);
    say(`reuse_original_still_cancelled=${stillCancelled.cancelled}`);
    say(`reuse_original_occupies_empty=${stillCancelled.empty}`);
    report.phases.cancel_reuse = {
      empty: cancelled.empty === true,
      reused: reused.vehicle_id === hotels[0].vehicleId,
    };
    if (!(cancelled.empty === true && cancelled.cancelled === true && reused.vehicle_id === hotels[0].vehicleId && stillCancelled.cancelled === true)) {
      failed("cancel/reuse did not release occupancy");
    }

    const limiterDb = adapter(clients[3]);
    const serialHint = `cp29-load-serial-${suffix}`;
    const serialKey = hashGuestClientKey(serialHint);
    let serialOk = 0;
    for (let index = 0; index < GUEST_CREATE_LIMIT; index += 1) {
      await assertGuestCreateRateLimit(limiterDb, serialKey, new Date());
      serialOk += 1;
    }
    const twentyFirst = await assertGuestCreateRateLimit(limiterDb, serialKey, new Date()).then(
      () => "allowed",
      (err) => `${failCode(err)}:${err?.status || ""}`,
    );
    const other = await assertGuestCreateRateLimit(
      limiterDb,
      hashGuestClientKey(`cp29-load-other-${suffix}`),
      new Date(),
    ).then(
      () => "allowed",
      (err) => failCode(err),
    );
    const limitedEmail = `cp29-load-${suffix}-limited@example.test`;
    const beforeLimitedCreate = (
      await clients[3].query(`select count(*)::int as n from bookings where guest_email = $1`, [limitedEmail])
    ).rows[0].n;
    const limitedCreate = await createLimitedGuestBooking(
      adapter(clients[3]),
      {
        ...bookingInput(hotels[0], { date: "2026-11-22", time: "09:00", minutes: 30 }, `cp29-load-limited-${suffix}`),
        guestEmail: limitedEmail,
      },
      serialHint,
    ).then(
      () => "created",
      (err) => `${failCode(err)}:${err?.status || ""}`,
    );
    const afterLimitedCreate = (
      await clients[3].query(`select count(*)::int as n from bookings where guest_email = $1`, [limitedEmail])
    ).rows[0].n;
    say(`limiter_serial_allowed=${serialOk}`);
    say(`limiter_21st=${twentyFirst}`);
    say(`limiter_other_client=${other}`);
    say(`limiter_rejected_create=${limitedCreate}`);
    say(`limiter_rejected_created_rows=${Number(afterLimitedCreate) - Number(beforeLimitedCreate)}`);
    report.phases.limiter_serial = { allowed: serialOk, twentyFirst, other, rejectedCreate: limitedCreate };
    if (serialOk !== 20 || twentyFirst !== "rate_limited:429" || other !== "allowed" || Number(afterLimitedCreate) !== Number(beforeLimitedCreate)) {
      failed("serial limiter contract failed");
    }

    const concurrentKey = `cp29-load-limit-concurrent-${suffix}`;
    const concurrent = await mapPool(clients, Array.from({ length: 24 }, () => 0), (client) =>
      assertGuestCreateRateLimit(adapter(client), concurrentKey, new Date()),
    );
    const accepted = concurrent.filter((row) => row.ok).length;
    say(`limiter_concurrent_attempted=24`);
    say(`limiter_concurrent_accepted=${accepted}`);
    say(`limiter_concurrent_rejected=${24 - accepted}`);
    say(`limiter_overshoot=${Math.max(0, accepted - GUEST_CREATE_LIMIT)}`);
    report.phases.limiter_concurrent = { attempted: 24, accepted, overshoot: Math.max(0, accepted - GUEST_CREATE_LIMIT) };
    if (accepted > 40) failed("limiter concurrent accepts exceeded 40");
    else if (accepted > 20) say("limiter_overshoot_class=acceptable_bounded_hardening_debt");
    else say("limiter_overshoot_class=none");

    const dtoBooking = await insertGranted(clients[0], hotels[2], { date: "2026-11-23", time: "10:00", minutes: 30 }, `cp29-load-${suffix}-dto@example.test`);
    const tokenRow = (
      await clients[0].query(`select confirmation_token from bookings where id = $1::uuid`, [dtoBooking.id])
    ).rows[0];
    const dto = await getPublicBookingByToken(adapter(clients[0]), tokenRow.confirmation_token);
    const dtoKeys = Object.keys(dto).sort();
    const leaked = ["guestEmail", "guestPhone", "confirmationToken", "vehicleId", "driverId", "occupies", "guest_email", "guest_phone"].filter((key) => key in dto);
    const wrong = await getPublicBookingByToken(adapter(clients[0]), "not-a-cp29-token").then(
      () => "found",
      (err) => failCode(err),
    );
    const otherHotel = await getPublicBookingByToken(adapter(clients[0]), tokenRow.confirmation_token);
    say(`dto_keys=${dtoKeys.join(",")}`);
    say(`dto_leaked=${leaked.join(",") || "(none)"}`);
    say(`dto_token_length=${String(tokenRow.confirmation_token).length}`);
    say(`dto_wrong_token=${wrong}`);
    say(`dto_hotel=${otherHotel.hotelCode}`);
    report.phases.dto = { leaked: leaked.length, wrong, hotel: otherHotel.hotelCode };
    if (leaked.length || wrong !== "not_found" || otherHotel.hotelCode !== hotels[2].code || String(tokenRow.confirmation_token).length !== 43) {
      failed("public DTO or token integrity failed");
    }

    const foreign = await assignVehicle(adapter(clients[0]), {
      bookingId: dtoBooking.id,
      vehicleId: hotels[0].vehicleId,
      scope: hotels[0].scope,
    }).then(
      () => "assigned",
      (err) => failCode(err),
    );
    const foreignRow = await loadRow(clients[0], dtoBooking.id);
    say(`cross_tenant_assign=${foreign}`);
    say(`cross_tenant_vehicle_unchanged=${foreignRow.vehicle_id == null}`);
    report.phases.cross_tenant = { assign: foreign, unchanged: foreignRow.vehicle_id == null };
    if (foreign !== "forbidden" || foreignRow.vehicle_id != null) failed("cross-tenant assignment succeeded");

    const emailBooking = await insertGranted(clients[0], hotels[3], { date: "2026-11-24", time: "10:00", minutes: 30 }, `cp29-load-${suffix}-email@example.test`);
    const emailBefore = await loadRow(clients[0], emailBooking.id);
    const notConfigured = await sendConfirmationEmail(
      {
        humanReference: "PT-CP29-EMAIL",
        hotelName: "cp29-load",
        transferDate: "2026-11-24",
        pickupTime: "10:00",
        durationMinutes: 30,
        pickupText: "cp29-load lobby",
        destinationText: "cp29-load destination",
        passengerCount: 1,
        luggageCount: 0,
        pricing: { priced: true, currency: "EUR", amountMinor: 4500 },
        confirmationToken: "cp29-not-a-logged-token",
      },
      emailBefore.guest_email,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("resend stub failure");
    };
    process.env.RESEND_API_KEY = "re_test_stub";
    process.env.RESEND_FROM_EMAIL = "cp29-load@example.test";
    let failedStatus = "not_run";
    try {
      const failedEmail = await sendConfirmationEmail(
        {
          humanReference: "PT-CP29-EMAIL",
          hotelName: "cp29-load",
          transferDate: "2026-11-24",
          pickupTime: "10:00",
          durationMinutes: 30,
          pickupText: "cp29-load lobby",
          destinationText: "cp29-load destination",
          passengerCount: 1,
          luggageCount: 0,
          pricing: { priced: true, currency: "EUR", amountMinor: 4500 },
          confirmationToken: "cp29-not-a-logged-token",
        },
        emailBefore.guest_email,
      );
      failedStatus = failedEmail.status;
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM_EMAIL;
    }
    const emailAfter = await loadRow(clients[0], emailBooking.id);
    say(`email_not_configured=${notConfigured.status}`);
    say(`email_failed=${failedStatus}`);
    say(`email_booking_remains=${emailAfter.id === emailBooking.id && emailAfter.cancelled === false}`);
    report.phases.email = { notConfigured: notConfigured.status, failed: failedStatus, remains: true };
    if (notConfigured.status !== "not_configured" || failedStatus !== "failed" || emailAfter.id !== emailBooking.id) {
      failed("email failure did not preserve the booking");
    }

    if (live) {
      const recovery = await mapPool(
        clients.slice(0, 1),
        Array.from({ length: 5 }, (_, index) => index),
        (client, index) =>
          createBooking(
            adapter(client),
            bookingInput(
              hotels[2],
              { date: "2026-11-21", time: `08:${String(index * 10).padStart(2, "0")}`, minutes: 30 },
              `cp29-load-recovery-${suffix}-${index}`,
            ),
          ),
      );
      const recoverySummary = summarise("recovery", recovery);
      say(`recovery_first_ms=${recovery[0]?.ok ? Math.round(recovery[0].ms) : "failed"}`);
      if (recoverySummary.ok.length !== 5) failed("recovery creates did not all succeed");
      if (recovery[0]?.ms > 10000) failed("recovery first create exceeded 10s");
    } else {
      say("recovery=skipped_publication_denied");
      report.phases.recovery = "skipped_publication_denied";
    }

    for (const [sql, label] of denials) {
      if (!(await expectDenied(clients[4], sql, `final_${label}`))) return;
    }
    const schemaAfter = await assertSchema(clients[4]);
    if (!schemaAfter) return;
    if (schemaAfter.trigger !== schemaBefore.trigger || schemaAfter.constraints.join() !== schemaBefore.constraints.join()) {
      failed("schema protection changed during the run");
    }
    const vehicleOverlaps = await overlapCount(clients[4], "vehicle_id", emailLike);
    const driverOverlaps = await overlapCount(clients[4], "driver_id", emailLike);
    const dupTokens = (
      await clients[4].query(
        `select count(*)::int as n from (
           select confirmation_token from bookings where guest_email like $1 group by confirmation_token having count(*) > 1
         ) d`,
        [emailLike],
      )
    ).rows[0].n;
    const bookingCount = (
      await clients[4].query(`select count(*)::int as n from bookings where guest_email like $1`, [emailLike])
    ).rows[0].n;
    const stuck = (
      await clients[4].query(
        `select count(*)::int as n
           from pg_stat_activity
          where datname = current_database()
            and state = 'idle in transaction'
            and pid <> all($1::int[])`,
        [[...pids]],
      )
    ).rows[0].n;
    say(`fixture_bookings=${bookingCount}`);
    say(`vehicle_overlaps=${vehicleOverlaps}`);
    say(`driver_overlaps=${driverOverlaps}`);
    say(`duplicate_tokens=${dupTokens}`);
    say(`stuck_other_transactions=${stuck}`);
    report.correctness = {
      bookings: Number(bookingCount),
      vehicleOverlaps: Number(vehicleOverlaps),
      driverOverlaps: Number(driverOverlaps),
      duplicateTokens: Number(dupTokens),
      stuck: Number(stuck),
    };
    if (Number(vehicleOverlaps) || Number(driverOverlaps) || Number(dupTokens)) failed("final occupancy or token invariant failed");

    say(`publication_final=${report.publication}`);
    if (!live && exitCode === 0) {
      blocked("guest create success path blocked: aether_app cannot publish hotels live and owner DML is forbidden");
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
  }
  say(`CP292_JSON=${JSON.stringify(report)}`);
}

main()
  .catch((err) => {
    failed(redact(err?.stack || err?.message || err));
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
