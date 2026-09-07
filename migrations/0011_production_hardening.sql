-- Aether Transfer — Phase 10 production hardening
-- Privilege split only. Does NOT rewrite aether_athens_instant(),
-- bookings_occupies_before, occupies maintenance, or GiST EXCLUDE.
--
-- aether_runtime: application DML/EXECUTE. Must not own occupancy objects.
-- The role that applies this file remains the table/function/extension owner
-- (migration / schema owner). Production DATABASE_URL must not be that owner.
--
-- Preview / platform default still injects a single DATABASE_URL. The
-- application SET ROLE aether_runtime so current_user is restricted. RESET ROLE
-- restores the connecting owner — that remaining gap is why production must
-- use a non-owner runtime login. Neon two-credential verification is a
-- separate, environment-dependent gate.

-- ---------------------------------------------------------------------------
-- Runtime role
-- ---------------------------------------------------------------------------
do $aether$
begin
  if not exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    create role aether_runtime
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      nobypassrls
      inherit;
  end if;
end
$aether$;

alter role aether_runtime
  nologin
  nosuperuser
  nocreatedb
  nocreaterole
  nobypassrls;

comment on role aether_runtime is
  'Aether Transfer application DML role. Must not own occupancy objects.';

-- Connecting owner (migrations, preview postgres, Neon neondb_owner) may
-- SET ROLE aether_runtime. This does not grant the runtime role any owner
-- privileges.
grant aether_runtime to current_user;

-- ---------------------------------------------------------------------------
-- Schema / PUBLIC
-- ---------------------------------------------------------------------------
revoke create on schema public from public;
revoke create on schema public from aether_runtime;
grant usage on schema public to aether_runtime;

revoke all on all tables in schema public from public;
revoke all on all tables in schema public from aether_runtime;
revoke all on all sequences in schema public from public;
revoke all on all sequences in schema public from aether_runtime;
revoke all on all functions in schema public from public;
revoke all on all functions in schema public from aether_runtime;

-- DML only. No TRIGGER, TRUNCATE, REFERENCES, or schema CREATE.
grant select, insert, update, delete on all tables in schema public
  to aether_runtime;
grant usage, select on all sequences in schema public to aether_runtime;
grant execute on all functions in schema public to aether_runtime;

-- schema_phase / checkpoint are migration-owned.
revoke insert, update, delete on table aether_meta from aether_runtime;
grant select on table aether_meta to aether_runtime;

alter default privileges in schema public
  revoke all on tables from public;
alter default privileges in schema public
  revoke all on functions from public;
alter default privileges in schema public
  grant select, insert, update, delete on tables to aether_runtime;
alter default privileges in schema public
  grant usage, select on sequences to aether_runtime;
alter default privileges in schema public
  grant execute on functions to aether_runtime;

-- ---------------------------------------------------------------------------
-- Record. Occupancy objects are unchanged.
-- ---------------------------------------------------------------------------
insert into aether_meta (key, value)
values
  ('schema_phase', '10'),
  ('checkpoint', '10'),
  ('runtime_role', 'aether_runtime'),
  ('db_owner', current_user)
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
