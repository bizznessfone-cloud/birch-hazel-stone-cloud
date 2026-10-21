-- Gate 2 Stage 5C — route and repositioning integrity. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0071.
-- Does not open checkout, admit a payment, or rewrite a booking.
--
-- Reuses sbg_fleet_writer. Does not create another operational role and does
-- not grant that role capacity, payment, webhook, or expiry authority.
-- Application roles stay SELECT-only on the catalogue tables. They may
-- execute the two writers below. A caller-supplied provider id is only an
-- ownership key inside those writers. It is not authentication. There is
-- no application route editor; a future caller must pass the provider
-- already bound to the authenticated operator session.
--
-- Lock order matches Stage 3. Vehicles currently operated by the provider
-- are locked in ascending uuid order through sbg_capacity_lock_vehicle
-- (pg_advisory_xact_lock(hashtextextended(vehicle_id::text, 20260302))).
-- The catalogue row is then locked exclusively, then sbg_capacity_lock_scope,
-- then booking rows of those vehicles FOR SHARE via sbg_fleet_lock_assignments.
-- No second advisory key. No payment lock. Operator writers wait at most 2s.
-- lock_not_available, deadlock, and a drifted operated-by set return
-- rejected/lock_busy and write nothing. Guest sbg_reserve_capacity is not
-- modified and still waits; this file does not set lock_timeout on that path.
--
-- Owner UPDATE of vehicles.operated_by_provider_id or owned_by_provider_id
-- does not take the Stage 3 lock. This file locks only the operated-by set
-- observed at lock time and writes nothing if that set changes before the
-- catalogue write. It does not stop a later owner reassignment. A vehicle
-- moved into the provider after that recheck can still be legacy-dispatched
-- without taking the route lock. Capacity reserve cannot sneak past: it
-- share-locks the provider's routes and waits on this writer's exclusive
-- catalogue lock. Direct owner UPDATE of a route or reposition also remains
-- outside the protocol. Neither hole is closed here.
--
-- Missing route and reposition rows stay infeasible. They are not zero.
-- Same-endpoint reposition is zero and is not stored. Reposition rows have
-- no active flag and this file does not add one and does not delete.
-- A legacy booking with no itinerary is not a known endpoint pair and is
-- not treated as zero travel. It is not rewritten.

grant sbg_fleet_writer to current_user;

grant insert (
  provider_id,
  origin_location_id,
  destination_location_id,
  duration_minutes,
  active
), update (
  duration_minutes,
  active
) on table public.sbg_fleet_routes to sbg_fleet_writer;

grant insert (
  provider_id,
  from_location_id,
  to_location_id,
  duration_minutes
), update (
  duration_minutes
) on table public.sbg_fleet_repositions to sbg_fleet_writer;

-- Booking and catalogue FOR UPDATE/SHARE need the table owner's rights.
-- These helpers only lock. The fleet role does not receive booking DML,
-- route DELETE, or reposition DELETE.
create or replace function public.sbg_fleet_lock_provider_vehicles(p_provider_id uuid)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $lock_vehicles$
declare
  v_ids uuid[];
  v_id uuid;
  v_after uuid[];
begin
  if p_provider_id is null then
    return array[]::uuid[];
  end if;
  select coalesce(pg_catalog.array_agg(v.id order by v.id), array[]::uuid[])
    into v_ids
    from public.vehicles v
   where v.operated_by_provider_id = p_provider_id;
  foreach v_id in array v_ids loop
    perform public.sbg_capacity_lock_vehicle(v_id);
  end loop;
  select coalesce(pg_catalog.array_agg(v.id order by v.id), array[]::uuid[])
    into v_after
    from public.vehicles v
   where v.operated_by_provider_id = p_provider_id;
  if v_after is distinct from v_ids then
    raise exception 'capacity_lock_retry'
      using errcode = '40001';
  end if;
  return v_ids;
