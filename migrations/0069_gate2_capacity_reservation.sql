-- Gate 2 Stage 3 — atomic capacity reservation. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0068.
-- Does not open checkout, mount a webhook, or grant fleet DML to application roles.
--
-- sbg_capacity_writer is a NOLOGIN role. It is not operator authentication.
-- Only functions it owns may change a capacity-managed booking. The guard is
-- invoker-rights, so it sees that owner and not the shared application role.
-- A session GUC, a supplied operator id, and current_user of the migration
-- owner are not accepted as function identity.
--
-- Lock order for every capacity mutation: vehicle advisory locks in uuid
-- order, fleet rows, vehicle rows, booking rows in id order, then payment.
-- Existing legacy expiry keeps FOR UPDATE SKIP LOCKED and does not take a
-- vehicle advisory lock. Checkout-session expiry does not release a hold.
--
-- Operational writers for maintenance, routes, hours, and repositioning do
-- not exist yet. Until they take the same advisory lock, this migration does
-- not claim that an ordinary fleet edit cannot overlap a committed hold.
-- Application roles stay select-only on those tables.

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'sbg_capacity_writer') then
    create role sbg_capacity_writer nologin;
  end if;
end
$role$;

grant sbg_capacity_writer to current_user;

grant select on table
  public.bookings,
  public.vehicles,
  public.drivers,
  public.hotels,
  public.sbg_fleet_locations,
  public.sbg_fleet_routes,
  public.sbg_fleet_repositions,
  public.sbg_provider_hours,
  public.sbg_provider_hour_exceptions,
  public.sbg_vehicle_unavailability,
  public.sbg_booking_itinerary,
  public.sbg_booking_payments
to sbg_capacity_writer;

grant update (
  vehicle_id,
  driver_id,
  cancelled_at,
  lifecycle_state,
  hold_expires_at,
  confirmed_paid_at,
  capacity_managed,
  duration_minutes
) on table public.bookings to sbg_capacity_writer;

grant insert, update on table public.sbg_booking_itinerary to sbg_capacity_writer;
grant insert on table public.audit_events to sbg_capacity_writer;
grant execute on function public.aether_civil_instant(date, time, text) to sbg_capacity_writer;

create or replace function public.sbg_capacity_lock_vehicle(p_vehicle_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $lock_vehicle$
begin
  if p_vehicle_id is null then
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_vehicle_id::text, 20260302));
end;
$lock_vehicle$;

revoke all on function public.sbg_capacity_lock_vehicle(uuid) from public;

