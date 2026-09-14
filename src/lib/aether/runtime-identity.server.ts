/**
 * Temporary CP19D production runtime identity diagnostic.
 * Read-only catalog queries through the application pool. No owner URL.
 */
import { AETHER_APP_ROLE, AETHER_RUNTIME_ROLE } from "./runtime-config";
import { getDbSource, getPgPool } from "@/lib/db";

const EXPECTED_DATABASE = "neondb";
const EXPECTED_OWNER = "neondb_owner";
const FAIL = "runtime identity verification failed";

type QueryClient = {
  query: <T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
};

export type RuntimeIdentityPayload = {
  session_user: string;
  current_user: string;
  session_matches_current: boolean;
  current_database: string;
};

export type RuntimeRolePayload = {
  login: boolean;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  replication: boolean;
  bypassrls: boolean;
  neon_superuser_member: boolean;
};

export type RuntimeMetadataPayload = {
  schema_phase: string;
  checkpoint: string;
  production_role: string;
  runtime_login: string;
};

export type RuntimeIdentityResult =
  | {
      ok: true;
      identity: RuntimeIdentityPayload;
      role: RuntimeRolePayload;
      metadata: RuntimeMetadataPayload;
      privileges: Record<string, boolean>;
      occupancy: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
      identity?: RuntimeIdentityPayload;
      role?: RuntimeRolePayload;
      metadata?: RuntimeMetadataPayload;
      privileges?: Record<string, boolean>;
      occupancy?: Record<string, string>;
    };

function failed(partial: Omit<Extract<RuntimeIdentityResult, { ok: false }>, "ok" | "error"> = {}): RuntimeIdentityResult {
  return { ok: false, error: FAIL, ...partial };
}

async function flag(
  client: QueryClient,
  table: string,
  privilege: string,
): Promise<boolean> {
  const row = (
    await client.query<{ ok: boolean }>(`select has_table_privilege(current_user, $1, $2) as ok`, [
      table,
      privilege,
    ])
  ).rows[0];
  return Boolean(row?.ok);
}

async function col(
  client: QueryClient,
  table: string,
  column: string,
  privilege: string,
): Promise<boolean> {
  const row = (
    await client.query<{ ok: boolean }>(
      `select has_column_privilege(current_user, $1, $2, $3) as ok`,
      [table, column, privilege],
    )
  ).rows[0];
  return Boolean(row?.ok);
}

async function schemaPriv(client: QueryClient, privilege: string): Promise<boolean> {
  const row = (
    await client.query<{ ok: boolean }>(`select has_schema_privilege(current_user, 'public', $1) as ok`, [
      privilege,
    ])
  ).rows[0];
  return Boolean(row?.ok);
}

