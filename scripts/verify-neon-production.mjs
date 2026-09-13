#!/usr/bin/env node
/**
 * Neon production-infrastructure gate (CP11 identity + CP13A SQL-created LOGIN).
 *
 * Fail closed. Never print connection strings or passwords.
 * Does not use PGLite. Does not claim production if this process cannot
 * connect to Neon with a runtime role distinct from the schema owner.
 *
 * Required env (names only):
 *   DATABASE_URL                 runtime LOGIN — must be aether_app, not owner
 *   AETHER_DATABASE_OWNER_URL    migration/schema-owner login
 *
 * The runtime pool must authenticate as aether_app LOGIN (SQL-created).
 * Do not pass a startup role option. session_user and current_user
 * must both be aether_app. aether_app must not be a neon_superuser member.
 */
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = "aether_app";
const PREVIEW_ROLE = "aether_runtime";
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

async function expectTablePriv(client, table, privilege, expected, label) {
  const row = (
    await client.query(`select has_table_privilege($1, $2, $3) as ok`, [RUNTIME, table, privilege])
  ).rows[0];
  if (Boolean(row?.ok) !== expected) {
    blocked(`${label}: has_table_privilege(${table}, ${privilege}) = ${row?.ok}, expected ${expected}`);
  }
  say(`PASS  ${label}`);
}