-- Row locks need UPDATE, which application roles must not have. This helper is
-- owned by the table owner, takes only SHARE/UPDATE locks, and is executable
-- only by sbg_capacity_writer. It does not update fleet or booking rows.
create or replace function public.sbg_capacity_lock_scope(
  p_provider_id uuid,
  p_vehicle_ids uuid[],
  p_location_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $lock_scope$
begin
  if p_location_ids is not null then
    perform 1
      from public.sbg_fleet_locations l
     where l.id = any (p_location_ids)
     order by l.id
     for share;
  end if;
  if p_provider_id is not null then
    perform 1
      from public.sbg_fleet_routes r
     where r.provider_id = p_provider_id
     order by r.id
     for share;
    perform 1
      from public.sbg_fleet_repositions r
     where r.provider_id = p_provider_id
     order by r.id
     for share;
    perform 1
      from public.sbg_provider_hours h
     where h.provider_id = p_provider_id
     order by h.isodow
     for share;
    perform 1
      from public.sbg_provider_hour_exceptions e
     where e.provider_id = p_provider_id
     order by e.service_date
     for share;
  end if;
  if p_vehicle_ids is not null then
    perform 1
      from public.sbg_vehicle_unavailability u
     where u.vehicle_id = any (p_vehicle_ids)
     order by u.vehicle_id, u.id
     for share;
    perform 1
      from public.vehicles v
     where v.id = any (p_vehicle_ids)
     order by v.id
     for update;
  end if;
end;
$lock_scope$;

revoke all on function public.sbg_capacity_lock_scope(uuid, uuid[], uuid[]) from public;
grant execute on function public.sbg_capacity_lock_scope(uuid, uuid[], uuid[]) to sbg_capacity_writer;

create or replace function public.sbg_assess_capacity(
  p_provider_id uuid,
  p_hotel_id uuid,
  p_origin_location_id uuid,
  p_destination_location_id uuid,
  p_transfer_date date,
  p_pickup_time time,
  p_passenger_count integer,
  p_luggage_count integer,
  p_vehicle_id uuid,
  p_exclude_booking_id uuid default null,
  p_frozen_duration integer default null
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $assess$
declare
  v_tz text;
  v_pickup timestamptz;
  v_dropoff timestamptz;
  v_duration integer;
  v_route jsonb := 'null'::jsonb;
  v_schedule jsonb;
  v_origin_id uuid;
  v_origin_provider uuid;
  v_origin_active boolean;
  v_destination_id uuid;
  v_destination_provider uuid;
  v_destination_active boolean;
  v_prev_ends timestamptz;
  v_prev_destination uuid;
  v_next_starts timestamptz;
  v_next_origin uuid;
  v_prev_need jsonb;
  v_next_need jsonb;
  v_prev_minutes integer;
  v_next_minutes integer;
  v_pickup_date date;
  v_dropoff_date date;
  v_date date;
  v_count integer := 0;
  v_exception record;
  v_opens time;
  v_closes time;
  v_close_date date;
  v_open_at timestamptz;
  v_close_at timestamptz;
  v_ranges timestamptz[];
  v_range_ends timestamptz[];
  v_merged_s timestamptz[];
  v_merged_e timestamptz[];
  v_i integer;
  v_j integer;
  v_covered boolean := false;
  v_vehicles jsonb := '[]'::jsonb;
  v_vehicle record;
  v_rejections text[];
  v_commitment record;
  v_block record;
  v_hit boolean;
  v_span_start timestamptz;
  v_span_end timestamptz;
  v_bounds jsonb;
  v_one jsonb;
  v_eligible jsonb;
  v_flat text[];
  v_shared jsonb;
  v_code text;
begin
  if p_passenger_count is null
     or p_luggage_count is null
     or p_passenger_count < 1
     or p_passenger_count > 20
     or p_luggage_count < 0
     or p_luggage_count > 40 then
    return pg_catalog.jsonb_build_object(
      'feasible', false,
      'vehicleIds', '[]'::jsonb,
      'rejections', pg_catalog.jsonb_build_array('invalid_request'),
      'route', null,
      'assessments', '[]'::jsonb,
      'schedule', pg_catalog.jsonb_build_object(
        'pickupAt', null, 'dropoffAt', null, 'bufferMinutes', 15,
        'previousEndsAt', null, 'earliestPickupAt', null,
        'nextStartsAt', null, 'latestDropoffAt', null
      )
    );
  end if;

  select pg_catalog.btrim(h.iana_timezone) into v_tz
    from public.hotels h
   where h.id = p_hotel_id;
  if v_tz is null or v_tz = '' then
    return pg_catalog.jsonb_build_object(
      'feasible', false, 'vehicleIds', '[]'::jsonb,
      'rejections', pg_catalog.jsonb_build_array('not_found'),
      'route', null, 'assessments', '[]'::jsonb,
      'schedule', pg_catalog.jsonb_build_object(
        'pickupAt', null, 'dropoffAt', null, 'bufferMinutes', 15,
        'previousEndsAt', null, 'earliestPickupAt', null,
        'nextStartsAt', null, 'latestDropoffAt', null
      )
    );
  end if;

  begin
    v_pickup := public.aether_civil_instant(p_transfer_date, p_pickup_time, v_tz);
  exception
    when others then
      if sqlerrm ilike '%does not exist%' then
        v_code := 'time_nonexistent';
      elsif sqlerrm ilike '%ambiguous%' then
        v_code := 'time_ambiguous';
      else
        v_code := 'invalid_time';
      end if;
      return pg_catalog.jsonb_build_object(
        'feasible', false, 'vehicleIds', '[]'::jsonb,
        'rejections', pg_catalog.jsonb_build_array(v_code),
        'route', null, 'assessments', '[]'::jsonb,
        'schedule', pg_catalog.jsonb_build_object(
          'pickupAt', null, 'dropoffAt', null, 'bufferMinutes', 15,
          'previousEndsAt', null, 'earliestPickupAt', null,
          'nextStartsAt', null, 'latestDropoffAt', null
        )
      );
  end;

  select l.id, l.provider_id, l.active
    into v_origin_id, v_origin_provider, v_origin_active
    from public.sbg_fleet_locations l
   where l.id = p_origin_location_id;
  select l.id, l.provider_id, l.active
    into v_destination_id, v_destination_provider, v_destination_active
    from public.sbg_fleet_locations l
   where l.id = p_destination_location_id;
  if v_origin_id is null
     or v_destination_id is null
     or v_origin_provider is distinct from p_provider_id
     or v_destination_provider is distinct from p_provider_id
     or v_origin_active is not true
     or v_destination_active is not true then
    return pg_catalog.jsonb_build_object(
      'feasible', false, 'vehicleIds', '[]'::jsonb,
      'rejections', pg_catalog.jsonb_build_array('not_found'),
      'route', null, 'assessments', '[]'::jsonb,
      'schedule', pg_catalog.jsonb_build_object(
        'pickupAt', null, 'dropoffAt', null, 'bufferMinutes', 15,
        'previousEndsAt', null, 'earliestPickupAt', null,
        'nextStartsAt', null, 'latestDropoffAt', null
      )
    );
  end if;

  if p_frozen_duration is not null then
    v_duration := p_frozen_duration;
  else
    select r.duration_minutes
      into v_duration
      from public.sbg_fleet_routes r
     where r.provider_id = p_provider_id
       and r.origin_location_id = p_origin_location_id
       and r.destination_location_id = p_destination_location_id
       and r.active;
  end if;
  if v_duration is null then
    return pg_catalog.jsonb_build_object(
      'feasible', false, 'vehicleIds', '[]'::jsonb,
      'rejections', pg_catalog.jsonb_build_array('route_missing'),
      'route', null, 'assessments', '[]'::jsonb,
      'schedule', pg_catalog.jsonb_build_object(
        'pickupAt', null, 'dropoffAt', null, 'bufferMinutes', 15,
        'previousEndsAt', null, 'earliestPickupAt', null,
        'nextStartsAt', null, 'latestDropoffAt', null
      )
    );
  end if;

  v_dropoff := v_pickup + pg_catalog.make_interval(mins => v_duration);
  v_route := pg_catalog.jsonb_build_object(
    'originLocationId', p_origin_location_id,
    'destinationLocationId', p_destination_location_id,
    'durationMinutes', v_duration
  );
  v_shared := pg_catalog.jsonb_build_object(
    'pickupAt', v_pickup, 'dropoffAt', v_dropoff, 'bufferMinutes', 15,
    'previousEndsAt', null, 'earliestPickupAt', null,
    'nextStartsAt', null, 'latestDropoffAt', null
  );

  if p_frozen_duration is null then
    v_pickup_date := (v_pickup at time zone v_tz)::date;
    v_dropoff_date := (v_dropoff at time zone v_tz)::date;
    v_date := v_pickup_date - 1;
    while v_date <= v_dropoff_date and v_count < 5 loop
      v_opens := null;
      v_closes := null;
      select e.closed, e.opens_local, e.closes_local
        into v_exception
        from public.sbg_provider_hour_exceptions e
       where e.provider_id = p_provider_id
         and e.service_date = v_date;
      if found then
        if v_exception.closed is not true and v_exception.opens_local is not null then
          v_opens := v_exception.opens_local;
          v_closes := v_exception.closes_local;
        end if;
      else
        select h.opens_local, h.closes_local
          into v_opens, v_closes
          from public.sbg_provider_hours h
         where h.provider_id = p_provider_id
           and h.isodow = extract(isodow from v_date);
      end if;
      if v_opens is not null and v_closes is not null then
        if v_opens < v_closes then
          v_close_date := v_date;
        else
          v_close_date := v_date + 1;
        end if;
        begin
          v_open_at := public.aether_civil_instant(v_date, v_opens, v_tz);
          v_close_at := public.aether_civil_instant(v_close_date, v_closes, v_tz);
          v_ranges := pg_catalog.array_append(v_ranges, v_open_at);
          v_range_ends := pg_catalog.array_append(v_range_ends, v_close_at);
        exception
          when others then
            null;
        end;
      end if;
      v_date := v_date + 1;
      v_count := v_count + 1;
    end loop;

    if v_ranges is not null then
      for v_i in 1 .. pg_catalog.array_length(v_ranges, 1) loop
        for v_j in v_i + 1 .. pg_catalog.array_length(v_ranges, 1) loop
          if v_ranges[v_j] < v_ranges[v_i]
             or (v_ranges[v_j] = v_ranges[v_i] and v_range_ends[v_j] < v_range_ends[v_i]) then
            v_open_at := v_ranges[v_i];
            v_ranges[v_i] := v_ranges[v_j];
            v_ranges[v_j] := v_open_at;
            v_close_at := v_range_ends[v_i];
            v_range_ends[v_i] := v_range_ends[v_j];
            v_range_ends[v_j] := v_close_at;
          end if;
        end loop;
      end loop;
      for v_i in 1 .. pg_catalog.array_length(v_ranges, 1) loop
        if v_range_ends[v_i] <= v_ranges[v_i] then
          continue;
        end if;
        if v_merged_s is null then
          v_merged_s := pg_catalog.array_append(v_merged_s, v_ranges[v_i]);
          v_merged_e := pg_catalog.array_append(v_merged_e, v_range_ends[v_i]);
        elsif v_ranges[v_i] > v_merged_e[pg_catalog.array_length(v_merged_e, 1)] then
          v_merged_s := pg_catalog.array_append(v_merged_s, v_ranges[v_i]);
          v_merged_e := pg_catalog.array_append(v_merged_e, v_range_ends[v_i]);
        elsif v_range_ends[v_i] > v_merged_e[pg_catalog.array_length(v_merged_e, 1)] then
          v_merged_e[pg_catalog.array_length(v_merged_e, 1)] := v_range_ends[v_i];
        end if;
      end loop;
    end if;
    if v_merged_s is not null then
      for v_i in 1 .. pg_catalog.array_length(v_merged_s, 1) loop
        if v_merged_s[v_i] <= v_pickup and v_merged_e[v_i] >= v_dropoff then
          v_covered := true;
        end if;
      end loop;
    end if;
    if not v_covered or v_dropoff <= v_pickup then
      return pg_catalog.jsonb_build_object(
        'feasible', false, 'vehicleIds', '[]'::jsonb,
        'rejections', pg_catalog.jsonb_build_array('outside_hours'),
        'route', v_route, 'assessments', '[]'::jsonb,
        'schedule', v_shared
      );
    end if;
  end if;

  for v_vehicle in
    select v.id, v.active, v.capacity, v.luggage_capacity, v.operated_by_provider_id
      from public.vehicles v
     where (p_vehicle_id is not null and v.id = p_vehicle_id)
        or (p_vehicle_id is null and v.operated_by_provider_id = p_provider_id)
     order by v.id
  loop
    v_rejections := array[]::text[];
    if v_vehicle.operated_by_provider_id is distinct from p_provider_id then
      v_rejections := pg_catalog.array_append(v_rejections, 'vehicle_provider');
    end if;
    if v_vehicle.active is not true then
      v_rejections := pg_catalog.array_append(v_rejections, 'inactive');
    end if;
    if p_passenger_count > v_vehicle.capacity then
      v_rejections := pg_catalog.array_append(v_rejections, 'seats');
    end if;
    if p_luggage_count > 0 and v_vehicle.luggage_capacity is null then
      v_rejections := pg_catalog.array_append(v_rejections, 'luggage_unknown');
    elsif v_vehicle.luggage_capacity is not null and p_luggage_count > v_vehicle.luggage_capacity then
      v_rejections := pg_catalog.array_append(v_rejections, 'luggage');
    end if;

    v_prev_ends := null;
    v_prev_destination := null;
    select c.ends_at, c.destination_location_id
      into v_prev_ends, v_prev_destination
      from (
        select pg_catalog.lower(b.occupies) as starts_at,
               pg_catalog.upper(b.occupies) as ends_at,
               i.origin_location_id,
               i.destination_location_id
          from public.bookings b
          left join public.sbg_booking_itinerary i on i.booking_id = b.id
         where b.vehicle_id = v_vehicle.id
           and b.cancelled_at is null
           and not pg_catalog.isempty(b.occupies)
           and (p_exclude_booking_id is null or b.id is distinct from p_exclude_booking_id)
           and pg_catalog.upper(b.occupies) <= v_pickup
         order by pg_catalog.upper(b.occupies) desc
         limit 1
      ) c;

    v_next_starts := null;
    v_next_origin := null;
    select c.starts_at, c.origin_location_id
      into v_next_starts, v_next_origin
      from (
        select pg_catalog.lower(b.occupies) as starts_at,
               pg_catalog.upper(b.occupies) as ends_at,
               i.origin_location_id,
               i.destination_location_id
          from public.bookings b
          left join public.sbg_booking_itinerary i on i.booking_id = b.id
         where b.vehicle_id = v_vehicle.id
           and b.cancelled_at is null
           and not pg_catalog.isempty(b.occupies)
           and (p_exclude_booking_id is null or b.id is distinct from p_exclude_booking_id)
           and pg_catalog.lower(b.occupies) >= v_dropoff
         order by pg_catalog.lower(b.occupies)
         limit 1
      ) c;

    if exists (
      select 1
        from public.bookings b
       where b.vehicle_id = v_vehicle.id
         and b.cancelled_at is null
         and not pg_catalog.isempty(b.occupies)
         and (p_exclude_booking_id is null or b.id is distinct from p_exclude_booking_id)
         and pg_catalog.lower(b.occupies) < v_dropoff
         and v_pickup < pg_catalog.upper(b.occupies)
    ) then
      v_rejections := pg_catalog.array_append(v_rejections, 'occupancy');
    end if;

    v_prev_need := 'null'::jsonb;
    v_prev_minutes := null;
    if v_prev_ends is not null then
      if v_prev_destination is null or p_origin_location_id is null then
        v_rejections := pg_catalog.array_append(v_rejections, 'previous_endpoint_unknown');
      elsif v_prev_destination = p_origin_location_id then
        v_prev_minutes := 0;
        v_prev_need := pg_catalog.jsonb_build_object(
          'fromLocationId', v_prev_destination,
          'toLocationId', p_origin_location_id,
          'durationMinutes', 0
        );
        if v_prev_ends + pg_catalog.make_interval(mins => 15) > v_pickup then
          v_rejections := pg_catalog.array_append(v_rejections, 'previous_reposition');
        end if;
      else
        select r.duration_minutes
          into v_prev_minutes
          from public.sbg_fleet_repositions r
         where r.provider_id = p_provider_id
           and r.from_location_id = v_prev_destination
           and r.to_location_id = p_origin_location_id;
        v_prev_need := pg_catalog.jsonb_build_object(
          'fromLocationId', v_prev_destination,
          'toLocationId', p_origin_location_id,
          'durationMinutes', v_prev_minutes
        );
        if v_prev_minutes is null then
          v_rejections := pg_catalog.array_append(v_rejections, 'reposition_missing');
        elsif v_prev_ends + pg_catalog.make_interval(mins => v_prev_minutes + 15) > v_pickup then
          v_rejections := pg_catalog.array_append(v_rejections, 'previous_reposition');
        end if;
      end if;
    end if;

    v_next_need := 'null'::jsonb;
    v_next_minutes := null;
    if v_next_starts is not null then
      if p_destination_location_id is null or v_next_origin is null then
        v_rejections := pg_catalog.array_append(v_rejections, 'next_endpoint_unknown');
      elsif p_destination_location_id = v_next_origin then
        v_next_minutes := 0;
        v_next_need := pg_catalog.jsonb_build_object(
          'fromLocationId', p_destination_location_id,
          'toLocationId', v_next_origin,
          'durationMinutes', 0
        );
        if v_dropoff + pg_catalog.make_interval(mins => 15) > v_next_starts then
          v_rejections := pg_catalog.array_append(v_rejections, 'next_reposition');
        end if;
      else
        select r.duration_minutes
          into v_next_minutes
          from public.sbg_fleet_repositions r
         where r.provider_id = p_provider_id
           and r.from_location_id = p_destination_location_id
           and r.to_location_id = v_next_origin;
        v_next_need := pg_catalog.jsonb_build_object(
          'fromLocationId', p_destination_location_id,
          'toLocationId', v_next_origin,
          'durationMinutes', v_next_minutes
        );
        if v_next_minutes is null then
          v_rejections := pg_catalog.array_append(v_rejections, 'reposition_missing');
        elsif v_dropoff + pg_catalog.make_interval(mins => v_next_minutes + 15) > v_next_starts then
          v_rejections := pg_catalog.array_append(v_rejections, 'next_reposition');
        end if;
      end if;
    end if;

    v_hit := false;
    for v_block in
      select u.starts_at, u.ends_at
        from public.sbg_vehicle_unavailability u
       where u.vehicle_id = v_vehicle.id
    loop
      if v_pickup < v_block.ends_at and v_block.starts_at < v_dropoff then
        v_hit := true;
      end if;
      if v_prev_ends is not null and v_prev_minutes is not null and v_prev_minutes > 0 then
        v_span_start := v_prev_ends;
        v_span_end := v_prev_ends + pg_catalog.make_interval(mins => v_prev_minutes);
        if v_span_start < v_block.ends_at and v_block.starts_at < v_span_end then
          v_hit := true;
        end if;
      end if;
      if v_next_starts is not null and v_next_minutes is not null and v_next_minutes > 0 then
        v_span_start := v_dropoff;
        v_span_end := v_dropoff + pg_catalog.make_interval(mins => v_next_minutes);
        if v_span_start < v_block.ends_at and v_block.starts_at < v_span_end then
          v_hit := true;
        end if;
      end if;
    end loop;
    if v_hit then
      v_rejections := pg_catalog.array_append(v_rejections, 'maintenance');
    end if;

    v_bounds := pg_catalog.jsonb_build_object(
      'pickupAt', v_pickup,
      'dropoffAt', v_dropoff,
      'bufferMinutes', 15,
      'previousEndsAt', v_prev_ends,
      'earliestPickupAt', case
        when v_prev_ends is not null and v_prev_minutes is not null
          then v_prev_ends + pg_catalog.make_interval(mins => v_prev_minutes + 15)
        else null
      end,
      'nextStartsAt', v_next_starts,
      'latestDropoffAt', case
        when v_next_starts is not null and v_next_minutes is not null
          then v_next_starts - pg_catalog.make_interval(mins => v_next_minutes + 15)
        else null
      end
    );
    select coalesce(pg_catalog.jsonb_agg(code order by code), '[]'::jsonb)
      into v_one
      from (select distinct unnest(v_rejections) as code) s;
    v_vehicles := v_vehicles || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'vehicleId', v_vehicle.id,
      'eligible', pg_catalog.jsonb_array_length(v_one) = 0,
      'rejections', v_one,
      'previousReposition', case when v_prev_ends is null then null else v_prev_need end,
      'nextReposition', case when v_next_starts is null then null else v_next_need end,
      'bounds', v_bounds
    ));
  end loop;

  if pg_catalog.jsonb_array_length(v_vehicles) = 0 then
    return pg_catalog.jsonb_build_object(
      'feasible', false, 'vehicleIds', '[]'::jsonb,
      'rejections', pg_catalog.jsonb_build_array('not_found'),
      'route', v_route, 'assessments', '[]'::jsonb,
      'schedule', v_shared
    );
  end if;

  select coalesce(pg_catalog.jsonb_agg(elem order by elem->>'vehicleId'), '[]'::jsonb)
    into v_vehicles
    from pg_catalog.jsonb_array_elements(v_vehicles) elem;

  select coalesce(pg_catalog.jsonb_agg(elem->>'vehicleId' order by elem->>'vehicleId'), '[]'::jsonb)
    into v_eligible
    from pg_catalog.jsonb_array_elements(v_vehicles) elem
   where (elem->>'eligible')::boolean;

  if pg_catalog.jsonb_array_length(v_eligible) > 0 then
    v_flat := array[]::text[];
  else
    select coalesce(pg_catalog.array_agg(distinct code order by code), array[]::text[])
      into v_flat
      from pg_catalog.jsonb_array_elements(v_vehicles) elem
      cross join lateral pg_catalog.jsonb_array_elements_text(elem->'rejections') as code;
  end if;

  if p_vehicle_id is not null then
    v_schedule := v_vehicles->0->'bounds';
  else
    v_schedule := v_shared;
  end if;

  return pg_catalog.jsonb_build_object(
    'feasible', pg_catalog.jsonb_array_length(v_eligible) > 0,
    'vehicleIds', v_eligible,
    'rejections', coalesce((select pg_catalog.jsonb_agg(code order by code) from unnest(v_flat) as code), '[]'::jsonb),
    'route', v_route,
    'assessments', v_vehicles,
    'schedule', v_schedule
  );
