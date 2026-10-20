/**
 * Gate 2 R2 Stage 1. Real PostgreSQL roles and two-session GiST only.
 * Refuses a non-local host. Fails closed when STAGE_G2S1_PG_URL is unset.
 * Not a PGlite substitute and not a Neon connection.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";

const ADMIN_URL = process.env.STAGE_G2S1_PG_URL;
const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

type Row = Record<string, unknown>;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function apply(client: pg.Client, names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await client.query(readFileSync(new URL(name, MIGRATIONS), "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${name}: ${message}`);
    }
  }
}

function assertLocal(url: URL): void {
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    assert.fail(`BLOCKED — LOCAL POSTGRESQL TEST NOT RUN: refusing non-local host ${url.hostname}`);
  }
}

async function resetCluster(adminUrl: URL): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = 'neondb' and pid <> pg_backend_pid()`,
  );
  await admin.query("drop database if exists neondb");
  for (const role of ["aether_payment_gateway", "aether_expiry_runner", "aether_expiry", "aether_app", "aether_runtime", "aether_webhook", "aether_mailer"]) {
    const exists = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) continue;
    await admin.query(`drop owned by ${role}`);
    await admin.query(
      `alter default privileges for role postgres in schema public revoke all on tables from ${role};
       alter default privileges for role postgres in schema public revoke all on sequences from ${role};
       alter default privileges for role postgres in schema public revoke all on functions from ${role};
       alter default privileges for role postgres in schema public revoke all on types from ${role}`,
    );
    await admin.query(`revoke ${role} from postgres`).catch((err: { code?: string }) => {
      if (err.code !== "42704" && err.code !== "0LP01") throw err;
    });
    await admin.query(`drop role ${role}`);
  }
  await admin.query("create database neondb");
  await admin.end();
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = "/neondb";
  return dbUrl.toString();
}

async function asRole(
  client: pg.Client,
  role: "aether_app" | "aether_runtime" | "aether_webhook" | "aether_mailer",
  sql: string,
  params: unknown[] = [],
): Promise<{ ok: true; rows: Row[] } | { ok: false; code: string; message: string }> {
  await client.query("begin");
  try {
    await client.query(`set local session authorization ${role}`);
    const result = await client.query(sql, params);
    await client.query("commit");
    return { ok: true, rows: result.rows as Row[] };
  } catch (err) {
    await client.query("rollback");
    const error = err as { code?: string; message?: string };
    return { ok: false, code: error.code ?? "", message: error.message ?? String(err) };
  }
}

test("stage 1 source does not open checkout, admit production, or reserve a vehicle", () => {
  const files = migrationFiles();
  assert.equal(files.includes("0065_gate2_vehicle_dispatch_boundary.sql"), true);
  assert.ok(
    (files.at(-1) ?? "") >= "0065_gate2_vehicle_dispatch_boundary.sql",
    files.at(-1),
  );
  assert.equal(files.includes("0064_gate2_paid_confirmation_admission.sql"), true);
  const sql = readFileSync(new URL("0065_gate2_vehicle_dispatch_boundary.sql", MIGRATIONS), "utf8");
  const inventory = readFileSync(new URL("./inventory.ts", import.meta.url), "utf8");
  const booking = readFileSync(new URL("./booking.ts", import.meta.url), "utf8");
  const guest = readFileSync(new URL("./guest-payment-fns.ts", import.meta.url), "utf8");
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../../routes/api/stripe/webhook.ts", import.meta.url), "utf8");
  assert.match(sql, /set search_path = pg_catalog, public/);
  assert.match(sql, /security definer/);
  assert.doesNotMatch(sql, /current_setting|set_config|pg_cron/);
  assert.match(sql, /revoke update \(vehicle_id\) on table public\.bookings from aether_app/);
  assert.match(sql, /revoke update on table public\.bookings from aether_runtime/);
  assert.match(sql, /grant update \(driver_id, cancelled_at, status\) on table public\.bookings to aether_runtime/);
  assert.match(sql, /revoke insert, delete on table public\.bookings from aether_runtime/);
  assert.match(sql, /grant insert \(/);
  assert.match(sql, /authenticate an operator/);
  assert.match(sql, /v_cancelled is not null/);
  assert.match(sql, /v_active is not true/);
  assert.match(sql, /capacity_managed is immutable/);
  assert.match(inventory, /Operator authority is enforced here/);
  assert.match(sql, /grant execute on function public\.sbg_dispatch_set_vehicle\(uuid, uuid\) to aether_app/);
  assert.match(sql, /grant execute on function public\.sbg_dispatch_set_vehicle\(uuid, uuid\) to aether_runtime/);
  assert.doesNotMatch(sql, /grant execute on function public\.sbg_dispatch_set_vehicle\(uuid, uuid\) to aether_webhook/);
  assert.match(sql, /not a provisional reservation/);
  assert.doesNotMatch(sql, /hold_expires_at|stripe_checkout|create table/i);
  assert.equal(preflight.includes("0065_gate2_vehicle_dispatch_boundary.sql"), false);
  assert.match(inventory, /sbg_dispatch_set_vehicle/);
  assert.match(inventory, /vehicle\.assign/);
  assert.match(inventory, /vehicle\.unassign/);
  assert.match(inventory, /update bookings set driver_id/);
  assert.match(inventory, /update bookings set cancelled_at/);
  assert.match(inventory, /update bookings set status/);
  assert.doesNotMatch(booking, /sbg_dispatch_set_vehicle/);
  assert.match(booking, /openFreshHold/);
  assert.match(guest, /class GuestCheckoutClosed/);
  assert.match(guest, /throw new GuestCheckoutClosed\(\)/);
  assert.doesNotMatch(webhook, /sbg_dispatch_set_vehicle|sbg_accept_verified_payment_event/);
});

test("local postgres keeps desk dispatch and refuses direct vehicle writes", { timeout: 180_000 }, async () => {
  if (!ADMIN_URL) assert.fail("BLOCKED — LOCAL POSTGRESQL TEST NOT RUN");
  const adminUrl = new URL(ADMIN_URL);
  assertLocal(adminUrl);
  adminUrl.pathname = "/postgres";
  const dbUrl = await resetCluster(adminUrl);
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  const files = migrationFiles();
  const boundary = "0065_gate2_vehicle_dispatch_boundary.sql";
  await apply(root, files.filter((name) => name < boundary));

  const tag = "s1hist";
  const hotel = (
    await root.query<{ id: string }>(
      `insert into hotels (code, name) values ($1, 'Historical Hotel') returning id`,
      [`h${tag}`],
    )
  ).rows[0]!.id;
  const provider = (
    await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ($1, 'Historical Provider', 'in_house') returning id`,
      [`p${tag}`],
    )
  ).rows[0]!.id;
  await root.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
    [hotel, provider],
  );
  const historicalVan = (
    await root.query<{ id: string }>(
      `insert into vehicles (name, owned_by_provider_id, operated_by_provider_id)
       values ('Historical Van', $1::uuid, $1::uuid) returning id`,
      [provider],
    )
  ).rows[0]!.id;
  const historical = (
    await root.query<{
      id: string;
      vehicle_id: string;
      driver_id: string | null;
      status: string;
      lifecycle_state: string;
      cancelled_at: string | null;
      occupies: string;
    }>(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, pickup_text, destination_text,
         human_reference, confirmation_token, vehicle_id
       ) values (
         $1::uuid, $2::uuid, '2026-04-01', '08:00', 60,
         'Historical Guest', '+302100000001', 'hist@example.com', 'Door', 'Port',
         'HIST-1', 'token-hist-1', $3::uuid
       ) returning id, vehicle_id, driver_id, status, lifecycle_state, cancelled_at, occupies::text as occupies`,
      [hotel, provider, historicalVan],
    )
  ).rows[0]!;
  await apply(root, [boundary]);
  const afterMigration = (
    await root.query<{
      vehicle_id: string;
      driver_id: string | null;
      status: string;
      lifecycle_state: string;
      cancelled_at: string | null;
      occupies: string;
      capacity_managed: boolean;
    }>(
      `select vehicle_id, driver_id, status, lifecycle_state, cancelled_at, occupies::text as occupies, capacity_managed
         from bookings where id = $1::uuid`,
      [historical.id],
    )
  ).rows[0]!;
  assert.equal(afterMigration.vehicle_id, historical.vehicle_id);
  assert.equal(afterMigration.driver_id, historical.driver_id);
  assert.equal(afterMigration.status, historical.status);
  assert.equal(afterMigration.lifecycle_state, historical.lifecycle_state);
  assert.equal(afterMigration.cancelled_at, historical.cancelled_at);
  assert.equal(afterMigration.occupies, historical.occupies);
  assert.equal(afterMigration.capacity_managed, false);

  const roles = await root.query<{
    rolname: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolbypassrls: boolean;
    rolcanlogin: boolean;
  }>(
    `select rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin
       from pg_roles
      where rolname in ('aether_app', 'aether_runtime', 'aether_webhook', 'aether_mailer')
      order by rolname`,
  );
  const byRole = new Map(roles.rows.map((row) => [row.rolname, row]));
  for (const name of ["aether_app", "aether_runtime", "aether_webhook", "aether_mailer"]) {
    const role = byRole.get(name);
    assert.ok(role, name);
    assert.equal(role.rolsuper, false, name);
    assert.equal(role.rolcreaterole, false, name);
    assert.equal(role.rolcreatedb, false, name);
    assert.equal(role.rolbypassrls, false, name);
  }
  assert.equal(byRole.get("aether_webhook")!.rolcanlogin, false);
  assert.equal(byRole.get("aether_mailer")!.rolcanlogin, false);
  const membership = await root.query(
    `select member.rolname as member, granted.rolname as granted
       from pg_auth_members am
       join pg_roles member on member.oid = am.member
       join pg_roles granted on granted.oid = am.roleid
      where member.rolname in ('aether_app', 'aether_runtime')`,
  );
  assert.equal(membership.rowCount, 0);

  const privileges = (
    await root.query<{
      app_exec: boolean;
      runtime_exec: boolean;
      public_exec: boolean;
      webhook_exec: boolean;
      mailer_exec: boolean;
      app_vehicle: boolean;
      runtime_vehicle: boolean;
      app_driver: boolean;
      runtime_driver: boolean;
      app_cancel: boolean;
      runtime_cancel: boolean;
      app_status: boolean;
      runtime_status: boolean;
      runtime_insert_vehicle: boolean;
      runtime_insert_hotel: boolean;
      runtime_insert_capacity: boolean;
      runtime_table_insert: boolean;
      runtime_delete: boolean;
      app_delete: boolean;
    }>(
      `select
         has_function_privilege('aether_app', 'public.sbg_dispatch_set_vehicle(uuid, uuid)', 'execute') as app_exec,
         has_function_privilege('aether_runtime', 'public.sbg_dispatch_set_vehicle(uuid, uuid)', 'execute') as runtime_exec,
         has_function_privilege('public', 'public.sbg_dispatch_set_vehicle(uuid, uuid)', 'execute') as public_exec,
         has_function_privilege('aether_webhook', 'public.sbg_dispatch_set_vehicle(uuid, uuid)', 'execute') as webhook_exec,
         has_function_privilege('aether_mailer', 'public.sbg_dispatch_set_vehicle(uuid, uuid)', 'execute') as mailer_exec,
         has_column_privilege('aether_app', 'public.bookings', 'vehicle_id', 'update') as app_vehicle,
         has_column_privilege('aether_runtime', 'public.bookings', 'vehicle_id', 'update') as runtime_vehicle,
         has_column_privilege('aether_app', 'public.bookings', 'driver_id', 'update') as app_driver,
         has_column_privilege('aether_runtime', 'public.bookings', 'driver_id', 'update') as runtime_driver,
         has_column_privilege('aether_app', 'public.bookings', 'cancelled_at', 'update') as app_cancel,
         has_column_privilege('aether_runtime', 'public.bookings', 'cancelled_at', 'update') as runtime_cancel,
         has_column_privilege('aether_app', 'public.bookings', 'status', 'update') as app_status,
         has_column_privilege('aether_runtime', 'public.bookings', 'status', 'update') as runtime_status,
         has_column_privilege('aether_runtime', 'public.bookings', 'vehicle_id', 'insert') as runtime_insert_vehicle,
         has_column_privilege('aether_runtime', 'public.bookings', 'hotel_id', 'insert') as runtime_insert_hotel,
         has_column_privilege('aether_runtime', 'public.bookings', 'capacity_managed', 'insert') as runtime_insert_capacity,
         has_table_privilege('aether_runtime', 'public.bookings', 'insert') as runtime_table_insert,
         has_table_privilege('aether_runtime', 'public.bookings', 'delete') as runtime_delete,
         has_table_privilege('aether_app', 'public.bookings', 'delete') as app_delete`,
    )
  ).rows[0]!;
  assert.equal(privileges.app_exec, true);
  assert.equal(privileges.runtime_exec, true);
  assert.equal(privileges.public_exec, false);
  assert.equal(privileges.webhook_exec, false);
  assert.equal(privileges.mailer_exec, false);
  assert.equal(privileges.app_vehicle, false);
  assert.equal(privileges.runtime_vehicle, false);
  assert.equal(privileges.app_driver, true);
  assert.equal(privileges.runtime_driver, true);
  assert.equal(privileges.app_cancel, true);
  assert.equal(privileges.runtime_cancel, true);
  assert.equal(privileges.app_status, true);
  assert.equal(privileges.runtime_status, true);
  assert.equal(privileges.runtime_insert_vehicle, false);
  assert.equal(privileges.runtime_insert_hotel, true);
  assert.equal(privileges.runtime_insert_capacity, false);
  assert.equal(privileges.runtime_table_insert, false);
  assert.equal(privileges.runtime_delete, false);
  assert.equal(privileges.app_delete, false);

  await root.query(
    `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
     values ('user-stage1','Ada','ada-stage1@example.com',true,now(),now())`,
  );
  const hotelOrg = (
    await root.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Stage Hotel Org', 'user-stage1', 'hotel') returning id`,
    )
  ).rows[0]!.id;
  const liveHotel = (
    await root.query<{ id: string }>(
      `insert into hotels (code, name, organisation_id) values ('stage1h', 'Stage Hotel', $1::uuid) returning id`,
      [hotelOrg],
    )
  ).rows[0]!.id;
  await root.query(
    `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity) values ($1::uuid, 'active', 1)`,
    [hotelOrg],
  );
  await root.query(
    `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
     values ($1::uuid, $2::uuid, 'user-stage1')`,
    [hotelOrg, liveHotel],
  );
  const liveProvider = (
    await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('stage1p', 'Stage Provider', 'in_house') returning id`,
    )
  ).rows[0]!.id;
  const otherProvider = (
    await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('stage1o', 'Other Provider', 'external') returning id`,
    )
  ).rows[0]!.id;
  await root.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
    [liveHotel, liveProvider],
  );
  await root.query(
    `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode) values ($1::uuid, 'acct_legacy_stage1', false)`,
    [liveHotel],
  );
  await root.query(
    `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
     values ($1::uuid, 'acct_hotel_stage1', false)`,
    [hotelOrg],
  );
  const ownVan = (
    await root.query<{ id: string }>(
      `insert into vehicles (name, owned_by_provider_id, operated_by_provider_id)
       values ('Own Van', $1::uuid, $1::uuid) returning id`,
      [liveProvider],
    )
  ).rows[0]!.id;
  const ownVan2 = (
    await root.query<{ id: string }>(
      `insert into vehicles (name, owned_by_provider_id, operated_by_provider_id)
       values ('Own Van 2', $1::uuid, $1::uuid) returning id`,
      [liveProvider],
    )
  ).rows[0]!.id;
  const foreignVan = (
    await root.query<{ id: string }>(
      `insert into vehicles (name, owned_by_provider_id, operated_by_provider_id)
       values ('Foreign Van', $1::uuid, $1::uuid) returning id`,
      [otherProvider],
    )
  ).rows[0]!.id;
  const driver = (
    await root.query<{ id: string }>(
      `insert into drivers (name, employed_by_provider_id, dispatched_by_provider_id)
       values ('Dee', $1::uuid, $1::uuid) returning id`,
      [liveProvider],
    )
  ).rows[0]!.id;

  async function insertBooking(reference: string, time: string): Promise<string> {
    const rows = await root.query<{ id: string }>(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, pickup_text, destination_text,
         human_reference, confirmation_token
       ) values (
         $1::uuid, $2::uuid, '2026-08-01', $3::time, 60,
         'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport', $4, $5
       ) returning id`,
      [liveHotel, liveProvider, time, reference, `token-${reference}`],
    );
    return rows.rows[0]!.id;
  }

  const legacy = await insertBooking("LEG-1", "09:00");
  const deniedApp = await asRole(
    root,
    "aether_app",
    `update bookings set vehicle_id = $1::uuid where id = $2::uuid`,
    [ownVan, legacy],
  );
  const deniedRuntime = await asRole(
    root,
    "aether_runtime",
    `update bookings set vehicle_id = $1::uuid where id = $2::uuid`,
    [ownVan, legacy],
  );
  assert.equal(deniedApp.ok, false);
  assert.equal(deniedRuntime.ok, false);
  if (!deniedApp.ok && !deniedRuntime.ok) {
    assert.equal(deniedApp.code, "42501");
    assert.equal(deniedRuntime.code, "42501");
    assert.match(deniedApp.message, /permission denied/);
    assert.match(deniedRuntime.message, /permission denied/);
  }
  const untouched = await root.query<{ vehicle_id: string | null }>(
    `select vehicle_id from bookings where id = $1::uuid`,
    [legacy],
  );
  assert.equal(untouched.rows[0]!.vehicle_id, null);

  for (const role of ["aether_app", "aether_runtime"] as const) {
    for (const target of ["aether_webhook", "aether_mailer", "postgres"] as const) {
      const escalated = await asRole(root, role, `set role ${target}`);
      assert.equal(escalated.ok, false, `${role} -> ${target}`);
      if (!escalated.ok) assert.equal(escalated.code, "42501");
    }
    const created = await asRole(
      root,
      role,
      `create function public.sbg_stage1_escalation() returns void language sql security definer as 'select 1'`,
    );
    assert.equal(created.ok, false, role);
  }

  const assigned = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [legacy, ownVan],
  );
  assert.equal(assigned.ok, true);
  const reassigned = await asRole(
    root,
    "aether_runtime",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [legacy, ownVan2],
  );
  assert.equal(reassigned.ok, true);
  const same = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [legacy, ownVan2],
  );
  assert.equal(same.ok, true);
  const cross = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [legacy, foreignVan],
  );
  assert.equal(cross.ok, false);
  if (!cross.ok) {
    assert.equal(cross.code, "42501");
    assert.match(cross.message, /dispatch_not_admitted/);
  }
  const inactiveVan = (
    await root.query<{ id: string }>(
      `insert into vehicles (name, owned_by_provider_id, operated_by_provider_id, active)
       values ('Inactive Van', $1::uuid, $1::uuid, false) returning id`,
      [liveProvider],
    )
  ).rows[0]!.id;
  const inactive = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [legacy, inactiveVan],
  );
  assert.equal(inactive.ok, false);
  if (!inactive.ok) {
    assert.equal(inactive.code, "42501");
    assert.match(inactive.message, /dispatch_not_admitted/);
  }
  const cancelledBooking = await insertBooking("CAN-1", "10:30");
  const cancelledSeed = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [cancelledBooking, ownVan],
  );
  assert.equal(cancelledSeed.ok, true);
  await root.query(`update bookings set cancelled_at = clock_timestamp() where id = $1::uuid`, [
    cancelledBooking,
  ]);
  const cancelledReassign = await asRole(
    root,
    "aether_runtime",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [cancelledBooking, ownVan2],
  );
  const cancelledClear = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, null::uuid)`,
    [cancelledBooking],
  );
  assert.equal(cancelledReassign.ok, false);
  assert.equal(cancelledClear.ok, false);
  if (!cancelledReassign.ok) assert.match(cancelledReassign.message, /dispatch_not_admitted/);
  if (!cancelledClear.ok) assert.match(cancelledClear.message, /dispatch_not_admitted/);
  const cancelledRow = await root.query<{ vehicle_id: string; cancelled_at: string | null }>(
    `select vehicle_id, cancelled_at from bookings where id = $1::uuid`,
    [cancelledBooking],
  );
  assert.equal(cancelledRow.rows[0]!.vehicle_id, ownVan);
  assert.ok(cancelledRow.rows[0]!.cancelled_at);
  const otherBooking = (
    await root.query<{ id: string }>(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, pickup_text, destination_text,
         human_reference, confirmation_token
       ) values (
         $1::uuid, $2::uuid, '2026-08-01', '11:00', 60,
         'Other Guest', '+302100000099', 'other@example.com', 'Door', 'Port',
         'OTH-1', 'token-OTH-1'
       ) returning id`,
      [liveHotel, otherProvider],
    )
  ).rows[0]!.id;
  // Retained limitation: the session has no operator identity. A caller-supplied
  // setting is not authority, so a compatible cross-tenant assignment still succeeds.
  const crossTenant = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)
       from (select set_config('sbg.operator_id', 'not-an-operator', true)) cfg`,
    [otherBooking, foreignVan],
  );
  assert.equal(crossTenant.ok, true);
  const crossTenantRow = await root.query<{ vehicle_id: string }>(
    `select vehicle_id from bookings where id = $1::uuid`,
    [otherBooking],
  );
  assert.equal(crossTenantRow.rows[0]!.vehicle_id, foreignVan);
  const legacyVehicle = await root.query<{ vehicle_id: string }>(
    `select vehicle_id from bookings where id = $1::uuid`,
    [legacy],
  );
  assert.equal(legacyVehicle.rows[0]!.vehicle_id, ownVan2);
  const cleared = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, null::uuid)`,
    [legacy],
  );
  assert.equal(cleared.ok, true);

  const paid = await insertBooking("PAID-1", "12:00");
  await root.query(`select * from sbg_open_provisional_hold($1::uuid, 1800)`, [paid]);
  const unpaidAssign = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [paid, ownVan],
  );
  assert.equal(unpaidAssign.ok, false);
  if (!unpaidAssign.ok) assert.match(unpaidAssign.message, /dispatch_not_admitted/);
  const payment = (
    await root.query<{ id: string }>(
      `insert into sbg_booking_payments (
         booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url
       ) values ($1::uuid, 4500, 'EUR', 'cs_stage1', 'https://checkout.stripe.test/session')
       returning id`,
      [paid],
    )
  ).rows[0]!.id;
  await root.query(`select * from sbg_bind_payment_authority($1::uuid)`, [paid]);
  await root.query(
    `update sbg_booking_payments set status = 'paid', paid_at = clock_timestamp() where id = $1::uuid`,
    [payment],
  );
  await root.query(
    `update bookings set lifecycle_state = 'confirmed_paid', confirmed_paid_at = clock_timestamp() where id = $1::uuid`,
    [paid],
  );
  const paidAssign = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [paid, ownVan],
  );
  assert.equal(paidAssign.ok, true);
  const paidDirect = await asRole(
    root,
    "aether_app",
    `update bookings set vehicle_id = $1::uuid where id = $2::uuid`,
    [ownVan2, paid],
  );
  assert.equal(paidDirect.ok, false);
  const paidReassign = await asRole(
    root,
    "aether_runtime",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [paid, ownVan2],
  );
  assert.equal(paidReassign.ok, true);
  const paidRow = await root.query<{ vehicle_id: string; lifecycle_state: string }>(
    `select vehicle_id, lifecycle_state from bookings where id = $1::uuid`,
    [paid],
  );
  assert.equal(paidRow.rows[0]!.vehicle_id, ownVan2);
  assert.equal(paidRow.rows[0]!.lifecycle_state, "confirmed_paid");
  const paidClear = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, null::uuid)`,
    [paid],
  );
  assert.equal(paidClear.ok, true);

  const managed = await insertBooking("CAP-1", "15:00");
  let ownerDirectBlocked = false;
  try {
    await root.query(`update bookings set capacity_managed = true where id = $1::uuid`, [managed]);
  } catch (err) {
    ownerDirectBlocked = true;
    assert.match((err as Error).message, /capacity dispatch is not directly writable/);
  }
  assert.equal(ownerDirectBlocked, true);
  await root.query(`
    create function public.sbg_stage1_probe_capacity(p_id uuid) returns void
    language plpgsql security definer
    set search_path = pg_catalog, public
    as $probe$
    begin
      update public.bookings set capacity_managed = true where id = p_id;
    end
    $probe$`);
  await root.query(`revoke all on function public.sbg_stage1_probe_capacity(uuid) from public`);
  await root.query(
    `grant execute on function public.sbg_stage1_probe_capacity(uuid) to aether_app, aether_runtime`,
  );
  const probeApp = await asRole(
    root,
    "aether_app",
    `select public.sbg_stage1_probe_capacity($1::uuid)`,
    [managed],
  );
  assert.equal(probeApp.ok, false);
  if (!probeApp.ok) assert.match(probeApp.message, /capacity dispatch is not directly writable/);
  await root.query("begin");
  let probeRoleBlocked = false;
  try {
    await root.query("set local role aether_runtime");
    await root.query(`select public.sbg_stage1_probe_capacity($1::uuid)`, [managed]);
  } catch (err) {
    probeRoleBlocked = true;
    assert.match((err as Error).message, /capacity dispatch is not directly writable/);
  } finally {
    await root.query("rollback");
  }
  assert.equal(probeRoleBlocked, true);
  await root.query(`drop function public.sbg_stage1_probe_capacity(uuid)`);
  await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
  await root.query(`update bookings set capacity_managed = true where id = $1::uuid`, [managed]);
  await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
  const disableTrigger = await asRole(
    root,
    "aether_runtime",
    "alter table public.bookings disable trigger bookings_capacity_managed_guard",
  );
  assert.equal(disableTrigger.ok, false);
  const managedFn = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [managed, ownVan],
  );
  const managedDirect = await asRole(
    root,
    "aether_runtime",
    `update bookings set vehicle_id = $1::uuid where id = $2::uuid`,
    [ownVan, managed],
  );
  const managedFlag = await asRole(
    root,
    "aether_app",
    `update bookings set capacity_managed = false where id = $1::uuid`,
    [managed],
  );
  assert.equal(managedFn.ok, false);
  assert.equal(managedDirect.ok, false);
  assert.equal(managedFlag.ok, false);
  if (!managedFn.ok) assert.match(managedFn.message, /dispatch_not_admitted/);
  const managedRow = await root.query<{ vehicle_id: string | null; capacity_managed: boolean }>(
    `select vehicle_id, capacity_managed from bookings where id = $1::uuid`,
    [managed],
  );
  assert.equal(managedRow.rows[0]!.vehicle_id, null);
  assert.equal(managedRow.rows[0]!.capacity_managed, true);
  const managedInsert = await asRole(
    root,
    "aether_runtime",
    `insert into bookings (
       hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
       guest_name, guest_phone, guest_email, pickup_text, destination_text,
       human_reference, confirmation_token, vehicle_id, capacity_managed
     ) values (
       $1::uuid, $2::uuid, '2026-08-02', '09:00', 60,
       'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport',
       'CAP-INS', 'token-CAP-INS', $3::uuid, true
     )`,
    [liveHotel, liveProvider, ownVan],
  );
  assert.equal(managedInsert.ok, false);
  if (!managedInsert.ok) assert.match(managedInsert.message, /permission denied/);
  const runtimeDelete = await asRole(
    root,
    "aether_runtime",
    `delete from bookings where id = $1::uuid`,
    [managed],
  );
  assert.equal(runtimeDelete.ok, false);
  if (!runtimeDelete.ok) assert.match(runtimeDelete.message, /permission denied/);
  const runtimeInsert = await asRole(
    root,
    "aether_runtime",
    `insert into bookings (
       hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
       guest_name, guest_phone, guest_email, pickup_text, destination_text,
       human_reference, confirmation_token
     ) values (
       $1::uuid, $2::uuid, '2026-08-03', '09:00', 60,
       'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport',
       'RT-INS', 'token-RT-INS'
     ) returning id`,
    [liveHotel, liveProvider],
  );
  assert.equal(runtimeInsert.ok, true);
  const runtimeRow = await root.query<{ vehicle_id: string | null; capacity_managed: boolean }>(
    `select vehicle_id, capacity_managed from bookings where human_reference = 'RT-INS'`,
  );
  assert.equal(runtimeRow.rows[0]!.vehicle_id, null);
  assert.equal(runtimeRow.rows[0]!.capacity_managed, false);
  let ownerCapacityInsertBlocked = false;
  try {
    await root.query(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, pickup_text, destination_text,
         human_reference, confirmation_token, capacity_managed
       ) values (
         $1::uuid, $2::uuid, '2026-08-03', '10:00', 60,
         'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport',
         'OWN-CAP', 'token-OWN-CAP', true
       )`,
      [liveHotel, liveProvider],
    );
  } catch (err) {
    ownerCapacityInsertBlocked = true;
    assert.match((err as Error).message, /capacity dispatch is not directly writable/);
  }
  assert.equal(ownerCapacityInsertBlocked, true);

  const held = await root.query<{ vehicle_id: string; lifecycle_state: string; capacity_managed: boolean }>(
    `select vehicle_id, lifecycle_state, capacity_managed from bookings where id = $1::uuid`,
    [historical.id],
  );
  assert.equal(held.rows[0]!.vehicle_id, historicalVan);
  assert.equal(held.rows[0]!.lifecycle_state, "legacy_unreconciled");
  assert.equal(held.rows[0]!.capacity_managed, false);

  const overlapLeft = await insertBooking("OVL-1", "16:00");
  const overlapRight = await insertBooking("OVL-2", "16:00");
  const left = new pg.Client({ connectionString: dbUrl });
  const right = new pg.Client({ connectionString: dbUrl });
  await left.connect();
  await right.connect();
  await left.query("set session authorization aether_app");
  await right.query("set session authorization aether_app");
  const vehicleRace = await Promise.allSettled([
    left.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [overlapLeft, ownVan]),
    right.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [overlapRight, ownVan]),
  ]);
  const vehicleFailures = vehicleRace.filter((result) => result.status === "rejected");
  const vehicleWins = vehicleRace.filter((result) => result.status === "fulfilled");
  assert.equal(vehicleWins.length, 1);
  assert.equal(vehicleFailures.length, 1);
  const vehicleCode = (vehicleFailures[0] as PromiseRejectedResult).reason.code;
  assert.ok(vehicleCode === "23P01" || vehicleCode === "40P01", vehicleCode);
  const occupied = await root.query<{ id: string }>(
    `select id from bookings where id in ($1::uuid, $2::uuid) and vehicle_id = $3::uuid`,
    [overlapLeft, overlapRight, ownVan],
  );
  assert.equal(occupied.rowCount, 1);
  const sequentialOverlap = await insertBooking("OVL-3", "16:00");
  const sequentialDenied = await asRole(
    root,
    "aether_app",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [sequentialOverlap, ownVan],
  );
  assert.equal(sequentialDenied.ok, false);
  if (!sequentialDenied.ok) assert.equal(sequentialDenied.code, "23P01");

  const driverLeft = await insertBooking("DRV-1", "18:00");
  const driverRight = await insertBooking("DRV-2", "18:00");
  const driverRace = await Promise.allSettled([
    left.query(`update bookings set driver_id = $1::uuid where id = $2::uuid`, [driver, driverLeft]),
    right.query(`update bookings set driver_id = $1::uuid where id = $2::uuid`, [driver, driverRight]),
  ]);
  const driverFailures = driverRace.filter((result) => result.status === "rejected");
  assert.equal(driverRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(driverFailures.length, 1);
  const driverCode = (driverFailures[0] as PromiseRejectedResult).reason.code;
  assert.ok(driverCode === "23P01" || driverCode === "40P01", driverCode);
  const sequentialDriver = await insertBooking("DRV-3", "18:00");
  const sequentialDriverDenied = await asRole(
    root,
    "aether_app",
    `update bookings set driver_id = $1::uuid where id = $2::uuid`,
    [driver, sequentialDriver],
  );
  assert.equal(sequentialDriverDenied.ok, false);
  if (!sequentialDriverDenied.ok) assert.equal(sequentialDriverDenied.code, "23P01");

  const cancelTarget = occupied.rows[0]!.id;
  const cancelled = await asRole(
    root,
    "aether_app",
    `update bookings set cancelled_at = clock_timestamp() where id = $1::uuid`,
    [cancelTarget],
  );
  assert.equal(cancelled.ok, true);
  const released = await root.query<{ occupies: string; vehicle_id: string }>(
    `select occupies::text as occupies, vehicle_id from bookings where id = $1::uuid`,
    [cancelTarget],
  );
  assert.equal(released.rows[0]!.occupies, "empty");
  assert.equal(released.rows[0]!.vehicle_id, ownVan);
  const reused = overlapLeft === cancelTarget ? overlapRight : overlapLeft;
  const reusedAssign = await asRole(
    root,
    "aether_runtime",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [reused, ownVan],
  );
  assert.equal(reusedAssign.ok, true);

  const statusBooking = await insertBooking("STA-1", "20:00");
  const status = await asRole(
    root,
    "aether_app",
    `update bookings set status = 'rolling' where id = $1::uuid`,
    [statusBooking],
  );
  const runtimeStatus = await asRole(
    root,
    "aether_runtime",
    `update bookings set status = 'done' where id = $1::uuid`,
    [statusBooking],
  );
  assert.equal(status.ok, true);
  assert.equal(runtimeStatus.ok, true);
  const statusRow = await root.query<{ status: string }>(
    `select status from bookings where id = $1::uuid`,
    [statusBooking],
  );
  assert.equal(statusRow.rows[0]!.status, "done");
  const lifecycleDenied = await asRole(
    root,
    "aether_app",
    `update bookings set lifecycle_state = 'confirmed_paid' where id = $1::uuid`,
    [statusBooking],
  );
  assert.equal(lifecycleDenied.ok, false);
  const guestDenied = await asRole(
    root,
    "aether_runtime",
    `update bookings set guest_name = 'Changed' where id = $1::uuid`,
    [statusBooking],
  );
  assert.equal(guestDenied.ok, false);
  const webhookCall = await asRole(
    root,
    "aether_webhook",
    `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
    [statusBooking, ownVan],
  );
  assert.equal(webhookCall.ok, false);
  if (!webhookCall.ok) assert.match(webhookCall.message, /permission denied/);

  const finalHistorical = await root.query<{ vehicle_id: string; capacity_managed: boolean }>(
    `select vehicle_id, capacity_managed from bookings where id = $1::uuid`,
    [historical.id],
  );
  assert.equal(finalHistorical.rows[0]!.vehicle_id, historicalVan);
  assert.equal(finalHistorical.rows[0]!.capacity_managed, false);

  await left.end();
  await right.end();
  await root.end();
});
