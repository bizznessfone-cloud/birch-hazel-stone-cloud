-- Gate 2 Stage 5D — operating hours and exception integrity. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0072.
-- Does not open checkout, admit a payment, or rewrite a booking.
--
-- Reuses sbg_fleet_writer. Does not create another operational role and does
-- not grant that role capacity, payment, webhook, or expiry authority.
-- Application roles stay SELECT-only on the schedule tables. They may
-- execute the writers below. A caller-supplied provider id is only an
-- ownership key. It is not authentication. There is no hours editor; a
-- future caller must pass the provider already bound to the authenticated
-- operator session.
--
-- sbg_assess_capacity skips hours when duration is frozen. These writers
-- therefore re-check each protected journey's committed occupies interval
-- against the proposed window, using the same precedence as assess:
-- a date exception replaces the window that starts that civil date; a
-- missing exception is not a closed day; a closed exception removes only
-- that start; the previous overnight tail is unchanged. opens > closes is
-- an overnight window. Coverage is one merged range containing the whole
-- pickup and dropoff. Nonexistent and ambiguous civil times are not
-- normalised: a window endpoint that aether_civil_instant rejects is
-- skipped, which is the established assess behaviour.
--
-- Protected journeys are capacity-managed, not cancelled, and still assigned
-- to a vehicle: open holds, payment_processing, and confirmed_paid. Legacy
-- assignments are not in that set and are not rewritten. This file does not
-- claim they are protected.
--
-- Lock order matches Stage 3. Vehicles currently operated by the provider
-- are locked in ascending uuid order through sbg_capacity_lock_vehicle
-- (pg_advisory_xact_lock(hashtextextended(vehicle_id::text, 20260302))).
-- The hours or exception row is then locked, then sbg_capacity_lock_scope,
-- then those vehicles' bookings FOR SHARE. No second advisory key. No
-- payment lock. Operator writers wait at most 2s. lock_not_available,
-- deadlock, and a drifted operated-by set return rejected/lock_busy and
-- write nothing. Guest sbg_reserve_capacity is not modified and still waits.
--
-- Owner UPDATE of vehicles.operated_by_provider_id or owned_by_provider_id
-- does not take the Stage 3 lock. This file locks only the operated-by set
-- observed at lock time and writes nothing if that set changes before the
-- schedule write. That hole is not closed. Direct owner UPDATE of hours
-- or exceptions also remains outside the protocol.

grant sbg_fleet_writer to current_user;

grant select on table public.providers to sbg_fleet_writer;

grant insert, update, delete on table
  public.sbg_provider_hours,
  public.sbg_provider_hour_exceptions
to sbg_fleet_writer;

