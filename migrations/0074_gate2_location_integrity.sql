-- Gate 2 Stage 5E — fleet location integrity. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0073.
-- Does not open checkout, admit a payment, or rewrite a booking.
--
-- Reuses sbg_fleet_writer. Does not create another operational role and does
-- not grant that role capacity, payment, webhook, or expiry authority.
-- Application roles stay SELECT-only on sbg_fleet_locations. They may
-- execute the writers below. There is no DELETE writer and no DELETE grant.
-- A caller-supplied provider id is only an ownership key. It is not
-- authentication. There is no location editor; a future caller must pass
-- the provider already bound to the authenticated operator session.
--
-- Location ids, codes, kinds, hotels, and providers are immutable here.
-- Rename changes the display name only. It does not change a booking's
-- route identity, origin, destination, or stored itinerary. Kind stays
-- airport or hotel. This file does not add a location taxonomy.
--
-- Deactivation is rejected when a capacity-managed, not-cancelled, still
-- assigned booking has a frozen itinerary that uses the location. That set
-- is open holds, payment_processing, and confirmed_paid, because those
-- rows keep a vehicle. A legacy assignment with no itinerary is not a
-- reference and is not rewritten. Route and reposition rows are not
-- deleted and are not themselves protection. Assess already returns
-- not_found for an inactive endpoint before it reads the route.
--
-- Lock order matches Stage 3. Vehicles currently operated by the provider
-- are locked in ascending uuid order through sbg_capacity_lock_vehicle
-- (pg_advisory_xact_lock(hashtextextended(vehicle_id::text, 20260302))).
-- The location row is then locked exclusively, then sbg_capacity_lock_scope,
-- then those vehicles' bookings FOR SHARE. No second advisory key. No
-- payment lock. Rename and deactivation wait at most 2s.
-- lock_not_available, deadlock, and a drifted operated-by set return
-- rejected/lock_busy and write nothing. Insert does not take that lock:
-- the new id cannot yet be on an itinerary. Guest sbg_reserve_capacity is
-- not modified and still waits.
--
-- Owner UPDATE of vehicles.operated_by_provider_id or owned_by_provider_id
-- does not take the Stage 3 lock. This file locks only the operated-by set
-- observed at lock time and writes nothing if that set changes before the
-- location write. That hole is not closed. Direct owner UPDATE of a
-- location, including active, code, or provider_id, also remains outside
-- the protocol.

grant sbg_fleet_writer to current_user;

grant insert (
  provider_id,
  kind,
  hotel_id,
  code,
  name
), update (
  name,
  active
) on table public.sbg_fleet_locations to sbg_fleet_writer;

