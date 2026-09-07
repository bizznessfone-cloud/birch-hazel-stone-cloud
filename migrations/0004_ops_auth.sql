-- Aether Transfer — Phase 2 operator authentication
-- Adds session CSRF binding and login-attempt throttle storage.
-- No credentials are seeded. Do not put passwords in SQL.
--
-- Implementation decisions (NOT recovered historical fact):
--   login identifier     operators.login (username, stored lowercase)
--   session TTL          12 hours
--   CSRF                 double-submit cookie + header, hashed on sessions.csrf_hash
--   throttle             login_attempts; 5 failures / 15 minutes / login_key

alter table sessions
  add column if not exists csrf_hash text not null default '';

create table if not exists login_attempts (
  id uuid primary key default gen_random_uuid(),
  login_key text not null,
  succeeded boolean not null default false,
  attempted_at timestamptz not null default now()
);

create index if not exists login_attempts_login_key_at
  on login_attempts (login_key, attempted_at desc);

insert into aether_meta (key, value)
values
  ('schema_phase', '2'),
  ('checkpoint', '2')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