create or replace function public.sbg_fleet_lock_hours(
  p_provider_id uuid,
  p_isodow smallint
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $lock_hours$
begin
  if p_provider_id is null or p_isodow is null then
    return;
  end if;
  perform 1
    from public.sbg_provider_hours h
   where h.provider_id = p_provider_id
     and h.isodow = p_isodow
   for update;
end;
$lock_hours$;

create or replace function public.sbg_fleet_lock_hour_exception(
  p_provider_id uuid,
  p_service_date date
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $lock_exception$
begin
  if p_provider_id is null or p_service_date is null then
    return;
  end if;
  perform 1
    from public.sbg_provider_hour_exceptions e
   where e.provider_id = p_provider_id
     and e.service_date = p_service_date
   for update;
end;
$lock_exception$;

revoke all on function public.sbg_fleet_lock_hours(uuid, smallint) from public;
revoke all on function public.sbg_fleet_lock_hour_exception(uuid, date) from public;
grant execute on function public.sbg_fleet_lock_hours(uuid, smallint) to sbg_fleet_writer;
grant execute on function public.sbg_fleet_lock_hour_exception(uuid, date) to sbg_fleet_writer;

-- True when a protected journey would not fit entirely inside the schedule
-- after the single proposed weekday or exception change. Null overrides mean
-- "no change of that kind".
create or replace function public.sbg_fleet_hours_blocked(
  p_provider_id uuid,
  p_vehicle_ids uuid[],
  p_replace_dow smallint,
  p_dow_opens time,
  p_dow_closes time,
  p_clear_dow smallint,
  p_replace_date date,
  p_closed boolean,
  p_ex_opens time,
  p_ex_closes time,
  p_clear_date date
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $hours_blocked$
declare
  v_booking record;
  v_pickup timestamptz;
  v_dropoff timestamptz;
  v_pickup_date date;
  v_dropoff_date date;
  v_date date;
  v_count integer;
  v_opens time;
  v_closes time;
  v_exception record;
  v_use_exception boolean;
  v_close_date date;
  v_open_at timestamptz;
  v_close_at timestamptz;
  v_ranges timestamptz[];
  v_range_ends timestamptz[];
  v_merged_s timestamptz[];
  v_merged_e timestamptz[];
  v_i integer;
  v_j integer;
  v_covered boolean;
  v_dow smallint;
begin
  for v_booking in
    select h.iana_timezone as tz,
           pg_catalog.lower(b.occupies) as pickup_at,
           pg_catalog.upper(b.occupies) as dropoff_at
      from public.bookings b
      join public.hotels h on h.id = b.hotel_id
     where b.vehicle_id = any (p_vehicle_ids)
       and b.cancelled_at is null
       and b.capacity_managed
       and b.vehicle_id is not null
       and not pg_catalog.isempty(b.occupies)
     order by b.id
  loop
    if v_booking.tz is null or pg_catalog.btrim(v_booking.tz) = '' then
      return true;
    end if;
    v_pickup := v_booking.pickup_at;
    v_dropoff := v_booking.dropoff_at;
    if v_dropoff <= v_pickup then
      return true;
    end if;
    v_pickup_date := (v_pickup at time zone pg_catalog.btrim(v_booking.tz))::date;
    v_dropoff_date := (v_dropoff at time zone pg_catalog.btrim(v_booking.tz))::date;
    v_ranges := null;
    v_range_ends := null;
    v_merged_s := null;
    v_merged_e := null;
    v_date := v_pickup_date - 1;
    v_count := 0;
    while v_date <= v_dropoff_date and v_count < 5 loop
      v_opens := null;
      v_closes := null;
      v_use_exception := false;
      v_dow := extract(isodow from v_date)::smallint;
      if p_clear_date is not null and v_date = p_clear_date then
        v_use_exception := false;
      elsif p_replace_date is not null and v_date = p_replace_date then
        v_use_exception := true;
        if p_closed is not true then
          v_opens := p_ex_opens;
          v_closes := p_ex_closes;
        end if;
      else
        select e.closed, e.opens_local, e.closes_local
          into v_exception
          from public.sbg_provider_hour_exceptions e
         where e.provider_id = p_provider_id
           and e.service_date = v_date;
        if found then
          v_use_exception := true;
          if v_exception.closed is not true and v_exception.opens_local is not null then
            v_opens := v_exception.opens_local;
            v_closes := v_exception.closes_local;
          end if;
        end if;
      end if;
      if not v_use_exception then
        if p_clear_dow is not null and v_dow = p_clear_dow then
          v_opens := null;
          v_closes := null;
        elsif p_replace_dow is not null and v_dow = p_replace_dow then
          v_opens := p_dow_opens;
          v_closes := p_dow_closes;
        else
          select h.opens_local, h.closes_local
            into v_opens, v_closes
            from public.sbg_provider_hours h
           where h.provider_id = p_provider_id
             and h.isodow = v_dow;
        end if;
      end if;
      if v_opens is not null and v_closes is not null and v_opens <> v_closes then
        if v_opens < v_closes then
          v_close_date := v_date;
        else
          v_close_date := v_date + 1;
        end if;
        begin
          v_open_at := public.aether_civil_instant(v_date, v_opens, pg_catalog.btrim(v_booking.tz));
          v_close_at := public.aether_civil_instant(v_close_date, v_closes, pg_catalog.btrim(v_booking.tz));
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
    v_covered := false;
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
    if not v_covered then
      return true;
    end if;
  end loop;
  return false;
end;
$hours_blocked$;

revoke all on function public.sbg_fleet_hours_blocked(uuid, uuid[], smallint, time, time, smallint, date, boolean, time, time, date) from public;

create or replace function public.sbg_fleet_upsert_hours(
  p_provider_id uuid,
  p_isodow integer,
  p_opens time,
  p_closes time
) returns table (
  fleet_outcome text,
  fleet_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $upsert_hours$
declare
  v_ids uuid[];
  v_after uuid[];
  v_vehicle uuid;
  v_opens time;
  v_closes time;
  v_found boolean;
begin
  if p_provider_id is null or p_isodow is null or p_opens is null or p_closes is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    return next;
    return;
  end if;
  if p_isodow < 1 or p_isodow > 7 or p_opens = p_closes then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_window';
    return next;
    return;
  end if;
  if not exists (select 1 from public.providers p where p.id = p_provider_id) then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;

  set local lock_timeout = '2s';
  v_ids := public.sbg_fleet_lock_provider_vehicles(p_provider_id);
  perform public.sbg_fleet_lock_hours(p_provider_id, p_isodow::smallint);
  perform public.sbg_capacity_lock_scope(p_provider_id, v_ids, null);
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

  select h.opens_local, h.closes_local
    into v_opens, v_closes
    from public.sbg_provider_hours h
   where h.provider_id = p_provider_id
     and h.isodow = p_isodow;
  v_found := found;
  if v_found and v_opens = p_opens and v_closes = p_closes then
    fleet_outcome := 'unchanged';
    fleet_rejection := null;
    return next;
    return;
  end if;
  if public.sbg_fleet_hours_blocked(
    p_provider_id, v_ids, p_isodow::smallint, p_opens, p_closes,
    null, null, null, null, null, null
  ) then
    fleet_outcome := 'rejected';
    fleet_rejection := 'outside_hours';
    return next;
    return;
  end if;
  if not v_found then
    insert into public.sbg_provider_hours (provider_id, isodow, opens_local, closes_local)
    values (p_provider_id, p_isodow, p_opens, p_closes);
    fleet_outcome := 'inserted';
  else
    update public.sbg_provider_hours
       set opens_local = p_opens,
           closes_local = p_closes
     where provider_id = p_provider_id
       and isodow = p_isodow;
    fleet_outcome := 'updated';
  end if;
  fleet_rejection := null;
  return next;
exception
  when lock_not_available or deadlock_detected or serialization_failure or unique_violation then
    fleet_outcome := 'rejected';
    fleet_rejection := 'lock_busy';
    return next;
end;
$upsert_hours$;

create or replace function public.sbg_fleet_clear_hours(
  p_provider_id uuid,
  p_isodow integer
) returns table (
  fleet_outcome text,
  fleet_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $clear_hours$
declare
  v_ids uuid[];
  v_after uuid[];
  v_vehicle uuid;
begin
  if p_provider_id is null or p_isodow is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    return next;
    return;
  end if;
  if p_isodow < 1 or p_isodow > 7 then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_window';
    return next;
    return;
  end if;

  set local lock_timeout = '2s';
  v_ids := public.sbg_fleet_lock_provider_vehicles(p_provider_id);
  perform public.sbg_fleet_lock_hours(p_provider_id, p_isodow::smallint);
  perform public.sbg_capacity_lock_scope(p_provider_id, v_ids, null);
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
  if not exists (
    select 1 from public.sbg_provider_hours h
     where h.provider_id = p_provider_id and h.isodow = p_isodow
  ) then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;
  if public.sbg_fleet_hours_blocked(
    p_provider_id, v_ids, null, null, null,
    p_isodow::smallint, null, null, null, null, null
  ) then
    fleet_outcome := 'rejected';
    fleet_rejection := 'outside_hours';
    return next;
    return;
  end if;
  delete from public.sbg_provider_hours
   where provider_id = p_provider_id
     and isodow = p_isodow;
  fleet_outcome := 'deleted';
  fleet_rejection := null;
  return next;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    fleet_outcome := 'rejected';
    fleet_rejection := 'lock_busy';
    return next;
end;
$clear_hours$;

create or replace function public.sbg_fleet_upsert_hour_exception(
  p_provider_id uuid,
  p_service_date date,
  p_closed boolean,
  p_opens time,
  p_closes time
) returns table (
  fleet_outcome text,
  fleet_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $upsert_exception$
declare
  v_ids uuid[];
  v_after uuid[];
  v_vehicle uuid;
  v_closed boolean;
  v_opens time;
  v_closes time;
  v_found boolean;
begin
  if p_provider_id is null or p_service_date is null or p_closed is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    return next;
    return;
  end if;
  if p_closed then
    if p_opens is not null or p_closes is not null then
      fleet_outcome := 'invalid';
      fleet_rejection := 'invalid_window';
      return next;
      return;
    end if;
  elsif p_opens is null or p_closes is null or p_opens = p_closes then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_window';
    return next;
    return;
  end if;
  if not exists (select 1 from public.providers p where p.id = p_provider_id) then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;

  set local lock_timeout = '2s';
  v_ids := public.sbg_fleet_lock_provider_vehicles(p_provider_id);
  perform public.sbg_fleet_lock_hour_exception(p_provider_id, p_service_date);
  perform public.sbg_capacity_lock_scope(p_provider_id, v_ids, null);
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

  select e.closed, e.opens_local, e.closes_local
    into v_closed, v_opens, v_closes
    from public.sbg_provider_hour_exceptions e
   where e.provider_id = p_provider_id
     and e.service_date = p_service_date;
  v_found := found;
  if v_found
     and v_closed is not distinct from p_closed
     and v_opens is not distinct from p_opens
     and v_closes is not distinct from p_closes then
    fleet_outcome := 'unchanged';
    fleet_rejection := null;
    return next;
    return;
  end if;
  if public.sbg_fleet_hours_blocked(
    p_provider_id, v_ids, null, null, null, null,
    p_service_date, p_closed, p_opens, p_closes, null
  ) then
    fleet_outcome := 'rejected';
    fleet_rejection := 'outside_hours';
    return next;
    return;
  end if;
  if not v_found then
    insert into public.sbg_provider_hour_exceptions (
      provider_id, service_date, closed, opens_local, closes_local
    ) values (
      p_provider_id, p_service_date, p_closed, p_opens, p_closes
    );
    fleet_outcome := 'inserted';
  else
    update public.sbg_provider_hour_exceptions
       set closed = p_closed,
           opens_local = p_opens,
           closes_local = p_closes
     where provider_id = p_provider_id
       and service_date = p_service_date;
    fleet_outcome := 'updated';
  end if;
  fleet_rejection := null;
  return next;
exception
  when lock_not_available or deadlock_detected or serialization_failure or unique_violation then
    fleet_outcome := 'rejected';
    fleet_rejection := 'lock_busy';
    return next;
end;
$upsert_exception$;

create or replace function public.sbg_fleet_clear_hour_exception(
  p_provider_id uuid,
  p_service_date date
) returns table (
  fleet_outcome text,
  fleet_rejection text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $clear_exception$
declare
  v_ids uuid[];
  v_after uuid[];
  v_vehicle uuid;
begin
  if p_provider_id is null or p_service_date is null then
    fleet_outcome := 'invalid';
    fleet_rejection := 'invalid_request';
    return next;
    return;
  end if;

  set local lock_timeout = '2s';
  v_ids := public.sbg_fleet_lock_provider_vehicles(p_provider_id);
  perform public.sbg_fleet_lock_hour_exception(p_provider_id, p_service_date);
  perform public.sbg_capacity_lock_scope(p_provider_id, v_ids, null);
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
  if not exists (
    select 1 from public.sbg_provider_hour_exceptions e
     where e.provider_id = p_provider_id
       and e.service_date = p_service_date
  ) then
    fleet_outcome := 'not_found';
    fleet_rejection := 'not_found';
    return next;
    return;
  end if;
  if public.sbg_fleet_hours_blocked(
    p_provider_id, v_ids, null, null, null, null,
    null, null, null, null, p_service_date
  ) then
    fleet_outcome := 'rejected';
    fleet_rejection := 'outside_hours';
    return next;
    return;
  end if;
  delete from public.sbg_provider_hour_exceptions
   where provider_id = p_provider_id
     and service_date = p_service_date;
  fleet_outcome := 'deleted';
  fleet_rejection := null;
  return next;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    fleet_outcome := 'rejected';
    fleet_rejection := 'lock_busy';
    return next;
end;
$clear_exception$;

revoke all on function public.sbg_fleet_upsert_hours(uuid, integer, time, time) from public;
revoke all on function public.sbg_fleet_clear_hours(uuid, integer) from public;
revoke all on function public.sbg_fleet_upsert_hour_exception(uuid, date, boolean, time, time) from public;
revoke all on function public.sbg_fleet_clear_hour_exception(uuid, date) from public;

alter function public.sbg_fleet_hours_blocked(uuid, uuid[], smallint, time, time, smallint, date, boolean, time, time, date) owner to sbg_fleet_writer;
alter function public.sbg_fleet_upsert_hours(uuid, integer, time, time) owner to sbg_fleet_writer;
alter function public.sbg_fleet_clear_hours(uuid, integer) owner to sbg_fleet_writer;
alter function public.sbg_fleet_upsert_hour_exception(uuid, date, boolean, time, time) owner to sbg_fleet_writer;
alter function public.sbg_fleet_clear_hour_exception(uuid, date) owner to sbg_fleet_writer;

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
      execute format('revoke insert, update, delete on table public.sbg_provider_hours from %I', v_role);
      execute format('revoke insert, update, delete on table public.sbg_provider_hour_exceptions from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_lock_hours(uuid, smallint) from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_lock_hour_exception(uuid, date) from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_hours_blocked(uuid, uuid[], smallint, time, time, smallint, date, boolean, time, time, date) from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_upsert_hours(uuid, integer, time, time) from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_clear_hours(uuid, integer) from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_upsert_hour_exception(uuid, date, boolean, time, time) from %I', v_role);
      execute format('revoke all on function public.sbg_fleet_clear_hour_exception(uuid, date) from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'grant execute on function public.sbg_fleet_upsert_hours(uuid, integer, time, time) to aether_app';
    execute 'grant execute on function public.sbg_fleet_clear_hours(uuid, integer) to aether_app';
    execute 'grant execute on function public.sbg_fleet_upsert_hour_exception(uuid, date, boolean, time, time) to aether_app';
    execute 'grant execute on function public.sbg_fleet_clear_hour_exception(uuid, date) to aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'grant execute on function public.sbg_fleet_upsert_hours(uuid, integer, time, time) to aether_runtime';
    execute 'grant execute on function public.sbg_fleet_clear_hours(uuid, integer) to aether_runtime';
    execute 'grant execute on function public.sbg_fleet_upsert_hour_exception(uuid, date, boolean, time, time) to aether_runtime';
    execute 'grant execute on function public.sbg_fleet_clear_hour_exception(uuid, date) to aether_runtime';
  end if;
end
$priv$;

revoke sbg_fleet_writer from current_user;

comment on role sbg_fleet_writer is
  'NOLOGIN owner of vehicle, route, reposition, and operating-schedule writers. Not a capacity, payment, or expiry authority. Owner UPDATE of operated_by_provider_id remains outside this role.';

comment on function public.sbg_fleet_upsert_hours(uuid, integer, time, time) is
  'Insert or replace one weekday operating window for a provider. Rejects a window that leaves a protected journey outside the merged schedule. Does not rewrite the booking. Owner reassignment of operated_by is not closed.';

comment on function public.sbg_fleet_upsert_hour_exception(uuid, date, boolean, time, time) is
  'Replace the window that starts on service_date. Closed removes that start only. A missing exception is not closed. The previous overnight tail is unchanged. Rejects a change that uncovers a protected journey.';
