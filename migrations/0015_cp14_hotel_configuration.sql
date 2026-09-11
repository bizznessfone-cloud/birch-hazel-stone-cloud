-- Aether Transfer — CP14.1 hotel configuration schema
-- Locality, IANA timezone, currency, lifecycle, per-hotel destinations,
-- booking destination FK (same hotel), quoted price snapshot + immutability.
-- Does NOT rewrite aether_athens_instant(), bookings_occupies_before,
-- occupies, GiST EXCLUDE, or civil-time conversion. Timezone authority
-- stays Athens until a later CP14 child step.

-- ---------------------------------------------------------------------------
-- hotels: one hotel = one operational location
-- ---------------------------------------------------------------------------
alter table hotels
  add column if not exists locality text,
  add column if not exists iana_timezone text,
  add column if not exists currency character(3),
  add column if not exists status text;

-- Existing demo rows stay unconfigured. Locality placeholder = current name.
update hotels
set
  locality = coalesce(nullif(btrim(locality), ''), btrim(name), 'unspecified'),
  iana_timezone = coalesce(nullif(btrim(iana_timezone), ''), 'Europe/Athens'),
  currency = coalesce(currency, 'EUR'),
  status = coalesce(status, 'unconfigured');

alter table hotels
  alter column locality set default 'unspecified',
  alter column iana_timezone set default 'Europe/Athens',
  alter column currency set default 'EUR',
  alter column status set default 'unconfigured';

alter table hotels
  alter column locality set not null,
  alter column iana_timezone set not null,
  alter column currency set not null,
  alter column status set not null;

alter table hotels drop constraint if exists hotels_locality_present;
alter table hotels
  add constraint hotels_locality_present
  check (char_length(btrim(locality)) > 0);

alter table hotels drop constraint if exists hotels_timezone_present;
alter table hotels
  add constraint hotels_timezone_present
  check (char_length(btrim(iana_timezone)) > 0);

-- ISO-4217 shape only (three uppercase letters). No full currency catalog.
alter table hotels drop constraint if exists hotels_currency_format;
alter table hotels
  add constraint hotels_currency_format
  check (currency::text ~ '^[A-Z]{3}$');

alter table hotels drop constraint if exists hotels_status_check;
alter table hotels
  add constraint hotels_status_check
  check (status in ('unconfigured', 'configured', 'live'));

-- ---------------------------------------------------------------------------
-- hotel_destinations: hotel-scoped catalogue (not a global marketplace)
-- ---------------------------------------------------------------------------
create table if not exists hotel_destinations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete restrict,
  kind text not null,
  name text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  amount_minor integer not null,
  created_at timestamptz not null default now(),
  constraint hotel_destinations_kind_check
    check (kind in ('airport', 'port', 'hotel', 'other')),
  constraint hotel_destinations_name_present
    check (char_length(btrim(name)) > 0),
  constraint hotel_destinations_amount_nonnegative
    check (amount_minor >= 0),
  constraint hotel_destinations_id_hotel_key unique (id, hotel_id)
);

create unique index if not exists hotel_destinations_hotel_kind_name_uidx
  on hotel_destinations (hotel_id, kind, lower(btrim(name)));

create index if not exists hotel_destinations_hotel_sort_idx
  on hotel_destinations (hotel_id, sort_order, name);

-- ---------------------------------------------------------------------------
-- bookings: destination must belong to the same hotel; quoted snapshot
-- ---------------------------------------------------------------------------
alter table bookings
  add column if not exists destination_id uuid,
  add column if not exists quoted_amount_minor integer,
  add column if not exists quoted_currency character(3);

alter table bookings drop constraint if exists bookings_destination_hotel_fk;
alter table bookings
  add constraint bookings_destination_hotel_fk
  foreign key (destination_id, hotel_id)
  references hotel_destinations (id, hotel_id)
  on delete restrict;

alter table bookings drop constraint if exists bookings_quoted_amount_nonnegative;
alter table bookings
  add constraint bookings_quoted_amount_nonnegative
  check (quoted_amount_minor is null or quoted_amount_minor >= 0);

alter table bookings drop constraint if exists bookings_quoted_currency_format;
alter table bookings
  add constraint bookings_quoted_currency_format
  check (quoted_currency is null or quoted_currency::text ~ '^[A-Z]{3}$');

alter table bookings drop constraint if exists bookings_quoted_pair;
alter table bookings
  add constraint bookings_quoted_pair
  check (
    (quoted_amount_minor is null and quoted_currency is null)
    or
    (quoted_amount_minor is not null and quoted_currency is not null)
  );

create index if not exists bookings_destination_id_idx
  on bookings (destination_id)
  where destination_id is not null;

-- pickup_text / destination_text remain guest-facing snapshots. Unchanged.

-- ---------------------------------------------------------------------------
-- Quoted fields are immutable after insert. Occupancy / assignment / cancel
-- still UPDATE other columns. Does not write occupies.
-- ---------------------------------------------------------------------------
create or replace function aether_bookings_quote_immutable_tg()
returns trigger
language plpgsql
as $aether$
begin
  if new.destination_id is distinct from old.destination_id
     or new.quoted_amount_minor is distinct from old.quoted_amount_minor
     or new.quoted_currency is distinct from old.quoted_currency then
    raise exception 'quoted booking fields are immutable'
      using errcode = '27000';
  end if;
  return new;
end;
$aether$;

drop trigger if exists bookings_quote_immutable on bookings;
create trigger bookings_quote_immutable
  before update on bookings
  for each row
  execute function aether_bookings_quote_immutable_tg();

-- ---------------------------------------------------------------------------
-- Runtime DML — mirror CP13A (aether_app) and CP11 (aether_runtime).
-- Do not grant _migrations. Do not grant TRIGGER/TRUNCATE/REFERENCES.
-- ---------------------------------------------------------------------------
do $aether$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'grant select, insert, update, delete on table hotel_destinations to aether_runtime';
    execute 'grant execute on function aether_bookings_quote_immutable_tg() to aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'grant select, insert, update, delete on table hotel_destinations to aether_app';
    execute 'grant execute on function aether_bookings_quote_immutable_tg() to aether_app';
  end if;
end
$aether$;

insert into aether_meta (key, value)
values
  ('schema_phase', '14'),
  ('checkpoint', '14.1')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
