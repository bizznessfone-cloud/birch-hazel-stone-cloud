-- Aether Transfer — Phase 8 hotel white label
-- Identity = name + unique code + generated HotelMark (application, not a column).
-- QR-ready guest URL is /book/{code}. Attribution only: no RLS, colour, logo, or skins.
-- Does not change occupies, EXCLUDE, aether_athens_instant, or operator auth.

update hotels
set code = lower(trim(code))
where code is distinct from lower(trim(code));

alter table hotels drop constraint if exists hotels_code_format;

alter table hotels
  add constraint hotels_code_format
  check (
    code ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'
    and char_length(code) between 2 and 32
  );

alter table hotels drop constraint if exists hotels_name_present;

alter table hotels
  add constraint hotels_name_present
  check (char_length(btrim(name)) > 0);

insert into hotels (code, name)
select 'harbor', 'Harbor Hotel'
where not exists (select 1 from hotels where lower(code) = 'harbor');

insert into aether_meta (key, value)
values
  ('schema_phase', '8'),
  ('checkpoint', '8')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
