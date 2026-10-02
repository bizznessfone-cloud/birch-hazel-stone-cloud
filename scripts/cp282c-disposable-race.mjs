#!/usr/bin/env node
/**
 * CP28.2C — disposable Neon branch race gate.
 *
 * Connects only through AETHER_DISPOSABLE_DATABASE_URL as aether_app.
 * Does not migrate, does not SET ROLE to an owner, does not grant, does not DELETE.
 * Refuses to open a connection unless confirmation, git baseline, source ledger,
 * and (after connect) neon.branch_id all match. Never prints the connection string.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ACCEPTED_LEDGER, AUTHORISED_PENDING } from "./production-db-preflight.mjs";

const BASELINE = "b8b04e7145fbf2774b5f873686f83f35f7cdb36a";
const CONFIRMATION = "RUN-CP28-2C";
const EXPECTED_BRANCH = "br-icy-shadow-b1fh96gk";
const EXPECTED_BRANCH_NAME = "cp28-2c-race-gate";
const FORBIDDEN_BRANCH = "br-green-darkness-b1k7wkue";
const EXPECTED_PROJECT = "quiet-sound-53513710";
const EXPECTED_DB = "neondb";
const EXPECTED_ROLE = "aether_app";
const ALLOWED_DIFF = [
  ".github/workflows/cp282c-disposable-race.yml",
  "scripts/cp282c-disposable-race.mjs",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function say(message) {
  console.log(`CP282C ${message}`);
}

function redact(value) {
  let text = String(value ?? "");
  const raw = process.env.AETHER_DISPOSABLE_DATABASE_URL;
  if (raw) {
    text = text.split(raw).join("postgres://redacted");
    try {
      const parsed = new URL(raw);
      if (parsed.password) text = text.split(decodeURIComponent(parsed.password)).join("redacted");
      if (parsed.password) text = text.split(parsed.password).join("redacted");
    } catch {
      /* URL parse is best-effort redaction only. */
    }
  }
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted");
}

function blocked(message) {
  console.error(`CP282C BLOCKED ${redact(message)}`);
  process.exitCode = 2;
}

function failed(message) {
  console.error(`CP282C FAIL ${redact(message)}`);
  process.exitCode = 1;
}

