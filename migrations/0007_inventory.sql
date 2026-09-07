-- Aether Transfer — Phase 5 inventory assignment
-- Does NOT replace occupies trigger, EXCLUDE, or aether_athens_instant().
-- Adds an active flag so unusable vehicles/drivers can be rejected.
--
-- Implementation decisions (NOT recovered historical fact):
--   usable resource     vehicles.active / drivers.active, default true
--   status              free-form operational label; no state machine
--   assignment          independent vehicle and driver mutations

alter table vehicles
  add column if not exists active boolean not null default true;

alter table drivers
  add column if not exists active boolean not null default true;

insert into aether_meta (key, value)
values
  ('schema_phase', '5'),
  ('checkpoint', '5')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
