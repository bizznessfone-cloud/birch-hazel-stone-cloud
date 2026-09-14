#!/usr/bin/env node
/**
 * Read-only production runtime identity gate (CP19B).
 *
 * Fail closed. Never print connection strings or passwords.
 * DATABASE_URL only. Does not open the migration-owner credential.
 * Does not migrate, DDL, DML, or SET ROLE.
 *
 * Proves: session_user = current_user = aether_app on neondb.
 */
import pg from "pg";

const RUNTIME = "aether_app";
const PREVIEW_ROLE = "aether_runtime";
const EXPECTED_DATABASE = "neondb";
const runtimeUrl = (process.env.DATABASE_URL || "").trim();

function say(msg) {
  console.log(msg);
}

function redact(text) {
  return String(text).replace(
    /(?:postgres(?:ql)?:\/\/)[^\s]+/gi,
    "postgres://redacted",
  );
}

function blocked(reason) {
  say("PRODUCTION RUNTIME VERIFICATION: BLOCKED");
  say(`REASON: ${redact(reason)}`);
  process.exit(2);
}

if (!runtimeUrl) {
  blocked("credentials unavailable — DATABASE_URL is required and must not be empty");
}

async function expectTablePriv(client, table, privilege, expected, label) {
  const row = (
    await client.query(`select has_table_privilege(current_user, $1, $2) as ok`, [
      table,
      privilege,
    ])
  ).rows[0];
  if (Boolean(row?.ok) !== expected) {
    blocked(`${label}: has_table_privilege(${table}, ${privilege}) = ${row?.ok}, expected ${expected}`);
  }
  say(`PASS  ${label}`);
}

