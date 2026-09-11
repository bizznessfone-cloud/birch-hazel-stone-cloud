-- Aether Transfer — CP13A SQL-created production application LOGIN
-- Privilege identity only. Does NOT rewrite aether_athens_instant(),
-- bookings_occupies_before, occupies maintenance, or GiST EXCLUDE.
--
-- 0011/0013 left aether_runtime as the PGLite/preview SET ROLE identity.
-- Production must not authenticate as a Neon Console-created role: those
-- inherit neon_superuser (CREATEDB, CREATEROLE, BYPASSRLS, REPLICATION).
-- This file creates aether_app via SQL CREATE ROLE. Password is NEVER
-- stored here. The schema owner must set it out of band on Neon.
--
-- Do not grant this role to the connecting owner (that would re-open SET ROLE /
-- RESET ROLE). Production DATABASE_URL authenticates as aether_app LOGIN
-- (session_user = current_user). Preview continues to SET ROLE aether_runtime.
-- aether_runtime, aether_app, and the migration owner remain distinct.
--
-- Parser-safe for Neon migration-preparation: no DO blocks, no dollar quoting,
-- and no role-comment statements. That runner splits on raw semicolons and does not track
-- quotes, comments, or dollar tags. PostgreSQL has no CREATE ROLE IF NOT EXISTS
-- (PG 18 / PGLite 0.5.4). Production does not already have aether_app.
-- migrate.mjs and preview apply this file once via _migrations. ALTER ROLE
-- below enforces the required attributes after create.

-- ---------------------------------------------------------------------------
-- Production application role (SQL-created LOGIN)
-- ---------------------------------------------------------------------------
create role aether_app
  login
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls
  inherit;

-- CONNECT on the preview database (postgres) and the Neon database (neondb).
-- Static identifiers keep this parser-safe. Do not look up the session database name.
grant connect on database postgres to aether_app;
grant connect on database neondb to aether_app;

-- ---------------------------------------------------------------------------
-- Schema / PUBLIC — mirror 0011 runtime DML, for aether_app only.
-- Default privileges are FOR the migration/schema owner, not FOR aether_app.
-- ---------------------------------------------------------------------------
revoke create on schema public from aether_app;
grant usage on schema public to aether_app;

-- Owner-owned objects that 0014 must be able to GRANT/REVOKE even when 0013
-- has not been applied (Neon production) and even if the migrator ledger was
-- not pre-created (some local test openers).
create table if not exists _migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists public_booking_attempts (
  id uuid primary key default gen_random_uuid(),
  client_key text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists public_booking_attempts_client_attempted_idx
  on public_booking_attempts (client_key, attempted_at);

revoke all on all tables in schema public from aether_app;
revoke all on all sequences in schema public from aether_app;
revoke all on all functions in schema public from aether_app;

-- DML only. No TRIGGER, TRUNCATE, REFERENCES, or schema CREATE.
grant select, insert, update, delete on all tables in schema public
  to aether_app;
grant usage, select on all sequences in schema public to aether_app;
grant execute on all functions in schema public to aether_app;

-- Owner migrator ledger. Runtime must not SELECT/INSERT/UPDATE/DELETE
-- (or otherwise use) _migrations.
revoke all on table _migrations from aether_app;

-- schema_phase / checkpoint are migration-owned.
revoke insert, update, delete on table aether_meta from aether_app;
grant select on table aether_meta to aether_app;

-- Rate-limit attempts: SELECT, INSERT, DELETE. Not UPDATE.
revoke update on table public_booking_attempts from aether_app;
grant select, insert, delete on table public_booking_attempts to aether_app;

-- 0012 / 0013 objects (equivalent production DML).
grant select, insert, update, delete on table providers to aether_app;
grant select, insert, update, delete on table hotel_provider_agreements to aether_app;
grant select, insert, update, delete on table operator_memberships to aether_app;

-- Future owner-created objects. Grantor is the migrator (current_user).
-- Implicit FOR ROLE current_user. Not FOR aether_app.
alter default privileges in schema public
  grant select, insert, update, delete on tables to aether_app;
alter default privileges in schema public
  grant usage, select on sequences to aether_app;
alter default privileges in schema public
  grant execute on functions to aether_app;

-- ---------------------------------------------------------------------------
-- Record. Occupancy objects and aether_runtime are unchanged.
-- ---------------------------------------------------------------------------
insert into aether_meta (key, value)
values
  ('schema_phase', '13'),
  ('checkpoint', '13a'),
  ('production_role', 'aether_app'),
  ('runtime_login', 'aether_app')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
