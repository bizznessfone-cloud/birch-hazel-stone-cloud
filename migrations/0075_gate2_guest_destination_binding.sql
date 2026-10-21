-- Gate 2 Stage 6B — guest catalogue to fleet endpoint binding. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0074.
-- Does not open checkout, create a payment, or schedule expiry.
--
-- hotel_destinations.id is a priced catalogue row. sbg_fleet_locations.id is
-- an operational endpoint. They are not the same identifier, and the display
-- name is not an authority. This table is the only join. The hotel door is
-- the single active hotel location for the agreement's provider and hotel.
-- Direction chooses which end is the origin. A provider id here is an
-- ownership key. A guest cannot supply one.

create table public.sbg_guest_destination_bindings (
  hotel_destination_id uuid not null,
  hotel_id uuid not null,
  provider_id uuid not null,
  fleet_location_id uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint sbg_guest_destination_bindings_pk
    primary key (hotel_destination_id, provider_id),
  constraint sbg_guest_destination_bindings_destination_fk
    foreign key (hotel_destination_id, hotel_id)
    references public.hotel_destinations (id, hotel_id)
    on delete restrict,
  constraint sbg_guest_destination_bindings_location_fk
    foreign key (fleet_location_id, provider_id)
    references public.sbg_fleet_locations (id, provider_id)
    on delete restrict
);

comment on table public.sbg_guest_destination_bindings is
  'Binds one hotel catalogue destination to one provider fleet endpoint. Not a name match. The hotel door is resolved separately. Direction is not stored here.';

revoke all on table public.sbg_guest_destination_bindings from public;

do $priv$
declare
  v_role text;
begin
  foreach v_role in array ARRAY[
    'aether_app', 'aether_runtime', 'aether_webhook', 'aether_mailer',
    'aether_payment_gateway', 'aether_expiry', 'aether_expiry_runner',
    'sbg_capacity_writer', 'sbg_fleet_writer'
  ]
  loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format(
        'revoke insert, update, delete on table public.sbg_guest_destination_bindings from %I',
        v_role
      );
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'grant select on table public.sbg_guest_destination_bindings to aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'grant select on table public.sbg_guest_destination_bindings to aether_runtime';
  end if;
end
$priv$;
