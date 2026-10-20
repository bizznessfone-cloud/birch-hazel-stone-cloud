-- Gate 2 R2 Stage 2 — fleet route and operational feasibility. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0065.
-- Does not reserve a vehicle, open checkout, change GiST, admit a payment,
-- or replace the capacity_managed guard. A later reservation writer must
-- still replace that guard in its own migration.
--
-- Missing route and repositioning durations are absent rows. They are not
-- zero minutes. The same endpoint reposition is the only zero, and it is
-- identity, not a stored duration. The desk buffer is 15 minutes and is
-- applied by the feasibility service in addition to repositioning. GiST
-- occupancy remains the overlap constraint; it does not prove a vehicle
-- can make the next pickup.
--
-- Application roles receive SELECT only on these tables. No INSERT, UPDATE,
-- or DELETE. aether_runtime's pre-existing table privileges on vehicles are
-- not widened and are not re-granted here.

alter table public.vehicles
  add column if not exists luggage_capacity integer;

alter table public.vehicles
  drop constraint if exists vehicles_luggage_capacity_check;

alter table public.vehicles
  add constraint vehicles_luggage_capacity_check
  check (luggage_capacity is null or (luggage_capacity >= 0 and luggage_capacity <= 40));

comment on column public.vehicles.luggage_capacity is
  'Known luggage slots. Null is unknown and is not unlimited.';

create table public.sbg_fleet_locations (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete restrict,
  kind text not null,
  hotel_id uuid references public.hotels (id) on delete restrict,
  code text not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint sbg_fleet_locations_kind_check
    check (kind in ('airport', 'hotel')),
  constraint sbg_fleet_locations_hotel_shape_check
    check (
      (kind = 'hotel' and hotel_id is not null)
      or (kind = 'airport' and hotel_id is null)
    ),
  constraint sbg_fleet_locations_code_present
    check (char_length(btrim(code)) > 0),
  constraint sbg_fleet_locations_name_present
    check (char_length(btrim(name)) > 0),
  constraint sbg_fleet_locations_provider_code unique (provider_id, code),
  constraint sbg_fleet_locations_id_provider unique (id, provider_id)
);

create unique index sbg_fleet_locations_provider_hotel_uidx
  on public.sbg_fleet_locations (provider_id, hotel_id)
  where hotel_id is not null;

comment on table public.sbg_fleet_locations is
  'Provider endpoints. Airport rows have no hotel. Hotel rows reference an existing hotel. Not a quote and not a map lookup.';

create table public.sbg_fleet_routes (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null,
  origin_location_id uuid not null,
  destination_location_id uuid not null,
  duration_minutes integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint sbg_fleet_routes_duration_check
    check (duration_minutes > 0 and duration_minutes <= 1440),
  constraint sbg_fleet_routes_distinct_check
    check (origin_location_id <> destination_location_id),
  constraint sbg_fleet_routes_pair unique (origin_location_id, destination_location_id),
  constraint sbg_fleet_routes_origin_fk
    foreign key (origin_location_id, provider_id)
    references public.sbg_fleet_locations (id, provider_id) on delete restrict,
  constraint sbg_fleet_routes_destination_fk
    foreign key (destination_location_id, provider_id)
    references public.sbg_fleet_locations (id, provider_id) on delete restrict
);

comment on table public.sbg_fleet_routes is
  'Directional guest-travel minutes. The opposite direction is a different row. No row means the assignment is infeasible.';

create table public.sbg_fleet_repositions (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null,
  from_location_id uuid not null,
  to_location_id uuid not null,
  duration_minutes integer not null,
  created_at timestamptz not null default now(),
  constraint sbg_fleet_repositions_duration_check
    check (duration_minutes > 0 and duration_minutes <= 1440),
  constraint sbg_fleet_repositions_distinct_check
    check (from_location_id <> to_location_id),
  constraint sbg_fleet_repositions_pair unique (from_location_id, to_location_id),
  constraint sbg_fleet_repositions_from_fk
    foreign key (from_location_id, provider_id)
    references public.sbg_fleet_locations (id, provider_id) on delete restrict,
  constraint sbg_fleet_repositions_to_fk
    foreign key (to_location_id, provider_id)
    references public.sbg_fleet_locations (id, provider_id) on delete restrict
);

comment on table public.sbg_fleet_repositions is
  'Empty-vehicle minutes between different endpoints. Missing is infeasible. Same endpoint is zero and is not stored.';

create table public.sbg_provider_hours (
  provider_id uuid not null references public.providers (id) on delete restrict,
  isodow smallint not null,
  opens_local time not null,
  closes_local time not null,
  constraint sbg_provider_hours_pk primary key (provider_id, isodow),
  constraint sbg_provider_hours_dow_check check (isodow between 1 and 7),
  constraint sbg_provider_hours_span_check check (opens_local <> closes_local)
);

comment on table public.sbg_provider_hours is
  'Civil operating window in the journey hotel timezone. opens > closes is an overnight window that starts on that ISO weekday.';

create table public.sbg_provider_hour_exceptions (
  provider_id uuid not null references public.providers (id) on delete restrict,
  service_date date not null,
  closed boolean not null,
  opens_local time,
  closes_local time,
  constraint sbg_provider_hour_exceptions_pk primary key (provider_id, service_date),
  constraint sbg_provider_hour_exceptions_shape_check check (
    (closed and opens_local is null and closes_local is null)
    or (
      not closed
      and opens_local is not null
      and closes_local is not null
      and opens_local <> closes_local
    )
  )
);