async function fnExecute(client: QueryClient, name: string): Promise<boolean> {
  const rows = (
    await client.query<{ name: string; ok: boolean }>(
      `select p.proname as name, has_function_privilege(current_user, p.oid, 'EXECUTE') as ok
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [name],
    )
  ).rows;
  return rows.length > 0 && rows.every((r) => r.ok);
}

async function objectOwner(
  client: QueryClient,
  sql: string,
  params: unknown[],
): Promise<string> {
  const row = (await client.query<{ owner: string }>(sql, params)).rows[0];
  return row?.owner ?? "";
}

function ownerAllowed(owner: string): boolean {
  return owner === EXPECTED_OWNER && owner !== AETHER_APP_ROLE && owner !== AETHER_RUNTIME_ROLE;
}

export async function verifyProductionRuntimeIdentity(): Promise<RuntimeIdentityResult> {
  if (getDbSource() !== "neon") return failed();

  const pool = await getPgPool();
  const client = await pool.connect();
  try {
    const id = (
      await client.query<{
        current_user: string;
        session_user: string;
        current_database: string;
      }>(
        `select current_user as current_user,
                session_user as session_user,
                current_database() as current_database`,
      )
    ).rows[0];
    if (!id) return failed();

    const identity: RuntimeIdentityPayload = {
      session_user: String(id.session_user),
      current_user: String(id.current_user),
      session_matches_current: id.session_user === id.current_user,
      current_database: String(id.current_database),
    };

    const identityOk =
      identity.session_user === AETHER_APP_ROLE &&
      identity.current_user === AETHER_APP_ROLE &&
      identity.session_matches_current &&
      identity.current_database === EXPECTED_DATABASE &&
      identity.session_user !== AETHER_RUNTIME_ROLE &&
      identity.current_user !== AETHER_RUNTIME_ROLE &&
      identity.session_user !== EXPECTED_OWNER &&
      identity.current_user !== EXPECTED_OWNER;

    const roleRow = (
      await client.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
           from pg_roles where rolname = current_user`,
      )
    ).rows[0];
    if (!roleRow) return failed({ identity });

    const neonSuExists = (
      await client.query<{ ok: boolean }>(
        `select exists (select 1 from pg_roles where rolname = 'neon_superuser') as ok`,
      )
    ).rows[0];
    const directSuper = (
      await client.query<{ member: boolean }>(
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
    let inherited = false;
    if (neonSuExists?.ok) {
      inherited = Boolean(
        (
          await client.query<{ member: boolean }>(
            `select pg_has_role(current_user, 'neon_superuser', 'MEMBER') as member`,
          )
        ).rows[0]?.member,
      );
    }

    const role: RuntimeRolePayload = {
      login: Boolean(roleRow.rolcanlogin),
      superuser: Boolean(roleRow.rolsuper),
      createdb: Boolean(roleRow.rolcreatedb),
      createrole: Boolean(roleRow.rolcreaterole),
      replication: Boolean(roleRow.rolreplication),
      bypassrls: Boolean(roleRow.rolbypassrls),
      neon_superuser_member: Boolean(directSuper?.member) || inherited,
    };

    const roleOk =
      role.login === true &&
      role.superuser === false &&
      role.createdb === false &&
      role.createrole === false &&
      role.replication === false &&
      role.bypassrls === false &&
      role.neon_superuser_member === false;

    const metaRows = (
      await client.query<{ key: string; value: string }>(
        `select key, value
           from aether_meta
          where key in ('schema_phase', 'checkpoint', 'production_role', 'runtime_login')
          order by key`,
      )
    ).rows;
    const metaMap = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
    const metadata: RuntimeMetadataPayload = {
      schema_phase: metaMap.schema_phase ?? "",
      checkpoint: metaMap.checkpoint ?? "",
      production_role: metaMap.production_role ?? "",
      runtime_login: metaMap.runtime_login ?? "",
    };
    const metadataOk =
      metadata.schema_phase === "16" &&
      metadata.checkpoint === "16" &&
      metadata.production_role === AETHER_APP_ROLE &&
      metadata.runtime_login === AETHER_APP_ROLE;

    const privileges: Record<string, boolean> = {
      hotels_select: await flag(client, "hotels", "SELECT"),
      hotels_insert: await flag(client, "hotels", "INSERT"),
      hotels_update: await flag(client, "hotels", "UPDATE"),
      hotels_delete: await flag(client, "hotels", "DELETE"),
      destinations_select: await flag(client, "hotel_destinations", "SELECT"),
      destinations_insert: await flag(client, "hotel_destinations", "INSERT"),
      destinations_update: await flag(client, "hotel_destinations", "UPDATE"),
      destinations_delete: await flag(client, "hotel_destinations", "DELETE"),
      providers_select: await flag(client, "providers", "SELECT"),
      providers_insert: await flag(client, "providers", "INSERT"),
      providers_update: await flag(client, "providers", "UPDATE"),
      providers_delete: await flag(client, "providers", "DELETE"),
      agreements_select: await flag(client, "hotel_provider_agreements", "SELECT"),
      agreements_insert: await flag(client, "hotel_provider_agreements", "INSERT"),
      agreements_update: await flag(client, "hotel_provider_agreements", "UPDATE"),
      agreements_delete: await flag(client, "hotel_provider_agreements", "DELETE"),
      memberships_select: await flag(client, "operator_memberships", "SELECT"),
      memberships_insert: await flag(client, "operator_memberships", "INSERT"),
      memberships_update: await flag(client, "operator_memberships", "UPDATE"),
      memberships_delete: await flag(client, "operator_memberships", "DELETE"),
      operators_select: await flag(client, "operators", "SELECT"),
      operators_delete: await flag(client, "operators", "DELETE"),
      operators_insert_login: await col(client, "operators", "login", "INSERT"),
      operators_insert_password_hash: await col(client, "operators", "password_hash", "INSERT"),
      operators_update_password_hash: await col(client, "operators", "password_hash", "UPDATE"),
      bookings_select: await flag(client, "bookings", "SELECT"),
      bookings_insert: await flag(client, "bookings", "INSERT"),
      bookings_delete: await flag(client, "bookings", "DELETE"),
      bookings_update_vehicle_id: await col(client, "bookings", "vehicle_id", "UPDATE"),
      bookings_update_driver_id: await col(client, "bookings", "driver_id", "UPDATE"),
      bookings_update_cancelled_at: await col(client, "bookings", "cancelled_at", "UPDATE"),
      bookings_update_status: await col(client, "bookings", "status", "UPDATE"),
      bookings_update_hotel_id: await col(client, "bookings", "hotel_id", "UPDATE"),
      bookings_update_executing_provider_id: await col(
        client,
        "bookings",
        "executing_provider_id",
        "UPDATE",
      ),
      bookings_update_occupies: await col(client, "bookings", "occupies", "UPDATE"),
      bookings_update_destination_id: await col(client, "bookings", "destination_id", "UPDATE"),
      bookings_update_quoted_amount_minor: await col(
        client,
        "bookings",
        "quoted_amount_minor",
        "UPDATE",
      ),
      bookings_update_quoted_currency: await col(client, "bookings", "quoted_currency", "UPDATE"),
      bookings_update_confirmation_token: await col(
        client,
        "bookings",
        "confirmation_token",
        "UPDATE",
      ),
      bookings_update_transfer_date: await col(client, "bookings", "transfer_date", "UPDATE"),
      bookings_update_pickup_time: await col(client, "bookings", "pickup_time", "UPDATE"),
      bookings_update_duration_minutes: await col(client, "bookings", "duration_minutes", "UPDATE"),
      bookings_insert_occupies: await col(client, "bookings", "occupies", "INSERT"),
      bookings_insert_vehicle_id: await col(client, "bookings", "vehicle_id", "INSERT"),
      vehicles_insert_owned_by_provider_id: await col(
        client,
        "vehicles",
        "owned_by_provider_id",
        "INSERT",
      ),
      vehicles_insert_operated_by_provider_id: await col(
        client,
        "vehicles",
        "operated_by_provider_id",
        "INSERT",
      ),
      vehicles_insert_owned_by_hotel_id: await col(client, "vehicles", "owned_by_hotel_id", "INSERT"),
      vehicles_update_name: await col(client, "vehicles", "name", "UPDATE"),
      vehicles_update_owned_by_provider_id: await col(
        client,
        "vehicles",
        "owned_by_provider_id",
        "UPDATE",
      ),
      drivers_insert_employed_by_provider_id: await col(
        client,
        "drivers",
        "employed_by_provider_id",
        "INSERT",
      ),
      drivers_insert_dispatched_by_provider_id: await col(
        client,
        "drivers",
        "dispatched_by_provider_id",
        "INSERT",
      ),
      drivers_insert_employed_by_hotel_id: await col(
        client,
        "drivers",
        "employed_by_hotel_id",
        "INSERT",
      ),
      drivers_update_name: await col(client, "drivers", "name", "UPDATE"),
      drivers_update_dispatched_by_provider_id: await col(
        client,
        "drivers",
        "dispatched_by_provider_id",
        "UPDATE",
      ),
      sessions_select: await flag(client, "sessions", "SELECT"),
      sessions_insert_operator_id: await col(client, "sessions", "operator_id", "INSERT"),
      sessions_insert_membership_id: await col(client, "sessions", "membership_id", "INSERT"),
      sessions_insert_token_hash: await col(client, "sessions", "token_hash", "INSERT"),
      sessions_insert_csrf_hash: await col(client, "sessions", "csrf_hash", "INSERT"),
      sessions_insert_expires_at: await col(client, "sessions", "expires_at", "INSERT"),
      sessions_update_revoked_at: await col(client, "sessions", "revoked_at", "UPDATE"),
      login_attempts_select: await flag(client, "login_attempts", "SELECT"),
      login_attempts_insert: await flag(client, "login_attempts", "INSERT"),
      idempotency_select: await flag(client, "idempotency_keys", "SELECT"),
      idempotency_insert_scope: await col(client, "idempotency_keys", "scope", "INSERT"),
      idempotency_insert_key: await col(client, "idempotency_keys", "key", "INSERT"),
      idempotency_insert_request_hash: await col(client, "idempotency_keys", "request_hash", "INSERT"),
      idempotency_update_booking_id: await col(client, "idempotency_keys", "booking_id", "UPDATE"),
      attempts_select: await flag(client, "public_booking_attempts", "SELECT"),
      attempts_insert: await flag(client, "public_booking_attempts", "INSERT"),
      attempts_delete: await flag(client, "public_booking_attempts", "DELETE"),
      attempts_update: await flag(client, "public_booking_attempts", "UPDATE"),
      audit_insert: await flag(client, "audit_events", "INSERT"),
      audit_update: await flag(client, "audit_events", "UPDATE"),
      audit_delete: await flag(client, "audit_events", "DELETE"),
      migrations_select: await flag(client, "_migrations", "SELECT"),
      migrations_insert: await flag(client, "_migrations", "INSERT"),
      migrations_update: await flag(client, "_migrations", "UPDATE"),
      migrations_delete: await flag(client, "_migrations", "DELETE"),
      meta_select: await flag(client, "aether_meta", "SELECT"),
      meta_insert: await flag(client, "aether_meta", "INSERT"),
      meta_update: await flag(client, "aether_meta", "UPDATE"),
      meta_delete: await flag(client, "aether_meta", "DELETE"),
      schema_usage: await schemaPriv(client, "USAGE"),
      schema_create: await schemaPriv(client, "CREATE"),
      civil_execute: await fnExecute(client, "aether_civil_instant"),
      athens_execute: await fnExecute(client, "aether_athens_instant"),
    };

    const expectedPriv: Record<string, boolean> = {
      hotels_select: true,
      hotels_insert: false,
      hotels_update: false,
      hotels_delete: false,
      destinations_select: true,
      destinations_insert: false,
      destinations_update: false,
      destinations_delete: false,
      providers_select: true,
      providers_insert: false,
      providers_update: false,
      providers_delete: false,
      agreements_select: true,
      agreements_insert: false,
      agreements_update: false,
      agreements_delete: false,
      memberships_select: true,
      memberships_insert: false,
      memberships_update: false,
      memberships_delete: false,
      operators_select: true,
      operators_delete: false,
      operators_insert_login: true,
      operators_insert_password_hash: true,
      operators_update_password_hash: true,
      bookings_select: true,
      bookings_insert: true,
      bookings_delete: false,
      bookings_update_vehicle_id: true,
      bookings_update_driver_id: true,
      bookings_update_cancelled_at: true,
      bookings_update_status: true,
      bookings_update_hotel_id: false,
      bookings_update_executing_provider_id: false,
      bookings_update_occupies: false,
      bookings_update_destination_id: false,
      bookings_update_quoted_amount_minor: false,
      bookings_update_quoted_currency: false,
      bookings_update_confirmation_token: false,
      bookings_update_transfer_date: false,
      bookings_update_pickup_time: false,
      bookings_update_duration_minutes: false,
      bookings_insert_occupies: false,
      bookings_insert_vehicle_id: false,
      vehicles_insert_owned_by_provider_id: true,
      vehicles_insert_operated_by_provider_id: true,
      vehicles_insert_owned_by_hotel_id: false,
      vehicles_update_name: true,
      vehicles_update_owned_by_provider_id: false,
      drivers_insert_employed_by_provider_id: true,
      drivers_insert_dispatched_by_provider_id: true,
      drivers_insert_employed_by_hotel_id: false,
      drivers_update_name: true,
      drivers_update_dispatched_by_provider_id: false,
      sessions_select: true,
      sessions_insert_operator_id: true,
      sessions_insert_membership_id: true,
      sessions_insert_token_hash: true,
      sessions_insert_csrf_hash: true,
      sessions_insert_expires_at: true,
      sessions_update_revoked_at: true,
      login_attempts_select: true,
      login_attempts_insert: true,
      idempotency_select: true,
      idempotency_insert_scope: true,
      idempotency_insert_key: true,
      idempotency_insert_request_hash: true,
      idempotency_update_booking_id: true,
      attempts_select: true,
      attempts_insert: true,
      attempts_delete: true,
      attempts_update: false,
      audit_insert: true,
      audit_update: false,
      audit_delete: false,
      migrations_select: false,
      migrations_insert: false,
      migrations_update: false,
      migrations_delete: false,
      meta_select: true,
      meta_insert: false,
      meta_update: false,
      meta_delete: false,
      schema_usage: true,
      schema_create: false,
      civil_execute: true,
      athens_execute: true,
    };

    const privilegesOk = Object.entries(expectedPriv).every(
      ([key, expected]) => privileges[key] === expected,
    );

    const occupancy = {
      bookings_occupies_before: await objectOwner(
        client,
        `select pg_get_userbyid(c.relowner) as owner
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
          where t.tgname = 'bookings_occupies_before'`,
        [],
      ),
      bookings_vehicle_occupancy_excl: await objectOwner(
        client,
        `select pg_get_userbyid(rel.relowner) as owner
           from pg_constraint c
           join pg_class rel on rel.oid = c.conrelid
          where c.conname = 'bookings_vehicle_occupancy_excl'`,
        [],
      ),
      bookings_driver_occupancy_excl: await objectOwner(
        client,
        `select pg_get_userbyid(rel.relowner) as owner
           from pg_constraint c
           join pg_class rel on rel.oid = c.conrelid
          where c.conname = 'bookings_driver_occupancy_excl'`,
        [],
      ),
      aether_civil_instant: await objectOwner(
        client,
        `select pg_get_userbyid(p.proowner) as owner
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'aether_civil_instant'
          limit 1`,
        [],
      ),
      aether_athens_instant: await objectOwner(
        client,
        `select pg_get_userbyid(p.proowner) as owner
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'aether_athens_instant'
          limit 1`,
        [],
      ),
      aether_bookings_occupies_tg: await objectOwner(
        client,
        `select pg_get_userbyid(p.proowner) as owner
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'aether_bookings_occupies_tg'
          limit 1`,
        [],
      ),
    };

    const occupancyOk = Object.values(occupancy).every(ownerAllowed);

    const ok = identityOk && roleOk && metadataOk && privilegesOk && occupancyOk;
    if (!ok) {
      return failed({ identity, role, metadata, privileges, occupancy });
    }
    return { ok: true, identity, role, metadata, privileges, occupancy };
  } finally {
    client.release();
  }
}