end;
$assess$;

revoke all on function public.sbg_assess_capacity(uuid, uuid, uuid, uuid, date, time, integer, integer, uuid, uuid, integer) from public;
grant execute on function public.sbg_assess_capacity(uuid, uuid, uuid, uuid, date, time, integer, integer, uuid, uuid, integer) to sbg_capacity_writer;

create or replace function public.sbg_bookings_capacity_managed_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $guard$
begin
  if tg_op = 'INSERT' then
    if new.capacity_managed then
      raise exception 'capacity dispatch is not directly writable'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.capacity_managed is not true and new.capacity_managed is not true then
    return new;
  end if;

  if current_user is distinct from 'sbg_capacity_writer' then
    if new.capacity_managed is distinct from old.capacity_managed
       or new.vehicle_id is distinct from old.vehicle_id
       or new.cancelled_at is distinct from old.cancelled_at
       or new.driver_id is distinct from old.driver_id
       or new.lifecycle_state is distinct from old.lifecycle_state
       or new.hold_expires_at is distinct from old.hold_expires_at
       or new.confirmed_paid_at is distinct from old.confirmed_paid_at
       or new.duration_minutes is distinct from old.duration_minutes then
      raise exception 'capacity dispatch is not directly writable'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.capacity_managed is not true and new.capacity_managed is true then
    if new.vehicle_id is null
       or old.vehicle_id is not null
       or new.lifecycle_state is distinct from 'awaiting_payment'
       or new.hold_expires_at is null
       or new.confirmed_paid_at is not null
       or new.cancelled_at is not null
       or new.driver_id is not null
       or new.duration_minutes is null
       or new.duration_minutes < 1 then
      raise exception 'capacity dispatch is not directly writable'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.capacity_managed is distinct from true
     or new.duration_minutes is distinct from old.duration_minutes
     or new.capacity_managed is distinct from old.capacity_managed then
    raise exception 'capacity dispatch is not directly writable'
      using errcode = '42501';
  end if;

  if new.lifecycle_state = 'confirmed_paid'
     and old.lifecycle_state in ('awaiting_payment', 'payment_processing') then
    if new.confirmed_paid_at is null
       or new.vehicle_id is distinct from old.vehicle_id
       or new.hold_expires_at is null
       or new.hold_expires_at < pg_catalog.clock_timestamp()
       or new.cancelled_at is not null then
      raise exception 'capacity dispatch is not directly writable'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.lifecycle_state in ('expired', 'failed')
     and old.lifecycle_state in ('awaiting_payment', 'payment_processing') then
    if new.vehicle_id is not null or new.confirmed_paid_at is not null then
      raise exception 'capacity dispatch is not directly writable'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.lifecycle_state = 'cancelled'
     and old.lifecycle_state in ('awaiting_payment', 'payment_processing', 'confirmed_paid') then
    if new.vehicle_id is not null or new.cancelled_at is null then
      raise exception 'capacity dispatch is not directly writable'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.lifecycle_state = 'refunded' and old.lifecycle_state = 'confirmed_paid' then
    if new.vehicle_id is not null
       or new.cancelled_at is null
       or old.confirmed_paid_at is null then
      raise exception 'capacity dispatch is not directly writable'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.lifecycle_state = 'confirmed_paid' and old.lifecycle_state = 'confirmed_paid' then
    if new.confirmed_paid_at is distinct from old.confirmed_paid_at
       or new.cancelled_at is not null
       or new.hold_expires_at is distinct from old.hold_expires_at
       or new.vehicle_id is null then
      raise exception 'capacity dispatch is not directly writable'
        using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'capacity dispatch is not directly writable'
    using errcode = '42501';
