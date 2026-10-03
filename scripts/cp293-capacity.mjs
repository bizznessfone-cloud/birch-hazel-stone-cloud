#!/usr/bin/env node
/**
 * CP29.3 disposable capacity measurement.
 * Runtime only: AETHER_CP29_DATABASE_URL as aether_app.
 * Does not migrate, grant, publish, call Stripe, or call Resend.
 * Does not change pool settings. Never prints a connection string.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompiledQuery, Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING } from "./production-db-preflight.mjs";
import { neonPoolSettings } from "../src/lib/aether/runtime-config.ts";
import { hashGuestClientKey } from "../src/lib/aether/guest-rate-limit.ts";

const BASELINE = "f523ba7c16c41b51c6f634479bd488fdd6e48055";
const CONFIRMATION = "RUN-CP29-3";
const EXPECTED_BRANCH = "br-mute-sky-b1tnej2d";
const EXPECTED_ENDPOINT = "ep-fancy-star-b1324ikc";
const FORBIDDEN_BRANCHES = ["br-green-darkness-b1k7wkue", "br-icy-shadow-b1fh96gk"];
const EXPECTED_PROJECT = "quiet-sound-53513710";
const EXPECTED_DB = "neondb";
const EXPECTED_ROLE = "aether_app";
const FIXTURE_CODES = ["cp29-load-05af6a0", "cp29-load-05af6a1", "cp29-load-05af6a2", "cp29-load-05af6a3"];
const EMAIL_LIKE = "cp29-load-%@example.test";
const KEY_PREFIX = "cp29-3-";
const ALLOWED_DIFF = [".github/workflows/cp293-capacity.yml", "scripts/cp293-capacity.mjs"];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const report = {};
let exitCode = 0;

function say(message) {
  console.log(`CP293 ${message}`);
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
    } catch { /* best-effort */ }
  }
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted");
}
function blocked(message) {
  console.error(`CP293 BLOCKED ${redact(message)}`);
  if (exitCode === 0) exitCode = 2;
}
function failed(message) {
  console.error(`CP293 FAIL ${redact(message)}`);
  if (exitCode === 0) exitCode = 1;
}
function failCode(err) {
  if (!err) return "";
  if (err.name === "BookingError" || err.name === "InventoryError" || err.name === "OpsDeskError") return String(err.code || "");
  if (/timeout/i.test(String(err.message || ""))) return "connection_timeout";
  return String(err.code || err.name || "error");
}
function dist(samples) {
  const xs = samples.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const pick = (p) => (xs.length ? Math.round(xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))]) : null);
  return { n: xs.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: xs.length ? Math.round(xs[xs.length - 1]) : null };
}
function purpose(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
  if (s.startsWith("begin")) return "begin";
  if (s.startsWith("commit")) return "commit";
  if (s.startsWith("rollback")) return "rollback";
  if (s.includes("public_booking_attempts") && s.startsWith("delete")) return "rate_limit_delete";
  if (s.includes("public_booking_attempts") && s.startsWith("select")) return "rate_limit_count";
  if (s.includes("public_booking_attempts")) return "rate_limit_insert";
  if (s.includes("from hotels") && s.includes("lower(code)")) return "hotel_lookup";
  if (s.includes("from hotel_destinations")) return "destination_lookup";
  if (s.includes("from hotel_provider_agreements") && s.startsWith("select")) return "provider_lookup";
  if (s.includes("aether_civil_instant")) return "civil_instant";
  if (s.includes("aether_athens_today")) return "athens_today";
  if (s.includes("at time zone")) return "civil_today";
  if (s.includes("idempotency_keys") && s.startsWith("insert")) return "idempotency_insert";
  if (s.includes("idempotency_keys") && s.startsWith("update")) return "idempotency_bind";
  if (s.includes("idempotency_keys")) return "idempotency_read";
  if (s.startsWith("insert into bookings")) return "booking_insert";
  if (s.startsWith("insert into audit_events")) return "audit_insert";
  if (s.startsWith("update bookings set vehicle_id")) return "vehicle_assign";
  if (s.includes("for update")) return "booking_lock";
  if (s.startsWith("select") && s.includes("from bookings")) return "booking_read";
  if (s.startsWith("select") && s.includes("from vehicles")) return "vehicle_read";
  if (s.startsWith("select") && s.includes("from drivers")) return "driver_read";
  if (s.startsWith("select") && s.includes("from hotels")) return "hotel_read";
  return "other";
}
function hostOk(connectionString) {
  let hostname = "";
  try { hostname = new URL(connectionString).hostname; } catch { return false; }
  if (!hostname.endsWith(".neon.tech") || hostname.includes("-pooler")) return false;
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
  const row = (await client.query(`
    select current_user, session_user, current_database() as database, pg_backend_pid() as pid,
           current_setting('neon.branch_id', true) as branch_id,
           current_setting('neon.project_id', true) as project_id,
           current_setting('neon.endpoint_id', true) as endpoint_id
  `)).rows[0];
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
  if (FORBIDDEN_BRANCHES.includes(id.branchId) || id.branchId !== EXPECTED_BRANCH || id.projectId !== EXPECTED_PROJECT || id.endpointId !== EXPECTED_ENDPOINT) {
    blocked(`${label} is not the authorised disposable branch`);
    return false;
  }
  if (id.database !== EXPECTED_DB || id.currentUser !== EXPECTED_ROLE || id.sessionUser !== EXPECTED_ROLE) {
    blocked(`${label} identity is not ${EXPECTED_ROLE}`);
    return false;
  }
  say(`${label}_production_branch_connected=false`);
  say(`${label}_cp28_branch_connected=false`);
  return true;
}
function directAdapter(client, bag) {
  return {
    async query(text, params = []) {
      const t0 = performance.now();
      const result = await client.query(text, params);
      bag?.steps.push({ purpose: purpose(text), ms: Math.round(performance.now() - t0), inTx: Boolean(bag?.inTx) });
      return result.rows;
    },
    async transaction(fn) {
      const t0 = performance.now();
      const b0 = performance.now();
      await client.query("BEGIN");
      bag?.steps.push({ purpose: "begin", ms: Math.round(performance.now() - b0), inTx: true });
      if (bag) bag.inTx = true;
      try {
        const value = await fn(directAdapter(client, bag));
        const c0 = performance.now();
        await client.query("COMMIT");
        bag?.steps.push({ purpose: "commit", ms: Math.round(performance.now() - c0), inTx: true });
        if (bag) bag.txMs = Math.round(performance.now() - t0);
        return value;
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch { /* aborted */ }
        throw err;
      } finally {
        if (bag) bag.inTx = false;
      }
    },
  };
}
function poolAdapter(exec, bag, inTx = false) {
  return {
    async query(text, params = []) {
      const t0 = performance.now();
      const result = await exec.executeQuery(CompiledQuery.raw(text, params));
      bag?.steps.push({ purpose: purpose(text), ms: Math.round(performance.now() - t0), inTx });
      return result.rows;
    },
    transaction(fn) {
      if (!("transaction" in exec) || typeof exec.transaction !== "function") throw new Error("nested booking transaction");
      const t0 = performance.now();
      return exec.transaction().execute((trx) => fn(poolAdapter(trx, bag, true))).finally(() => {
        if (bag) bag.txMs = Math.round(performance.now() - t0);
      });
    },
  };
}
function instrumentConnect(pool, bag) {
  const connect = pool.connect.bind(pool);
  pool.connect = function patched(cb) {
    const t0 = performance.now();
    const note = () => {
      bag.connectMs.push(performance.now() - t0);
      bag.peakTotal = Math.max(bag.peakTotal, pool.totalCount);
      bag.peakWaiting = Math.max(bag.peakWaiting, pool.waitingCount);
      bag.peakIdle = Math.max(bag.peakIdle, pool.idleCount);
    };
    if (typeof cb === "function") return connect((err, client, done) => { note(); cb(err, client, done); });
    return connect().then((client) => { note(); return client; });
  };
}
function watchPool(pool) {
  const seen = { waiting: 0, total: 0, idle: 0 };
  const timer = setInterval(() => {
    seen.waiting = Math.max(seen.waiting, pool.waitingCount);
    seen.total = Math.max(seen.total, pool.totalCount);
    seen.idle = Math.max(seen.idle, pool.idleCount);
  }, 20);
  return { stop() { clearInterval(timer); return seen; } };
}
function bookingInput(hotel, when, key, guestName = "CP293 Guest") {
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
function scopeFor(providerId) {
  return {
    operatorId: randomUUID(),
    login: "cp293",
    sessionId: randomUUID(),
    membershipId: randomUUID(),
    accessClass: "provider_dispatcher",
    hotelId: null,
    providerId,
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
    try { await client.query("ROLLBACK"); } catch { /* aborted */ }
    const code = err?.code || "";
    say(`${label}_sqlstate=${code || "(none)"}`);
    if (code !== "42501") {
      failed(`${label} expected 42501, got ${code || redact(err?.message)}`);
      return false;
    }
    return true;
  }
}
async function overlapCount(client, column) {
  const row = (await client.query(
    `select count(*)::int as n from bookings a join bookings b
       on a.id < b.id and a.${column} = b.${column}
      and a.cancelled_at is null and b.cancelled_at is null
      and not isempty(a.occupies) and not isempty(b.occupies) and a.occupies && b.occupies
     where a.guest_email like $1 and b.guest_email like $1`,
    [EMAIL_LIKE],
  )).rows[0];
  return Number(row.n);
}
async function privilegeHash(client) {
  const table = (await client.query(`select md5(coalesce(string_agg(table_name || ':' || privilege_type, ',' order by table_name, privilege_type), '')) as h from information_schema.role_table_grants where grantee = current_user`)).rows[0].h;
  const column = (await client.query(`select md5(coalesce(string_agg(table_name || '.' || column_name || ':' || privilege_type, ',' order by table_name, column_name, privilege_type), '')) as h from information_schema.column_privileges where grantee = current_user`)).rows[0].h;
  const roles = Number((await client.query(`select count(*)::int as n from pg_roles`)).rows[0].n);
  return { table, column, roles };
}
function summarise(label, rows, elapsedMs, extra = {}) {
  const ok = rows.filter((row) => row.ok);
  const bad = rows.filter((row) => !row.ok);
  const classes = {};
  for (const row of bad) classes[row.code || "(none)"] = (classes[row.code || "(none)"] || 0) + 1;
  const latency = dist(ok.map((row) => row.ms));
  const payload = {
    attempted: rows.length,
    success: ok.length,
    failed: bad.length,
    classes,
    latency,
    elapsedMs: Math.round(elapsedMs),
    throughput: elapsedMs > 0 ? Number((ok.length / (elapsedMs / 1000)).toFixed(2)) : 0,
    ...extra,
  };
  say(`${label}=${JSON.stringify(payload)}`);
  report[label] = payload;
  return payload;
}
async function activity(client) {
  const rows = (await client.query(
    `select application_name as app, coalesce(state, 'null') as state, count(*)::int as n
       from pg_stat_activity
      where datname = current_database() and application_name like 'cp293-%'
      group by 1, 2`,
  )).rows;
  return rows.map((row) => ({ app: row.app, state: row.state, n: Number(row.n) }));
}
async function explainSelect(client, text, params) {
  const row = (await client.query(`explain (analyze, buffers, format json) ${text}`, params)).rows[0];
  const plan = row["QUERY PLAN"]?.[0]?.Plan;
  const nodes = [];
  const walk = (node) => {
    if (!node) return;
    nodes.push(node["Node Type"]);
    for (const child of node.Plans || []) walk(child);
  };
  walk(plan);
  return { ms: plan ? Math.round(Number(plan["Actual Total Time"])) : null, rows: plan ? Number(plan["Actual Rows"]) : null, nodes: [...new Set(nodes)] };
}
async function isolateHold() {
  const url = process.env.AETHER_CP29_DATABASE_URL || "";
  if (!hostOk(url)) {
    blocked("isolate URL is not the authorised direct compute");
    return;
  }
  const settings = neonPoolSettings();
  const pool = new pg.Pool({
    connectionString: url,
    application_name: "cp293-isolate",
    max: settings.max,
    idleTimeoutMillis: settings.idleTimeoutMillis,
    connectionTimeoutMillis: settings.connectionTimeoutMillis,
    allowExitOnIdle: settings.allowExitOnIdle,
  });
  const held = [];
  try {
    for (let i = 0; i < settings.max; i += 1) held.push(await pool.connect());
    if (!branchOk("isolate", await readIdentity(held[0]))) return;
    await new Promise((resolve) => setTimeout(resolve, 2500));
  } finally {
    for (const client of held) client.release();
    await pool.end();
  }
}

async function main() {
  if (process.env.CP293_CONFIRMATION !== CONFIRMATION) {
    blocked("confirmation rejected; database not opened");
    return;
  }
  if (process.env.CP293_MODE === "isolate") {
    await isolateHold();
    return;
  }
  say("confirmation=accepted");
  const stripe = String(process.env.STRIPE_SECRET_KEY || "");
  if (String(process.env.SBG_SAAS_COMMERCE || "") === "live" || String(process.env.SBG_DOMAIN_B_LIVE_CHECKOUT || "") === "true" || stripe.startsWith("sk_live_") || stripe.startsWith("rk_live_")) {
    blocked("live commerce or live stripe is set; database not opened");
    return;
  }
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.DATABASE_URL;
  delete process.env.AETHER_DATABASE_OWNER_URL;
  say("live_commerce=absent");
  say("stripe_network=disabled");
  say("resend_network=disabled");
  const names = execFileSync("git", ["diff", "--name-only", BASELINE, "HEAD"], { cwd: root, encoding: "utf8" }).split("\n").map((line) => line.trim()).filter(Boolean).sort();
  const allowed = [...ALLOWED_DIFF].sort();
  say(`diff_from_baseline=${names.join(",") || "(none)"}`);
  if (names.length !== allowed.length || names.some((name, index) => name !== allowed[index])) {
    blocked("tree differs from the authorised baseline by more than the temporary CP29.3 harness");
    return;
  }
  execFileSync("git", ["merge-base", "--is-ancestor", BASELINE, "HEAD"], { cwd: root });
  const files = (await readdir(join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
  if (files.length !== ACCEPTED_LEDGER.length || files.some((name, index) => name !== ACCEPTED_LEDGER[index]) || AUTHORISED_PENDING.length) {
    blocked("source ledger is not exactly 0001-0030");
    return;
  }
  say(`source_migrations=${files.length}`);
  say(`source_last=${files.at(-1)}`);
  say(`authorised_pending=${JSON.stringify(AUTHORISED_PENDING)}`);
  const url = process.env.AETHER_CP29_DATABASE_URL || "";
  if (!url.startsWith("postgres") || !hostOk(url)) {
    blocked("runtime URL is missing or not the authorised direct compute; database not opened");
    return;
  }
  say("runtime_transport=direct_host_allowlisted");
  const settings = neonPoolSettings();
  say(`pool_settings=${JSON.stringify(settings)}`);
  say("pool_instantiation=one Pool per isolate via getPgPool globalThis singleton; harness uses that same neonPoolSettings and does not modify it");
  say("pool_modified=false");

  const observe = makeClient(url, "cp293-observe");
  const direct = makeClient(url, "cp293-direct");
  const poolBag = { connectMs: [], peakTotal: 0, peakWaiting: 0, peakIdle: 0 };
  const pool = new pg.Pool({
    connectionString: url,
    application_name: "cp293-pool",
    max: settings.max,
    idleTimeoutMillis: settings.idleTimeoutMillis,
    connectionTimeoutMillis: settings.connectionTimeoutMillis,
    allowExitOnIdle: settings.allowExitOnIdle,
  });
  instrumentConnect(pool, poolBag);
  const kysely = new Kysely({ dialect: new PostgresDialect({ pool }) });
  try {
    await observe.connect();
    await direct.connect();
    if (!branchOk("observe", await readIdentity(observe)) || !branchOk("direct", await readIdentity(direct))) return;
    const hotels = (await observe.query(
      `select h.code, h.status, d.id::text as destination_id, a.provider_id::text as provider_id,
              (select v.id::text from vehicles v where v.operated_by_provider_id = a.provider_id order by v.name limit 1) as vehicle_id
         from hotels h
         join hotel_destinations d on d.hotel_id = h.id and d.active
         join hotel_provider_agreements a on a.hotel_id = h.id and a.active
        where h.code = any($1::text[])
        order by h.code, d.sort_order`,
      [FIXTURE_CODES],
    )).rows;
    const byCode = new Map();
    for (const row of hotels) if (!byCode.has(row.code)) byCode.set(row.code, row);
    const fixture = FIXTURE_CODES.map((code) => byCode.get(code));
    const bookingsBefore = Number((await observe.query(`select count(*)::int as n from bookings where guest_email like $1`, [EMAIL_LIKE])).rows[0].n);
    const vehicleBefore = await overlapCount(observe, "vehicle_id");
    const driverBefore = await overlapCount(observe, "driver_id");
    const dupBefore = Number((await observe.query(`select count(*)::int as n from (select confirmation_token from bookings group by 1 having count(*) > 1) d`)).rows[0].n);
    const stuckBefore = Number((await observe.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'idle in transaction' and application_name like 'cp293-%'`)).rows[0].n);
    say(`fixture_statuses=${fixture.map((row) => row ? `${row.code}:${row.status}` : "missing").join(",")}`);
    say(`fixture_bookings_before=${bookingsBefore}`);
    say(`vehicle_overlaps_before=${vehicleBefore}`);
    say(`driver_overlaps_before=${driverBefore}`);
    say(`duplicate_tokens_before=${dupBefore}`);
    say(`stuck_before=${stuckBefore}`);
    if (fixture.some((row) => !row || row.status !== "live" || !row.destination_id || !row.vehicle_id) || bookingsBefore < 59 || vehicleBefore || driverBefore || dupBefore || stuckBefore) {
      blocked("existing CP29 fixtures are not the live consistent set; owner publication was not repeated");
      return;
    }
    const grantsBefore = await privilegeHash(observe);
    say(`grants_before=${JSON.stringify(grantsBefore)}`);

    const rtts = [];
    for (let i = 0; i < 21; i += 1) {
      const t0 = performance.now();
      await direct.query("select 1");
      rtts.push(Math.round(performance.now() - t0));
    }
    say(`select1_rtt=${JSON.stringify(dist(rtts.slice(1)))}`);
    const pairs = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      await direct.query("BEGIN");
      const mid = performance.now();
      await direct.query("COMMIT");
      pairs.push({ begin: Math.round(mid - t0), commit: Math.round(performance.now() - mid) });
    }
    say(`begin_commit_sample=${JSON.stringify(pairs)}`);
    const hashT0 = performance.now();
    hashGuestClientKey("cp293-local");
    say(`hash_guest_client_key_ms=${(performance.now() - hashT0).toFixed(3)}`);

    const { createLimitedGuestBooking } = await import("../src/lib/aether/guest-create.ts");
    const { sendConfirmationEmail } = await import("../src/lib/aether/confirmation-email.ts");
    const { assignVehicle } = await import("../src/lib/aether/inventory.ts");
    const ops = await import("../src/lib/aether/ops-desk.ts");
    const hotel0 = { code: fixture[0].code, destinationId: fixture[0].destination_id, providerId: fixture[0].provider_id, vehicleId: fixture[0].vehicle_id };
    const directBag = { steps: [], inTx: false, txMs: 0 };
    const directStarted = performance.now();
    const created = await createLimitedGuestBooking(
      directAdapter(direct, directBag),
      bookingInput(hotel0, { date: "2027-02-02", time: "08:00", minutes: 30 }, `${KEY_PREFIX}waterfall`),
      `${KEY_PREFIX}hint-waterfall`,
    );
    const directTotal = Math.round(performance.now() - directStarted);
    const querySum = directBag.steps.reduce((sum, step) => sum + step.ms, 0);
    say(`waterfall_total_ms=${directTotal}`);
    say(`waterfall_query_sum_ms=${querySum}`);
    say(`waterfall_tx_ms=${directBag.txMs}`);
    say(`waterfall_unaccounted_ms=${directTotal - querySum}`);
    say(`waterfall_round_trips=${directBag.steps.length}`);
    say(`waterfall_steps=${JSON.stringify(directBag.steps)}`);
    say(`waterfall_email=${created.confirmationEmailStatus}`);
    if (created.confirmationEmailStatus !== "not_configured") failed("confirmation email was not not_configured");
    const emailT0 = performance.now();
    const emailOnly = await sendConfirmationEmail({
      humanReference: "PT-CP293", hotelName: "cp293", transferDate: "2027-02-02", pickupTime: "08:00",
      durationMinutes: 30, pickupText: "lobby", destinationText: "airport", passengerCount: 1, luggageCount: 0,
      pricing: { priced: true, currency: "EUR", amountMinor: 4500 }, confirmationToken: "synthetic-not-logged",
    }, "cp293@example.test");
    say(`email_only_ms=${(performance.now() - emailT0).toFixed(3)}`);
    say(`email_only_status=${emailOnly.status}`);

    const app = poolAdapter(kysely, null);
    const poolTrace = { steps: [], txMs: 0 };
    const poolStarted = performance.now();
    const poolOne = await createLimitedGuestBooking(
      poolAdapter(kysely, poolTrace),
      bookingInput(hotel0, { date: "2027-02-02", time: "08:10", minutes: 30 }, `${KEY_PREFIX}pool-one`),
      `${KEY_PREFIX}hint-pool-one`,
    );
    say(`pool_one_total_ms=${Math.round(performance.now() - poolStarted)}`);
    say(`pool_one_tx_ms=${poolTrace.txMs}`);
    say(`pool_one_steps=${JSON.stringify(poolTrace.steps)}`);
    say(`pool_one_email=${poolOne.confirmationEmailStatus}`);
    say(`pool_one_connect=${JSON.stringify(dist(poolBag.connectMs.map((n) => Math.round(n))))}`);

    async function wave(level) {
      const started = Date.now();
      const before = poolBag.connectMs.length;
      const watch = watchPool(pool);
      const rows = await Promise.all(Array.from({ length: level }, (_, index) => {
        const t0 = performance.now();
        const hotel = fixture[index % 4];
        return createLimitedGuestBooking(
          app,
          bookingInput(
            { code: hotel.code, destinationId: hotel.destination_id },
            { date: "2027-02-03", time: `08:${String(level).padStart(2, "0")}`, minutes: 20 },
            `${KEY_PREFIX}c${level}-${index}`,
          ),
          `${KEY_PREFIX}hint-c${level}-${index}`,
        ).then(
          (value) => ({ ok: true, ms: performance.now() - t0, email: value.confirmationEmailStatus }),
          (err) => ({ ok: false, ms: performance.now() - t0, code: failCode(err) }),
        );
      }));
      const seen = watch.stop();
      const act = await activity(observe);
      return summarise(`pool_c${level}`, rows, Date.now() - started, {
        concurrency: level,
        connect: dist(poolBag.connectMs.slice(before).map((n) => Math.round(n))),
        ...seen,
        activity: act,
      });
    }
    const baselineWave = await wave(1);
    await wave(2);
    await wave(4);
    await wave(8);
    await wave(16);

    const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, CP293_MODE: "isolate" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childOut = "";
    child.stdout.on("data", (chunk) => { childOut += chunk; });
    child.stderr.on("data", (chunk) => { childOut += chunk; });
    const isolateSeen = [];
    const isolateTimer = setInterval(async () => { try { isolateSeen.push(await activity(observe)); } catch { /* busy */ } }, 200);
    const childCode = await new Promise((resolve) => child.on("close", resolve));
    clearInterval(isolateTimer);
    say(`isolate_exit=${childCode}`);
    for (const line of childOut.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("CP293 ")) say(`child_${trimmed.slice(6)}`);
    }
    const isolatePeak = {};
    for (const sample of isolateSeen) for (const row of sample) isolatePeak[`${row.app}:${row.state}`] = Math.max(isolatePeak[`${row.app}:${row.state}`] || 0, row.n);
    say(`isolate_activity_peak=${JSON.stringify(isolatePeak)}`);
    if (childCode !== 0) failed("second isolate did not prove the disposable branch");

    const scope = scopeFor(hotel0.providerId);
    async function timeOps(label, fn) {
      const t0 = performance.now();
      const value = await fn();
      const count = Array.isArray(value) ? value.length : value?.feed ? value.feed.length : 1;
      say(`${label}_ms=${Math.round(performance.now() - t0)}`);
      say(`${label}_rows=${count}`);
      return value;
    }
    const board = await timeOps("ops_today", () => ops.loadTodayBoard(app, scope));
    const listed = await timeOps("ops_list", () => ops.listOpsBookings(app, scope));
    if (listed[0]) await timeOps("ops_detail", () => ops.getOpsBooking(app, scope, listed[0].id));
    await timeOps("ops_vehicles", () => ops.listOpsVehicles(app, scope));
    await timeOps("ops_drivers", () => ops.listOpsDrivers(app, scope));
    await timeOps("ops_hotels", () => ops.listOpsHotels(app, scope));
    say(`explain_list=${JSON.stringify(await explainSelect(observe, `select b.id from bookings b where b.executing_provider_id = $1::uuid order by b.transfer_date desc, b.pickup_time, b.created_at`, [hotel0.providerId]))}`);
    say(`explain_today=${JSON.stringify(await explainSelect(observe, `select b.id from bookings b where b.transfer_date = $1::date and b.executing_provider_id = $2::uuid order by b.pickup_time, b.created_at`, [board.boardDate, hotel0.providerId]))}`);
    say("ops_list_bounded=false");
    say("ops_today_date_scoped=true");
    say("ops_today_row_limit=false");
    say("ops_detail_bounded=id");
    say("ops_resource_lists_provider_scoped=true");
    say("ops_pagination=none");

    const mixStarted = Date.now();
    const mix = await Promise.all([
      createLimitedGuestBooking(app, bookingInput(hotel0, { date: "2027-02-04", time: "09:00", minutes: 30 }, `${KEY_PREFIX}mix-a`), `${KEY_PREFIX}hint-mix-a`).then(() => ({ ok: true, kind: "create" }), (err) => ({ ok: false, kind: "create", code: failCode(err) })),
      ops.loadTodayBoard(app, scope).then((value) => ({ ok: true, kind: "today", rows: value.feed.length }), (err) => ({ ok: false, kind: "today", code: failCode(err) })),
      ops.listOpsBookings(app, scope).then((value) => ({ ok: true, kind: "list", rows: value.length }), (err) => ({ ok: false, kind: "list", code: failCode(err) })),
      ops.listOpsVehicles(app, scope).then((value) => ({ ok: true, kind: "vehicles", rows: value.length }), (err) => ({ ok: false, kind: "vehicles", code: failCode(err) })),
      ops.listOpsDrivers(app, scope).then((value) => ({ ok: true, kind: "drivers", rows: value.length }), (err) => ({ ok: false, kind: "drivers", code: failCode(err) })),
    ]);
    say(`mix_stage_a_elapsed_ms=${Date.now() - mixStarted}`);
    say(`mix_stage_a=${JSON.stringify(mix)}`);

    async function readWave(label, count, note) {
      const started = Date.now();
      const watch = watchPool(pool);
      const rows = await Promise.all(Array.from({ length: count }, (_, index) => {
        const t0 = performance.now();
        const op = index % 2 === 0 ? ops.loadTodayBoard(app, scope) : ops.listOpsBookings(app, scope);
        return op.then(
          (value) => ({ ok: true, ms: performance.now() - t0, rows: value.feed ? value.feed.length : value.length }),
          (err) => ({ ok: false, ms: performance.now() - t0, code: failCode(err) }),
        );
      }));
      return summarise(label, rows, Date.now() - started, { note, ...watch.stop() });
    }
    await readWave("ops_stage_b10", 10, "10 concurrent reads on the existing 4 hotels, not 10 tenants");
    await readWave("ops_stage_c100", 100, "100 concurrent today/list reads through pool max 2; not 100 tenant universes");

    const occWhen = { date: "2027-02-06", time: "10:00", minutes: 60 };
    const left = await createLimitedGuestBooking(app, bookingInput(hotel0, occWhen, `${KEY_PREFIX}occ-a`), `${KEY_PREFIX}hint-occ-a`);
    const right = await createLimitedGuestBooking(app, bookingInput(hotel0, occWhen, `${KEY_PREFIX}occ-b`), `${KEY_PREFIX}hint-occ-b`);
    const scopeOcc = scopeFor(hotel0.providerId);
    const race = await Promise.all([left, right].map((booking) => assignVehicle(app, { bookingId: booking.id, vehicleId: hotel0.vehicleId, scope: scopeOcc }).then(() => ({ ok: true, code: "" }), (err) => ({ ok: false, code: failCode(err) }))));
    const assigned = (await observe.query(`select vehicle_id::text from bookings where id = any($1::uuid[])`, [[left.id, right.id]])).rows;
    say(`occupancy_results=${JSON.stringify(race)}`);
    say(`occupancy_winners=${assigned.filter((row) => row.vehicle_id === hotel0.vehicleId).length}`);
    say(`occupancy_unchanged=${assigned.filter((row) => row.vehicle_id == null).length}`);
    if (race.filter((row) => row.ok).length !== 1 || !race.some((row) => row.code === "unavailable")) failed("pool occupancy race was not one winner and one unavailable");
    const adj = [];
    for (const [time, key] of [["12:00", "adj-a"], ["13:00", "adj-b"]]) {
      const booking = await createLimitedGuestBooking(app, bookingInput(hotel0, { date: "2027-02-06", time, minutes: 60 }, `${KEY_PREFIX}${key}`), `${KEY_PREFIX}hint-${key}`);
      adj.push(await assignVehicle(app, { bookingId: booking.id, vehicleId: hotel0.vehicleId, scope: scopeOcc }).then(() => "assigned", (err) => failCode(err)));
    }
    say(`adjacency=${adj.join(",")}`);
    if (adj.some((item) => item !== "assigned")) failed("adjacency assignment did not both succeed");

    const stormKey = `${KEY_PREFIX}storm`;
    const stormWhen = { date: "2027-02-07", time: "10:00", minutes: 30 };
    const stormStarted = Date.now();
    const storm = await Promise.all(Array.from({ length: 8 }, (_, index) => {
      const t0 = performance.now();
      return createLimitedGuestBooking(app, bookingInput(hotel0, stormWhen, stormKey), `${KEY_PREFIX}hint-storm-${index}`).then(
        (value) => ({ ok: true, ms: performance.now() - t0, ref: value.humanReference }),
        (err) => ({ ok: false, ms: performance.now() - t0, code: failCode(err) }),
      );
    }));
    const stormSummary = summarise("idempotency_pool", storm, Date.now() - stormStarted, { concurrency: 8 });
    const refs = new Set(storm.filter((row) => row.ok).map((row) => row.ref));
    const stormBookings = Number((await observe.query(`select count(*)::int as n from bookings b join idempotency_keys k on k.booking_id = b.id where k.key = $1`, [stormKey])).rows[0].n);
    const conflict = await createLimitedGuestBooking(app, { ...bookingInput(hotel0, stormWhen, stormKey), guestName: "CP293 Conflict" }, `${KEY_PREFIX}hint-storm-conflict`).then(() => "created", (err) => failCode(err));
    say(`idempotency_distinct_references=${refs.size}`);
    say(`idempotency_bookings=${stormBookings}`);
    say(`idempotency_conflict=${conflict}`);
    if (stormSummary.success !== 8 || refs.size !== 1 || stormBookings !== 1 || conflict !== "idempotency_conflict") failed("pool idempotency contract failed");
    say("limiter_retest=not_rerun");
    say("limiter_prior_overshoot=4");
    say("limiter_prior_class=acceptable_bounded_hardening_debt");

    await new Promise((resolve) => setTimeout(resolve, 2000));
    const stuckAfter = Number((await observe.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'idle in transaction' and application_name like 'cp293-%'`)).rows[0].n);
    say(`stuck_after_wait=${stuckAfter}`);
    const recoveryRows = [];
    const recoveryStarted = Date.now();
    for (let index = 0; index < 3; index += 1) {
      const t0 = performance.now();
      try {
        await createLimitedGuestBooking(app, bookingInput(hotel0, { date: "2027-02-08", time: `08:${String(index * 10).padStart(2, "0")}`, minutes: 30 }, `${KEY_PREFIX}recovery-${index}`), `${KEY_PREFIX}hint-recovery-${index}`);
        recoveryRows.push({ ok: true, ms: performance.now() - t0 });
      } catch (err) {
        recoveryRows.push({ ok: false, ms: performance.now() - t0, code: failCode(err) });
      }
    }
    summarise("recovery", recoveryRows, Date.now() - recoveryStarted);
    say(`recovery_first_ms=${recoveryRows[0]?.ok ? Math.round(recoveryRows[0].ms) : "failed"}`);
    say(`baseline_pool_p50=${baselineWave.latency.p50}`);
    if (recoveryRows.filter((row) => row.ok).length !== 3 || stuckAfter) failed("recovery did not clear saturation");

    for (const [sql, label] of [
      ["alter table bookings disable trigger bookings_occupies_before", "disable_occupancy_trigger"],
      ["alter table bookings drop constraint bookings_vehicle_occupancy_excl", "drop_vehicle_exclude"],
      ["alter table bookings drop constraint bookings_driver_occupancy_excl", "drop_driver_exclude"],
      ["delete from bookings where false", "delete_bookings"],
      ["set role neondb_owner", "set_role_owner"],
      ["insert into _migrations (name) values ('0031_cp293_forbidden')", "insert_migration"],
      ["update hotels set status = 'live' where code = 'cp293-not-authorised'", "publish_unauthorised_hotel"],
    ]) {
      if (!(await expectDenied(direct, sql, label))) return;
    }
    const trigger = (await observe.query(`select tgenabled from pg_trigger where tgrelid = 'public.bookings'::regclass and tgname = 'bookings_occupies_before' and not tgisinternal`)).rows[0];
    const constraints = (await observe.query(`select c.conname from pg_constraint c join pg_class r on r.oid = c.conrelid where r.relname = 'bookings' and c.conname in ('bookings_vehicle_occupancy_excl', 'bookings_driver_occupancy_excl') order by 1`)).rows.map((row) => row.conname);
    say(`occupancy_trigger=${trigger?.tgenabled || "(missing)"}`);
    say(`occupancy_constraints=${constraints.join(",")}`);
    const grantsAfter = await privilegeHash(observe);
    say(`grants_after=${JSON.stringify(grantsAfter)}`);
    if (JSON.stringify(grantsAfter) !== JSON.stringify(grantsBefore)) failed("grants or roles changed");
    say(`fixture_bookings_after=${Number((await observe.query(`select count(*)::int as n from bookings where guest_email like $1`, [EMAIL_LIKE])).rows[0].n)}`);
    say(`vehicle_overlaps=${await overlapCount(observe, "vehicle_id")}`);
    say(`driver_overlaps=${await overlapCount(observe, "driver_id")}`);
    say(`duplicate_tokens=${Number((await observe.query(`select count(*)::int as n from (select confirmation_token from bookings group by 1 having count(*) > 1) d`)).rows[0].n)}`);
    say(`cross_tenant=${Number((await observe.query(`select count(*)::int as n from bookings b join idempotency_keys k on k.booking_id = b.id where k.key like $1 and b.hotel_id not in (select id from hotels where code = any($2::text[]))`, [`${KEY_PREFIX}%`, FIXTURE_CODES])).rows[0].n)}`);
    say(`pool_peak_total=${poolBag.peakTotal}`);
    say(`pool_peak_waiting=${poolBag.peakWaiting}`);
    if ((await overlapCount(observe, "vehicle_id")) || (await overlapCount(observe, "driver_id"))) failed("final overlap invariant failed");
    if (trigger?.tgenabled !== "O" || constraints.length !== 2) failed("occupancy protection missing at the end");
  } finally {
    await kysely.destroy().catch(() => {});
    await direct.end().catch(() => {});
    await observe.end().catch(() => {});
  }
}

main().then(() => process.exit(exitCode)).catch((err) => {
  console.error(`CP293 FAIL ${redact(err?.stack || err?.message || err)}`);
  process.exit(1);
});
