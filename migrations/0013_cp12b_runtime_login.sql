-- Aether Transfer — CP12B pre-Vercel production hardening
-- Privilege identity only. Does NOT rewrite aether_athens_instant(),
-- bookings_occupies_before, occupies maintenance, or GiST EXCLUDE.
--
-- 0011 created aether_runtime NOLOGIN for SET ROLE. Production DATABASE_URL
-- must authenticate as aether_runtime itself (session_user = current_user).
-- This file enables LOGIN. The password is NEVER stored here; the schema
-- owner must set it out of band on Neon.
--
-- Preview PGLite continues to SET ROLE after migrations. Neon application
-- pools must NOT send options=-c role=aether_runtime.

do $aether$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute $sql$
      alter role aether_runtime
        login
        nosuperuser
        nocreatedb
        nocreaterole
        nobypassrls
    $sql$;
  end if;
end
$aether$;

comment on role aether_runtime is
  'Aether Transfer application DML LOGIN. Must not own occupancy objects. Password is set out of band; never in migrations.';

-- Durable guest-create limiter. No Redis. Runtime DML only.
create table if not exists public_booking_attempts (
  id uuid primary key default gen_random_uuid(),
  client_key text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists public_booking_attempts_client_attempted_idx
  on public_booking_attempts (client_key, attempted_at);

comment on table public_booking_attempts is
  'Hashed public booking-create attempts. Fail-open if unavailable. Not a tenant isolation mechanism.';

do $aether$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'grant select, insert, delete on table public_booking_attempts to aether_runtime';
  end if;
end
$aether$;

insert into aether_meta (key, value)
values
  ('schema_phase', '12'),
  ('checkpoint', '12b'),
  ('runtime_login', 'aether_runtime')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
