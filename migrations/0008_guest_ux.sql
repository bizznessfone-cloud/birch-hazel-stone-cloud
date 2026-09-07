-- Aether Transfer — Phase 6 guest UX
-- Seeds one hotel so the hotel-scoped guest URL works in preview.
-- Does not seed bookings. Does not change occupancy or assignment.

insert into hotels (code, name)
select 'gate', 'Gate Hotel'
where not exists (select 1 from hotels where lower(code) = 'gate');

insert into aether_meta (key, value)
values
  ('schema_phase', '6'),
  ('checkpoint', '6')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