function assertConfirmation() {
  if (process.env.CP282C_CONFIRMATION !== CONFIRMATION) {
    blocked("confirmation rejected; database not opened");
    return false;
  }
  say("confirmation=accepted");
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
  if (names.length !== allowed.length || names.some((name, i) => name !== allowed[i])) {
    blocked("tree differs from the authorised baseline by more than the temporary CP28.2C harness; database not opened");
    return false;
  }
  execFileSync("git", ["merge-base", "--is-ancestor", BASELINE, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  say("git_baseline=temporary_harness_only");
  return true;
}

async function assertSourceLedger() {
  const files = (await readdir(join(root, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const same =
    files.length === ACCEPTED_LEDGER.length && files.every((name, i) => name === ACCEPTED_LEDGER[i]);
  say(`source_migrations=${files.length}`);
  say(`source_last=${files.at(-1) ?? "(none)"}`);
  say(`authorised_pending=${JSON.stringify(AUTHORISED_PENDING)}`);
  if (!same) {
    blocked("source migrations are not exactly 0001-0030; database not opened");
    return false;
  }
  if (files.some((name) => name.startsWith("0031"))) {
    blocked("0031 is present in source; database not opened");
    return false;
  }
  if (AUTHORISED_PENDING.length !== 0) {
    blocked("AUTHORISED_PENDING is not empty; database not opened");
    return false;
  }
  say("source_ledger=0001-0030");
  say("source_0031=absent");
  return true;
}

function hostBindsEndpoint(connectionString, endpointId) {
  if (!endpointId || !/^ep-[a-z0-9-]+$/i.test(endpointId)) return false;
  let hostname = "";
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    return false;
  }
  return hostname === endpointId || hostname.startsWith(`${endpointId}.`) || hostname.startsWith(`${endpointId}-`);
}

async function readIdentity(client) {
  const row = (
    await client.query(`
      select
        current_user as current_user,
        session_user as session_user,
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

function identityOk(label, id, connectionString) {
  say(`${label}_current_user=${id.currentUser}`);
  say(`${label}_session_user=${id.sessionUser}`);
  say(`${label}_database=${id.database}`);
  say(`${label}_pid=${id.pid}`);
  say(`${label}_branch_id=${id.branchId || "(empty)"}`);
  say(`${label}_project_id=${id.projectId || "(empty)"}`);
  say(`${label}_endpoint_id=${id.endpointId || "(empty)"}`);
  if (id.branchId === FORBIDDEN_BRANCH) {
    blocked(`${label} is the production branch ${FORBIDDEN_BRANCH}; no writes`);
    return false;
  }
  if (id.branchId !== EXPECTED_BRANCH) {
    blocked(
      `${label} neon.branch_id is not ${EXPECTED_BRANCH} (branch name ${EXPECTED_BRANCH_NAME} was not inferred from the secret); no writes`,
    );
    return false;
  }
  if (id.projectId !== EXPECTED_PROJECT) {
    blocked(`${label} neon.project_id is not ${EXPECTED_PROJECT}; no writes`);
    return false;
  }
  if (id.currentUser !== EXPECTED_ROLE || id.sessionUser !== EXPECTED_ROLE) {
    blocked(`${label} role is not ${EXPECTED_ROLE}; no writes`);
    return false;
  }
  if (id.database !== EXPECTED_DB) {
    blocked(`${label} database is not ${EXPECTED_DB}; no writes`);
    return false;
  }
  if (!Number.isInteger(id.pid) || id.pid <= 0) {
    blocked(`${label} backend pid missing; no writes`);
    return false;
  }
  if (!hostBindsEndpoint(connectionString, id.endpointId)) {
    blocked(`${label} endpoint id does not match the connected host; no writes`);
    return false;
  }
  say(`${label}_endpoint_host_match=true`);
  return true;
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
  say(`occupancy_constraints=${constraints.join(",") || "(none)"}`);
  if (
    constraints.length !== 2 ||
    !constraints.includes("bookings_vehicle_occupancy_excl") ||
    !constraints.includes("bookings_driver_occupancy_excl")
  ) {
    blocked("occupancy exclusion constraints are missing; no writes");
    return false;
  }
  const trigger = (
    await client.query(
      `select tgname, tgenabled
         from pg_trigger
        where tgrelid = 'public.bookings'::regclass
          and tgname = 'bookings_occupies_before'
          and not tgisinternal`,
    )
  ).rows[0];
  say(`occupancy_trigger=${trigger ? `${trigger.tgname}:${trigger.tgenabled}` : "(missing)"}`);
  if (!trigger || trigger.tgenabled === "D") {
    blocked("bookings_occupies_before is missing or disabled; no writes");
    return false;
  }
  const payment = (
    await client.query(`select to_regprocedure('public.sbg_prepare_booking_payment(text)') as fn`)
  ).rows[0].fn;
  const hotelFn = (
    await client.query(
      `select to_regprocedure('public.sbg_create_hotel_for_user(text,text,text,text,text,text)') as fn`,
    )
  ).rows[0].fn;
  say(`prepare_booking_payment=${payment ? "present" : "absent"}`);
  say(`create_hotel_for_user=${hotelFn ? "present" : "absent"}`);
  if (!payment || !hotelFn) {
    blocked("expected runtime functions missing; no writes");
    return false;
  }
  try {
    const ledger = (await client.query("select name from _migrations order by name")).rows.map((row) => row.name);
    say(`db_migration_rows=${ledger.length}`);
    const ledgerMatches =
      ledger.length === ACCEPTED_LEDGER.length && ledger.every((name, i) => name === ACCEPTED_LEDGER[i]);
    say(`db_ledger_matches_0001_0030=${ledgerMatches}`);
    if (!ledgerMatches || ledger.some((name) => String(name).startsWith("0031"))) {
      blocked("database ledger is not exactly 0001-0030; no writes");
      return false;
    }
  } catch (err) {
    if (err?.code !== "42501") {
      blocked(`migration ledger read failed ${err?.code || ""} ${redact(err?.message)}; no writes`);
      return false;
    }
    say("migrations_table_select=denied");
  }
  return true;
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
      /* transaction already aborted */
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

function token(prefix) {
  return `${prefix}${randomBytes(6).toString("hex")}`;
}

async function insertBooking(client, fixture, email, date, time, minutes) {
  const row = (
    await client.query(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email,
         passenger_count, luggage_count,
         pickup_text, destination_text,
         human_reference, confirmation_token
       ) values (
         $1, $2, $3::date, $4::time, $5,
         $6, '+30000000000', $7,
         1, 0,
         'cp28-2c lobby', 'cp28-2c destination',
         $8, $9
       )
       returning id, guest_name, vehicle_id, driver_id, occupies::text as occupies`,
      [
        fixture.hotelId,
        fixture.providerId,
        date,
        time,
        minutes,
        email,
        email,
        token("CP282C"),
        token("cp282c"),
      ],
    )
  ).rows[0];
  return row;
}

async function racedUpdate(clientA, clientB, sql, paramsA, paramsB) {
  const started = {};
  const run = async (client, params, key) => {
    started[key] = Date.now();
    await client.query("BEGIN");
    try {
      await client.query(sql, params);
      await client.query("COMMIT");
      return { ok: true, code: "" };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* aborted */
      }
      return { ok: false, code: err?.code || "", message: redact(err?.message) };
    }
  };
  const [a, b] = await Promise.all([run(clientA, paramsA, "a"), run(clientB, paramsB, "b")]);
  const delta = Math.abs((started.a || 0) - (started.b || 0));
  return { a, b, startDeltaMs: delta };
}

function classifyRace(label, result) {
  const outcomes = [result.a, result.b];
  const wins = outcomes.filter((item) => item.ok).length;
  const losses = outcomes.filter((item) => !item.ok);
  say(`${label}_winners=${wins}`);
  say(`${label}_losers=${losses.length}`);
  say(`${label}_start_delta_ms=${result.startDeltaMs}`);
  say(`${label}_loser_sqlstate=${losses.map((item) => item.code || "(none)").join(",") || "(none)"}`);
  if (wins !== 1 || losses.length !== 1) {
    failed(`${label} expected exactly one commit and one loser`);
    return null;
  }
  if (losses[0].code !== "23P01") {
    failed(`${label} loser SQLSTATE ${losses[0].code || "(none)"}, expected 23P01`);
    return null;
  }
  const winnerKey = result.a.ok ? "a" : "b";
  return { winnerKey, loserSqlstate: losses[0].code };
}

async function loadBooking(client, id) {
  const row = (
    await client.query(
      `select id, guest_name, guest_email, vehicle_id, driver_id,
              isempty(occupies) as empty, cancelled_at is not null as cancelled,
              occupies::text as occupies, transfer_date::text as transfer_date,
              pickup_time::text as pickup_time, duration_minutes
         from bookings
        where id = $1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new Error(`fixture booking ${id} missing`);
  return row;
}

async function main() {
  if (!assertConfirmation()) return;
  try {
    if (!assertGitBaseline()) return;
  } catch (err) {
    blocked(`git baseline check failed ${redact(err?.message)}; database not opened`);
    return;
  }
  if (!(await assertSourceLedger())) return;
  const connectionString = process.env.AETHER_DISPOSABLE_DATABASE_URL;
  if (!connectionString) {
    blocked("disposable database URL is not set; database not opened");
    return;
  }
  if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    blocked("disposable database URL is not a postgres URL; database not opened");
    return;
  }

  const clientA = new pg.Client({
    connectionString,
    application_name: "cp282c-session-a",
    connectionTimeoutMillis: 45000,
  });
  const clientB = new pg.Client({
    connectionString,
    application_name: "cp282c-session-b",
    connectionTimeoutMillis: 45000,
  });
  let opened = false;
  try {
    await Promise.all([clientA.connect(), clientB.connect()]);
    opened = true;
    const idA = await readIdentity(clientA);
    const idB = await readIdentity(clientB);
    if (!identityOk("session_a", idA, connectionString)) return;
    if (!identityOk("session_b", idB, connectionString)) return;
    if (idA.pid === idB.pid) {
      blocked("backend pids are not distinct; no writes");
      return;
    }
    say(`distinct_pids=${idA.pid},${idB.pid}`);
    say(`production_branch=${FORBIDDEN_BRANCH}`);
    say("production_branch_connected=false");
    if (!(await assertSchema(clientA))) return;

    const denials = [
      ["alter table bookings disable trigger bookings_occupies_before", "disable_occupancy_trigger"],
      ["alter table bookings drop constraint bookings_vehicle_occupancy_excl", "drop_vehicle_exclude"],
      ["alter table bookings drop constraint bookings_driver_occupancy_excl", "drop_driver_exclude"],
      ["delete from bookings where false", "delete_bookings"],
      ["set role neondb_owner", "set_role_owner"],
    ];
    for (const [sql, label] of denials) {
      if (!(await expectDenied(clientA, sql, label))) return;
    }
    if (process.exitCode) return;

    const suffix = randomBytes(4).toString("hex");
    const userId = `cp28-2c-${suffix}`;
    const email = `cp28-2c-${suffix}@example.test`;
    const hotelCode = `cp28-2c-${suffix}`;
    try {
      await clientA.query(
        `insert into "user" (id, name, email, "emailVerified")
         values ($1, $2, $3, false)`,
        [userId, "cp28-2c fixture", email],
      );
    } catch (err) {
      blocked(`isolated user insert denied or failed ${err?.code || ""} ${redact(err?.message)}; no owner DML`);
      return;
    }
    let created;
    try {
      created = (
        await clientA.query(
          `select hotel_id, provider_id
             from sbg_create_hotel_for_user($1, $2, $3, $4, $5, $6)`,
          [userId, hotelCode, "cp28-2c fixture hotel", "Athens", "Europe/Athens", "EUR"],
        )
      ).rows[0];
    } catch (err) {
      blocked(
        `isolated hotel tree denied or failed ${err?.code || ""} ${redact(err?.message)}; no owner DML`,
      );
      return;
    }
    if (!created?.hotel_id || !created?.provider_id) {
      blocked("isolated hotel tree returned no ids; no further writes");
      return;
    }
    const vehicle = (
      await clientA.query(
        `insert into vehicles (name, capacity, active, owned_by_provider_id, operated_by_provider_id)
         values ($1, 4, true, $2, $2)
         returning id`,
        [`cp28-2c-vehicle-${suffix}`, created.provider_id],
      )
    ).rows[0];
    const driver = (
      await clientA.query(
        `insert into drivers (name, active, employed_by_provider_id, dispatched_by_provider_id)
         values ($1, true, $2, $2)
         returning id`,
        [`cp28-2c-driver-${suffix}`, created.provider_id],
      )
    ).rows[0];
    const fixture = {
      hotelId: created.hotel_id,
      providerId: created.provider_id,
      vehicleId: vehicle.id,
      driverId: driver.id,
    };
    say(`fixture_user=${userId}`);
    say(`fixture_hotel=${fixture.hotelId}`);
    say(`fixture_provider=${fixture.providerId}`);
    say(`fixture_vehicle=${fixture.vehicleId}`);
    say(`fixture_driver=${fixture.driverId}`);
    say("fixture_scope=newly_created_cp28-2c");

    const vehicleA = await insertBooking(clientA, fixture, `cp28-2c-va-${suffix}@example.test`, "2026-12-08", "10:00", 60);
    const vehicleB = await insertBooking(clientB, fixture, `cp28-2c-vb-${suffix}@example.test`, "2026-12-08", "10:00", 60);
    const beforeVehicle = new Map(
      [vehicleA, vehicleB].map((row) => [row.id, { guest: row.guest_name, occupies: row.occupies, vehicle: row.vehicle_id }]),
    );
    const vehicleRace = await racedUpdate(
      clientA,
      clientB,
      "update bookings set vehicle_id = $1 where id = $2",
      [fixture.vehicleId, vehicleA.id],
      [fixture.vehicleId, vehicleB.id],
    );
    const vehicleClass = classifyRace("vehicle", vehicleRace);
    if (!vehicleClass) return;
    const vehicleWinnerId = vehicleClass.winnerKey === "a" ? vehicleA.id : vehicleB.id;
    const vehicleLoserId = vehicleClass.winnerKey === "a" ? vehicleB.id : vehicleA.id;
    const vehicleWinner = await loadBooking(clientA, vehicleWinnerId);
    const vehicleLoser = await loadBooking(clientB, vehicleLoserId);
    const vehicleIntact =
      vehicleWinner.vehicle_id === fixture.vehicleId &&
      vehicleLoser.vehicle_id === null &&
      vehicleLoser.guest_name === beforeVehicle.get(vehicleLoserId).guest &&
      vehicleLoser.occupies === beforeVehicle.get(vehicleLoserId).occupies &&
      vehicleWinner.occupies === beforeVehicle.get(vehicleWinnerId).occupies &&
      vehicleLoser.empty === false &&
      vehicleWinner.cancelled === false;
    say(`vehicle_loser_keeps_vehicle=${vehicleLoser.vehicle_id !== null}`);
    say(`vehicle_winner_assigned=${vehicleWinner.vehicle_id === fixture.vehicleId}`);
    say(`vehicle_integrity=${vehicleIntact}`);
    if (!vehicleIntact) {
      failed("vehicle race transactional integrity failed");
      return;
    }

    const driverA = await insertBooking(clientA, fixture, `cp28-2c-da-${suffix}@example.test`, "2026-12-09", "10:00", 60);
    const driverB = await insertBooking(clientB, fixture, `cp28-2c-db-${suffix}@example.test`, "2026-12-09", "10:00", 60);
    const beforeDriver = new Map(
      [driverA, driverB].map((row) => [row.id, { guest: row.guest_name, occupies: row.occupies, driver: row.driver_id }]),
    );
    const driverRace = await racedUpdate(
      clientA,
      clientB,
      "update bookings set driver_id = $1 where id = $2",
      [fixture.driverId, driverA.id],
      [fixture.driverId, driverB.id],
    );
    const driverClass = classifyRace("driver", driverRace);
    if (!driverClass) return;
    const driverWinnerId = driverClass.winnerKey === "a" ? driverA.id : driverB.id;
    const driverLoserId = driverClass.winnerKey === "a" ? driverB.id : driverA.id;
    const driverWinner = await loadBooking(clientA, driverWinnerId);
    const driverLoser = await loadBooking(clientB, driverLoserId);
    const driverIntact =
      driverWinner.driver_id === fixture.driverId &&
      driverLoser.driver_id === null &&
      driverLoser.vehicle_id === null &&
      driverLoser.guest_name === beforeDriver.get(driverLoserId).guest &&
      driverLoser.occupies === beforeDriver.get(driverLoserId).occupies &&
      driverWinner.occupies === beforeDriver.get(driverWinnerId).occupies &&
      driverLoser.empty === false;
    say(`driver_loser_keeps_driver=${driverLoser.driver_id !== null}`);
    say(`driver_winner_assigned=${driverWinner.driver_id === fixture.driverId}`);
    say(`driver_integrity=${driverIntact}`);
    if (!driverIntact) {
      failed("driver race transactional integrity failed");
      return;
    }

    const adjA = await insertBooking(clientA, fixture, `cp28-2c-adj-a-${suffix}@example.test`, "2026-12-10", "10:00", 90);
    const adjB = await insertBooking(clientB, fixture, `cp28-2c-adj-b-${suffix}@example.test`, "2026-12-10", "11:30", 90);
    await clientA.query("update bookings set vehicle_id = $1, driver_id = $2 where id = $3", [
      fixture.vehicleId,
      fixture.driverId,
      adjA.id,
    ]);
    await clientB.query("update bookings set vehicle_id = $1, driver_id = $2 where id = $3", [
      fixture.vehicleId,
      fixture.driverId,
      adjB.id,
    ]);
    const adjLeft = await loadBooking(clientA, adjA.id);
    const adjRight = await loadBooking(clientB, adjB.id);
    const ranges = (
      await clientA.query(
        `select id, lower(occupies) as lo, upper(occupies) as hi
           from bookings
          where id = any($1::uuid[])`,
        [[adjA.id, adjB.id]],
      )
    ).rows;
    const leftRange = ranges.find((row) => row.id === adjA.id);
    const rightRange = ranges.find((row) => row.id === adjB.id);
    const adjacent =
      adjLeft.vehicle_id === fixture.vehicleId &&
      adjRight.vehicle_id === fixture.vehicleId &&
      adjLeft.driver_id === fixture.driverId &&
      adjRight.driver_id === fixture.driverId &&
      String(leftRange.hi) === String(rightRange.lo);
    say(`adjacency_left=${adjLeft.pickup_time}/${adjLeft.duration_minutes}`);
    say(`adjacency_right=${adjRight.pickup_time}/${adjRight.duration_minutes}`);
    say(`adjacency_bounds_touch=${String(leftRange.hi) === String(rightRange.lo)}`);
    say(`adjacency_both_committed=${adjacent}`);
    if (!adjacent) {
      failed("adjacency [) bookings did not both commit");
      return;
    }

    await clientA.query("update bookings set cancelled_at = now() where id = $1", [vehicleWinnerId]);
    const cancelled = await loadBooking(clientA, vehicleWinnerId);
    say(`cancel_isempty=${cancelled.empty === true}`);
    say(`cancel_flag=${cancelled.cancelled === true}`);
    if (cancelled.empty !== true) {
      failed("cancellation did not empty occupies");
      return;
    }
    const reused = await insertBooking(
      clientB,
      fixture,
      `cp28-2c-reuse-${suffix}@example.test`,
      "2026-12-08",
      "10:00",
      60,
    );
    await clientB.query("update bookings set vehicle_id = $1 where id = $2", [fixture.vehicleId, reused.id]);
    const reusedRow = await loadBooking(clientB, reused.id);
    say(`reuse_vehicle_assigned=${reusedRow.vehicle_id === fixture.vehicleId}`);
    say(`reuse_occupies_empty=${reusedRow.empty === true}`);
    if (reusedRow.vehicle_id !== fixture.vehicleId || reusedRow.empty === true) {
      failed("vehicle reuse after cancellation failed");
      return;
    }

    await clientA.query("update bookings set cancelled_at = now() where id = $1", [driverWinnerId]);
    const driverCancelled = await loadBooking(clientA, driverWinnerId);
    say(`driver_cancel_isempty=${driverCancelled.empty === true}`);
    if (driverCancelled.empty !== true) {
      failed("driver-winner cancellation did not empty occupies");
      return;
    }
    const driverReuse = await insertBooking(
      clientB,
      fixture,
      `cp28-2c-driver-reuse-${suffix}@example.test`,
      "2026-12-09",
      "10:00",
      60,
    );
    await clientB.query("update bookings set driver_id = $1 where id = $2", [fixture.driverId, driverReuse.id]);
    const driverReuseRow = await loadBooking(clientB, driverReuse.id);
    say(`reuse_driver_assigned=${driverReuseRow.driver_id === fixture.driverId}`);
    if (driverReuseRow.driver_id !== fixture.driverId) {
      failed("driver reuse after cancellation failed");
      return;
    }

    say("rows_left_on_disposable_branch=true");
    say("owner_dml=false");
    say("delete_granted=false");
    say("migration_executed=false");
    say("VERDICT=PASS");
  } catch (err) {
    if (!process.exitCode) {
      failed(err?.code ? `${err.code} ${redact(err.message)}` : redact(err?.message || err));
    }
  } finally {
    if (opened) {
      await Promise.allSettled([clientA.end(), clientB.end()]);
    }
  }
}

main().catch((err) => {
  if (!process.exitCode) failed(redact(err?.message || err));
});