end;
$guard$;

create or replace function public.sbg_bookings_dispatch_admission_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $dispatch$
declare
  v_assign_vehicle boolean;
  v_assign_driver boolean;
  v_paid boolean;
begin
  if tg_op = 'INSERT' then
    v_assign_vehicle := new.vehicle_id is not null;
    v_assign_driver := new.driver_id is not null;
  else
    v_assign_vehicle := new.vehicle_id is not null and new.vehicle_id is distinct from old.vehicle_id;
    v_assign_driver := new.driver_id is not null and new.driver_id is distinct from old.driver_id;
  end if;
  if not v_assign_vehicle and not v_assign_driver then
    return new;
  end if;
  if new.cancelled_at is not null then
    raise exception 'dispatch_not_admitted' using errcode = '42501';
  end if;
  if v_assign_vehicle and not exists (
    select 1
      from public.vehicles v
     where v.id = new.vehicle_id
       and v.operated_by_provider_id = new.executing_provider_id
  ) then
    raise exception 'dispatch_not_admitted' using errcode = '42501';
  end if;
  if v_assign_driver and not exists (
    select 1
      from public.drivers d
     where d.id = new.driver_id
       and d.dispatched_by_provider_id = new.executing_provider_id
  ) then
    raise exception 'dispatch_not_admitted' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE'
     and old.capacity_managed is not true
     and new.capacity_managed is true
     and old.vehicle_id is null
     and new.vehicle_id is not null
     and old.lifecycle_state = 'legacy_unreconciled'
     and new.lifecycle_state = 'awaiting_payment'
     and new.hold_expires_at is not null
     and new.cancelled_at is null
     and new.driver_id is null
     and new.confirmed_paid_at is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.lifecycle_state = 'legacy_unreconciled'
     and new.lifecycle_state = 'legacy_unreconciled' then
    return new;
  end if;
  if tg_op = 'INSERT' and new.lifecycle_state = 'legacy_unreconciled' then
    return new;
  end if;

  if new.lifecycle_state is distinct from 'confirmed_paid' or new.confirmed_paid_at is null then
    raise exception 'dispatch_not_admitted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.lifecycle_state is distinct from 'confirmed_paid' then
    raise exception 'dispatch_not_admitted' using errcode = '42501';
  end if;

  select exists (
    select 1
      from public.sbg_booking_payments p
     where p.booking_id = new.id
       and p.status = 'paid'
       and p.paid_at is not null
       and p.executing_provider_id = new.executing_provider_id
       and p.payee_organisation_id is not null
       and p.payee_stripe_account_id is not null
       and p.payee_kind is not null
       and p.authority_bound_at is not null
  ) into v_paid;
  if not v_paid then
    raise exception 'dispatch_not_admitted' using errcode = '42501';
  end if;

  begin
    perform 1 from public.sbg_resolve_executing_payee(new.id);
  exception
    when sqlstate 'P0001' or sqlstate 'P0002' then
      raise exception 'dispatch_not_admitted' using errcode = '42501';
  end;
  return new;
end;
$dispatch$;

create or replace function public.sbg_capacity_settle(
  p_booking_id uuid,
  p_action text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $settle$
declare
  v_vehicle uuid;
  v_managed boolean;
  v_seen uuid;
begin
  select b.vehicle_id, b.capacity_managed
    into v_seen, v_managed
    from public.bookings b
   where b.id = p_booking_id;
  if not found or v_managed is not true then
    raise exception 'payment_transition_conflict' using errcode = '40001';
  end if;
  perform public.sbg_capacity_lock_vehicle(v_seen);

  select b.vehicle_id
    into v_vehicle
    from public.bookings b
   where b.id = p_booking_id
   for update;
  if v_vehicle is distinct from v_seen then
    raise exception 'capacity_lock_retry' using errcode = '40001';
  end if;

  if p_action = 'confirm' then
    update public.bookings
       set lifecycle_state = 'confirmed_paid',
           confirmed_paid_at = pg_catalog.clock_timestamp()
     where id = p_booking_id
       and capacity_managed
       and lifecycle_state in ('awaiting_payment', 'payment_processing')
       and hold_expires_at is not null
       and hold_expires_at >= pg_catalog.clock_timestamp()
       and confirmed_paid_at is null
       and vehicle_id is not null;
    if not found then
      raise exception 'payment_transition_conflict' using errcode = '40001';
    end if;
  elsif p_action = 'expire' then
    update public.bookings
       set lifecycle_state = 'expired',
           vehicle_id = null
     where id = p_booking_id
       and capacity_managed
       and lifecycle_state in ('awaiting_payment', 'payment_processing')
       and hold_expires_at is not null
       and hold_expires_at <= pg_catalog.clock_timestamp()
       and confirmed_paid_at is null;
  elsif p_action = 'fail' then
    update public.bookings
       set lifecycle_state = 'failed',
           vehicle_id = null
     where id = p_booking_id
       and capacity_managed
       and lifecycle_state in ('awaiting_payment', 'payment_processing')
       and confirmed_paid_at is null;
  elsif p_action = 'refund' then
    update public.bookings
       set lifecycle_state = 'refunded',
           vehicle_id = null,
           cancelled_at = coalesce(cancelled_at, pg_catalog.clock_timestamp())
     where id = p_booking_id
       and capacity_managed
       and lifecycle_state = 'confirmed_paid'
       and confirmed_paid_at is not null;
  else
    raise exception 'payment_transition_conflict' using errcode = '40001';
  end if;
end;
$settle$;

revoke all on function public.sbg_capacity_settle(uuid, text) from public;

create or replace function public.sbg_reserve_capacity(
  p_booking_id uuid,
  p_origin_location_id uuid,
  p_destination_location_id uuid,
  p_vehicle_id uuid
) returns table (
  reserve_outcome text,
  reserve_booking_id uuid,
  reserve_vehicle_id uuid,
  reserve_lifecycle text,
  reserve_hold_expires_at timestamptz,
  reserve_duration_minutes integer,
  reserve_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $reserve$
declare
  v_row public.bookings%rowtype;
  v_candidate uuid;
  v_locked uuid;
  v_assessment jsonb;
  v_duration integer;
  v_rejection text;
  v_request_code text;
  v_chosen uuid;
begin
  if p_booking_id is null
     or p_origin_location_id is null
     or p_destination_location_id is null then
    reserve_outcome := 'not_found';
    return next;
    return;
  end if;

  select * into v_row from public.bookings b where b.id = p_booking_id;
  if not found then
    reserve_outcome := 'not_found';
    return next;
    return;
  end if;

  if v_row.capacity_managed
     and v_row.lifecycle_state = 'awaiting_payment'
     and v_row.vehicle_id is not null
     and v_row.hold_expires_at > pg_catalog.clock_timestamp()
     and v_row.cancelled_at is null
     and (p_vehicle_id is null or p_vehicle_id = v_row.vehicle_id) then
    reserve_outcome := 'reserved';
    reserve_booking_id := v_row.id;
    reserve_vehicle_id := v_row.vehicle_id;
    reserve_lifecycle := v_row.lifecycle_state;
    reserve_hold_expires_at := v_row.hold_expires_at;
    reserve_duration_minutes := v_row.duration_minutes;
    return next;
    return;
  end if;

  if v_row.lifecycle_state is distinct from 'legacy_unreconciled'
     or v_row.vehicle_id is not null
     or v_row.driver_id is not null
     or v_row.cancelled_at is not null
     or v_row.capacity_managed
     or v_row.confirmed_paid_at is not null
     or exists (
       select 1 from public.sbg_booking_payments p where p.booking_id = p_booking_id
     ) then
    reserve_outcome := 'incompatible';
    reserve_booking_id := v_row.id;
    return next;
    return;
  end if;

  v_chosen := null;
  for v_candidate in
    select v.id
      from public.vehicles v
     where v.operated_by_provider_id = v_row.executing_provider_id
       and (p_vehicle_id is null or v.id = p_vehicle_id)
     order by v.id
  loop
    if p_vehicle_id is null then
      if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(v_candidate::text, 20260302)) then
        continue;
      end if;
    else
      perform public.sbg_capacity_lock_vehicle(v_candidate);
    end if;
    v_locked := v_candidate;

    perform public.sbg_capacity_lock_scope(
      v_row.executing_provider_id,
      array[v_candidate],
      array[p_origin_location_id, p_destination_location_id]
    );
    perform 1
      from public.bookings b
     where b.id = p_booking_id
        or (b.vehicle_id = v_candidate and b.cancelled_at is null)
     order by b.id
     for update;

    select * into v_row from public.bookings b where b.id = p_booking_id;
    if v_row.lifecycle_state is distinct from 'legacy_unreconciled'
       or v_row.vehicle_id is not null
       or v_row.capacity_managed then
      reserve_outcome := 'incompatible';
      reserve_booking_id := p_booking_id;
      return next;
      return;
    end if;

    v_assessment := public.sbg_assess_capacity(
      v_row.executing_provider_id,
      v_row.hotel_id,
      p_origin_location_id,
      p_destination_location_id,
      v_row.transfer_date,
      v_row.pickup_time,
      v_row.passenger_count,
      v_row.luggage_count,
      v_candidate,
      p_booking_id,
      null
    );
    v_request_code := v_assessment->'rejections'->>0;
    if v_request_code in (
      'invalid_request', 'not_found', 'time_nonexistent', 'time_ambiguous',
      'invalid_time', 'route_missing', 'outside_hours'
    ) and jsonb_array_length(v_assessment->'vehicleIds') = 0
       and jsonb_array_length(v_assessment->'assessments') = 0 then
      reserve_outcome := 'unavailable';
      reserve_booking_id := p_booking_id;
      reserve_rejection := v_request_code;
      return next;
      return;
    end if;

    if coalesce((v_assessment->>'feasible')::boolean, false)
       and v_assessment->'vehicleIds' ? v_candidate::text then
      v_chosen := v_candidate;
      v_duration := (v_assessment->'route'->>'durationMinutes')::integer;
      exit;
    end if;

    v_rejection := v_assessment->'assessments'->0->'rejections'->>0;
    if p_vehicle_id is not null then
      reserve_outcome := 'unavailable';
      reserve_booking_id := p_booking_id;
      reserve_rejection := coalesce(v_rejection, 'unavailable');
      return next;
      return;
    end if;
  end loop;

  if v_chosen is null then
    reserve_outcome := 'unavailable';
    reserve_booking_id := p_booking_id;
    reserve_rejection := coalesce(v_rejection, 'not_found');
    return next;
    return;
  end if;

  begin
    update public.bookings
       set vehicle_id = v_chosen,
           capacity_managed = true,
           lifecycle_state = 'awaiting_payment',
           hold_expires_at = pg_catalog.clock_timestamp() + interval '30 minutes',
           duration_minutes = v_duration
     where id = p_booking_id
       and lifecycle_state = 'legacy_unreconciled'
       and vehicle_id is null
       and capacity_managed is not true
       and cancelled_at is null
       and driver_id is null;
    if not found then
      reserve_outcome := 'incompatible';
      reserve_booking_id := p_booking_id;
      return next;
      return;
    end if;

    insert into public.sbg_booking_itinerary (
      booking_id, origin_location_id, destination_location_id
    ) values (
      p_booking_id, p_origin_location_id, p_destination_location_id
    )
    on conflict (booking_id) do nothing;

    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'server',
      'capacity_reserved',
      p_booking_id,
      pg_catalog.jsonb_build_object('vehicle_id', v_chosen, 'duration_minutes', v_duration)
    );
  exception
    when exclusion_violation then
      reserve_outcome := 'unavailable';
      reserve_booking_id := p_booking_id;
      reserve_rejection := 'occupancy';
      return next;
      return;
  end;

  select b.lifecycle_state, b.hold_expires_at, b.duration_minutes
    into reserve_lifecycle, reserve_hold_expires_at, reserve_duration_minutes
    from public.bookings b
   where b.id = p_booking_id;
  reserve_outcome := 'reserved';
  reserve_booking_id := p_booking_id;
  reserve_vehicle_id := v_chosen;
  return next;
