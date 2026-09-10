#!/usr/bin/env node
/**
 * Neon production-infrastructure gate (CP11 identity + CP12B runtime LOGIN).
 *
 * Fail closed. Never print connection strings or passwords.
 * Does not use PGLite. Does not claim production if this process cannot
 * connect to Neon with a runtime role distinct from the schema owner.
 *
 * Required env (names only):
 *   DATABASE_URL                 runtime LOGIN — must be aether_runtime, not owner
 *   AETHER_DATABASE_OWNER_URL    migration/schema-owner login
 *
 * The runtime pool must authenticate as aether_runtime LOGIN.
 * Do not pass a startup role option. session_user and current_user
 * must both be aether_runtime.
 */
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = "aether_runtime";
const runtimeUrl = (process.env.DATABASE_URL || "").trim();
const ownerUrl = (process.env.AETHER_DATABASE_OWNER_URL || "").trim();

function say(msg) {
  console.log(msg);
}

function blocked(reason) {
  say("PRODUCTION VERIFICATION: BLOCKED");
  say(`REASON: ${reason}`);
  say("This is not a PGLite result and must not be reported as Neon-verified.");
  process.exit(2);
}

if (!runtimeUrl || !ownerUrl) {
  blocked(
    "credentials unavailable — DATABASE_URL and AETHER_DATABASE_OWNER_URL are both required; neither may be empty",
  );
}

if (runtimeUrl === ownerUrl) {
  blocked(
    "DATABASE_URL equals AETHER_DATABASE_OWNER_URL — runtime must not be the table-owner connection",
  );
}

function sqlState(err) {
  return err && typeof err === "object" ? String(err.code || "") : "";
}

