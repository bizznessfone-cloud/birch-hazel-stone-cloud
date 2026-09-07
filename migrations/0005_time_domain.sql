-- Aether Transfer — Phase 3 time domain helpers
-- Does NOT replace aether_athens_instant() or the occupies trigger.
-- Adds Europe/Athens business-date functions for dashboard "Today".
-- Occupies remains trigger-maintained tstzrange [).

create or replace function aether_athens_date(p_instant timestamptz)
returns date
language sql
stable
as $aether$
  select (p_instant at time zone 'Europe/Athens')::date;
$aether$;

comment on function aether_athens_date(timestamptz) is
  'Absolute instant to Europe/Athens civil date. Session TimeZone is irrelevant.';

create or replace function aether_athens_today()
returns date
language sql
stable
as $aether$
  select (now() at time zone 'Europe/Athens')::date;
$aether$;

comment on function aether_athens_today() is
  'Current Europe/Athens business date. Dashboard Today uses this, not the browser.';

insert into aether_meta (key, value)
values
  ('schema_phase', '3'),
  ('checkpoint', '3')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