end;
$reserve$;

revoke all on function public.sbg_reserve_capacity(uuid, uuid, uuid, uuid) from public;

create or replace function public.sbg_release_capacity(p_booking_id uuid)
returns table (
  reserve_outcome text,
  reserve_booking_id uuid,
  reserve_vehicle_id uuid,
  reserve_lifecycle text,
  reserve_hold_expires_at timestamptz,
  reserve_duration_minutes integer,
  reserve_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $release$
declare
  v_seen uuid;
  v_managed boolean;
  v_vehicle uuid;
  v_state text;
begin
  select b.vehicle_id, b.capacity_managed
    into v_seen, v_managed
    from public.bookings b
   where b.id = p_booking_id;
  if not found then
    reserve_outcome := 'not_found';
    return next;
    return;
  end if;
  if v_managed is not true then
    reserve_outcome := 'incompatible';
    reserve_booking_id := p_booking_id;
    return next;
    return;
  end if;
  perform public.sbg_capacity_lock_vehicle(v_seen);
  select b.vehicle_id, b.lifecycle_state
    into v_vehicle, v_state
    from public.bookings b
   where b.id = p_booking_id
   for update;
  if v_vehicle is distinct from v_seen then
    raise exception 'capacity_lock_retry' using errcode = '40001';
  end if;
  if v_state = 'cancelled' and v_vehicle is null then
    reserve_outcome := 'released';
    reserve_booking_id := p_booking_id;
    reserve_lifecycle := 'cancelled';
    return next;
    return;
  end if;
  if v_state not in ('awaiting_payment', 'payment_processing', 'confirmed_paid') then
    reserve_outcome := 'incompatible';
    reserve_booking_id := p_booking_id;
    reserve_lifecycle := v_state;
    return next;
    return;
  end if;

  update public.bookings
     set lifecycle_state = 'cancelled',
         cancelled_at = coalesce(cancelled_at, pg_catalog.clock_timestamp()),
         vehicle_id = null
   where id = p_booking_id
     and capacity_managed
     and lifecycle_state = v_state
     and vehicle_id is not distinct from v_vehicle;
  if not found then
    reserve_outcome := 'incompatible';
    reserve_booking_id := p_booking_id;
    return next;
    return;
  end if;
  insert into public.audit_events (actor_type, action, booking_id, payload)
  values ('server', 'capacity_released', p_booking_id, pg_catalog.jsonb_build_object('previous_lifecycle', v_state));
  reserve_outcome := 'released';
  reserve_booking_id := p_booking_id;
  reserve_lifecycle := 'cancelled';
  return next;
end;
$release$;

revoke all on function public.sbg_release_capacity(uuid) from public;

create or replace function public.sbg_reassign_capacity_vehicle(
  p_booking_id uuid,
  p_vehicle_id uuid
) returns table (
  reserve_outcome text,
  reserve_booking_id uuid,
  reserve_vehicle_id uuid,
  reserve_lifecycle text,
  reserve_hold_expires_at timestamptz,
  reserve_duration_minutes integer,
  reserve_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $reassign$
declare
  v_row public.bookings%rowtype;
  v_origin uuid;
  v_destination uuid;
  v_first uuid;
  v_second uuid;
  v_assessment jsonb;
  v_rejection text;
begin
  if p_vehicle_id is null then
    reserve_outcome := 'incompatible';
    reserve_booking_id := p_booking_id;
    return next;
    return;
  end if;
  select * into v_row from public.bookings b where b.id = p_booking_id;
  if not found then
    reserve_outcome := 'not_found';
    return next;
    return;
  end if;
  if v_row.capacity_managed is not true
     or v_row.lifecycle_state is distinct from 'confirmed_paid'
     or v_row.vehicle_id is null
     or v_row.cancelled_at is not null then
    reserve_outcome := 'incompatible';
    reserve_booking_id := p_booking_id;
    return next;
    return;
  end if;
  if v_row.vehicle_id = p_vehicle_id then
    reserve_outcome := 'reassigned';
    reserve_booking_id := p_booking_id;
    reserve_vehicle_id := p_vehicle_id;
    reserve_lifecycle := v_row.lifecycle_state;
    return next;
    return;
  end if;

  if v_row.vehicle_id < p_vehicle_id then
    v_first := v_row.vehicle_id;
    v_second := p_vehicle_id;
  else
    v_first := p_vehicle_id;
    v_second := v_row.vehicle_id;
  end if;
  perform public.sbg_capacity_lock_vehicle(v_first);
  perform public.sbg_capacity_lock_vehicle(v_second);

  select i.origin_location_id, i.destination_location_id
    into v_origin, v_destination
    from public.sbg_booking_itinerary i
   where i.booking_id = p_booking_id;

  perform public.sbg_capacity_lock_scope(
    v_row.executing_provider_id,
    array[v_first, v_second],
    array[v_origin, v_destination]
  );
  perform 1
    from public.bookings b
   where b.id = p_booking_id
      or (b.vehicle_id in (v_first, v_second) and b.cancelled_at is null)
   order by b.id
   for update;

  select * into v_row from public.bookings b where b.id = p_booking_id;
  if v_row.capacity_managed is not true
     or v_row.lifecycle_state is distinct from 'confirmed_paid'
     or v_row.cancelled_at is not null
     or v_row.vehicle_id is null then
    reserve_outcome := 'incompatible';
    reserve_booking_id := p_booking_id;
    reserve_lifecycle := v_row.lifecycle_state;
    return next;
    return;
  end if;
  v_assessment := public.sbg_assess_capacity(
    v_row.executing_provider_id,
    v_row.hotel_id,
    v_origin,
    v_destination,
    v_row.transfer_date,
    v_row.pickup_time,
    v_row.passenger_count,
    v_row.luggage_count,
    p_vehicle_id,
    p_booking_id,
    v_row.duration_minutes
  );
  if coalesce((v_assessment->>'feasible')::boolean, false) is not true then
    v_rejection := coalesce(
      v_assessment->'assessments'->0->'rejections'->>0,
      v_assessment->'rejections'->>0,
      'unavailable'
    );
    reserve_outcome := 'unavailable';
    reserve_booking_id := p_booking_id;
    reserve_rejection := v_rejection;
    return next;
    return;
  end if;

  begin
    update public.bookings
       set vehicle_id = p_vehicle_id
     where id = p_booking_id
       and capacity_managed
       and lifecycle_state = 'confirmed_paid'
       and vehicle_id = v_row.vehicle_id
       and cancelled_at is null;
    if not found then
      reserve_outcome := 'incompatible';
      reserve_booking_id := p_booking_id;
      return next;
      return;
    end if;
  exception
    when exclusion_violation then
      reserve_outcome := 'unavailable';
      reserve_booking_id := p_booking_id;
      reserve_rejection := 'occupancy';
      return next;
      return;
    when sqlstate '42501' then
      reserve_outcome := 'unavailable';
      reserve_booking_id := p_booking_id;
      reserve_rejection := 'vehicle_provider';
      return next;
      return;
  end;

  reserve_outcome := 'reassigned';
  reserve_booking_id := p_booking_id;
  reserve_vehicle_id := p_vehicle_id;
  reserve_lifecycle := 'confirmed_paid';
  return next;
end;
$reassign$;

revoke all on function public.sbg_reassign_capacity_vehicle(uuid, uuid) from public;

create or replace function public.sbg_assign_capacity_driver(
  p_booking_id uuid,
  p_driver_id uuid
) returns table (
  reserve_outcome text,
  reserve_booking_id uuid,
  reserve_vehicle_id uuid,
  reserve_lifecycle text,
  reserve_hold_expires_at timestamptz,
  reserve_duration_minutes integer,
  reserve_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $assign_driver$
declare
  v_vehicle uuid;
  v_state text;
  v_managed boolean;
begin
  select b.vehicle_id, b.lifecycle_state, b.capacity_managed
    into v_vehicle, v_state, v_managed
    from public.bookings b
   where b.id = p_booking_id;
  if not found then
    reserve_outcome := 'not_found';
    return next;
    return;
  end if;
  if v_managed is not true or v_state is distinct from 'confirmed_paid' then
    reserve_outcome := 'incompatible';
    reserve_booking_id := p_booking_id;
    return next;
    return;
  end if;
  perform public.sbg_capacity_lock_vehicle(v_vehicle);
  perform 1 from public.bookings b where b.id = p_booking_id for update;
  begin
    update public.bookings
       set driver_id = p_driver_id
     where id = p_booking_id
       and capacity_managed
       and lifecycle_state = 'confirmed_paid'
       and cancelled_at is null;
  exception
    when exclusion_violation then
      reserve_outcome := 'unavailable';
      reserve_booking_id := p_booking_id;
      reserve_rejection := 'occupancy';
      return next;
      return;
    when sqlstate '42501' then
      reserve_outcome := 'incompatible';
      reserve_booking_id := p_booking_id;
      return next;
      return;
  end;
  reserve_outcome := 'assigned';
  reserve_booking_id := p_booking_id;
  reserve_vehicle_id := v_vehicle;
  reserve_lifecycle := 'confirmed_paid';
  return next;
end;
$assign_driver$;

revoke all on function public.sbg_assign_capacity_driver(uuid, uuid) from public;

create or replace function public.sbg_dispatch_set_vehicle(
  p_booking_id uuid,
  p_vehicle_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $dispatch_vehicle$
declare
  v_managed boolean;
  v_current uuid;
  v_seen uuid;
  v_cancelled timestamptz;
  v_provider uuid;
  v_vehicle_provider uuid;
  v_active boolean;
begin
  if p_booking_id is null then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  select b.vehicle_id
    into v_seen
    from public.bookings b
   where b.id = p_booking_id;
  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  if v_seen is not null and (p_vehicle_id is null or v_seen <= p_vehicle_id) then
    perform public.sbg_capacity_lock_vehicle(v_seen);
    if p_vehicle_id is not null and p_vehicle_id is distinct from v_seen then
      perform public.sbg_capacity_lock_vehicle(p_vehicle_id);
    end if;
  elsif p_vehicle_id is not null then
    perform public.sbg_capacity_lock_vehicle(p_vehicle_id);
    if v_seen is not null and v_seen is distinct from p_vehicle_id then
      perform public.sbg_capacity_lock_vehicle(v_seen);
    end if;
  end if;

  if p_vehicle_id is not null then
    perform 1 from public.vehicles v where v.id = p_vehicle_id for share;
  end if;

  select b.capacity_managed, b.vehicle_id, b.cancelled_at, b.executing_provider_id
    into v_managed, v_current, v_cancelled, v_provider
    from public.bookings b
   where b.id = p_booking_id
   for update;
  if v_current is distinct from v_seen then
    raise exception 'capacity_lock_retry' using errcode = '40001';
  end if;
  if v_managed then
    raise exception 'dispatch_not_admitted' using errcode = '42501';
  end if;
  if p_vehicle_id is not distinct from v_current then
    return;
  end if;
  if v_cancelled is not null then
    raise exception 'dispatch_not_admitted' using errcode = '42501';
  end if;

  if p_vehicle_id is not null then
    select v.operated_by_provider_id, v.active
      into v_vehicle_provider, v_active
      from public.vehicles v
     where v.id = p_vehicle_id;
    if not found
       or v_vehicle_provider is distinct from v_provider
       or v_active is not true then
      raise exception 'dispatch_not_admitted' using errcode = '42501';
    end if;
  end if;

  update public.bookings
     set vehicle_id = p_vehicle_id
   where id = p_booking_id;
end;
$dispatch_vehicle$;

create or replace function public.sbg_expire_provisional_holds(p_limit integer)
returns table (
  expired_booking_id uuid,
  previous_lifecycle text,
  observed_payment_status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $expire$
declare
  v_row record;
  v_payment text;
  v_seen uuid;
  v_vehicle uuid;
  v_managed boolean;
  v_state text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'unsafe_expiry_limit' using errcode = '22023';
  end if;

  for v_row in
    select b.id, b.lifecycle_state, b.hold_expires_at, b.vehicle_id, b.driver_id
      from public.bookings b
     where b.lifecycle_state in ('awaiting_payment', 'payment_processing')
       and b.capacity_managed is not true
       and b.hold_expires_at <= pg_catalog.clock_timestamp()
       and b.confirmed_paid_at is null
       and not exists (
         select 1
           from public.sbg_booking_payments p
          where p.booking_id = b.id
            and p.status in ('paid', 'received_after_expiry')
       )
     order by b.hold_expires_at, b.id
     limit p_limit
     for update of b skip locked
  loop
    select p.status
      into v_payment
      from public.sbg_booking_payments p
     where p.booking_id = v_row.id
     for update;
    if v_payment in ('paid', 'received_after_expiry') then
      continue;
    end if;

    update public.bookings
       set lifecycle_state = 'expired'
     where id = v_row.id
       and capacity_managed is not true
       and lifecycle_state = v_row.lifecycle_state
       and lifecycle_state in ('awaiting_payment', 'payment_processing')
       and confirmed_paid_at is null
       and vehicle_id is not distinct from v_row.vehicle_id
       and driver_id is not distinct from v_row.driver_id;
    if not found then
      continue;
    end if;

    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'expiry_worker',
      'hold_expired',
      v_row.id,
      pg_catalog.jsonb_build_object(
        'previous_lifecycle', v_row.lifecycle_state,
        'hold_expires_at', v_row.hold_expires_at,
        'payment_status', v_payment
      )
    );

    expired_booking_id := v_row.id;
    previous_lifecycle := v_row.lifecycle_state;
    observed_payment_status := v_payment;
    return next;
  end loop;

  for v_row in
    select b.id
      from public.bookings b
     where b.capacity_managed
       and b.lifecycle_state in ('awaiting_payment', 'payment_processing')
       and b.hold_expires_at <= pg_catalog.clock_timestamp()
       and b.confirmed_paid_at is null
       and not exists (
         select 1
           from public.sbg_booking_payments p
          where p.booking_id = b.id
            and p.status in ('paid', 'received_after_expiry')
       )
     order by b.hold_expires_at, b.id
     limit p_limit
  loop
    select b.vehicle_id
      into v_seen
      from public.bookings b
     where b.id = v_row.id;
    perform public.sbg_capacity_lock_vehicle(v_seen);
    select b.vehicle_id, b.capacity_managed, b.lifecycle_state, b.hold_expires_at
      into v_vehicle, v_managed, v_state, previous_lifecycle
      from public.bookings b
     where b.id = v_row.id
     for update;
    if v_vehicle is distinct from v_seen
       or v_managed is not true
       or v_state not in ('awaiting_payment', 'payment_processing') then
      continue;
    end if;
    select p.status
      into v_payment
      from public.sbg_booking_payments p
     where p.booking_id = v_row.id
     for update;
    if v_payment in ('paid', 'received_after_expiry') then
      continue;
    end if;
    perform public.sbg_capacity_settle(v_row.id, 'expire');
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'expiry_worker',
      'hold_expired',
      v_row.id,
      pg_catalog.jsonb_build_object('previous_lifecycle', v_state, 'payment_status', v_payment)
    );
    expired_booking_id := v_row.id;
    previous_lifecycle := v_state;
    observed_payment_status := v_payment;
    return next;
  end loop;
end;
$expire$;

create or replace function sbg_apply_payment_event(
  p_event_id text, p_event_type text, p_booking_id uuid, p_payment_id uuid,
  p_payment_intent_id text, p_status text, p_stripe_account_id text
)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  if p_booking_id is not null and exists (
    select 1
      from bookings b
     where b.id = p_booking_id
       and b.capacity_managed
  ) then
    return false;
  end if;

  insert into sbg_stripe_events (event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (event_id) do nothing;
  if not found then return false; end if;

  if not exists (
    select 1
      from sbg_booking_payments p
      join bookings b on b.id = p.booking_id
      join sbg_stripe_connections c on c.hotel_id = b.hotel_id
     where p.id = p_payment_id
       and p.booking_id = p_booking_id
       and c.stripe_account_id = p_stripe_account_id
       and c.disconnected_at is null
  ) then return false; end if;

  update sbg_booking_payments
     set stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id),
         status = p_status,
         paid_at = case when p_status = 'paid' then coalesce(paid_at, now()) else paid_at end,
         updated_at = now()
   where id = p_payment_id and booking_id = p_booking_id;
  return true;
end;
$$;
create or replace function public.sbg_accept_verified_payment_event(
  p_signature_verified boolean,
  p_event_id text,
  p_event_type text,
  p_booking_id uuid,
  p_payment_id uuid,
  p_executing_provider_id uuid,
  p_account_id text,
  p_session_id text,
  p_amount_minor integer,
  p_currency text,
  p_payment_status text,
  p_payment_intent_id text
) returns table (
  transition_outcome text,
  transition_lifecycle text,
  transition_payment_status text,
  transition_event_recorded boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $accept$
declare
  v_lifecycle text;
  v_hold timestamptz;
  v_payment_booking uuid;
  v_payment_status text;
  v_org uuid;
  v_assessment text;
  v_class text;
  v_open boolean;
  v_confirmable boolean := false;
  v_drift boolean := false;
  v_resolved record;
  v_recorded boolean := false;
  v_managed boolean := false;
  v_vehicle uuid;
  v_seen_vehicle uuid;
begin
  if p_signature_verified is not true then
    insert into public.audit_events (actor_type, action, payload)
    values (
      'stripe_webhook',
      'payment_event_rejected',
      pg_catalog.jsonb_build_object('reason', 'signature_not_verified', 'event_id', p_event_id)
    );
    transition_outcome := 'signature_not_verified';
    transition_event_recorded := false;
    return next;
    return;
  end if;

  if p_event_id is null
     or p_event_id !~ '^evt_[A-Za-z0-9_]+$'
     or char_length(p_event_id) > 255 then
    insert into public.audit_events (actor_type, action, payload)
    values (
      'stripe_webhook',
      'payment_event_rejected',
      pg_catalog.jsonb_build_object('reason', 'event_id_required')
    );
    transition_outcome := 'event_id_required';
    transition_event_recorded := false;
    return next;
    return;
  end if;

  if exists (select 1 from public.sbg_stripe_events e where e.event_id = p_event_id) then
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'stripe_webhook',
      'payment_event_duplicate',
      (select b.id from public.bookings b where b.id = p_booking_id),
      pg_catalog.jsonb_build_object('event_id', p_event_id)
    );
    transition_outcome := 'duplicate';
    transition_event_recorded := false;
    return next;
    return;
  end if;

  if p_booking_id is null then
    insert into public.audit_events (actor_type, action, payload)
    values (
      'stripe_webhook',
      'payment_event_rejected',
      pg_catalog.jsonb_build_object('reason', 'booking', 'event_id', p_event_id)
    );
    transition_outcome := 'booking';
    transition_event_recorded := false;
    return next;
    return;
  end if;

  select b.vehicle_id
    into v_seen_vehicle
    from public.bookings b
   where b.id = p_booking_id;
  if v_seen_vehicle is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_seen_vehicle::text, 20260302));
  end if;

  select b.lifecycle_state, b.hold_expires_at, b.capacity_managed, b.vehicle_id
    into v_lifecycle, v_hold, v_managed, v_vehicle
    from public.bookings b
   where b.id = p_booking_id
   for update;
  if found and v_managed is true and v_vehicle is distinct from v_seen_vehicle then
    raise exception 'capacity_lock_retry' using errcode = '40001';
  end if;

  if not found then
    insert into public.audit_events (actor_type, action, payload)
    values (
      'stripe_webhook',
      'payment_event_rejected',
      pg_catalog.jsonb_build_object('reason', 'booking', 'event_id', p_event_id, 'booking_id', p_booking_id)
    );
    transition_outcome := 'booking';
    transition_event_recorded := false;
    return next;
    return;
  end if;

  select p.booking_id, p.status, p.payee_organisation_id
    into v_payment_booking, v_payment_status, v_org
    from public.sbg_booking_payments p
   where p.id = p_payment_id
   for update;
  if not found then
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'stripe_webhook',
      'payment_event_rejected',
      p_booking_id,
      pg_catalog.jsonb_build_object('reason', 'payment', 'event_id', p_event_id)
    );
    transition_outcome := 'payment';
    transition_event_recorded := false;
    return next;
    return;
  end if;
  if v_payment_booking is distinct from p_booking_id then
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'stripe_webhook',
      'payment_event_rejected',
      p_booking_id,
      pg_catalog.jsonb_build_object('reason', 'booking', 'event_id', p_event_id)
    );
    transition_outcome := 'booking';
    transition_event_recorded := false;
    return next;
    return;
  end if;

  if exists (select 1 from public.sbg_stripe_events e where e.event_id = p_event_id) then
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'stripe_webhook',
      'payment_event_duplicate',
      p_booking_id,
      pg_catalog.jsonb_build_object('event_id', p_event_id)
    );
    transition_outcome := 'duplicate';
    transition_lifecycle := v_lifecycle;
    transition_payment_status := v_payment_status;
    transition_event_recorded := false;
    return next;
    return;
  end if;

  v_assessment := public.sbg_assess_payment_authority_event(
    p_booking_id,
    p_payment_id,
    p_executing_provider_id,
    p_account_id,
    p_session_id,
    p_amount_minor,
    p_currency
  );
  if v_assessment is distinct from 'matched' then
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'stripe_webhook',
      'payment_event_rejected',
      p_booking_id,
      pg_catalog.jsonb_build_object('reason', v_assessment, 'event_id', p_event_id)
    );
    transition_outcome := v_assessment;
    transition_lifecycle := v_lifecycle;
    transition_payment_status := v_payment_status;
    transition_event_recorded := false;
    return next;
    return;
  end if;

  v_class := case
    when p_event_type = 'checkout.session.completed' and p_payment_status = 'paid' then 'success'
    when p_event_type = 'checkout.session.async_payment_succeeded' then 'success'
    when p_event_type = 'checkout.session.async_payment_failed' then 'failure'
    when p_event_type = 'checkout.session.expired' then 'expired_session'
    when p_event_type in ('charge.refunded', 'refund.updated') then 'refund'
    when p_event_type = 'checkout.session.completed' then 'processing'
    else 'unsupported'
  end;

  if v_class = 'unsupported' then
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'stripe_webhook',
      'payment_event_rejected',
      p_booking_id,
      pg_catalog.jsonb_build_object('reason', 'unsupported_event', 'event_id', p_event_id, 'event_type', p_event_type)
    );
    transition_outcome := 'unsupported_event';
    transition_lifecycle := v_lifecycle;
    transition_payment_status := v_payment_status;
    transition_event_recorded := false;
    return next;
    return;
  end if;

  v_open := v_lifecycle in ('awaiting_payment', 'payment_processing')
    and v_hold is not null
    and v_hold >= pg_catalog.clock_timestamp();

  -- Confirmable payment statuses are an unfinished Checkout attempt:
  -- pending, an expired Checkout Session, or a canceled Checkout Session.
  -- None of those is an expired booking hold. v_open is that hold deadline.
  -- paid, received_after_expiry, and failed cannot confirm. A later success
  -- after failed is late reconciliation, not a resurrection of the hold.
  v_confirmable := v_class = 'success'
    and v_open
    and v_payment_status in ('pending', 'expired', 'canceled');

  if v_confirmable then
    begin
      select *
        into v_resolved
        from public.sbg_resolve_executing_payee(p_booking_id);
      if not found
         or v_resolved.resolved_payee_organisation_id is distinct from v_org
         or v_resolved.resolved_stripe_account_id is distinct from p_account_id then
        v_drift := true;
      end if;
    exception
      when sqlstate 'P0001' then
        v_drift := true;
    end;
    if v_drift then
      insert into public.audit_events (actor_type, action, booking_id, payload)
      values (
        'stripe_webhook',
        'payment_event_rejected',
        p_booking_id,
        pg_catalog.jsonb_build_object('reason', 'authority_drift', 'event_id', p_event_id)
      );
      transition_outcome := 'authority_drift';
      transition_lifecycle := v_lifecycle;
      transition_payment_status := v_payment_status;
      transition_event_recorded := false;
      return next;
      return;
    end if;
  end if;

  if v_class = 'success' and v_lifecycle = 'legacy_unreconciled' then
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'stripe_webhook',
      'payment_event_rejected',
      p_booking_id,
      pg_catalog.jsonb_build_object('reason', 'ineligible_lifecycle', 'event_id', p_event_id)
    );
    transition_outcome := 'ineligible_lifecycle';
    transition_lifecycle := v_lifecycle;
    transition_payment_status := v_payment_status;
    transition_event_recorded := false;
    return next;
    return;
  end if;

  if v_class = 'refund' and (v_lifecycle is distinct from 'confirmed_paid' or v_payment_status is distinct from 'paid') then
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'stripe_webhook',
      'payment_event_rejected',
      p_booking_id,
      pg_catalog.jsonb_build_object('reason', 'refund_not_applicable', 'event_id', p_event_id)
    );
    transition_outcome := 'refund_not_applicable';
    transition_lifecycle := v_lifecycle;
    transition_payment_status := v_payment_status;
    transition_event_recorded := false;
    return next;
    return;
  end if;

  insert into public.sbg_stripe_events (event_id, event_type, organisation_id, outcome)
  values (p_event_id, p_event_type, v_org, 'applied')
  on conflict (event_id) do nothing;
  if not found then
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'stripe_webhook',
      'payment_event_duplicate',
      p_booking_id,
      pg_catalog.jsonb_build_object('event_id', p_event_id)
    );
    transition_outcome := 'duplicate';
    transition_lifecycle := v_lifecycle;
    transition_payment_status := v_payment_status;
    transition_event_recorded := false;
    return next;
    return;
  end if;
  v_recorded := true;

  if v_confirmable then
    update public.sbg_booking_payments
       set status = 'paid',
           paid_at = coalesce(paid_at, pg_catalog.clock_timestamp()),
           stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id),
           updated_at = pg_catalog.clock_timestamp()
     where id = p_payment_id
       and status in ('pending', 'expired', 'canceled');
    if v_managed then
      perform public.sbg_capacity_settle(p_booking_id, 'confirm');
    else
      update public.bookings
         set lifecycle_state = 'confirmed_paid',
             confirmed_paid_at = pg_catalog.clock_timestamp()
       where id = p_booking_id
         and lifecycle_state = v_lifecycle
         and lifecycle_state in ('awaiting_payment', 'payment_processing')
         and hold_expires_at is not null
         and hold_expires_at >= pg_catalog.clock_timestamp()
         and confirmed_paid_at is null;
      if not found then
        raise exception 'payment_transition_conflict' using errcode = '40001';
      end if;
    end if;
    transition_outcome := 'confirmed_paid';
  elsif v_class = 'success' then
    if v_payment_status in ('paid', 'received_after_expiry') or v_lifecycle in ('confirmed_paid', 'refunded') then
      transition_outcome := 'ignored_after_settlement';
    else
      update public.sbg_booking_payments
         set status = 'received_after_expiry',
             stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id),
             updated_at = pg_catalog.clock_timestamp()
       where id = p_payment_id
         and status is distinct from 'paid'
         and status is distinct from 'received_after_expiry';
      if v_lifecycle in ('awaiting_payment', 'payment_processing') then
        if v_managed then
          perform public.sbg_capacity_settle(p_booking_id, 'expire');
        else
          update public.bookings
             set lifecycle_state = 'expired'
           where id = p_booking_id
             and lifecycle_state = v_lifecycle
             and confirmed_paid_at is null;
        end if;
      end if;
      transition_outcome := 'late_payment';
    end if;
  elsif v_class = 'failure' then
    if v_payment_status in ('paid', 'received_after_expiry') or v_lifecycle in ('confirmed_paid', 'refunded') then
      transition_outcome := 'ignored_after_settlement';
    else
      update public.sbg_booking_payments
         set status = 'failed',
             updated_at = pg_catalog.clock_timestamp()
       where id = p_payment_id
         and status = 'pending';
      if v_lifecycle in ('awaiting_payment', 'payment_processing') then
        if v_managed then
          perform public.sbg_capacity_settle(p_booking_id, 'fail');
        else
          update public.bookings
             set lifecycle_state = 'failed'
           where id = p_booking_id
             and lifecycle_state = v_lifecycle
             and confirmed_paid_at is null;
        end if;
      end if;
      transition_outcome := 'payment_failed';
    end if;
  elsif v_class = 'expired_session' then
    if v_payment_status in ('paid', 'received_after_expiry') or v_lifecycle in ('confirmed_paid', 'refunded') then
      transition_outcome := 'ignored_after_settlement';
    else
      update public.sbg_booking_payments
         set status = 'expired',
             updated_at = pg_catalog.clock_timestamp()
       where id = p_payment_id
         and status = 'pending';
      transition_outcome := 'payment_canceled';
    end if;
  elsif v_class = 'refund' then
    if v_managed then
      perform public.sbg_capacity_settle(p_booking_id, 'refund');
    else
      update public.bookings
         set lifecycle_state = 'refunded'
       where id = p_booking_id
         and lifecycle_state = 'confirmed_paid'
         and confirmed_paid_at is not null;
    end if;
    transition_outcome := 'refunded';
  else
    transition_outcome := 'processing';
  end if;

  select b.lifecycle_state into v_lifecycle from public.bookings b where b.id = p_booking_id;
  select p.status into v_payment_status from public.sbg_booking_payments p where p.id = p_payment_id;
  insert into public.audit_events (actor_type, action, booking_id, payload)
  values (
    'stripe_webhook',
    'payment_event_' || transition_outcome,
    p_booking_id,
    pg_catalog.jsonb_build_object(
      'event_id', p_event_id,
      'outcome', transition_outcome,
      'payment_id', p_payment_id
    )
  );
  transition_lifecycle := v_lifecycle;
  transition_payment_status := v_payment_status;
  transition_event_recorded := v_recorded;
  return next;