async function expectColumnPriv(client, table, column, privilege, expected, label) {
  const row = (
    await client.query(`select has_column_privilege(current_user, $1, $2, $3) as ok`, [
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

async function expectFnExecute(client, name) {
  const rows = (
    await client.query(
      `select p.proname as name, has_function_privilege(current_user, p.oid, 'EXECUTE') as ok
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [name],
    )
  ).rows;
  if (!rows.length) blocked(`${name} missing`);
  if (rows.some((r) => !r.ok)) blocked(`${name} EXECUTE denied`);
  say(`PASS  ${name} EXECUTE`);
}

async function main() {
  say("=== Neon runtime identity gate ===");
  say("DATABASE_URL: SET");

  const pool = new pg.Pool({
    connectionString: runtimeUrl,
    max: 1,
  });

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.end().catch(() => {});
    blocked(`runtime connection failed: ${message}`);
  }

  try {
    const id = (
      await client.query(
        `select current_user as current_user,
                session_user as session_user,
                current_database() as current_database,
                current_schema() as current_schema`,
      )
    ).rows[0];

    say(`session_user=${id.session_user}`);
    say(`current_user=${id.current_user}`);
    say(`database=${id.current_database}`);
    say(`schema=${id.current_schema}`);

    if (id.current_user !== RUNTIME) {
      blocked(
        `runtime current_user is ${id.current_user}, not ${RUNTIME} — DATABASE_URL is not the restricted aether_app LOGIN`,
      );
    }
    if (id.session_user !== id.current_user) {
      blocked(
        "runtime is SET ROLE from a non-app login (session_user is not current_user). Production DATABASE_URL must be an aether_app LOGIN, not SET ROLE.",
      );
    }
    if (id.session_user !== RUNTIME) {
      blocked(
        `runtime session_user is ${id.session_user}, not ${RUNTIME}. Production DATABASE_URL must authenticate as aether_app.`,
      );
    }
    if (id.session_user === PREVIEW_ROLE || id.current_user === PREVIEW_ROLE) {
      blocked("runtime authenticated as aether_runtime — preview SET ROLE identity is not production LOGIN");
    }
    if (id.current_database !== EXPECTED_DATABASE) {
      blocked(
        `current_database is ${id.current_database}, not ${EXPECTED_DATABASE} — unexpected database target`,
      );
    }
    say("PASS  runtime login is aether_app (session_user and current_user)");
    say(`PASS  current_database is ${EXPECTED_DATABASE}`);

    const roleRow = (
      await client.query(
        `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
           from pg_roles where rolname = current_user`,
      )
    ).rows[0];
    if (!roleRow) blocked("connected role missing from pg_roles");
    if (!roleRow.rolcanlogin) blocked("connected role is NOLOGIN");
    if (roleRow.rolsuper) blocked("connected role is SUPERUSER");
    if (roleRow.rolcreatedb) blocked("connected role has CREATEDB");
    if (roleRow.rolcreaterole) blocked("connected role has CREATEROLE");
    if (roleRow.rolreplication) blocked("connected role has REPLICATION");
    if (roleRow.rolbypassrls) blocked("connected role has BYPASSRLS");
    say("PASS  connected aether_app attributes are least-privilege");

    const neonSuExists = (
      await client.query(`select exists (select 1 from pg_roles where rolname = 'neon_superuser') as ok`)
    ).rows[0];
    const directSuper = (
      await client.query(
        `select exists (
           select 1
             from pg_auth_members m
             join pg_roles g on g.oid = m.roleid
             join pg_roles u on u.oid = m.member
            where g.rolname = 'neon_superuser'
              and u.rolname = current_user
         ) as member`,
      )
    ).rows[0];
    if (directSuper.member) {
      blocked("aether_app is a member of neon_superuser — production login must be SQL-created, never a Neon Console role");
    }
    if (neonSuExists.ok) {
      const inherited = (
        await client.query(`select pg_has_role(current_user, 'neon_superuser', 'MEMBER') as member`)
      ).rows[0];
      if (inherited.member) blocked("aether_app inherits neon_superuser");
      say("PASS  aether_app is not a neon_superuser member");
    } else {
      say("PASS  neon_superuser does not exist — membership cannot exist");
    }

    const metaRows = (
      await client.query(
        `select key, value
           from aether_meta
          where key in ('schema_phase', 'checkpoint', 'production_role', 'runtime_login')
          order by key`,
      )
    ).rows;
    const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
    const expectedMeta = {
      checkpoint: "16",
      production_role: RUNTIME,
      runtime_login: RUNTIME,
      schema_phase: "16",
    };
    for (const [key, value] of Object.entries(expectedMeta)) {
      if (meta[key] !== value) {
        blocked(`aether_meta.${key} is ${meta[key] ?? "missing"}, expected ${value}`);
      }
    }
    say("PASS  aether_meta schema_phase=16 checkpoint=16 production_role=aether_app runtime_login=aether_app");

    const schemaUsage = (
      await client.query(`select has_schema_privilege(current_user, 'public', 'USAGE') as ok`)
    ).rows[0];
    if (!schemaUsage.ok) blocked("aether_app missing schema USAGE");
    say("PASS  schema USAGE");
    const schemaCreate = (
      await client.query(`select has_schema_privilege(current_user, 'public', 'CREATE') as ok`)
    ).rows[0];
    if (schemaCreate.ok) blocked("aether_app has schema CREATE");
    say("PASS  schema CREATE denied");

    await expectTablePriv(client, "hotels", "SELECT", true, "hotels SELECT");
    await expectTablePriv(client, "hotels", "INSERT", false, "hotels INSERT denied");
    await expectTablePriv(client, "hotels", "UPDATE", false, "hotels UPDATE denied");
    await expectTablePriv(client, "hotels", "DELETE", false, "hotels DELETE denied");
    await expectTablePriv(client, "hotel_destinations", "SELECT", true, "destinations SELECT");
    await expectTablePriv(client, "hotel_destinations", "INSERT", false, "destinations INSERT denied");
    await expectTablePriv(client, "hotel_destinations", "UPDATE", false, "destinations UPDATE denied");
    await expectTablePriv(client, "hotel_destinations", "DELETE", false, "destinations DELETE denied");
    await expectTablePriv(client, "providers", "SELECT", true, "providers SELECT");
    await expectTablePriv(client, "providers", "INSERT", false, "providers INSERT denied");
    await expectTablePriv(client, "providers", "UPDATE", false, "providers UPDATE denied");
    await expectTablePriv(client, "providers", "DELETE", false, "providers DELETE denied");
    await expectTablePriv(client, "hotel_provider_agreements", "SELECT", true, "agreements SELECT");
    await expectTablePriv(client, "hotel_provider_agreements", "INSERT", false, "agreements INSERT denied");
    await expectTablePriv(client, "hotel_provider_agreements", "UPDATE", false, "agreements UPDATE denied");
    await expectTablePriv(client, "hotel_provider_agreements", "DELETE", false, "agreements DELETE denied");
    await expectTablePriv(client, "operator_memberships", "SELECT", true, "memberships SELECT");
    await expectTablePriv(client, "operator_memberships", "INSERT", false, "memberships INSERT denied");
    await expectTablePriv(client, "operator_memberships", "UPDATE", false, "memberships UPDATE denied");
    await expectTablePriv(client, "operator_memberships", "DELETE", false, "memberships DELETE denied");
    await expectTablePriv(client, "audit_events", "INSERT", true, "audit INSERT");
    await expectTablePriv(client, "audit_events", "UPDATE", false, "audit UPDATE denied");
    await expectTablePriv(client, "audit_events", "DELETE", false, "audit DELETE denied");
    await expectTablePriv(client, "_migrations", "SELECT", false, "_migrations SELECT denied");
    await expectTablePriv(client, "_migrations", "INSERT", false, "_migrations INSERT denied");
    await expectTablePriv(client, "_migrations", "UPDATE", false, "_migrations UPDATE denied");
    await expectTablePriv(client, "_migrations", "DELETE", false, "_migrations DELETE denied");
    await expectTablePriv(client, "aether_meta", "SELECT", true, "aether_meta SELECT");
    await expectTablePriv(client, "aether_meta", "INSERT", false, "aether_meta INSERT denied");
    await expectTablePriv(client, "aether_meta", "UPDATE", false, "aether_meta UPDATE denied");
    await expectTablePriv(client, "aether_meta", "DELETE", false, "aether_meta DELETE denied");

    await expectTablePriv(client, "bookings", "SELECT", true, "bookings SELECT");
    await expectTablePriv(client, "bookings", "INSERT", true, "bookings INSERT");
    await expectTablePriv(client, "bookings", "DELETE", false, "bookings DELETE denied");
    await expectColumnPriv(client, "bookings", "vehicle_id", "UPDATE", true, "bookings vehicle_id UPDATE");
    await expectColumnPriv(client, "bookings", "driver_id", "UPDATE", true, "bookings driver_id UPDATE");
    await expectColumnPriv(client, "bookings", "cancelled_at", "UPDATE", true, "bookings cancelled_at UPDATE");
    await expectColumnPriv(client, "bookings", "status", "UPDATE", true, "bookings status UPDATE");
    await expectColumnPriv(client, "bookings", "hotel_id", "UPDATE", false, "bookings hotel_id UPDATE denied");
    await expectColumnPriv(
      client,
      "bookings",
      "executing_provider_id",
      "UPDATE",
      false,
      "bookings executing_provider_id UPDATE denied",
    );
    await expectColumnPriv(client, "bookings", "occupies", "UPDATE", false, "bookings occupies UPDATE denied");
    await expectColumnPriv(
      client,
      "bookings",
      "destination_id",
      "UPDATE",
      false,
      "bookings destination_id UPDATE denied",
    );
    await expectColumnPriv(
      client,
      "bookings",
      "quoted_amount_minor",
      "UPDATE",
      false,
      "bookings quoted_amount_minor UPDATE denied",
    );
    await expectColumnPriv(
      client,
      "bookings",
      "quoted_currency",
      "UPDATE",
      false,
      "bookings quoted_currency UPDATE denied",
    );
    await expectColumnPriv(
      client,
      "bookings",
      "confirmation_token",
      "UPDATE",
      false,
      "bookings confirmation_token UPDATE denied",
    );
    await expectColumnPriv(
      client,
      "bookings",
      "transfer_date",
      "UPDATE",
      false,
      "bookings transfer_date UPDATE denied",
    );
    await expectColumnPriv(client, "bookings", "pickup_time", "UPDATE", false, "bookings pickup_time UPDATE denied");
    await expectColumnPriv(
      client,
      "bookings",
      "duration_minutes",
      "UPDATE",
      false,
      "bookings duration_minutes UPDATE denied",
    );

    await expectFnExecute(client, "aether_civil_instant");
    await expectFnExecute(client, "aether_athens_instant");

    const triggerOwner = (
      await client.query(
        `select pg_get_userbyid(c.relowner) as owner
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
          where t.tgname = 'bookings_occupies_before'`,
      )
    ).rows[0];
    if (!triggerOwner) blocked("bookings_occupies_before missing");
    if (triggerOwner.owner === RUNTIME || triggerOwner.owner === PREVIEW_ROLE) {
      blocked(`${triggerOwner.owner} owns bookings_occupies_before — application roles must not own occupancy objects`);
    }
    say(`PASS  occupancy trigger owned by ${triggerOwner.owner}, not aether_app`);
  } finally {
    client.release();
    await pool.end();
  }

  say("PRODUCTION RUNTIME VERIFICATION: PASS");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  say("PRODUCTION RUNTIME VERIFICATION: BLOCKED");
  say(`REASON: ${redact(message)}`);
  process.exit(2);
});
