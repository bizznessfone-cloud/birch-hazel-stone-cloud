-- Gate 2 Stage 5B — vehicle integrity and maintenance insertion. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0070.
-- Does not open checkout, admit a payment, or rewrite a booking.
--
-- sbg_fleet_writer is a NOLOGIN role. It is not a member of
-- sbg_capacity_writer and cannot reserve, settle, accept, or expire.
-- Application roles lose direct UPDATE of vehicles.capacity and
-- vehicles.active. Name updates stay. New vehicles may still be inserted.
-- Maintenance rows are inserted only by sbg_fleet_insert_unavailability.
--
-- Lock order matches Stage 3: one vehicle advisory lock
-- (hashtextextended(vehicle_id::text, 20260302)), then
-- sbg_capacity_lock_scope, then booking rows in id order FOR SHARE.
-- No payment lock. No second advisory key. Provider reassignment is not
-- a fleet-writer operation. This file does not lock every vehicle of a
-- provider.

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'sbg_fleet_writer') then
    create role sbg_fleet_writer
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      nobypassrls
      inherit;
  end if;
end
$role$;

grant sbg_fleet_writer to current_user;

grant select on table
  public.bookings,
  public.vehicles,
  public.hotels,
  public.sbg_fleet_locations,
  public.sbg_fleet_routes,
  public.sbg_fleet_repositions,
  public.sbg_provider_hours,
  public.sbg_provider_hour_exceptions,
  public.sbg_vehicle_unavailability,
  public.sbg_booking_itinerary
to sbg_fleet_writer;

grant update (
  name,
  capacity,
  active,
  luggage_capacity
) on table public.vehicles to sbg_fleet_writer;

grant insert on table public.sbg_vehicle_unavailability to sbg_fleet_writer;

grant execute on function public.aether_civil_instant(date, time, text) to sbg_fleet_writer;
grant execute on function public.sbg_assess_capacity(uuid, uuid, uuid, uuid, date, time, integer, integer, uuid, uuid, integer) to sbg_fleet_writer;
grant execute on function public.sbg_capacity_lock_scope(uuid, uuid[], uuid[]) to sbg_fleet_writer;

grant sbg_capacity_writer to current_user;
set local role sbg_capacity_writer;
grant execute on function public.sbg_capacity_lock_vehicle(uuid) to sbg_fleet_writer;
reset role;

