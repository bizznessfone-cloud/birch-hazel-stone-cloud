-- Aether Transfer — Phase 0 foundation
-- Proves migrations apply on PGLite (preview) and PostgreSQL/Neon (deploy).
-- Domain tables, occupancy trigger, and GiST EXCLUDE constraints are Phase 1.
-- Do not seed fake bookings.

create table if not exists aether_meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into aether_meta (key, value)
values
  ('product', 'Aether Transfer'),
  ('schema_phase', '0'),
  ('checkpoint', '0'),
  ('blueprint', 'v2')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
