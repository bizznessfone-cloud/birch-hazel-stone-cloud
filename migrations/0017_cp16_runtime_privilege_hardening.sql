-- Aether Transfer — CP16 runtime privilege hardening
-- REVOKE/GRANT only. Does NOT rewrite occupancy, 0011–0016, or roles.
-- aether_app = production LOGIN. aether_runtime (preview) is unchanged.
-- Owner/migrator retains table ownership and all DML.
--
-- LEGACY_RUNTIME: operators INSERT(login, password_hash) and UPDATE(password_hash)
-- remain because ensureOperatorFromEnv() still runs on production HTTP login.
-- That is not owner-grade identity administration.
--
-- DEFERRED FLEET OWNERSHIP STAMPER ARCHITECTURE:
-- vehicles/drivers INSERT still includes provider ownership columns because
-- current upsertVehicle/upsertDriver SQL names them and they are NOT NULL /
-- XOR-checked with no default. PostgreSQL grants cannot bind those UUIDs to
-- requireOps().providerId. HTTP does not accept provider IDs from the DTO.

do $aether$
begin
  if not exists (select 1 from pg_roles where rolname = 'aether_app') then
    raise exception 'aether_app missing — 0014 not applied';
  end if;
end
$aether$;

-- ---------------------------------------------------------------------------
-- Default privileges: stop auto-granting DML/EXECUTE on future owner objects.
-- Grantor is the migrator (same implicit FOR ROLE as 0014).
-- ---------------------------------------------------------------------------
alter default privileges in schema public
  revoke insert, update, delete on tables from aether_app;
alter default privileges in schema public
  revoke all on tables from aether_app;
alter default privileges in schema public
  revoke all on sequences from aether_app;
alter default privileges in schema public
  revoke all on functions from aether_app;

-- ---------------------------------------------------------------------------
-- Schema / functions / sequences
-- ---------------------------------------------------------------------------
revoke create on schema public from aether_app;
grant usage on schema public to aether_app;

revoke all on all functions in schema public from aether_app;
grant execute on function aether_civil_instant(date, time, text) to aether_app;
grant execute on function aether_athens_instant(date, time) to aether_app;
grant execute on function aether_athens_today() to aether_app;
grant execute on function aether_bookings_occupies_tg() to aether_app;
grant execute on function aether_bookings_quote_immutable_tg() to aether_app;

revoke all on all sequences in schema public from aether_app;
grant usage, select on all sequences in schema public to aether_app;

-- Snapshot: strip 0014/0015 blanket DML, then re-grant the least-privilege set.
revoke all on all tables in schema public from aether_app;

-- ---------------------------------------------------------------------------
-- Owner-only / migration
-- ---------------------------------------------------------------------------
revoke all on table _migrations from aether_app;

revoke all on table aether_meta from aether_app;
grant select on table aether_meta to aether_app;

-- ---------------------------------------------------------------------------
-- Tenant / identity (SELECT only)
-- ---------------------------------------------------------------------------
revoke all on table hotels from aether_app;
grant select on table hotels to aether_app;

revoke all on table hotel_destinations from aether_app;
grant select on table hotel_destinations to aether_app;

revoke all on table providers from aether_app;
grant select on table providers to aether_app;

revoke all on table hotel_provider_agreements from aether_app;
grant select on table hotel_provider_agreements to aether_app;

revoke all on table operator_memberships from aether_app;
grant select on table operator_memberships to aether_app;

-- ---------------------------------------------------------------------------
-- Operators — LEGACY_RUNTIME env bootstrap. No DELETE.
-- ---------------------------------------------------------------------------
revoke all on table operators from aether_app;
grant select on table operators to aether_app;
grant insert (login, password_hash) on table operators to aether_app;
grant update (password_hash) on table operators to aether_app;

-- ---------------------------------------------------------------------------
-- Bookings — operational columns only
-- ---------------------------------------------------------------------------
revoke all on table bookings from aether_app;
grant select on table bookings to aether_app;
grant insert (
  hotel_id,
  executing_provider_id,
  transfer_date,
  pickup_time,
  duration_minutes,
  guest_name,
  guest_phone,
  guest_email,
  passenger_count,
  luggage_count,
  pickup_text,
  destination_text,
  special_requirements,
  human_reference,
  confirmation_token,
  destination_id,
  quoted_amount_minor,
  quoted_currency
) on table bookings to aether_app;
grant update (vehicle_id, driver_id, cancelled_at, status) on table bookings to aether_app;

-- ---------------------------------------------------------------------------
-- Fleet — dispatcher HTTP; ownership columns remain INSERTable (deferred stamper)
-- ---------------------------------------------------------------------------
revoke all on table vehicles from aether_app;
grant select on table vehicles to aether_app;
grant insert (
  name, capacity, active, owned_by_provider_id, operated_by_provider_id
) on table vehicles to aether_app;
grant update (name, capacity, active) on table vehicles to aether_app;

revoke all on table drivers from aether_app;
grant select on table drivers to aether_app;
grant insert (
  name, active, employed_by_provider_id, dispatched_by_provider_id
) on table drivers to aether_app;
grant update (name, active) on table drivers to aether_app;

-- ---------------------------------------------------------------------------
-- Sessions / login / idempotency / rate limit / audit
-- ---------------------------------------------------------------------------
revoke all on table sessions from aether_app;
grant select on table sessions to aether_app;
grant insert (operator_id, membership_id, token_hash, csrf_hash, expires_at) on table sessions to aether_app;
grant update (revoked_at) on table sessions to aether_app;

revoke all on table login_attempts from aether_app;
grant select, insert on table login_attempts to aether_app;

revoke all on table idempotency_keys from aether_app;
grant select on table idempotency_keys to aether_app;
grant insert (scope, key, request_hash) on table idempotency_keys to aether_app;
grant update (booking_id) on table idempotency_keys to aether_app;

revoke all on table public_booking_attempts from aether_app;
grant select, insert, delete on table public_booking_attempts to aether_app;

revoke all on table audit_events from aether_app;
grant select, insert on table audit_events to aether_app;

-- Unused Better Auth tables (may be absent on Neon).
do $aether$
begin
  if to_regclass('public.user') is not null then
    execute 'revoke all on table "user" from aether_app';
  end if;
  if to_regclass('public.session') is not null then
    execute 'revoke all on table "session" from aether_app';
  end if;
  if to_regclass('public.account') is not null then
    execute 'revoke all on table "account" from aether_app';
  end if;
  if to_regclass('public.verification') is not null then
    execute 'revoke all on table "verification" from aether_app';
  end if;
end
$aether$;

insert into aether_meta (key, value)
values
  ('schema_phase', '16'),
  ('checkpoint', '16')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
