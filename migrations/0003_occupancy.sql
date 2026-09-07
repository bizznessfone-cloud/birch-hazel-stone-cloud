-- Aether Transfer — Phase 1 occupancy engine
-- Canonical schema + aether_athens_instant() + trigger-maintained occupies
-- + partial GiST EXCLUDE. Do not seed fake bookings.
--
-- Implementation decisions (NOT recovered historical fact):
--   PK type            uuid (gen_random_uuid)
--   cancellation       cancelled_at timestamptz; occupancy ignores status
--   status             operational label, default 'new'
--   default duration   none; CHECK 1..1440
--   idempotency        table idempotency_keys (scope, key)
--   optional v/d fields omitted
--   trigger SQL        this file; Blueprint exact SQL is UNKNOWN

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Civil time: Europe/Athens → absolute timestamptz
-- Session TimeZone is irrelevant. Browser TZ is irrelevant.
-- Rejects: 24:00, DST spring gap (time does not exist), DST autumn fold
-- (time is ambiguous).
-- ---------------------------------------------------------------------------
create or replace function aether_athens_instant(p_date date, p_time time)
returns timestamptz
language plpgsql
stable
as $aether$
declare
  civil timestamp;
  instant timestamptz;
  roundtrip timestamp;
begin
  if p_date is null or p_time is null then
    raise exception using
      errcode = '22007',
      message = 'civil time required';
  end if;

  -- Reject before date+time: PostgreSQL turns time 24:00 into next midnight.
  if p_time = time '24:00:00' then
    raise exception using
      errcode = '22008',
      message = '24:00 is not a valid time';
  end if;

  civil := p_date + p_time;
  -- Interpret naive civil timestamp as Europe/Athens, never session TZ.
  instant := civil at time zone 'Europe/Athens';
  roundtrip := instant at time zone 'Europe/Athens';

  if roundtrip <> civil then
    raise exception using
      errcode = '22008',
      message = 'time does not exist';
  end if;

  -- Fold: another UTC instant one hour earlier maps to the same civil time.
  if (instant - interval '1 hour') at time zone 'Europe/Athens' = civil then
    raise exception using
      errcode = '22008',
      message = 'time is ambiguous';
  end if;

  return instant;
end;
$aether$;

comment on function aether_athens_instant(date, time) is
  'Athens civil date+time to absolute timestamptz. Rejects DST gap, DST fold, 24:00.';

-- ---------------------------------------------------------------------------
-- Domain tables
-- ---------------------------------------------------------------------------
create table if not exists hotels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists operators (
  id uuid primary key default gen_random_uuid(),
  login text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id),
  transfer_date date not null,
  pickup_time time not null,
  duration_minutes integer not null,
  occupies tstzrange not null default 'empty'::tstzrange,
  vehicle_id uuid references vehicles (id),
  driver_id uuid references drivers (id),
  cancelled_at timestamptz,
  status text not null default 'new',
  guest_name text not null,
  guest_phone text not null,
  guest_email text not null,
  passenger_count integer not null default 1,
  luggage_count integer not null default 0,
  pickup_text text not null,
  destination_text text not null,
  special_requirements text,
  internal_notes text,
  human_reference text not null unique,
  confirmation_token text not null unique,
  created_at timestamptz not null default now(),
  constraint bookings_duration_minutes_check
    check (duration_minutes > 0 and duration_minutes <= 1440),
  constraint bookings_pickup_time_not_24
    check (pickup_time <> time '24:00:00')
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_type text not null,
  actor_id uuid,
  action text not null,
  booking_id uuid references bookings (id),
  payload jsonb not null default '{}'::jsonb
);

create table if not exists idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  key text not null,
  request_hash text not null,
  booking_id uuid references bookings (id),
  created_at timestamptz not null default now(),
  unique (scope, key)
);

-- ---------------------------------------------------------------------------
-- occupies is written ONLY by this trigger. Application values are discarded.
-- Cancelled bookings get an empty range (releases vehicle and driver).
-- ---------------------------------------------------------------------------
create or replace function aether_bookings_occupies_tg()
returns trigger
language plpgsql
as $aether$
declare
  instant timestamptz;
begin
  if new.cancelled_at is not null then
    new.occupies := 'empty'::tstzrange;
    return new;
  end if;

  instant := aether_athens_instant(new.transfer_date, new.pickup_time);
  new.occupies := tstzrange(
    instant,
    instant + make_interval(mins => new.duration_minutes),
    '[)'
  );
  return new;
end;
$aether$;

drop trigger if exists bookings_occupies_before on bookings;
create trigger bookings_occupies_before
  before insert or update on bookings
  for each row
  execute function aether_bookings_occupies_tg();

-- Vehicle and driver occupancy are independent partial GiST EXCLUDE.
-- [) adjacency is allowed; any overlap raises 23P01.
alter table bookings
  add constraint bookings_vehicle_occupancy_excl
  exclude using gist (
    vehicle_id with =,
    occupies with &&
  )
  where (vehicle_id is not null and cancelled_at is null and not isempty(occupies));

alter table bookings
  add constraint bookings_driver_occupancy_excl
  exclude using gist (
    driver_id with =,
    occupies with &&
  )
  where (driver_id is not null and cancelled_at is null and not isempty(occupies));

insert into aether_meta (key, value)
values
  ('schema_phase', '1'),
  ('checkpoint', '1')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
