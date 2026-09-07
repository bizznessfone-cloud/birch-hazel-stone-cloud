-- Aether Transfer — Phase 7 operations desk
-- Adds vehicle capacity for the management screen.
-- Does not change occupies, EXCLUDE, or public booking.

alter table vehicles
  add column if not exists capacity integer not null default 4;

alter table vehicles
  drop constraint if exists vehicles_capacity_check;

alter table vehicles
  add constraint vehicles_capacity_check
  check (capacity > 0 and capacity <= 20);

insert into vehicles (name, capacity, active)
select 'Van 1', 7, true
where not exists (select 1 from vehicles);

insert into vehicles (name, capacity, active)
select 'Saloon 1', 3, true
where (select count(*) from vehicles) < 2;

insert into drivers (name, active)
select 'Driver 1', true
where not exists (select 1 from drivers);

insert into drivers (name, active)
select 'Driver 2', true
where (select count(*) from drivers) < 2;

insert into aether_meta (key, value)
values
  ('schema_phase', '7'),
  ('checkpoint', '7')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