comment on table public.sbg_provider_hour_exceptions is
  'Replaces the window that starts on service_date. Closed removes that start. The previous overnight tail is unchanged.';

create table public.sbg_vehicle_unavailability (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles (id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null,
  constraint sbg_vehicle_unavailability_kind_check
    check (kind in ('maintenance', 'unavailable')),
  constraint sbg_vehicle_unavailability_span_check
    check (ends_at > starts_at)
);

alter table public.sbg_vehicle_unavailability
  add constraint sbg_vehicle_unavailability_excl
  exclude using gist (
    vehicle_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  );

comment on table public.sbg_vehicle_unavailability is
  'Maintenance or other blocks. Overlap with a proposed passenger interval makes that vehicle infeasible.';

create table public.sbg_booking_itinerary (
  booking_id uuid primary key references public.bookings (id) on delete restrict,
  origin_location_id uuid not null references public.sbg_fleet_locations (id) on delete restrict,
  destination_location_id uuid not null references public.sbg_fleet_locations (id) on delete restrict,
  constraint sbg_booking_itinerary_distinct_check
    check (origin_location_id <> destination_location_id)
);

comment on table public.sbg_booking_itinerary is
  'Optional endpoints for an existing commitment. Absence is unknown, not a zero reposition. Legacy bookings stay without a row.';

revoke all on table public.sbg_fleet_locations from public;
revoke all on table public.sbg_fleet_routes from public;
revoke all on table public.sbg_fleet_repositions from public;
revoke all on table public.sbg_provider_hours from public;
revoke all on table public.sbg_provider_hour_exceptions from public;
revoke all on table public.sbg_vehicle_unavailability from public;
revoke all on table public.sbg_booking_itinerary from public;

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke all on table public.sbg_fleet_locations from aether_app';
    execute 'revoke all on table public.sbg_fleet_routes from aether_app';
    execute 'revoke all on table public.sbg_fleet_repositions from aether_app';
    execute 'revoke all on table public.sbg_provider_hours from aether_app';
    execute 'revoke all on table public.sbg_provider_hour_exceptions from aether_app';
    execute 'revoke all on table public.sbg_vehicle_unavailability from aether_app';
    execute 'revoke all on table public.sbg_booking_itinerary from aether_app';
    execute 'grant select on table public.sbg_fleet_locations to aether_app';
    execute 'grant select on table public.sbg_fleet_routes to aether_app';
    execute 'grant select on table public.sbg_fleet_repositions to aether_app';
    execute 'grant select on table public.sbg_provider_hours to aether_app';
    execute 'grant select on table public.sbg_provider_hour_exceptions to aether_app';
    execute 'grant select on table public.sbg_vehicle_unavailability to aether_app';
    execute 'grant select on table public.sbg_booking_itinerary to aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke all on table public.sbg_fleet_locations from aether_runtime';
    execute 'revoke all on table public.sbg_fleet_routes from aether_runtime';
    execute 'revoke all on table public.sbg_fleet_repositions from aether_runtime';
    execute 'revoke all on table public.sbg_provider_hours from aether_runtime';
    execute 'revoke all on table public.sbg_provider_hour_exceptions from aether_runtime';
    execute 'revoke all on table public.sbg_vehicle_unavailability from aether_runtime';
    execute 'revoke all on table public.sbg_booking_itinerary from aether_runtime';
    execute 'grant select on table public.sbg_fleet_locations to aether_runtime';
    execute 'grant select on table public.sbg_fleet_routes to aether_runtime';
    execute 'grant select on table public.sbg_fleet_repositions to aether_runtime';
    execute 'grant select on table public.sbg_provider_hours to aether_runtime';
    execute 'grant select on table public.sbg_provider_hour_exceptions to aether_runtime';
    execute 'grant select on table public.sbg_vehicle_unavailability to aether_runtime';
    execute 'grant select on table public.sbg_booking_itinerary to aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_webhook') then
    execute 'revoke all on table public.sbg_fleet_locations from aether_webhook';
    execute 'revoke all on table public.sbg_fleet_routes from aether_webhook';
    execute 'revoke all on table public.sbg_fleet_repositions from aether_webhook';
    execute 'revoke all on table public.sbg_provider_hours from aether_webhook';
    execute 'revoke all on table public.sbg_provider_hour_exceptions from aether_webhook';
    execute 'revoke all on table public.sbg_vehicle_unavailability from aether_webhook';
    execute 'revoke all on table public.sbg_booking_itinerary from aether_webhook';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_mailer') then
    execute 'revoke all on table public.sbg_fleet_locations from aether_mailer';
    execute 'revoke all on table public.sbg_fleet_routes from aether_mailer';
    execute 'revoke all on table public.sbg_fleet_repositions from aether_mailer';
    execute 'revoke all on table public.sbg_provider_hours from aether_mailer';
    execute 'revoke all on table public.sbg_provider_hour_exceptions from aether_mailer';
    execute 'revoke all on table public.sbg_vehicle_unavailability from aether_mailer';
    execute 'revoke all on table public.sbg_booking_itinerary from aether_mailer';
  end if;
end
$priv$;