end;
$accept$;


alter function public.sbg_capacity_lock_vehicle(uuid) owner to sbg_capacity_writer;
alter function public.sbg_capacity_settle(uuid, text) owner to sbg_capacity_writer;
alter function public.sbg_reserve_capacity(uuid, uuid, uuid, uuid) owner to sbg_capacity_writer;
alter function public.sbg_release_capacity(uuid) owner to sbg_capacity_writer;
alter function public.sbg_reassign_capacity_vehicle(uuid, uuid) owner to sbg_capacity_writer;
alter function public.sbg_assign_capacity_driver(uuid, uuid) owner to sbg_capacity_writer;

do $priv$
declare
  v_owner name;
begin
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'grant execute on function public.sbg_assess_capacity(uuid, uuid, uuid, uuid, date, time, integer, integer, uuid, uuid, integer) to aether_app';
    execute 'grant execute on function public.sbg_reserve_capacity(uuid, uuid, uuid, uuid) to aether_app';
    execute 'grant execute on function public.sbg_release_capacity(uuid) to aether_app';
    execute 'grant execute on function public.sbg_reassign_capacity_vehicle(uuid, uuid) to aether_app';
    execute 'grant execute on function public.sbg_assign_capacity_driver(uuid, uuid) to aether_app';
    execute 'revoke all on function public.sbg_capacity_settle(uuid, text) from aether_app';
    execute 'revoke all on function public.sbg_capacity_lock_vehicle(uuid) from aether_app';
    execute 'revoke all on function public.sbg_capacity_lock_scope(uuid, uuid[], uuid[]) from aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'grant execute on function public.sbg_assess_capacity(uuid, uuid, uuid, uuid, date, time, integer, integer, uuid, uuid, integer) to aether_runtime';
    execute 'grant execute on function public.sbg_reserve_capacity(uuid, uuid, uuid, uuid) to aether_runtime';
    execute 'grant execute on function public.sbg_release_capacity(uuid) to aether_runtime';
    execute 'grant execute on function public.sbg_reassign_capacity_vehicle(uuid, uuid) to aether_runtime';
    execute 'grant execute on function public.sbg_assign_capacity_driver(uuid, uuid) to aether_runtime';
    execute 'revoke all on function public.sbg_capacity_settle(uuid, text) from aether_runtime';
    execute 'revoke all on function public.sbg_capacity_lock_vehicle(uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_capacity_lock_scope(uuid, uuid[], uuid[]) from aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_webhook') then
    execute 'revoke all on function public.sbg_reserve_capacity(uuid, uuid, uuid, uuid) from aether_webhook';
    execute 'revoke all on function public.sbg_release_capacity(uuid) from aether_webhook';
    execute 'revoke all on function public.sbg_capacity_settle(uuid, text) from aether_webhook';
    execute 'revoke all on function public.sbg_capacity_lock_scope(uuid, uuid[], uuid[]) from aether_webhook';
    execute 'revoke all on function public.sbg_reassign_capacity_vehicle(uuid, uuid) from aether_webhook';
    execute 'revoke all on function public.sbg_assign_capacity_driver(uuid, uuid) from aether_webhook';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_mailer') then
    execute 'revoke all on function public.sbg_reserve_capacity(uuid, uuid, uuid, uuid) from aether_mailer';
    execute 'revoke all on function public.sbg_release_capacity(uuid) from aether_mailer';
    execute 'revoke all on function public.sbg_capacity_settle(uuid, text) from aether_mailer';
    execute 'revoke all on function public.sbg_capacity_lock_scope(uuid, uuid[], uuid[]) from aether_mailer';
  end if;
  select r.rolname into v_owner
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
   where p.proname = 'sbg_accept_verified_payment_event'
   limit 1;
  if v_owner is not null then
    execute format('grant execute on function public.sbg_capacity_settle(uuid, text) to %I', v_owner);
    execute format('grant execute on function public.sbg_capacity_lock_vehicle(uuid) to %I', v_owner);
  end if;
end
$priv$;

revoke sbg_capacity_writer from current_user;

comment on function public.sbg_reserve_capacity(uuid, uuid, uuid, uuid) is
  'Atomically rechecks feasibility and opens a 30-minute capacity hold. Does not authenticate an operator. Route duration replaces the stored duration. Returns unavailable instead of another provider''s fleet.';
comment on function public.sbg_capacity_settle(uuid, text) is
  'Capacity payment outcome. Confirm keeps the vehicle only while the hold is unexpired. Expiry, failure, and refund clear vehicle_id. Not granted to application roles.';