end;
$lock_vehicles$;

create or replace function public.sbg_fleet_lock_route(p_route_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $lock_route$
begin
  if p_route_id is null then
    return;
  end if;
  perform 1
    from public.sbg_fleet_routes r
   where r.id = p_route_id
   for update;
end;
$lock_route$;

create or replace function public.sbg_fleet_lock_reposition(p_reposition_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $lock_reposition$
begin
  if p_reposition_id is null then
    return;
  end if;
  perform 1
    from public.sbg_fleet_repositions r
   where r.id = p_reposition_id
   for update;
end;
$lock_reposition$;

revoke all on function public.sbg_fleet_lock_provider_vehicles(uuid) from public;
revoke all on function public.sbg_fleet_lock_route(uuid) from public;
revoke all on function public.sbg_fleet_lock_reposition(uuid) from public;
grant execute on function public.sbg_fleet_lock_provider_vehicles(uuid) to sbg_fleet_writer;
grant execute on function public.sbg_fleet_lock_route(uuid) to sbg_fleet_writer;
grant execute on function public.sbg_fleet_lock_reposition(uuid) to sbg_fleet_writer;

create or replace function public.sbg_fleet_upsert_route(
  p_provider_id uuid,
  p_route_id uuid,
  p_origin_location_id uuid,
  p_destination_location_id uuid,
  p_duration integer,
  p_active boolean
) returns table (
  fleet_outcome text,
  fleet_rejection text,
  fleet_route_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $fleet_route$
declare
  v_ids uuid[];
  v_after uuid[];
  v_vehicle uuid;
  v_row_provider uuid;
  v_row_origin uuid;
  v_row_destination uuid;
  v_row_duration integer;
  v_row_active boolean;
  v_origin_provider uuid;
  v_destination_provider uuid;
  v_booking record;
  v_old jsonb;
  v_new jsonb;
  v_old_ok boolean;
  v_new_ok boolean;
  v_time_blocked boolean;
begin
  if p_provider_id is null
     or p_origin_location_id is null
     or p_destination_location_id is null
     or p_duration is null
     or p_active is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    fleet_route_id := null;
    return next;
    return;
  end if;
  if p_origin_location_id = p_destination_location_id then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_endpoints';
    fleet_route_id := null;
    return next;
    return;
  end if;
  if p_duration < 1 or p_duration > 1440 then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_duration';
    fleet_route_id := null;
    return next;
    return;
  end if;

  -- Operator writers wait at most 2s. A competing reservation gets lock_busy
  -- and no write. This is not retried inside the function.
  set local lock_timeout = '2s';
  v_ids := public.sbg_fleet_lock_provider_vehicles(p_provider_id);

  if p_route_id is not null then
    perform public.sbg_fleet_lock_route(p_route_id);
    select r.provider_id, r.origin_location_id, r.destination_location_id,
           r.duration_minutes, r.active
      into v_row_provider, v_row_origin, v_row_destination, v_row_duration, v_row_active
      from public.sbg_fleet_routes r
     where r.id = p_route_id;
    if not found then
      fleet_outcome := 'not_found';
      fleet_rejection := 'not_found';
      fleet_route_id := null;
      return next;
      return;
    end if;
    if v_row_provider is distinct from p_provider_id then
      fleet_outcome := 'wrong_provider';
      fleet_rejection := 'wrong_provider';
      fleet_route_id := null;
      return next;
      return;
    end if;
    if v_row_origin is distinct from p_origin_location_id
       or v_row_destination is distinct from p_destination_location_id then
      fleet_outcome := 'invalid';
      fleet_rejection := 'invalid_endpoints';
      fleet_route_id := null;
      return next;
      return;
    end if;
  end if;

  perform public.sbg_capacity_lock_scope(
    p_provider_id,
    v_ids,
    array[p_origin_location_id, p_destination_location_id]
  );
  foreach v_vehicle in array v_ids loop
    perform public.sbg_fleet_lock_assignments(v_vehicle);
  end loop;

  select coalesce(pg_catalog.array_agg(v.id order by v.id), array[]::uuid[])
    into v_after
    from public.vehicles v
   where v.operated_by_provider_id = p_provider_id;
  if v_after is distinct from v_ids then
    raise exception 'capacity_lock_retry'
      using errcode = '40001';
  end if;

  select l.provider_id
    into v_origin_provider
    from public.sbg_fleet_locations l
   where l.id = p_origin_location_id;
  select l.provider_id
    into v_destination_provider
    from public.sbg_fleet_locations l
   where l.id = p_destination_location_id;
  if v_origin_provider is null or v_destination_provider is null then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    fleet_route_id := null;
    return next;
    return;
  end if;
  if v_origin_provider is distinct from p_provider_id
     or v_destination_provider is distinct from p_provider_id then
    fleet_outcome := 'wrong_provider';
    fleet_rejection := 'wrong_provider';
    fleet_route_id := null;
    return next;
    return;
  end if;

  if p_route_id is null then
    select r.id, r.duration_minutes, r.active
      into fleet_route_id, v_row_duration, v_row_active
      from public.sbg_fleet_routes r
     where r.origin_location_id = p_origin_location_id
       and r.destination_location_id = p_destination_location_id;
    if found then
      fleet_outcome := 'duplicate';
      fleet_rejection := null;
      return next;
      return;
    end if;
  elsif p_duration is not distinct from v_row_duration
        and p_active is not distinct from v_row_active then
    fleet_outcome := 'unchanged';
    fleet_rejection := null;
    fleet_route_id := p_route_id;
    return next;
    return;
  end if;

  if p_route_id is not null
     and p_active is not true
     and v_row_active is true
     and exists (
       select 1
         from public.bookings b
         join public.sbg_booking_itinerary i on i.booking_id = b.id
        where b.vehicle_id = any (v_ids)
          and b.cancelled_at is null
          and (
            b.capacity_managed
            or not pg_catalog.isempty(b.occupies)
          )
          and i.origin_location_id = p_origin_location_id
          and i.destination_location_id = p_destination_location_id
     ) then
    fleet_outcome := 'rejected';
    fleet_rejection := 'route_inactive';
    fleet_route_id := null;
    return next;
    return;
  end if;

  if p_route_id is null or p_duration is distinct from v_row_duration then
    for v_booking in
      select b.id,
             b.hotel_id,
             b.transfer_date,
             b.pickup_time,
             b.passenger_count,
             b.luggage_count,
             b.duration_minutes,
             b.vehicle_id
        from public.bookings b
        join public.sbg_booking_itinerary i on i.booking_id = b.id
       where b.vehicle_id = any (v_ids)
         and b.cancelled_at is null
         and (
           b.capacity_managed
           or not pg_catalog.isempty(b.occupies)
         )
         and i.origin_location_id = p_origin_location_id
         and i.destination_location_id = p_destination_location_id
       order by b.id
    loop
      v_old := public.sbg_assess_capacity(
        p_provider_id,
        v_booking.hotel_id,
        p_origin_location_id,
        p_destination_location_id,
        v_booking.transfer_date,
        v_booking.pickup_time,
        v_booking.passenger_count,
        v_booking.luggage_count,
        v_booking.vehicle_id,
        v_booking.id,
        v_booking.duration_minutes
      );
      v_new := public.sbg_assess_capacity(
        p_provider_id,
        v_booking.hotel_id,
        p_origin_location_id,
        p_destination_location_id,
        v_booking.transfer_date,
        v_booking.pickup_time,
        v_booking.passenger_count,
        v_booking.luggage_count,
        v_booking.vehicle_id,
        v_booking.id,
        p_duration
      );
      v_old_ok := coalesce((v_old->>'feasible')::boolean, false);
      v_new_ok := coalesce((v_new->>'feasible')::boolean, false);
      -- The revised journey is the frozen pickup plus the proposed duration.
      -- Assess adds the stored reposition (zero only for the same endpoint)
      -- and the 15-minute buffer, then compares that with the next protected
      -- pickup. A missing reposition rule is not zero. An itinerary-less
      -- neighbour is not a known pair and is not treated as zero either.
      -- Reject when that revised journey does not fit, including when the
      -- frozen duration was already too long. Do not rewrite the booking.
      select exists (
        select 1
          from pg_catalog.jsonb_array_elements_text(
            coalesce(v_new->'assessments'->0->'rejections', '[]'::jsonb)
          ) as code(code)
         where code.code in (
           'occupancy',
           'next_reposition',
           'reposition_missing',
           'maintenance'
         )
      ) into v_time_blocked;
      if v_time_blocked or (v_old_ok and not v_new_ok) then
        fleet_outcome := 'rejected';
        fleet_rejection := 'route_duration';
        fleet_route_id := null;
        return next;
        return;
      end if;
    end loop;
  end if;

  if p_route_id is null then
    insert into public.sbg_fleet_routes (
      provider_id, origin_location_id, destination_location_id, duration_minutes, active
    ) values (
      p_provider_id, p_origin_location_id, p_destination_location_id, p_duration, p_active
    )
    returning id into fleet_route_id;
    fleet_outcome := 'inserted';
    fleet_rejection := null;
    return next;
    return;
  end if;

  update public.sbg_fleet_routes
     set duration_minutes = p_duration,
         active = p_active
   where id = p_route_id
     and provider_id = p_provider_id;
  if not found then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    fleet_route_id := null;
    return next;
    return;
  end if;
  fleet_outcome := 'updated';
  fleet_rejection := null;
  fleet_route_id := p_route_id;
  return next;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    fleet_outcome := 'rejected';
    fleet_rejection := 'lock_busy';
    fleet_route_id := null;
    return next;
  when unique_violation then
    select r.id
      into fleet_route_id
      from public.sbg_fleet_routes r
     where r.origin_location_id = p_origin_location_id
       and r.destination_location_id = p_destination_location_id;
    fleet_outcome := 'duplicate';
    fleet_rejection := null;
    return next;
end;
$fleet_route$;

create or replace function public.sbg_fleet_upsert_reposition(
  p_provider_id uuid,
  p_reposition_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_duration integer
) returns table (
  fleet_outcome text,
  fleet_rejection text,
  fleet_reposition_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $fleet_reposition$
declare
  v_ids uuid[];
  v_after uuid[];
  v_vehicle uuid;
  v_row_provider uuid;
  v_row_from uuid;
  v_row_to uuid;
  v_row_duration integer;
  v_from_provider uuid;
  v_to_provider uuid;
  v_pair record;
begin
  if p_provider_id is null
     or p_from_location_id is null
     or p_to_location_id is null
     or p_duration is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    fleet_reposition_id := null;
    return next;
    return;
  end if;
  if p_from_location_id = p_to_location_id then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_endpoints';
    fleet_reposition_id := null;
    return next;
    return;
  end if;
  if p_duration < 1 or p_duration > 1440 then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_duration';
    fleet_reposition_id := null;
    return next;
    return;
  end if;

  set local lock_timeout = '2s';
  v_ids := public.sbg_fleet_lock_provider_vehicles(p_provider_id);

  if p_reposition_id is not null then
    perform public.sbg_fleet_lock_reposition(p_reposition_id);
    select r.provider_id, r.from_location_id, r.to_location_id, r.duration_minutes
      into v_row_provider, v_row_from, v_row_to, v_row_duration
      from public.sbg_fleet_repositions r
     where r.id = p_reposition_id;
    if not found then
      fleet_outcome := 'not_found';
      fleet_rejection := 'not_found';
      fleet_reposition_id := null;
      return next;
      return;
    end if;
    if v_row_provider is distinct from p_provider_id then
      fleet_outcome := 'wrong_provider';
      fleet_rejection := 'wrong_provider';
      fleet_reposition_id := null;
      return next;
      return;
    end if;
    if v_row_from is distinct from p_from_location_id
       or v_row_to is distinct from p_to_location_id then
      fleet_outcome := 'invalid';
      fleet_rejection := 'invalid_endpoints';
      fleet_reposition_id := null;
      return next;
      return;
    end if;
  end if;

  perform public.sbg_capacity_lock_scope(
    p_provider_id,
    v_ids,
    array[p_from_location_id, p_to_location_id]
  );
  foreach v_vehicle in array v_ids loop
    perform public.sbg_fleet_lock_assignments(v_vehicle);
  end loop;

  select coalesce(pg_catalog.array_agg(v.id order by v.id), array[]::uuid[])
    into v_after
    from public.vehicles v
   where v.operated_by_provider_id = p_provider_id;
  if v_after is distinct from v_ids then
    raise exception 'capacity_lock_retry'
      using errcode = '40001';
  end if;

  select l.provider_id
    into v_from_provider
    from public.sbg_fleet_locations l
   where l.id = p_from_location_id;
  select l.provider_id
    into v_to_provider
    from public.sbg_fleet_locations l
   where l.id = p_to_location_id;
  if v_from_provider is null or v_to_provider is null then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    fleet_reposition_id := null;
    return next;
    return;
  end if;
  if v_from_provider is distinct from p_provider_id
     or v_to_provider is distinct from p_provider_id then
    fleet_outcome := 'wrong_provider';
    fleet_rejection := 'wrong_provider';
    fleet_reposition_id := null;
    return next;
    return;
  end if;

  if p_reposition_id is null then
    select r.id, r.duration_minutes
      into fleet_reposition_id, v_row_duration
      from public.sbg_fleet_repositions r
     where r.from_location_id = p_from_location_id
       and r.to_location_id = p_to_location_id;
    if found then
      fleet_outcome := 'duplicate';
      fleet_rejection := null;
      return next;
      return;
    end if;
  elsif p_duration is not distinct from v_row_duration then
    fleet_outcome := 'unchanged';
    fleet_rejection := null;
    fleet_reposition_id := p_reposition_id;
    return next;
    return;
  end if;

  for v_pair in
    select s.vehicle_id, s.ends_at, s.next_starts
      from (
        select b.vehicle_id,
               pg_catalog.upper(b.occupies) as ends_at,
               i.destination_location_id,
               pg_catalog.lead(pg_catalog.lower(b.occupies)) over w as next_starts,
               pg_catalog.lead(i.origin_location_id) over w as next_origin
          from public.bookings b
          left join public.sbg_booking_itinerary i on i.booking_id = b.id
         where b.vehicle_id = any (v_ids)
           and b.cancelled_at is null
           and not pg_catalog.isempty(b.occupies)
        window w as (
          partition by b.vehicle_id
          order by pg_catalog.lower(b.occupies), b.id
        )
      ) s
     where s.destination_location_id = p_from_location_id
       and s.next_origin = p_to_location_id
       and s.destination_location_id is distinct from s.next_origin
       and s.next_starts is not null
  loop
    if v_pair.ends_at + pg_catalog.make_interval(mins => p_duration + 15) > v_pair.next_starts then
      fleet_outcome := 'rejected';
      fleet_rejection := 'reposition_gap';
      fleet_reposition_id := null;
      return next;
      return;
    end if;
    if exists (
      select 1
        from public.sbg_vehicle_unavailability u
       where u.vehicle_id = v_pair.vehicle_id
         and u.starts_at < v_pair.ends_at + pg_catalog.make_interval(mins => p_duration)
         and v_pair.ends_at < u.ends_at
    ) then
      fleet_outcome := 'rejected';
      fleet_rejection := 'reposition_maintenance';
      fleet_reposition_id := null;
      return next;
      return;
    end if;
  end loop;

  if p_reposition_id is null then
    insert into public.sbg_fleet_repositions (
      provider_id, from_location_id, to_location_id, duration_minutes
    ) values (
      p_provider_id, p_from_location_id, p_to_location_id, p_duration
    )
    returning id into fleet_reposition_id;
    fleet_outcome := 'inserted';
    fleet_rejection := null;
    return next;
    return;
  end if;

  update public.sbg_fleet_repositions
     set duration_minutes = p_duration
   where id = p_reposition_id
     and provider_id = p_provider_id;
  if not found then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    fleet_reposition_id := null;
    return next;
    return;
  end if;
  fleet_outcome := 'updated';
  fleet_rejection := null;
  fleet_reposition_id := p_reposition_id;
  return next;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    fleet_outcome := 'rejected';
    fleet_rejection := 'lock_busy';
    fleet_reposition_id := null;
    return next;
  when unique_violation then
    select r.id
      into fleet_reposition_id
      from public.sbg_fleet_repositions r
     where r.from_location_id = p_from_location_id
       and r.to_location_id = p_to_location_id;
    fleet_outcome := 'duplicate';
    fleet_rejection := null;
    return next;
end;
$fleet_reposition$;

revoke all on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) from public;
revoke all on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) from public;

alter function public.sbg_fleet_lock_provider_vehicles(uuid) owner to sbg_fleet_writer;
alter function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) owner to sbg_fleet_writer;
alter function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) owner to sbg_fleet_writer;

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke insert, update, delete on table public.sbg_fleet_routes from aether_app';
    execute 'revoke insert, update, delete on table public.sbg_fleet_repositions from aether_app';
    execute 'revoke all on function public.sbg_fleet_lock_provider_vehicles(uuid) from aether_app';
    execute 'revoke all on function public.sbg_fleet_lock_route(uuid) from aether_app';
    execute 'revoke all on function public.sbg_fleet_lock_reposition(uuid) from aether_app';
    execute 'revoke all on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) from aether_app';
    execute 'revoke all on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) from aether_app';
    execute 'grant execute on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) to aether_app';
    execute 'grant execute on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) to aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke insert, update, delete on table public.sbg_fleet_routes from aether_runtime';
    execute 'revoke insert, update, delete on table public.sbg_fleet_repositions from aether_runtime';
    execute 'revoke all on function public.sbg_fleet_lock_provider_vehicles(uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_fleet_lock_route(uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_fleet_lock_reposition(uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) from aether_runtime';
    execute 'revoke all on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) from aether_runtime';
    execute 'grant execute on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) to aether_runtime';
    execute 'grant execute on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) to aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_webhook') then
    execute 'revoke insert, update, delete on table public.sbg_fleet_routes from aether_webhook';
    execute 'revoke insert, update, delete on table public.sbg_fleet_repositions from aether_webhook';
    execute 'revoke all on function public.sbg_fleet_lock_provider_vehicles(uuid) from aether_webhook';
    execute 'revoke all on function public.sbg_fleet_lock_route(uuid) from aether_webhook';
    execute 'revoke all on function public.sbg_fleet_lock_reposition(uuid) from aether_webhook';
    execute 'revoke all on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) from aether_webhook';
    execute 'revoke all on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) from aether_webhook';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_mailer') then
    execute 'revoke insert, update, delete on table public.sbg_fleet_routes from aether_mailer';
    execute 'revoke insert, update, delete on table public.sbg_fleet_repositions from aether_mailer';
    execute 'revoke all on function public.sbg_fleet_lock_provider_vehicles(uuid) from aether_mailer';
    execute 'revoke all on function public.sbg_fleet_lock_route(uuid) from aether_mailer';
    execute 'revoke all on function public.sbg_fleet_lock_reposition(uuid) from aether_mailer';
    execute 'revoke all on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) from aether_mailer';
    execute 'revoke all on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) from aether_mailer';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_payment_gateway') then
    execute 'revoke insert, update, delete on table public.sbg_fleet_routes from aether_payment_gateway';
    execute 'revoke insert, update, delete on table public.sbg_fleet_repositions from aether_payment_gateway';
    execute 'revoke all on function public.sbg_fleet_lock_provider_vehicles(uuid) from aether_payment_gateway';
    execute 'revoke all on function public.sbg_fleet_lock_route(uuid) from aether_payment_gateway';
    execute 'revoke all on function public.sbg_fleet_lock_reposition(uuid) from aether_payment_gateway';
    execute 'revoke all on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) from aether_payment_gateway';
    execute 'revoke all on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) from aether_payment_gateway';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_expiry') then
    execute 'revoke all on function public.sbg_fleet_lock_provider_vehicles(uuid) from aether_expiry';
    execute 'revoke all on function public.sbg_fleet_lock_route(uuid) from aether_expiry';
    execute 'revoke all on function public.sbg_fleet_lock_reposition(uuid) from aether_expiry';
    execute 'revoke all on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) from aether_expiry';
    execute 'revoke all on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) from aether_expiry';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_expiry_runner') then
    execute 'revoke all on function public.sbg_fleet_lock_provider_vehicles(uuid) from aether_expiry_runner';
    execute 'revoke all on function public.sbg_fleet_lock_route(uuid) from aether_expiry_runner';
    execute 'revoke all on function public.sbg_fleet_lock_reposition(uuid) from aether_expiry_runner';
    execute 'revoke all on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) from aether_expiry_runner';
    execute 'revoke all on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) from aether_expiry_runner';
  end if;
  if exists (select 1 from pg_roles where rolname = 'sbg_capacity_writer') then
    execute 'revoke all on function public.sbg_fleet_lock_provider_vehicles(uuid) from sbg_capacity_writer';
    execute 'revoke all on function public.sbg_fleet_lock_route(uuid) from sbg_capacity_writer';
    execute 'revoke all on function public.sbg_fleet_lock_reposition(uuid) from sbg_capacity_writer';
    execute 'revoke all on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) from sbg_capacity_writer';
    execute 'revoke all on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) from sbg_capacity_writer';
  end if;
