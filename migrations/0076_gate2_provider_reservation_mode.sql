-- Gate 2 Stage 6B — explicit provider reservation mode. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0075.
--
-- No earlier column is this authority:
--   providers.kind is in_house or external, not a booking mode.
--   hotel_provider_agreements.active chooses the executing provider.
--   bookings.capacity_managed is set by sbg_reserve_capacity, per row.
-- Fleet location count is not a mode.
--
-- Rows that already exist used the vehicle-less provisional hold. They are
-- marked legacy. That preserves them and does not activate capacity.
-- A provider inserted after this file stays unset until an owner sets the
-- column. Unset fails closed. Application roles cannot write the column.

alter table public.providers
  add column reservation_mode text;

update public.providers
   set reservation_mode = 'legacy'
 where reservation_mode is null;

alter table public.providers
  add constraint providers_reservation_mode_check
  check (reservation_mode is null or reservation_mode in ('legacy', 'capacity'));

comment on column public.providers.reservation_mode is
  'Guest reservation authority. legacy uses the vehicle-less provisional hold. capacity always calls sbg_reserve_capacity and never falls back. Null is unset and fails closed. Not inferred from fleet locations, provider kind, or agreement activity.';

-- Table-level UPDATE already held by aether_runtime is not removed by a
-- column revoke. The trigger is the authority that keeps those roles from
-- changing the mode. The owner is not in the list and can set it.
create or replace function public.sbg_providers_reservation_mode_guard()
returns trigger
language plpgsql
as $guard$
begin
  if current_user in (
    'aether_app', 'aether_runtime', 'aether_webhook', 'aether_mailer',
    'aether_payment_gateway', 'aether_expiry', 'aether_expiry_runner',
    'sbg_capacity_writer', 'sbg_fleet_writer'
  ) then
    if tg_op = 'INSERT' and new.reservation_mode is not null then
      raise exception 'reservation mode is owner-assigned'
        using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.reservation_mode is distinct from old.reservation_mode then
      raise exception 'reservation mode is owner-assigned'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$guard$;

revoke all on function public.sbg_providers_reservation_mode_guard() from public;

drop trigger if exists providers_reservation_mode_guard on public.providers;
create trigger providers_reservation_mode_guard
  before insert or update on public.providers
  for each row
  execute function public.sbg_providers_reservation_mode_guard();

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
        'revoke insert (reservation_mode), update (reservation_mode) on table public.providers from %I',
        v_role
      );
    end if;
  end loop;
end
$priv$;