async function expectColumnPriv(client, table, column, privilege, expected, label) {
  const row = (
    await client.query(`select has_column_privilege($1, $2, $3, $4) as ok`, [
      RUNTIME,
      table,
      column,
      privilege,
    ])
  ).rows[0];
  if (Boolean(row?.ok) !== expected) {
    blocked(
      `${label}: has_column_privilege(${table}.${column}, ${privilege}) = ${row?.ok}, expected ${expected}`,
    );
  }
  say(`PASS  ${label}`);
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
  // Production runtime authenticates as aether_app LOGIN. Do not SET ROLE.
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
      blocked("AETHER_DATABASE_OWNER_URL authenticated as aether_app — owner/runtime reversed");
    }
    if (ownerId.session === PREVIEW_ROLE) {
      blocked("AETHER_DATABASE_OWNER_URL authenticated as aether_runtime — owner URL is not the schema owner");
    }
    if (ownerId.session === ownerId.current && ownerId.session === RUNTIME) {
      blocked("schema owner is aether_app — migration/schema owner must be distinct from runtime");
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
      `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         from pg_roles where rolname = $1`,
      [RUNTIME],
    );
    const attrs = login.rows[0];
    if (!attrs) {
      blocked("aether_app role missing — 0014 not applied");
    }
    if (!attrs.rolcanlogin) {
      blocked("aether_app is NOLOGIN — production DATABASE_URL cannot authenticate as the app role");
    }
    if (attrs.rolsuper) blocked("aether_app is SUPERUSER");
    if (attrs.rolcreatedb) blocked("aether_app has CREATEDB");
    if (attrs.rolcreaterole) blocked("aether_app has CREATEROLE");
    if (attrs.rolreplication) blocked("aether_app has REPLICATION");
    if (attrs.rolbypassrls) blocked("aether_app has BYPASSRLS");
    say("PASS  aether_app LOGIN with least-privilege attributes");
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
        `runtime current_user is ${runtimeId.current}, not ${RUNTIME} — DATABASE_URL is not the restricted aether_app LOGIN`,
      );
    }
    if (runtimeId.session !== runtimeId.current) {
      blocked(
        "runtime is SET ROLE from a non-app login (session_user is not current_user). RESET ROLE would restore the connecting role. Production DATABASE_URL must be an aether_app LOGIN, not SET ROLE.",
      );
    }
    if (runtimeId.session !== RUNTIME) {
      blocked(
        `runtime session_user is ${runtimeId.session}, not ${RUNTIME}. Production DATABASE_URL must authenticate as aether_app.`,
      );
    }
    say("PASS  runtime login is aether_app (session_user and current_user)");

    const roleRow = (
      await runtime.query(
        `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
           from pg_roles where rolname = current_user`,
      )
    ).rows[0];
    if (!roleRow?.rolcanlogin) blocked("connected role is NOLOGIN");
    if (roleRow.rolsuper) blocked("connected role is SUPERUSER");
    if (roleRow.rolcreatedb) blocked("connected role has CREATEDB");
    if (roleRow.rolcreaterole) blocked("connected role has CREATEROLE");
    if (roleRow.rolreplication) blocked("connected role has REPLICATION");
    if (roleRow.rolbypassrls) blocked("connected role has BYPASSRLS");
    say("PASS  connected aether_app attributes are least-privilege");

    const neonSuExists = (
      await runtime.query(
        `select exists (select 1 from pg_roles where rolname = 'neon_superuser') as ok`,
      )
    ).rows[0];
    const directSuper = (
      await runtime.query(
        `select exists (
           select 1
             from pg_auth_members m
             join pg_roles g on g.oid = m.roleid
             join pg_roles u on u.oid = m.member
            where g.rolname = 'neon_superuser'
              and u.rolname = $1
         ) as member`,
        [RUNTIME],
      )
    ).rows[0];
    if (directSuper.member) {
      blocked("aether_app is a member of neon_superuser — production login must be SQL-created, never a Neon Console role");
    }
    if (neonSuExists.ok) {
      const inherited = (
        await runtime.query(
          `select pg_has_role($1, 'neon_superuser', 'member') as member`,
          [RUNTIME],
        )
      ).rows[0];
      if (inherited.member) {
        blocked("aether_app inherits neon_superuser");
      }
    }
    say("PASS  aether_app is not a neon_superuser member");

    const triggerOwner = (
      await runtime.query(
        `select pg_get_userbyid(c.relowner) as owner
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
          where t.tgname = 'bookings_occupies_before'`,
      )
    ).rows[0];
    if (!triggerOwner) throw new Error("bookings_occupies_before missing");
    if (triggerOwner.owner === RUNTIME || triggerOwner.owner === PREVIEW_ROLE) {
      blocked(`${triggerOwner.owner} owns bookings_occupies_before — application roles must not own occupancy objects`);
    }
    say(`PASS  occupancy trigger owned by ${triggerOwner.owner}, not aether_app`);

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

    const civil = await runtime.query(
      "select aether_civil_instant('2026-01-15', '09:00', 'Europe/Athens') as t",
    );
    if (!civil.rows[0]?.t) throw new Error("runtime cannot EXECUTE aether_civil_instant");
    say("PASS  runtime EXECUTE aether_civil_instant");

    await expectTablePriv(runtime, "hotels", "SELECT", true, "hotels SELECT");
    await expectTablePriv(runtime, "hotels", "INSERT", false, "hotels INSERT denied");
    await expectTablePriv(runtime, "hotels", "UPDATE", false, "hotels UPDATE denied");
    await expectTablePriv(runtime, "hotels", "DELETE", false, "hotels DELETE denied");
    await expectTablePriv(runtime, "hotel_destinations", "SELECT", true, "destinations SELECT");
    await expectTablePriv(runtime, "hotel_destinations", "INSERT", false, "destinations INSERT denied");
    await expectTablePriv(runtime, "hotel_destinations", "UPDATE", false, "destinations UPDATE denied");
    await expectTablePriv(runtime, "hotel_destinations", "DELETE", false, "destinations DELETE denied");
    await expectTablePriv(runtime, "providers", "SELECT", true, "providers SELECT");
    await expectTablePriv(runtime, "providers", "INSERT", false, "providers INSERT denied");
    await expectTablePriv(runtime, "providers", "UPDATE", false, "providers UPDATE denied");
    await expectTablePriv(runtime, "providers", "DELETE", false, "providers DELETE denied");
    await expectTablePriv(
      runtime,
      "hotel_provider_agreements",
      "SELECT",
      true,
      "agreements SELECT",
    );
    await expectTablePriv(
      runtime,
      "hotel_provider_agreements",
      "INSERT",
      false,
      "agreements INSERT denied",
    );
    await expectTablePriv(
      runtime,
      "hotel_provider_agreements",
      "UPDATE",
      false,
      "agreements UPDATE denied",
    );
    await expectTablePriv(
      runtime,
      "hotel_provider_agreements",
      "DELETE",
      false,
      "agreements DELETE denied",
    );
    await expectTablePriv(runtime, "operator_memberships", "SELECT", true, "memberships SELECT");
    await expectTablePriv(
      runtime,
      "operator_memberships",
      "INSERT",
      false,
      "memberships INSERT denied",
    );
    await expectTablePriv(
      runtime,
      "operator_memberships",
      "UPDATE",
      false,
      "memberships UPDATE denied",
    );
    await expectTablePriv(
      runtime,
      "operator_memberships",
      "DELETE",
      false,
      "memberships DELETE denied",
    );
    await expectTablePriv(runtime, "operators", "SELECT", true, "operators SELECT");
    await expectTablePriv(runtime, "operators", "DELETE", false, "operators DELETE denied");
    await expectColumnPriv(runtime, "operators", "login", "INSERT", true, "operators INSERT login (legacy runtime)");
    await expectColumnPriv(
      runtime,
      "operators",
      "password_hash",
      "INSERT",
      true,
      "operators INSERT password_hash (legacy runtime)",
    );
    await expectColumnPriv(
      runtime,
      "operators",
      "password_hash",
      "UPDATE",
      true,
      "operators UPDATE password_hash (legacy runtime)",
    );
    await expectTablePriv(runtime, "bookings", "SELECT", true, "bookings SELECT");
    await expectTablePriv(runtime, "bookings", "DELETE", false, "bookings DELETE denied");
    await expectColumnPriv(runtime, "bookings", "vehicle_id", "UPDATE", true, "bookings UPDATE vehicle_id");
    await expectColumnPriv(runtime, "bookings", "driver_id", "UPDATE", true, "bookings UPDATE driver_id");
    await expectColumnPriv(runtime, "bookings", "cancelled_at", "UPDATE", true, "bookings UPDATE cancelled_at");
    await expectColumnPriv(runtime, "bookings", "status", "UPDATE", true, "bookings UPDATE status");
    await expectColumnPriv(runtime, "bookings", "hotel_id", "UPDATE", false, "bookings UPDATE hotel_id denied");
    await expectColumnPriv(
      runtime,
      "bookings",
      "executing_provider_id",
      "UPDATE",
      false,
      "bookings UPDATE executing_provider_id denied",
    );
    await expectColumnPriv(runtime, "bookings", "occupies", "UPDATE", false, "bookings UPDATE occupies denied");
    await expectColumnPriv(
      runtime,
      "bookings",
      "destination_id",
      "UPDATE",
      false,
      "bookings UPDATE destination_id denied",
    );
    await expectColumnPriv(
      runtime,
      "bookings",
      "quoted_amount_minor",
      "UPDATE",
      false,
      "bookings UPDATE quoted_amount_minor denied",
    );
    await expectColumnPriv(
      runtime,
      "bookings",
      "quoted_currency",
      "UPDATE",
      false,
      "bookings UPDATE quoted_currency denied",
    );
    await expectColumnPriv(
      runtime,
      "bookings",
      "confirmation_token",
      "UPDATE",
      false,
      "bookings UPDATE confirmation_token denied",
    );
    await expectColumnPriv(
      runtime,
      "bookings",
      "transfer_date",
      "UPDATE",
      false,
      "bookings UPDATE transfer_date denied",
    );
    await expectColumnPriv(
      runtime,
      "bookings",
      "pickup_time",
      "UPDATE",
      false,
      "bookings UPDATE pickup_time denied",
    );
    await expectColumnPriv(
      runtime,
      "bookings",
      "duration_minutes",
      "UPDATE",
      false,
      "bookings UPDATE duration_minutes denied",
    );
    await expectColumnPriv(
      runtime,
      "vehicles",
      "owned_by_provider_id",
      "INSERT",
      true,
      "vehicles INSERT owned_by_provider_id (deferred stamper)",
    );
    await expectColumnPriv(
      runtime,
      "vehicles",
      "operated_by_provider_id",
      "INSERT",
      true,
      "vehicles INSERT operated_by_provider_id (deferred stamper)",
    );
    await expectColumnPriv(
      runtime,
      "vehicles",
      "owned_by_hotel_id",
      "INSERT",
      false,
      "vehicles INSERT owned_by_hotel_id denied",
    );
    await expectColumnPriv(runtime, "vehicles", "name", "UPDATE", true, "vehicles UPDATE name");
    await expectColumnPriv(
      runtime,
      "vehicles",
      "owned_by_provider_id",
      "UPDATE",
      false,
      "vehicles UPDATE owned_by_provider_id denied",
    );
    await expectColumnPriv(
      runtime,
      "drivers",
      "employed_by_provider_id",
      "INSERT",
      true,
      "drivers INSERT employed_by_provider_id (deferred stamper)",
    );
    await expectColumnPriv(
      runtime,
      "drivers",
      "dispatched_by_provider_id",
      "INSERT",
      true,
      "drivers INSERT dispatched_by_provider_id (deferred stamper)",
    );
    await expectColumnPriv(
      runtime,
      "drivers",
      "employed_by_hotel_id",
      "INSERT",
      false,
      "drivers INSERT employed_by_hotel_id denied",
    );
    await expectColumnPriv(runtime, "drivers", "name", "UPDATE", true, "drivers UPDATE name");
    await expectColumnPriv(
      runtime,
      "drivers",
      "dispatched_by_provider_id",
      "UPDATE",
      false,
      "drivers UPDATE dispatched_by_provider_id denied",
    );
    await expectTablePriv(runtime, "audit_events", "INSERT", true, "audit INSERT");
    await expectTablePriv(runtime, "audit_events", "UPDATE", false, "audit UPDATE denied");
    await expectTablePriv(runtime, "audit_events", "DELETE", false, "audit DELETE denied");
    await expectTablePriv(runtime, "_migrations", "SELECT", false, "_migrations SELECT denied");
    await expectTablePriv(runtime, "_migrations", "INSERT", false, "_migrations INSERT denied");
    await expectTablePriv(runtime, "_migrations", "UPDATE", false, "_migrations UPDATE denied");
    await expectTablePriv(runtime, "_migrations", "DELETE", false, "_migrations DELETE denied");
    await expectTablePriv(runtime, "aether_meta", "SELECT", true, "aether_meta SELECT");
    await expectTablePriv(runtime, "aether_meta", "INSERT", false, "aether_meta INSERT denied");
    await expectTablePriv(runtime, "aether_meta", "UPDATE", false, "aether_meta UPDATE denied");
    await expectTablePriv(runtime, "aether_meta", "DELETE", false, "aether_meta DELETE denied");
    const schemaCreate = (
      await runtime.query(`select has_schema_privilege($1, 'public', 'CREATE') as ok`, [RUNTIME])
    ).rows[0];
    if (schemaCreate.ok) blocked("aether_app has schema CREATE");
    say("PASS  schema CREATE denied");
    const schemaUsage = (
      await runtime.query(`select has_schema_privilege($1, 'public', 'USAGE') as ok`, [RUNTIME])
    ).rows[0];
    if (!schemaUsage.ok) blocked("aether_app missing schema USAGE");
    say("PASS  schema USAGE");
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

    async function insertThenAssign(client, email, date, time, vehicleId) {
      const id = await insertBooking(client, email, date, time);
      await client.query("update bookings set vehicle_id = $1 where id = $2", [vehicleId, id]);
      return id;
    }

    await insertThenAssign(a, "adj1@example.com", "2026-11-03", "09:00", vehicle.id);
    await insertThenAssign(a, "adj2@example.com", "2026-11-03", "10:00", vehicle.id);
    say("PASS  [) adjacency remains valid");

    const cancelId = await insertThenAssign(
      a,
      "cancel@example.com",
      "2026-11-04",
      "11:00",
      vehicle.id,
    );
    await a.query("update bookings set cancelled_at = now() where id = $1", [cancelId]);
    const empty = (
      await a.query("select isempty(occupies) as empty from bookings where id = $1", [cancelId])
    ).rows[0];
    if (!empty.empty) throw new Error("cancellation did not release occupies");
    await insertThenAssign(a, "reuse@example.com", "2026-11-04", "11:00", vehicle.id);
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
