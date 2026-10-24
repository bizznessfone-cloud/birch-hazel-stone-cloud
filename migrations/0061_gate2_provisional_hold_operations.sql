-- Gate 2 Stage B — provisional hold open and expiry. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0060.
-- Does not change GiST, the occupancy trigger, duration, checkout, email, or dispatch.
-- Does not cancel a Stripe Checkout session.
--
-- Invocation: nothing in this migration schedules expiry. A later authorised
-- worker may call sbg_expire_provisional_holds. The guest booking route must not.
--
-- Lock order for the unpaid-expiry versus payment race: lock the booking row,
-- then the payment row. Stage D's verified-payment transition must use the same
-- order and must not confirm a booking whose lifecycle is already expired.
-- Until that transition exists, this function only implements the expiry side.
-- A payment that arrives after expiry stays a reconciliation case.

create or replace function public.sbg_open_provisional_hold(
  p_booking_id uuid,
  p_ttl_seconds integer
) returns table (
  opened_booking_id uuid,
  opened_lifecycle_state text,
  opened_hold_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $open$
declare
  v_state text;
  v_created timestamptz;
  v_vehicle uuid;
  v_driver uuid;
  v_cancelled timestamptz;
  v_expires timestamptz;
begin
  if p_booking_id is null
     or p_ttl_seconds is null
     or p_ttl_seconds < 60
     or p_ttl_seconds > 1800 then
    raise exception 'unsafe_hold_ttl' using errcode = '22023';
  end if;

  select b.lifecycle_state, b.created_at, b.vehicle_id, b.driver_id, b.cancelled_at
    into v_state, v_created, v_vehicle, v_driver, v_cancelled
    from public.bookings b
   where b.id = p_booking_id
   for update;

  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;
  if v_state = 'awaiting_payment' then
    raise exception 'duplicate_hold' using errcode = 'P0001';
  end if;
  if v_state is distinct from 'legacy_unreconciled' then
    raise exception 'incompatible_lifecycle' using errcode = 'P0001';
  end if;
  if v_vehicle is not null
     or v_driver is not null
     or v_cancelled is not null
     or exists (
       select 1 from public.sbg_booking_payments p where p.booking_id = p_booking_id
     ) then
    raise exception 'legacy_protected' using errcode = 'P0001';
  end if;
  if v_created < clock_timestamp() - interval '2 minutes' then
    raise exception 'not_newly_created' using errcode = 'P0001';
  end if;

  v_expires := clock_timestamp() + make_interval(secs => p_ttl_seconds);
  update public.bookings
     set lifecycle_state = 'awaiting_payment',
         hold_expires_at = v_expires
   where id = p_booking_id
     and lifecycle_state = 'legacy_unreconciled'
     and vehicle_id is null
     and driver_id is null
     and cancelled_at is null
     and confirmed_paid_at is null
     and hold_expires_at is null;
  if not found then
    raise exception 'incompatible_lifecycle' using errcode = 'P0001';
  end if;

  insert into public.audit_events (actor_type, action, booking_id, payload)
  values (
    'server',
    'hold_opened',
    p_booking_id,
    jsonb_build_object('ttl_seconds', p_ttl_seconds, 'hold_expires_at', v_expires)
  );

  opened_booking_id := p_booking_id;
  opened_lifecycle_state := 'awaiting_payment';
  opened_hold_expires_at := v_expires;
  return next;
end;
$open$;

create or replace function public.sbg_expire_provisional_holds(
  p_limit integer
) returns table (
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
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'unsafe_expiry_limit' using errcode = '22023';
  end if;

  for v_row in
    select b.id, b.lifecycle_state, b.hold_expires_at, b.vehicle_id, b.driver_id
      from public.bookings b
     where b.lifecycle_state in ('awaiting_payment', 'payment_processing')
       and b.hold_expires_at <= clock_timestamp()
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
      jsonb_build_object(
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
end;
$expire$;

revoke all on function public.sbg_open_provisional_hold(uuid, integer) from public;
revoke all on function public.sbg_expire_provisional_holds(integer) from public;

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke all on function public.sbg_open_provisional_hold(uuid, integer) from aether_runtime';
    execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke all on function public.sbg_open_provisional_hold(uuid, integer) from aether_app';
    execute 'grant execute on function public.sbg_open_provisional_hold(uuid, integer) to aether_app';
    execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from aether_app';
    execute 'grant execute on function public.sbg_expire_provisional_holds(integer) to aether_app';
  end if;
end
$priv$;

comment on function public.sbg_open_provisional_hold(uuid, integer) is
  'Opens awaiting_payment on a newly created unassigned booking. Rejects legacy, assigned, paid, and duplicate rows. TTL is seconds, 60 through 1800. Not a guest input.';
comment on function public.sbg_expire_provisional_holds(integer) is
  'Expires due unpaid holds. Skips paid and received_after_expiry. Does not change payment rows, vehicles, drivers, or Stripe sessions. Not scheduled.';