async function expectDenied(label, fn) {
  try {
    await fn();
  } catch (err) {
    const code = sqlState(err);
    if (code === "42501" || code === "0A000") {
      say(`PASS  ${label}  denied ${code}`);
      return;
    }
    throw new Error(`${label}: expected 42501/0A000, got ${code || err}`);
  }
  throw new Error(`${label}: unexpectedly succeeded`);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function migrateOwner(client) {
  await client.query(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const applied = (await client.query("SELECT name FROM _migrations")).rows.map((r) => r.name);
  const entries = await readdir(migrationsDir);
  let count = 0;
  for (const { name } of pendingMigrations(entries, applied)) {
    const text = await readFile(join(migrationsDir, name), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(text);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      count += 1;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* keep original */
      }
      throw err;
    }
  }
  say(`PASS  owner migrations applied (new files: ${count})`);
}

async function identity(client) {
  const row = (
    await client.query("select current_user as current_user, session_user as session_user")
  ).rows[0];
  return { current: row.current_user, session: row.session_user };
}

async function main() {
  say("=== Neon production gate ===");
  say("DATABASE_URL: SET");
  say("AETHER_DATABASE_OWNER_URL: SET");
  say("URLs differ: yes");

  const ownerPool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  // Production runtime authenticates as aether_runtime LOGIN. Do not SET ROLE.
  const runtimePool = new pg.Pool({
    connectionString: runtimeUrl,
    max: 2,
  });

  const owner = await ownerPool.connect();
  try {
    await migrateOwner(owner);
    const ownerId = await identity(owner);
    say(`owner session_user=${ownerId.session} current_user=${ownerId.current}`);
    if (ownerId.session === RUNTIME) {
      blocked("AETHER_DATABASE_OWNER_URL authenticated as aether_runtime — owner/runtime reversed");
    }

    const tenancy = await owner.query(
      `select to_regclass('providers') as providers,
              to_regclass('hotel_provider_agreements') as agreements,
              to_regclass('operator_memberships') as memberships`,
    );
    const t = tenancy.rows[0];
    if (!t.providers || !t.agreements || !t.memberships) {
      blocked("CP12 tenancy objects missing after owner migrate — 0012 not applied");
    }
    say("PASS  0012 tenancy objects present");

    const login = await owner.query(
      `select rolcanlogin from pg_roles where rolname = $1`,
      [RUNTIME],
    );
    if (!login.rows[0]?.rolcanlogin) {
      blocked("aether_runtime is NOLOGIN — production DATABASE_URL cannot authenticate as the runtime role");
    }
    say("PASS  aether_runtime LOGIN");
  } finally {
    owner.release();
  }

  const runtime = await runtimePool.connect();
  let runtimeId;
  try {
    runtimeId = await identity(runtime);
    say(`runtime session_user=${runtimeId.session} current_user=${runtimeId.current}`);
    if (runtimeId.current !== RUNTIME) {
      blocked(
        `runtime current_user is ${runtimeId.current}, not ${RUNTIME} — DATABASE_URL is not the restricted runtime role`,
      );
    }
    if (runtimeId.session === runtimeId.current && runtimeId.session === RUNTIME) {
      say("PASS  runtime login is aether_runtime (session_user and current_user)");
    } else if (runtimeId.current === RUNTIME && runtimeId.session !== RUNTIME) {
      blocked(
        "runtime is SET ROLE from a non-runtime login (session_user is not aether_runtime). RESET ROLE would restore the owner. Production DATABASE_URL must be an aether_runtime LOGIN, not the owner.",
      );
    }

    const triggerOwner = (
      await runtime.query(
        `select pg_get_userbyid(c.relowner) as owner
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
          where t.tgname = 'bookings_occupies_before'`,
      )
    ).rows[0];
    if (!triggerOwner) throw new Error("bookings_occupies_before missing");
    if (triggerOwner.owner === RUNTIME) {
      blocked("aether_runtime owns bookings_occupies_before");
    }
    say(`PASS  occupancy trigger owned by ${triggerOwner.owner}, not runtime`);

    await expectDenied("ALTER/DISABLE occupancy trigger", () =>
      runtime.query("alter table bookings disable trigger bookings_occupies_before"),
    );
    await expectDenied("DROP occupancy trigger", () =>
      runtime.query("drop trigger bookings_occupies_before on bookings"),
    );
    await expectDenied("DROP vehicle EXCLUDE", () =>
      runtime.query("alter table bookings drop constraint bookings_vehicle_occupancy_excl"),
    );
    await expectDenied("DROP driver EXCLUDE", () =>
      runtime.query("alter table bookings drop constraint bookings_driver_occupancy_excl"),
    );
    await expectDenied("DROP aether_athens_instant", () =>
      runtime.query("drop function aether_athens_instant(date, time)"),
    );
    await expectDenied("DROP btree_gist", () => runtime.query("drop extension btree_gist"));

    const dml = await runtime.query("select aether_athens_instant('2026-01-15', '09:00') as t");
    if (!dml.rows[0]?.t) throw new Error("runtime cannot EXECUTE aether_athens_instant");
    say("PASS  runtime EXECUTE aether_athens_instant");
  } finally {
    runtime.release();
  }

  // Concurrent overlapping vehicle/driver assignments on two runtime connections.
  const a = await runtimePool.connect();
  const b = await runtimePool.connect();
  try {
    const hotel = (await a.query("select id from hotels where code = 'gate' limit 1")).rows[0];
    if (!hotel) throw new Error("seed hotel gate missing — owner migrations incomplete");
    const vehicle = (await a.query("select id from vehicles where active = true limit 1")).rows[0];
    const driver = (await a.query("select id from drivers where active = true limit 1")).rows[0];
    const provider = (
      await a.query(
        "select provider_id from hotel_provider_agreements where hotel_id = $1 and active limit 1",
        [hotel.id],
      )
    ).rows[0];
    if (!vehicle || !driver) throw new Error("seed vehicle/driver missing");
    if (!provider) throw new Error("seed executing provider missing — 0012 incomplete");

    async function insertBooking(client, email, date, time) {
      const token = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
      const human = `PT${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
      const row = (
        await client.query(
          `insert into bookings (
             hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
             guest_name, guest_phone, guest_email,
             passenger_count, luggage_count,
             pickup_text, destination_text,
             human_reference, confirmation_token
           ) values (
             $1, $2, $3::date, $4::time, 60,
             'Gate Guest', '+30000000000', $5,
             2, 1,
             'Hotel lobby', 'Airport',
             $6, $7
           ) returning id`,
          [hotel.id, provider.provider_id, date, time, email, human, token],
        )
      ).rows[0];
      return row.id;
    }

    const idA = await insertBooking(a, "cp11-a@example.com", "2026-11-02", "10:00");
    const idB = await insertBooking(b, "cp11-b@example.com", "2026-11-02", "10:00");

    const vehicleSettled = await Promise.allSettled([
      a.query("update bookings set vehicle_id = $1 where id = $2", [vehicle.id, idA]),
      b.query("update bookings set vehicle_id = $1 where id = $2", [vehicle.id, idB]),
    ]);
    const vWin = vehicleSettled.filter((s) => s.status === "fulfilled").length;
    const vLose = vehicleSettled.filter((s) => s.status === "rejected");
    if (vWin !== 1 || vLose.length !== 1) {
      throw new Error(`vehicle concurrency winners=${vWin} losers=${vLose.length}`);
    }
    const vCode = sqlState(vLose[0].reason);
    if (vCode !== "23P01") throw new Error(`vehicle loser SQLSTATE ${vCode}, expected 23P01`);
    say("PASS  concurrent overlapping vehicle assign: one winner, loser 23P01");

    const idC = await insertBooking(a, "cp11-c@example.com", "2026-11-02", "16:00");
    const idD = await insertBooking(b, "cp11-d@example.com", "2026-11-02", "16:00");
    const driverSettled = await Promise.allSettled([
      a.query("update bookings set driver_id = $1 where id = $2", [driver.id, idC]),
      b.query("update bookings set driver_id = $1 where id = $2", [driver.id, idD]),
    ]);
    const dWin = driverSettled.filter((s) => s.status === "fulfilled").length;
    const dLose = driverSettled.filter((s) => s.status === "rejected");
    if (dWin !== 1 || dLose.length !== 1) {
      throw new Error(`driver concurrency winners=${dWin} losers=${dLose.length}`);
    }
    const dCode = sqlState(dLose[0].reason);
    if (dCode !== "23P01") throw new Error(`driver loser SQLSTATE ${dCode}, expected 23P01`);
    say("PASS  concurrent overlapping driver assign: one winner, loser 23P01");

    await a.query(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email,
         passenger_count, luggage_count,
         pickup_text, destination_text,
         vehicle_id, human_reference, confirmation_token
       ) values (
         $1, $2, '2026-11-03', '09:00', 60,
         'Adj One', '+30000000000', 'adj1@example.com',
         1, 0, 'Hotel lobby', 'Airport',
         $3, $4, $5
       )`,
      [hotel.id, provider.provider_id, vehicle.id, `PTADJ1${Date.now()}`, `tok-adj1-${Date.now()}`],
    );
    await a.query(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email,
         passenger_count, luggage_count,
         pickup_text, destination_text,
         vehicle_id, human_reference, confirmation_token
       ) values (
         $1, $2, '2026-11-03', '10:00', 60,
         'Adj Two', '+30000000000', 'adj2@example.com',
         1, 0, 'Hotel lobby', 'Airport',
         $3, $4, $5
       )`,
      [hotel.id, provider.provider_id, vehicle.id, `PTADJ2${Date.now()}`, `tok-adj2-${Date.now()}`],
    );
    say("PASS  [) adjacency remains valid");

    const cancelId = (
      await a.query(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email,
           passenger_count, luggage_count,
           pickup_text, destination_text,
           vehicle_id, human_reference, confirmation_token
         ) values (
           $1, $2, '2026-11-04', '11:00', 60,
           'Cancel Me', '+30000000000', 'cancel@example.com',
           1, 0, 'Hotel lobby', 'Airport',
           $3, $4, $5
         ) returning id`,
        [hotel.id, provider.provider_id, vehicle.id, `PTCAN${Date.now()}`, `tok-can-${Date.now()}`],
      )
    ).rows[0].id;
    await a.query("update bookings set cancelled_at = now() where id = $1", [cancelId]);
    const empty = (
      await a.query("select isempty(occupies) as empty from bookings where id = $1", [cancelId])
    ).rows[0];
    if (!empty.empty) throw new Error("cancellation did not release occupies");
    await a.query(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email,
         passenger_count, luggage_count,
         pickup_text, destination_text,
         vehicle_id, human_reference, confirmation_token
       ) values (
         $1, $2, '2026-11-04', '11:00', 60,
         'Reuse', '+30000000000', 'reuse@example.com',
         1, 0, 'Hotel lobby', 'Airport',
         $3, $4, $5
       )`,
      [hotel.id, provider.provider_id, vehicle.id, `PTREU${Date.now()}`, `tok-reu-${Date.now()}`],
    );
    say("PASS  cancellation releases occupancy so the vehicle can be reused");
  } finally {
    a.release();
    b.release();
  }

  await ownerPool.end();
  await runtimePool.end();
  say("=== NEON PRODUCTION GATE PASS ===");
}

main().catch((err) => {
  console.error("NEON VERIFICATION FAILURE");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
