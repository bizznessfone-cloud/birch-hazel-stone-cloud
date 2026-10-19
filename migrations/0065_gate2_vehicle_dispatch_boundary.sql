-- Gate 2 R2 Stage 1 — vehicle dispatch privilege boundary. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0064.
-- Does not reserve a vehicle, open checkout, change GiST, or admit a payment.
--
-- There is no per-operator database identity. Production logs in as the shared
-- role aether_app. Preview SET ROLE aether_runtime from the migration owner.
-- A caller-supplied operator_id, provider_id, session variable, or membership
-- lookup is not authenticated operator authority. This function does not
-- authenticate an operator. Operator authority stays in the application
-- assertDispatcher check. Direct execution by either application role can
-- still assign a compatible vehicle on any tenant's admitted booking. That
-- retained trust boundary is not independent operator authentication.
--
-- aether_app holds only a column grant for vehicle_id (0017), so revoking
-- that column is enough. aether_runtime still has the table-level UPDATE from
-- 0011, which a column revoke does not override (see 0060). That table grant
-- is replaced with the columns the desk still writes directly.
--
-- aether_runtime INSERT and DELETE on bookings came from the 0011 table grant.
-- The only legitimate insert is the guest booking shape in booking.ts, the
-- same columns 0017 grants aether_app. Table INSERT is revoked and replaced
-- with that column list, which excludes vehicle_id and capacity_managed.
-- No legitimate operation deletes a booking. DELETE is revoked. Keeping it
-- would let aether_runtime remove a future capacity-managed row (and its GiST
-- occupancy) without a lifecycle transition. Stage 3 must not grant it back.
--
-- sbg_dispatch_set_vehicle is the only application path that may change
-- vehicle_id. It refuses capacity_managed rows, cancelled rows, inactive
-- vehicles, and a vehicle operated by a different provider. It does not
-- widen what 0064 already admitted. Migration 0064 remains the admission
-- rule on the update: legacy desk assignment, or confirmed paid assignment.
-- Clearing is not a new assignment under 0064. This function is not a provisional reservation.
--
-- capacity_managed is immutable on every SQL path, including the table owner
-- and SECURITY DEFINER functions. A current_user allowlist would not see the
-- application role inside a security-definer body (current_user becomes the
-- owner; under preview SET ROLE, session_user is also the owner). Stage 3
-- must replace this guard in the same change that introduces an intentional
-- reservation writer. Disabling the trigger is owner-only and is not granted
-- to application roles.
--
-- Stage 3 must not activate a capacity-managed booking until it also:
--   * stops generic cancelled_at updates from releasing that row's occupancy;
--   * stops generic driver_id updates on that row;
--   * keeps vehicle_id and capacity_managed out of runtime and app INSERT;
--   * keeps DELETE on bookings revoked from both application roles.
--
-- Rollback: drop the function and the capacity_managed guard, grant update
-- (vehicle_id) back to aether_app, grant update, insert, delete on bookings
-- back to aether_runtime. The nullable-in-practice flag may stay false. Do
-- not edit 0003 or 0064 to roll this back.

alter table public.bookings
  add column if not exists capacity_managed boolean not null default false;

comment on column public.bookings.capacity_managed is
  'False on every historical and current desk booking. True only for a future capacity reservation. Immutable until Stage 3 replaces the guard. Application roles cannot set it.';

-- Invoker-rights on purpose. The check is not current_user, so a security-definer
-- writer cannot flip the flag by running as its owner. It does not authorise
-- a vehicle write.
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
  elsif new.capacity_managed is distinct from old.capacity_managed then
    raise exception 'capacity dispatch is not directly writable'
      using errcode = '42501';
  end if;
  return new;
end;
$guard$;

revoke all on function public.sbg_bookings_capacity_managed_guard() from public;

drop trigger if exists bookings_capacity_managed_guard on public.bookings;
create trigger bookings_capacity_managed_guard
  before insert or update on public.bookings
  for each row
  execute function public.sbg_bookings_capacity_managed_guard();

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
  v_cancelled timestamptz;
  v_provider uuid;
  v_vehicle_provider uuid;
  v_active boolean;
begin
  if p_booking_id is null then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  select b.capacity_managed, b.vehicle_id, b.cancelled_at, b.executing_provider_id
    into v_managed, v_current, v_cancelled, v_provider
    from public.bookings b
   where b.id = p_booking_id
   for update;

  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
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
     where v.id = p_vehicle_id
     for share;
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

revoke all on function public.sbg_dispatch_set_vehicle(uuid, uuid) from public;

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke update (vehicle_id) on table public.bookings from aether_app';
    execute 'revoke all on function public.sbg_dispatch_set_vehicle(uuid, uuid) from aether_app';
    execute 'revoke all on function public.sbg_bookings_capacity_managed_guard() from aether_app';
    execute 'grant execute on function public.sbg_dispatch_set_vehicle(uuid, uuid) to aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke update on table public.bookings from aether_runtime';
    execute 'grant update (driver_id, cancelled_at, status) on table public.bookings to aether_runtime';
    execute 'revoke insert, delete on table public.bookings from aether_runtime';
    execute 'grant insert (
      hotel_id,
      executing_provider_id,
      transfer_date,
      pickup_time,
      duration_minutes,
      guest_name,
      guest_phone,
      guest_email,
      passenger_count,
      luggage_count,
      pickup_text,
      destination_text,
      special_requirements,
      human_reference,
      confirmation_token,
      destination_id,
      quoted_amount_minor,
      quoted_currency
    ) on table public.bookings to aether_runtime';
    execute 'revoke all on function public.sbg_dispatch_set_vehicle(uuid, uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_bookings_capacity_managed_guard() from aether_runtime';
    execute 'grant execute on function public.sbg_dispatch_set_vehicle(uuid, uuid) to aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_webhook') then
    execute 'revoke all on function public.sbg_dispatch_set_vehicle(uuid, uuid) from aether_webhook';
    execute 'revoke all on function public.sbg_bookings_capacity_managed_guard() from aether_webhook';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_mailer') then
    execute 'revoke all on function public.sbg_dispatch_set_vehicle(uuid, uuid) from aether_mailer';
    execute 'revoke all on function public.sbg_bookings_capacity_managed_guard() from aether_mailer';
  end if;
end
$priv$;

comment on function public.sbg_dispatch_set_vehicle(uuid, uuid) is
  'Desk assign or clear of vehicle_id. Does not authenticate an operator. Refuses capacity_managed rows, cancelled bookings, inactive vehicles, and a vehicle from another provider. 0064 still admits only a legacy row or a confirmed paid row. This function is not a provisional reservation and not a caller-chosen deadline.';

comment on function public.sbg_bookings_capacity_managed_guard() is
  'capacity_managed is immutable for every role, including the table owner and security-definer writers. Stage 3 must replace this guard before a capacity reservation can be stored.';