create or replace function public.sbg_fleet_lock_location(p_location_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $lock_location$
begin
  if p_location_id is null then
    return;
  end if;
  perform 1
    from public.sbg_fleet_locations l
   where l.id = p_location_id
   for update;
end;
$lock_location$;

revoke all on function public.sbg_fleet_lock_location(uuid) from public;
grant execute on function public.sbg_fleet_lock_location(uuid) to sbg_fleet_writer;

create or replace function public.sbg_fleet_insert_location(
  p_provider_id uuid,
  p_kind text,
  p_hotel_id uuid,
  p_code text,
  p_name text
) returns table (
  fleet_outcome text,
  fleet_rejection text,
  fleet_location_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $insert_location$
declare
  v_code text;
  v_name text;
  v_id uuid;
begin
  fleet_location_id := null;
  if p_provider_id is null or p_kind is null or p_code is null or p_name is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    return next;
    return;
  end if;
  v_code := pg_catalog.btrim(p_code);
  v_name := pg_catalog.btrim(p_name);
  if v_code = ''
     or v_name = ''
     or p_kind not in ('airport', 'hotel')
     or (p_kind = 'airport' and p_hotel_id is not null)
     or (p_kind = 'hotel' and p_hotel_id is null) then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_location';
    return next;
    return;
  end if;
  if not exists (select 1 from public.providers p where p.id = p_provider_id) then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;
  if p_kind = 'hotel' and not exists (
    select 1 from public.hotels h where h.id = p_hotel_id
  ) then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;

  insert into public.sbg_fleet_locations (
    provider_id, kind, hotel_id, code, name
  ) values (
    p_provider_id, p_kind, p_hotel_id, v_code, v_name
  )
  returning id into v_id;
  fleet_outcome := 'inserted';
  fleet_rejection := null;
  fleet_location_id := v_id;
  return next;
exception
  when unique_violation then
    fleet_outcome := 'duplicate';
    fleet_rejection := 'duplicate';
    fleet_location_id := null;
    return next;
  when check_violation or foreign_key_violation then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_location';
    fleet_location_id := null;
    return next;
end;
$insert_location$;

create or replace function public.sbg_fleet_rename_location(
  p_provider_id uuid,
  p_location_id uuid,
  p_name text
) returns table (
  fleet_outcome text,
  fleet_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $rename_location$
declare
  v_ids uuid[];
  v_after uuid[];
  v_vehicle uuid;
  v_name text;
  v_provider uuid;
  v_current text;
begin
  if p_provider_id is null or p_location_id is null or p_name is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    return next;
    return;
  end if;
  v_name := pg_catalog.btrim(p_name);
  if v_name = '' then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_location';
    return next;
    return;
  end if;
  select l.provider_id
    into v_provider
    from public.sbg_fleet_locations l
   where l.id = p_location_id;
  if v_provider is null or v_provider is distinct from p_provider_id then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;

  set local lock_timeout = '2s';
  v_ids := public.sbg_fleet_lock_provider_vehicles(p_provider_id);
  perform public.sbg_fleet_lock_location(p_location_id);
  perform public.sbg_capacity_lock_scope(p_provider_id, v_ids, array[p_location_id]);
  foreach v_vehicle in array v_ids loop
    perform public.sbg_fleet_lock_assignments(v_vehicle);
  end loop;
  select coalesce(pg_catalog.array_agg(v.id order by v.id), array[]::uuid[])
    into v_after
    from public.vehicles v
   where v.operated_by_provider_id = p_provider_id;
  if v_after is distinct from v_ids then
    raise exception 'capacity_lock_retry' using errcode = '40001';
  end if;

  select l.provider_id, l.name
    into v_provider, v_current
    from public.sbg_fleet_locations l
   where l.id = p_location_id
   for update;
  if v_provider is null or v_provider is distinct from p_provider_id then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;
  if v_current = v_name then
    fleet_outcome := 'unchanged';
    fleet_rejection := null;
    return next;
    return;
  end if;
  update public.sbg_fleet_locations
     set name = v_name
   where id = p_location_id
     and provider_id = p_provider_id;
  fleet_outcome := 'updated';
  fleet_rejection := null;
  return next;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    fleet_outcome := 'rejected';
    fleet_rejection := 'lock_busy';
    return next;
end;
$rename_location$;

create or replace function public.sbg_fleet_deactivate_location(
  p_provider_id uuid,
  p_location_id uuid
) returns table (
  fleet_outcome text,
  fleet_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $deactivate_location$
declare
  v_ids uuid[];
  v_after uuid[];
  v_vehicle uuid;
  v_provider uuid;
  v_active boolean;
begin
  if p_provider_id is null or p_location_id is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    return next;
    return;
  end if;
  select l.provider_id
    into v_provider
    from public.sbg_fleet_locations l
   where l.id = p_location_id;
  if v_provider is null or v_provider is distinct from p_provider_id then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;

  set local lock_timeout = '2s';
  v_ids := public.sbg_fleet_lock_provider_vehicles(p_provider_id);
  perform public.sbg_fleet_lock_location(p_location_id);
  perform public.sbg_capacity_lock_scope(p_provider_id, v_ids, array[p_location_id]);
  foreach v_vehicle in array v_ids loop
    perform public.sbg_fleet_lock_assignments(v_vehicle);
  end loop;
  select coalesce(pg_catalog.array_agg(v.id order by v.id), array[]::uuid[])
    into v_after
    from public.vehicles v
   where v.operated_by_provider_id = p_provider_id;
  if v_after is distinct from v_ids then
    raise exception 'capacity_lock_retry' using errcode = '40001';
  end if;

  select l.provider_id, l.active
    into v_provider, v_active
    from public.sbg_fleet_locations l
   where l.id = p_location_id
   for update;
  if v_provider is null or v_provider is distinct from p_provider_id then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;
  if v_active is not true then
    fleet_outcome := 'unchanged';
    fleet_rejection := null;
    return next;
    return;
  end if;
  if exists (
    select 1
      from public.sbg_booking_itinerary i
      join public.bookings b on b.id = i.booking_id
     where (i.origin_location_id = p_location_id or i.destination_location_id = p_location_id)
       and b.cancelled_at is null
       and b.capacity_managed
       and b.vehicle_id is not null
  ) then
    fleet_outcome := 'rejected';
    fleet_rejection := 'location_in_use';
    return next;
    return;
  end if;
  update public.sbg_fleet_locations
     set active = false
   where id = p_location_id
     and provider_id = p_provider_id
     and active;
  fleet_outcome := 'updated';
  fleet_rejection := null;
  return next;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    fleet_outcome := 'rejected';
    fleet_rejection := 'lock_busy';
    return next;
end;
$deactivate_location$;

revoke all on function public.sbg_fleet_insert_location(uuid, text, uuid, text, text) from public;
revoke all on function public.sbg_fleet_rename_location(uuid, uuid, text) from public;
revoke all on function public.sbg_fleet_deactivate_location(uuid, uuid) from public;

alter function public.sbg_fleet_insert_location(uuid, text, uuid, text, text) owner to sbg_fleet_writer;
alter function public.sbg_fleet_rename_location(uuid, uuid, text) owner to sbg_fleet_writer;
alter function public.sbg_fleet_deactivate_location(uuid, uuid) owner to sbg_fleet_writer;

do $priv$
declare
  v_role text;
begin
  foreach v_role in array ARRAY[
    'aether_app', 'aether_runtime', 'aether_webhook', 'aether_mailer',
    'aether_payment_gateway', 'aether_expiry', 'aether_expiry_runner', 'sbg_capacity_writer'
  ]
  loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke insert, update, delete on table public.sbg_fleet_locations from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_lock_location(uuid) from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_insert_location(uuid, text, uuid, text, text) from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_rename_location(uuid, uuid, text) from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_deactivate_location(uuid, uuid) from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'grant execute on function public.sbg_fleet_insert_location(uuid, text, uuid, text, text) to aether_app';
    execute 'grant execute on function public.sbg_fleet_rename_location(uuid, uuid, text) to aether_app';
    execute 'grant execute on function public.sbg_fleet_deactivate_location(uuid, uuid) to aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'grant execute on function public.sbg_fleet_insert_location(uuid, text, uuid, text, text) to aether_runtime';
    execute 'grant execute on function public.sbg_fleet_rename_location(uuid, uuid, text) to aether_runtime';
    execute 'grant execute on function public.sbg_fleet_deactivate_location(uuid, uuid) to aether_runtime';
  end if;
end
$priv$;

revoke sbg_fleet_writer from current_user;

comment on role sbg_fleet_writer is
  'NOLOGIN owner of vehicle, route, reposition, operating-schedule, and location writers. Not a capacity, payment, or expiry authority. Owner UPDATE of operated_by_provider_id remains outside this role.';

comment on function public.sbg_fleet_insert_location(uuid, text, uuid, text, text) is
  'Insert one airport or hotel endpoint for a provider. Does not take the vehicle lock: the new id is not yet on an itinerary. Duplicate code or hotel is duplicate and writes nothing.';

comment on function public.sbg_fleet_rename_location(uuid, uuid, text) is
  'Change the display name only. Location id, code, kind, hotel, and provider stay. Does not rewrite bookings or itineraries. Owner reassignment of operated_by is not closed.';

comment on function public.sbg_fleet_deactivate_location(uuid, uuid) is
  'Clear active when no capacity-managed assigned itinerary references the location. Rejects location_in_use and writes nothing. Does not delete the row, route, reposition, booking, or itinerary. A missing itinerary is not a reference.';