-- Booking FOR SHARE needs the table owner's UPDATE right. The fleet role
-- does not receive booking DML. This helper only locks rows.
create or replace function public.sbg_fleet_lock_assignments(p_vehicle_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $fleet_lock$
begin
  if p_vehicle_id is null then
    return;
  end if;
  perform 1
    from public.bookings b
   where b.vehicle_id = p_vehicle_id
   order by b.id
     for share;
end;
$fleet_lock$;

revoke all on function public.sbg_fleet_lock_assignments(uuid) from public;
grant execute on function public.sbg_fleet_lock_assignments(uuid) to sbg_fleet_writer;

create or replace function public.sbg_fleet_insert_unavailability(
  p_provider_id uuid,
  p_vehicle_id uuid,
  p_starts timestamptz,
  p_ends timestamptz,
  p_kind text
) returns table (
  fleet_outcome text,
  fleet_rejection text,
  fleet_block_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $fleet_ins$
declare
  v_operated uuid;
  v_owned uuid;
  v_existing uuid;
  v_block uuid;
  v_reason text;
  v_booking record;
  v_assess jsonb;
  v_item jsonb;
  v_pickup timestamptz;
  v_dropoff timestamptz;
  v_prev_ends timestamptz;
  v_next_drop timestamptz;
  v_minutes integer;
  v_span_end timestamptz;
begin
  if p_provider_id is null or p_vehicle_id is null or p_starts is null or p_ends is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    fleet_block_id := null;
    return next;
    return;
  end if;
  if p_kind is null or p_kind not in ('maintenance', 'unavailable') or p_ends <= p_starts then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_span';
    fleet_block_id := null;
    return next;
    return;
  end if;

  -- Operator writers wait at most 2s for the Stage 3 vehicle lock. A competing
  -- reservation then gets lock_busy and no write, instead of an unbounded hang.
  -- This is not retried inside the function. Guest reserve is unchanged and
  -- still waits; the application does not set lock_timeout on that path.
  set local lock_timeout = '2s';
  perform public.sbg_capacity_lock_vehicle(p_vehicle_id);
  perform public.sbg_capacity_lock_scope(p_provider_id, array[p_vehicle_id], null);
  perform public.sbg_fleet_lock_assignments(p_vehicle_id);

  select v.operated_by_provider_id, v.owned_by_provider_id
    into v_operated, v_owned
    from public.vehicles v
   where v.id = p_vehicle_id;
  if not found then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    fleet_block_id := null;
    return next;
    return;
  end if;
  if v_operated is distinct from p_provider_id or v_owned is distinct from p_provider_id then
    fleet_outcome := 'wrong_provider';
    fleet_rejection := 'wrong_provider';
    fleet_block_id := null;
    return next;
    return;
  end if;

  select u.id
    into v_existing
    from public.sbg_vehicle_unavailability u
   where u.vehicle_id = p_vehicle_id
     and u.starts_at = p_starts
     and u.ends_at = p_ends
     and u.kind = p_kind;
  if found then
    fleet_outcome := 'duplicate';
    fleet_rejection := null;
    fleet_block_id := v_existing;
    return next;
    return;
  end if;

  for v_booking in
    select b.id,
           b.hotel_id,
           b.transfer_date,
           b.pickup_time,
           b.passenger_count,
           b.luggage_count,
           b.duration_minutes,
           b.capacity_managed,
           b.occupies,
           i.origin_location_id,
           i.destination_location_id
      from public.bookings b
      left join public.sbg_booking_itinerary i on i.booking_id = b.id
     where b.vehicle_id = p_vehicle_id
       and b.cancelled_at is null
     order by b.id
  loop
    if v_booking.capacity_managed is true then
      if not pg_catalog.isempty(v_booking.occupies)
         and v_booking.occupies && tstzrange(p_starts, p_ends, '[)') then
        fleet_outcome := 'rejected';
        fleet_rejection := 'protected_booking';
        fleet_block_id := null;
        return next;
        return;
      end if;
      if v_booking.origin_location_id is not null and v_booking.destination_location_id is not null then
        v_assess := public.sbg_assess_capacity(
          p_provider_id,
          v_booking.hotel_id,
          v_booking.origin_location_id,
          v_booking.destination_location_id,
          v_booking.transfer_date,
          v_booking.pickup_time,
          v_booking.passenger_count,
          v_booking.luggage_count,
          p_vehicle_id,
          v_booking.id,
          v_booking.duration_minutes
        );
        v_item := v_assess->'assessments'->0;
        if v_item is not null and pg_catalog.jsonb_typeof(v_item) = 'object' then
          v_pickup := nullif(v_item->'bounds'->>'pickupAt', '')::timestamptz;
          v_dropoff := nullif(v_item->'bounds'->>'dropoffAt', '')::timestamptz;
          if v_pickup is not null and v_dropoff is not null
             and v_pickup < p_ends and p_starts < v_dropoff then
            fleet_outcome := 'rejected';
            fleet_rejection := 'protected_booking';
            fleet_block_id := null;
            return next;
            return;
          end if;
          v_minutes := null;
          if pg_catalog.jsonb_typeof(v_item->'previousReposition') = 'object' then
            v_minutes := (v_item->'previousReposition'->>'durationMinutes')::integer;
          end if;
          v_prev_ends := nullif(v_item->'bounds'->>'previousEndsAt', '')::timestamptz;
          if v_minutes is not null and v_minutes > 0 and v_prev_ends is not null then
            v_span_end := v_prev_ends + pg_catalog.make_interval(mins => v_minutes);
            if v_prev_ends < p_ends and p_starts < v_span_end then
              fleet_outcome := 'rejected';
              fleet_rejection := 'protected_booking';
              fleet_block_id := null;
              return next;
              return;
            end if;
          end if;
          v_minutes := null;
          if pg_catalog.jsonb_typeof(v_item->'nextReposition') = 'object' then
            v_minutes := (v_item->'nextReposition'->>'durationMinutes')::integer;
          end if;
          if v_minutes is not null and v_minutes > 0 and v_dropoff is not null then
            v_next_drop := v_dropoff + pg_catalog.make_interval(mins => v_minutes);
            if v_dropoff < p_ends and p_starts < v_next_drop then
              fleet_outcome := 'rejected';
              fleet_rejection := 'protected_booking';
              fleet_block_id := null;
              return next;
              return;
            end if;
          end if;
        end if;
      end if;
    elsif not pg_catalog.isempty(v_booking.occupies)
          and v_booking.occupies && tstzrange(p_starts, p_ends, '[)') then
      fleet_outcome := 'rejected';
      fleet_rejection := 'legacy_assignment';
      fleet_block_id := null;
      return next;
      return;
    end if;
  end loop;

  v_reason := null;
  begin
    insert into public.sbg_vehicle_unavailability (vehicle_id, starts_at, ends_at, kind)
    values (p_vehicle_id, p_starts, p_ends, p_kind)
    returning id into v_block;
  exception
    when exclusion_violation then
      v_reason := 'maintenance_overlap';
  end;
  if v_reason is not null then
    fleet_outcome := 'rejected';
    fleet_rejection := v_reason;
    fleet_block_id := null;
    return next;
    return;
  end if;

  fleet_outcome := 'inserted';
  fleet_rejection := null;
  fleet_block_id := v_block;
  return next;
exception
  when lock_not_available then
    fleet_outcome := 'rejected';
    fleet_rejection := 'lock_busy';
    fleet_block_id := null;
    return next;
end;
$fleet_ins$;

create or replace function public.sbg_fleet_configure_vehicle(
  p_provider_id uuid,
  p_vehicle_id uuid,
  p_capacity integer,
  p_active boolean,
  p_luggage integer,
  p_set_luggage boolean,
  p_name text
) returns table (
  fleet_outcome text,
  fleet_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $fleet_cfg$
declare
  v_operated uuid;
  v_owned uuid;
  v_capacity integer;
  v_active boolean;
  v_luggage integer;
  v_name text;
  v_next_name text;
  v_next_luggage integer;
begin
  if p_provider_id is null or p_vehicle_id is null or p_capacity is null or p_active is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    return next;
    return;
  end if;
  if p_capacity < 1 or p_capacity > 20 then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_capacity';
    return next;
    return;
  end if;
  if p_name is not null and pg_catalog.char_length(pg_catalog.btrim(p_name)) = 0 then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_name';
    return next;
    return;
  end if;
  if coalesce(p_set_luggage, false)
     and p_luggage is not null
     and (p_luggage < 0 or p_luggage > 40) then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_luggage';
    return next;
    return;
  end if;

  -- Operator writers wait at most 2s for the Stage 3 vehicle lock. A competing
  -- reservation then gets lock_busy and no write, instead of an unbounded hang.
  -- This is not retried inside the function. Guest reserve is unchanged and
  -- still waits; the application does not set lock_timeout on that path.
  set local lock_timeout = '2s';
  perform public.sbg_capacity_lock_vehicle(p_vehicle_id);
  perform public.sbg_capacity_lock_scope(p_provider_id, array[p_vehicle_id], null);
  perform public.sbg_fleet_lock_assignments(p_vehicle_id);

  select v.operated_by_provider_id,
         v.owned_by_provider_id,
         v.capacity,
         v.active,
         v.luggage_capacity,
         v.name
    into v_operated, v_owned, v_capacity, v_active, v_luggage, v_name
    from public.vehicles v
   where v.id = p_vehicle_id;
  if not found then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;
  if v_operated is distinct from p_provider_id or v_owned is distinct from p_provider_id then
    fleet_outcome := 'wrong_provider';
    fleet_rejection := 'wrong_provider';
    return next;
    return;
  end if;

  v_next_name := case when p_name is null then v_name else pg_catalog.btrim(p_name) end;
  v_next_luggage := case when coalesce(p_set_luggage, false) then p_luggage else v_luggage end;

  if v_next_name is not distinct from v_name
     and p_capacity is not distinct from v_capacity
     and p_active is not distinct from v_active
     and v_next_luggage is not distinct from v_luggage then
    fleet_outcome := 'unchanged';
    fleet_rejection := null;
    return next;
    return;
  end if;

  if p_capacity < v_capacity and exists (
    select 1
      from public.bookings b
     where b.vehicle_id = p_vehicle_id
       and b.cancelled_at is null
       and b.passenger_count > p_capacity
  ) then
    fleet_outcome := 'rejected';
    fleet_rejection := 'seats';
    return next;
    return;
  end if;

  if p_active is not true and v_active is true and exists (
    select 1
      from public.bookings b
     where b.vehicle_id = p_vehicle_id
       and b.cancelled_at is null
  ) then
    fleet_outcome := 'rejected';
    fleet_rejection := 'inactive';
    return next;
    return;
  end if;

  if coalesce(p_set_luggage, false)
     and v_next_luggage is distinct from v_luggage
     and (
       v_luggage is null
       or v_next_luggage is null
       or v_next_luggage < v_luggage
     )
     and exists (
       select 1
         from public.bookings b
        where b.vehicle_id = p_vehicle_id
          and b.cancelled_at is null
          and b.luggage_count > 0
          and (v_next_luggage is null or b.luggage_count > v_next_luggage)
     ) then
    fleet_outcome := 'rejected';
    fleet_rejection := 'luggage';
    return next;
    return;
  end if;

  update public.vehicles
     set name = v_next_name,
         capacity = p_capacity,
         active = p_active,
         luggage_capacity = v_next_luggage
   where id = p_vehicle_id
     and operated_by_provider_id = p_provider_id
     and owned_by_provider_id = p_provider_id;
  if not found then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;

  fleet_outcome := 'updated';
  fleet_rejection := null;
  return next;
exception
  when lock_not_available then
    fleet_outcome := 'rejected';
    fleet_rejection := 'lock_busy';
    return next;
end;
$fleet_cfg$;

revoke all on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) from public;
revoke all on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) from public;

alter function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) owner to sbg_fleet_writer;
alter function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) owner to sbg_fleet_writer;

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke update (capacity, active) on table public.vehicles from aether_app';
    execute 'revoke all on function public.sbg_fleet_lock_assignments(uuid) from aether_app';
    execute 'revoke all on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) from aether_app';
    execute 'revoke all on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) from aether_app';
    execute 'grant execute on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) to aether_app';
    execute 'grant execute on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) to aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke update (capacity, active) on table public.vehicles from aether_runtime';
    execute 'revoke all on function public.sbg_fleet_lock_assignments(uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) from aether_runtime';
    execute 'revoke all on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) from aether_runtime';
    execute 'grant execute on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) to aether_runtime';
    execute 'grant execute on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) to aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_webhook') then
    execute 'revoke all on function public.sbg_fleet_lock_assignments(uuid) from aether_webhook';
    execute 'revoke all on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) from aether_webhook';
    execute 'revoke all on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) from aether_webhook';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_mailer') then
    execute 'revoke all on function public.sbg_fleet_lock_assignments(uuid) from aether_mailer';
    execute 'revoke all on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) from aether_mailer';
    execute 'revoke all on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) from aether_mailer';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_payment_gateway') then
    execute 'revoke all on function public.sbg_fleet_lock_assignments(uuid) from aether_payment_gateway';
    execute 'revoke all on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) from aether_payment_gateway';
    execute 'revoke all on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) from aether_payment_gateway';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_expiry') then
    execute 'revoke all on function public.sbg_fleet_lock_assignments(uuid) from aether_expiry';
    execute 'revoke all on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) from aether_expiry';
    execute 'revoke all on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) from aether_expiry';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_expiry_runner') then
    execute 'revoke all on function public.sbg_fleet_lock_assignments(uuid) from aether_expiry_runner';
    execute 'revoke all on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) from aether_expiry_runner';
    execute 'revoke all on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) from aether_expiry_runner';
  end if;
  if exists (select 1 from pg_roles where rolname = 'sbg_capacity_writer') then
    execute 'revoke all on function public.sbg_fleet_lock_assignments(uuid) from sbg_capacity_writer';
    execute 'revoke all on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) from sbg_capacity_writer';
    execute 'revoke all on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) from sbg_capacity_writer';
  end if;
end
$priv$;

revoke sbg_capacity_writer from current_user;
revoke sbg_fleet_writer from current_user;

comment on role sbg_fleet_writer is
  'NOLOGIN owner of vehicle maintenance insertion and seat, luggage, and active configuration. Not a capacity, payment, or expiry authority.';

comment on function public.sbg_fleet_insert_unavailability(uuid, uuid, timestamptz, timestamptz, text) is
  'Insert one maintenance or unavailable block for a vehicle the provider both owns and operates. Identical replay is duplicate and writes nothing. Overlap of a protected hold, confirmed reservation, reposition span, legacy assignment, or another block is rejected and writes nothing.';

comment on function public.sbg_fleet_configure_vehicle(uuid, uuid, integer, boolean, integer, boolean, text) is
  'Change seat capacity, active status, optional luggage, and optional name for a vehicle the provider both owns and operates. Rejects a reduction or deactivation that would invalidate a non-cancelled assignment. Does not rewrite the booking.';
