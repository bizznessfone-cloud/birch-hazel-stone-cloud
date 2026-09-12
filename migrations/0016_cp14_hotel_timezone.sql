-- Aether Transfer — CP14.4 hotel IANA timezone conversion
-- Parameterised civil-time → timestamptz. Occupies trigger reads
-- hotels.iana_timezone. Does NOT edit 0003–0015 files. Does NOT drop
-- aether_athens_instant, bookings_occupies_before, occupies, or GiST EXCLUDE.
-- Does NOT convert on read. Does NOT backfill historical occupies.

-- ---------------------------------------------------------------------------
-- Canonical conversion: same algorithm as aether_athens_instant, zone in p_tz.
-- SECURITY INVOKER, STABLE, explicit null handling (not STRICT).
-- Session TimeZone is irrelevant. Process TZ is irrelevant.
-- No fallback to Europe/Athens.
-- ---------------------------------------------------------------------------
create or replace function aether_civil_instant(
  p_date date,
  p_time time,
  p_tz text
)
returns timestamptz
language plpgsql
stable
as $aether$
declare
  tz text;
  civil timestamp;
  instant timestamptz;
  roundtrip timestamp;
begin
  if p_date is null or p_time is null then
    raise exception using
      errcode = '22007',
      message = 'civil time required';
  end if;

  tz := btrim(p_tz);
  if tz is null or tz = '' then
    raise exception using
      errcode = '22023',
      message = 'time zone is invalid';
  end if;

  -- Reject before date+time: PostgreSQL turns time 24:00 into next midnight.
  if p_time = time '24:00:00' then
    raise exception using
      errcode = '22008',
      message = '24:00 is not a valid time';
  end if;

  civil := p_date + p_time;

  begin
    instant := civil at time zone tz;
  exception
    when others then
      raise exception using
        errcode = '22023',
        message = 'time zone is invalid';
  end;

  begin
    roundtrip := instant at time zone tz;
  exception
    when others then
      raise exception using
        errcode = '22023',
        message = 'time zone is invalid';
  end;

  if roundtrip <> civil then
    raise exception using
      errcode = '22008',
      message = 'time does not exist';
  end if;

  -- Fold: another UTC instant one hour earlier maps to the same civil time.
  if (instant - interval '1 hour') at time zone tz = civil then
    raise exception using
      errcode = '22008',
      message = 'time is ambiguous';
  end if;

  return instant;
end;
$aether$;

comment on function aether_civil_instant(date, time, text) is
  'Hotel IANA civil date+time to absolute timestamptz. Rejects DST gap, DST fold, 24:00, invalid zone. No Athens fallback.';

-- Backwards-compatible Athens entry. Same semantics as 0003.
create or replace function aether_athens_instant(p_date date, p_time time)
returns timestamptz
language plpgsql
stable
as $aether$
begin
  return aether_civil_instant(p_date, p_time, 'Europe/Athens');
end;
$aether$;

comment on function aether_athens_instant(date, time) is
  'Athens civil date+time to absolute timestamptz. Delegates to aether_civil_instant(..., Europe/Athens).';

-- ---------------------------------------------------------------------------
-- Occupies trigger: hotel timezone from NEW.hotel_id. Application occupies
-- values remain discarded. Cancelled bookings stay empty. Does not DROP the
-- trigger object; CREATE OR REPLACE updates the existing function body.
-- ---------------------------------------------------------------------------
create or replace function aether_bookings_occupies_tg()
returns trigger
language plpgsql
as $aether$
declare
  instant timestamptz;
  tz text;
begin
  if new.cancelled_at is not null then
    new.occupies := 'empty'::tstzrange;
    return new;
  end if;

  select btrim(iana_timezone) into tz
    from hotels
   where id = new.hotel_id;

  if tz is null or tz = '' then
    raise exception using
      errcode = '22023',
      message = 'hotel timezone is invalid';
  end if;

  instant := aether_civil_instant(new.transfer_date, new.pickup_time, tz);
  new.occupies := tstzrange(
    instant,
    instant + make_interval(mins => new.duration_minutes),
    '[)'
  );
  return new;
end;
$aether$;

-- ---------------------------------------------------------------------------
-- Runtime EXECUTE — mirror CP11 (aether_runtime) and CP13A (aether_app).
-- Do not grant _migrations. Do not grant TRIGGER/TRUNCATE/REFERENCES.
-- ---------------------------------------------------------------------------
do $aether$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'grant execute on function aether_civil_instant(date, time, text) to aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'grant execute on function aether_civil_instant(date, time, text) to aether_app';
  end if;
end
$aether$;

insert into aether_meta (key, value)
values
  ('schema_phase', '14'),
  ('checkpoint', '14.4')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