end
$priv$;

revoke sbg_fleet_writer from current_user;

comment on role sbg_fleet_writer is
  'NOLOGIN owner of vehicle maintenance, seat configuration, and route and reposition catalogue writers. Not a capacity, payment, or expiry authority. Owner UPDATE of operated_by_provider_id remains outside this role.';

comment on function public.sbg_fleet_lock_provider_vehicles(uuid) is
  'Stage 3 advisory locks, in ascending uuid order, for vehicles currently operated by the provider. Raises capacity_lock_retry (40001) if that set changes while locking. Does not freeze owner reassignment of operated_by.';

comment on function public.sbg_fleet_upsert_route(uuid, uuid, uuid, uuid, integer, boolean) is
  'Insert or modify one provider route duration and active flag. Rejects a deactivation or a duration that makes a currently feasible protected itinerary infeasible, including the next journey and the 15-minute buffer. Does not rewrite booking duration, itinerary, payment, lifecycle, or vehicle assignment. Missing routes stay absent. Direct owner UPDATE of the table is outside this function.';

comment on function public.sbg_fleet_upsert_reposition(uuid, uuid, uuid, uuid, integer) is
  'Insert or modify one provider reposition duration. Same-endpoint input is rejected and not stored. A missing row is not turned into zero. No active flag and no delete. Rejects a duration that breaks a consecutive protected pair once the 15-minute buffer is included, or that overlaps maintenance on the reposition span. Does not rewrite bookings. Legacy rows without itinerary are not a known pair.';
