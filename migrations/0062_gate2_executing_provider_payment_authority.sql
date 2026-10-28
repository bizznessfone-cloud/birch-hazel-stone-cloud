-- Gate 2 Stage C — executing-provider payment authority. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0061.
-- Does not open Checkout, call Stripe, send email, assign dispatch, or admit CP31.
-- Does not replace sbg_prepare_booking_payment or sbg_apply_payment_event.
--
-- Payee source is the booking's executing provider, not bookings.hotel_id.
-- sbg_stripe_connections remains the legacy hotel connection. It is not the
-- payee. The entitled organisation's row in sbg_organisation_stripe_connections
-- is the current account for a new attempt. sbg_booking_payments.payee_stripe_account_id
-- is the immutable account of an attempt that has already been bound.
--
-- Property licences can be allocated only to hotels.organisation_id (0027).
-- An operator payee does not become that allocation holder. The property must
-- still be licensed to the hotel organisation. The payee's own subscription
-- must be status active with licensed_quantity >= 1. trial and past_due fail closed.
--
-- Stage D integration, not done here:
--   evaluateDomainBCheckoutBinding still joins sbg_stripe_connections on hotel_id.
--   sbg_apply_payment_event inserts sbg_stripe_events before its account check,
--   so a wrong-account call would consume the event id. Stage D must not call it
--   for this boundary. It must lock the booking, then the payment, call
--   sbg_assess_payment_authority_event, and insert the event only after 'matched',
--   in the same transaction as the payment write. It must not confirm an expired
--   lifecycle or retarget a bound attempt onto a later account.
--
-- Bulk expiry: 0061 granted aether_app execute on sbg_expire_provisional_holds.
-- This migration revokes that. No worker role is created and nothing is scheduled.
-- A later worker grant must be execute-only on that function, not a table write.

create table if not exists public.sbg_organisation_stripe_connections (
  organisation_id uuid primary key references public.sbg_organisations (id) on delete restrict,
  stripe_account_id text not null,
  livemode boolean not null,
  connected_at timestamptz not null default pg_catalog.clock_timestamp(),
  disconnected_at timestamptz,
  constraint sbg_organisation_stripe_account_present
    check (char_length(pg_catalog.btrim(stripe_account_id)) > 0),
  constraint sbg_organisation_stripe_disconnect_after
    check (disconnected_at is null or disconnected_at >= connected_at)
);

create unique index if not exists sbg_organisation_stripe_account_uidx
  on public.sbg_organisation_stripe_connections (stripe_account_id);

alter table public.sbg_booking_payments
  add column if not exists payee_organisation_id uuid references public.sbg_organisations (id) on delete restrict,
  add column if not exists executing_provider_id uuid references public.providers (id) on delete restrict,
  add column if not exists payee_stripe_account_id text,
  add column if not exists payee_kind text,
  add column if not exists authority_bound_at timestamptz;

alter table public.sbg_booking_payments
  drop constraint if exists sbg_booking_payment_authority_complete_check;

alter table public.sbg_booking_payments
  add constraint sbg_booking_payment_authority_complete_check
  check (
    (
      payee_organisation_id is null
      and executing_provider_id is null
      and payee_stripe_account_id is null
      and payee_kind is null
      and authority_bound_at is null
    )
    or
    (
      payee_organisation_id is not null
      and executing_provider_id is not null
      and payee_stripe_account_id is not null
      and char_length(pg_catalog.btrim(payee_stripe_account_id)) > 0
      and payee_kind in ('hotel_in_house', 'independent_operator')
      and authority_bound_at is not null
    )
  );

create or replace function public.sbg_organisation_stripe_account_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $guard$
begin
  if exists (
    select 1
      from public.sbg_stripe_connections c
      join public.hotels h on h.id = c.hotel_id
     where c.stripe_account_id = new.stripe_account_id
       and h.organisation_id is distinct from new.organisation_id
  ) then
    raise exception 'hotel_account_not_payee' using errcode = 'P0001';
  end if;
  return new;
end;
$guard$;

drop trigger if exists sbg_organisation_stripe_account_guard on public.sbg_organisation_stripe_connections;
create trigger sbg_organisation_stripe_account_guard
  before insert or update of stripe_account_id, organisation_id
  on public.sbg_organisation_stripe_connections
  for each row
  execute function public.sbg_organisation_stripe_account_guard();

create or replace function public.sbg_hotel_stripe_account_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $guard$
begin
  if exists (
    select 1
      from public.sbg_organisation_stripe_connections o
      join public.hotels h on h.id = new.hotel_id
     where o.stripe_account_id = new.stripe_account_id
       and h.organisation_id is distinct from o.organisation_id
  ) then
    raise exception 'hotel_account_not_payee' using errcode = 'P0001';
  end if;
  return new;
end;
$guard$;

drop trigger if exists sbg_hotel_stripe_account_guard on public.sbg_stripe_connections;
create trigger sbg_hotel_stripe_account_guard
  before insert or update of stripe_account_id, hotel_id
  on public.sbg_stripe_connections
  for each row
  execute function public.sbg_hotel_stripe_account_guard();

create or replace function public.sbg_booking_payment_authority_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $guard$
begin
  if current_user in ('aether_app', 'aether_runtime') then
    if tg_op = 'INSERT' then
      if new.payee_organisation_id is not null
         or new.executing_provider_id is not null
         or new.payee_stripe_account_id is not null
         or new.payee_kind is not null
         or new.authority_bound_at is not null then
        raise exception 'payment authority is not directly writable' using errcode = '42501';
      end if;
    elsif new.payee_organisation_id is distinct from old.payee_organisation_id
       or new.executing_provider_id is distinct from old.executing_provider_id
       or new.payee_stripe_account_id is distinct from old.payee_stripe_account_id
       or new.payee_kind is distinct from old.payee_kind
       or new.authority_bound_at is distinct from old.authority_bound_at then
      raise exception 'payment authority is not directly writable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$guard$;

drop trigger if exists sbg_booking_payment_authority_guard on public.sbg_booking_payments;
create trigger sbg_booking_payment_authority_guard
  before insert or update on public.sbg_booking_payments
  for each row
  execute function public.sbg_booking_payment_authority_guard();

create or replace function public.sbg_resolve_executing_payee(p_booking_id uuid)
returns table (
  resolved_booking_id uuid,
  resolved_provider_id uuid,
  resolved_payee_organisation_id uuid,
  resolved_payee_kind text,
  resolved_stripe_account_id text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $resolve$
declare
  v_hotel uuid;
  v_provider uuid;
  v_cancelled timestamptz;
  v_kind text;
  v_hotel_org uuid;
  v_hotel_org_type text;
  v_auth_count integer;
  v_operator uuid;
  v_operator_type text;
  v_payee uuid;
  v_payee_kind text;
  v_account text;
  v_hotel_account text;
  v_status text;
  v_quantity integer;
begin
  if p_booking_id is null then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  select b.hotel_id, b.executing_provider_id, b.cancelled_at
    into v_hotel, v_provider, v_cancelled
    from public.bookings b
   where b.id = p_booking_id
   for update;
  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;
  if v_cancelled is not null then
    raise exception 'booking_not_payable' using errcode = 'P0001';
  end if;
  if v_provider is null then
    raise exception 'ambiguous_authority' using errcode = 'P0001';
  end if;

  select p.kind
    into v_kind
    from public.hotel_provider_agreements a
    join public.providers p on p.id = a.provider_id
   where a.hotel_id = v_hotel
     and a.provider_id = v_provider
     and a.active = true;
  if not found then
    raise exception 'inactive_agreement' using errcode = 'P0001';
  end if;

  select h.organisation_id, o.organisation_type
    into v_hotel_org, v_hotel_org_type
    from public.hotels h
    left join public.sbg_organisations o on o.id = h.organisation_id
   where h.id = v_hotel;
  if v_hotel_org is null or v_hotel_org_type is distinct from 'hotel' then
    raise exception 'ambiguous_authority' using errcode = 'P0001';
  end if;

  select count(*)::integer
    into v_auth_count
    from public.sbg_operator_provider_authorisations a
   where a.hotel_id = v_hotel
     and a.provider_id = v_provider
     and a.revoked_at is null;

  if v_kind = 'in_house' then
    if v_auth_count <> 0 then
      raise exception 'ambiguous_authority' using errcode = 'P0001';
    end if;
    v_payee := v_hotel_org;
    v_payee_kind := 'hotel_in_house';
  elsif v_kind = 'external' then
    if v_auth_count = 0 then
      raise exception 'authorisation_revoked' using errcode = 'P0001';
    end if;
    if v_auth_count <> 1 then
      raise exception 'ambiguous_authority' using errcode = 'P0001';
    end if;
    select a.operator_organisation_id
      into v_operator
      from public.sbg_operator_provider_authorisations a
     where a.hotel_id = v_hotel
       and a.provider_id = v_provider
       and a.revoked_at is null;
    select o.organisation_type
      into v_operator_type
      from public.sbg_organisations o
     where o.id = v_operator;
    if v_operator_type is distinct from 'transfer_operator' or v_operator = v_hotel_org then
      raise exception 'ambiguous_authority' using errcode = 'P0001';
    end if;
    if not exists (
      select 1
        from public.sbg_operator_property_grants g
       where g.operator_organisation_id = v_operator
         and g.hotel_id = v_hotel
         and g.revoked_at is null
    ) then
      raise exception 'grant_revoked' using errcode = 'P0001';
    end if;
    v_payee := v_operator;
    v_payee_kind := 'independent_operator';
  else
    raise exception 'ambiguous_authority' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
      from public.sbg_property_licence_allocations l
     where l.hotel_id = v_hotel
       and l.organisation_id = v_hotel_org
       and l.released_at is null
  ) then
    raise exception 'licence_missing' using errcode = 'P0001';
  end if;

  select b.status, b.licensed_quantity
    into v_status, v_quantity
    from public.sbg_organisation_billing b
   where b.organisation_id = v_payee;
  if v_status is distinct from 'active' or v_quantity is null or v_quantity < 1 then
    raise exception 'subscription_inactive' using errcode = 'P0001';
  end if;

  select c.stripe_account_id
    into v_account
    from public.sbg_organisation_stripe_connections c
   where c.organisation_id = v_payee
     and c.disconnected_at is null
   for share;
  if v_account is null or char_length(pg_catalog.btrim(v_account)) = 0 then
    raise exception 'stripe_disconnected' using errcode = 'P0001';
  end if;

  select c.stripe_account_id
    into v_hotel_account
    from public.sbg_stripe_connections c
   where c.hotel_id = v_hotel
     and c.disconnected_at is null;
  if v_payee_kind = 'independent_operator'
     and v_hotel_account is not null
     and v_account = v_hotel_account then
    raise exception 'hotel_account_not_payee' using errcode = 'P0001';
  end if;

  resolved_booking_id := p_booking_id;
  resolved_provider_id := v_provider;
  resolved_payee_organisation_id := v_payee;
  resolved_payee_kind := v_payee_kind;
  resolved_stripe_account_id := v_account;
  return next;
end;
$resolve$;

create or replace function public.sbg_bind_payment_authority(p_booking_id uuid)
returns table (
  bound_payment_id uuid,
  bound_booking_id uuid,
  bound_provider_id uuid,
  bound_payee_organisation_id uuid,
  bound_payee_kind text,
  bound_stripe_account_id text,
  binding_state text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $bind$
declare
  v_payment uuid;
  v_provider uuid;
  v_org uuid;
  v_kind text;
  v_account text;
  v_bound_at timestamptz;
  v_amount integer;
  v_currency text;
  v_session text;
  v_intent text;
  v_status text;
  v_resolved record;
begin
  if p_booking_id is null then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  perform 1
    from public.bookings b
   where b.id = p_booking_id
   for update;
  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  select
    p.id,
    p.executing_provider_id,
    p.payee_organisation_id,
    p.payee_kind,
    p.payee_stripe_account_id,
    p.authority_bound_at,
    p.amount_minor,
    p.currency,
    p.stripe_checkout_session_id,
    p.stripe_payment_intent_id,
    p.status
    into
      v_payment, v_provider, v_org, v_kind, v_account, v_bound_at,
      v_amount, v_currency, v_session, v_intent, v_status
    from public.sbg_booking_payments p
   where p.booking_id = p_booking_id
   for update;
  if not found then
    raise exception 'payment_attempt_missing' using errcode = 'P0002';
  end if;

  if v_org is not null then
    bound_payment_id := v_payment;
    bound_booking_id := p_booking_id;
    bound_provider_id := v_provider;
    bound_payee_organisation_id := v_org;
    bound_payee_kind := v_kind;
    bound_stripe_account_id := v_account;
    binding_state := 'immutable';
    return next;
    return;
  end if;

  select *
    into v_resolved
    from public.sbg_resolve_executing_payee(p_booking_id);

  update public.sbg_booking_payments
     set executing_provider_id = v_resolved.resolved_provider_id,
         payee_organisation_id = v_resolved.resolved_payee_organisation_id,
         payee_kind = v_resolved.resolved_payee_kind,
         payee_stripe_account_id = v_resolved.resolved_stripe_account_id,
         authority_bound_at = pg_catalog.clock_timestamp()
   where id = v_payment
     and payee_organisation_id is null
     and executing_provider_id is null
     and payee_stripe_account_id is null
     and payee_kind is null
     and authority_bound_at is null
     and amount_minor is not distinct from v_amount
     and currency is not distinct from v_currency
     and stripe_checkout_session_id is not distinct from v_session
     and stripe_payment_intent_id is not distinct from v_intent
     and status is not distinct from v_status;
  if not found then
    raise exception 'incompatible_authority' using errcode = 'P0001';
  end if;

  insert into public.audit_events (actor_type, action, booking_id, payload)
  values (
    'server',
    'payment_authority_bound',
    p_booking_id,
    pg_catalog.jsonb_build_object(
      'payment_id', v_payment,
      'executing_provider_id', v_resolved.resolved_provider_id,
      'payee_organisation_id', v_resolved.resolved_payee_organisation_id,
      'payee_kind', v_resolved.resolved_payee_kind,
      'stripe_account_id', v_resolved.resolved_stripe_account_id
    )
  );

  bound_payment_id := v_payment;
  bound_booking_id := p_booking_id;
  bound_provider_id := v_resolved.resolved_provider_id;
  bound_payee_organisation_id := v_resolved.resolved_payee_organisation_id;
  bound_payee_kind := v_resolved.resolved_payee_kind;
  bound_stripe_account_id := v_resolved.resolved_stripe_account_id;
  binding_state := 'established';
  return next;
end;
$bind$;

create or replace function public.sbg_payment_authority_drift(p_booking_id uuid)
returns table (
  drift_payment_id uuid,
  drift_bound_account text,
  drift_bound_organisation_id uuid,
  drift_current_account text,
  drift_current_organisation_id uuid,
  drift_state text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $drift$
declare
  v_payment uuid;
  v_bound_account text;
  v_bound_org uuid;
  v_current_account text;
  v_current_org uuid;
  v_resolved record;
  v_unresolved boolean := false;
begin
  if p_booking_id is null then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.bookings b where b.id = p_booking_id for update;
  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;
  select p.id, p.payee_stripe_account_id, p.payee_organisation_id
    into v_payment, v_bound_account, v_bound_org
    from public.sbg_booking_payments p
   where p.booking_id = p_booking_id
   for update;
  if not found then
    raise exception 'payment_attempt_missing' using errcode = 'P0002';
  end if;

  begin
    select * into v_resolved from public.sbg_resolve_executing_payee(p_booking_id);
    v_current_account := v_resolved.resolved_stripe_account_id;
    v_current_org := v_resolved.resolved_payee_organisation_id;
  exception
    when sqlstate 'P0001' then
      v_unresolved := true;
  end;

  drift_payment_id := v_payment;
  drift_bound_account := v_bound_account;
  drift_bound_organisation_id := v_bound_org;
  drift_current_account := v_current_account;
  drift_current_organisation_id := v_current_org;
  if v_bound_org is null then
    drift_state := case when v_unresolved then 'current_unresolved' else 'unbound' end;
  elsif v_unresolved then
    drift_state := 'current_unresolved';
  elsif v_current_org is distinct from v_bound_org then
    drift_state := 'payee_changed';
  elsif v_current_account is distinct from v_bound_account then
    drift_state := 'account_changed';
  else
    drift_state := 'unchanged';
  end if;
  return next;
end;
$drift$;

create or replace function public.sbg_assess_payment_authority_event(
  p_booking_id uuid,
  p_payment_id uuid,
  p_executing_provider_id uuid,
  p_account_id text,
  p_session_id text,
  p_amount_minor integer,
  p_currency text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $assess$
declare
  v_booking uuid;
  v_provider uuid;
  v_org uuid;
  v_kind text;
  v_account text;
  v_bound_at timestamptz;
  v_amount integer;
  v_currency text;
  v_session text;
  v_hotel uuid;
  v_hotel_account text;
  v_event_account text;
  v_event_currency text;
begin
  if p_payment_id is null or p_booking_id is null then
    return 'payment';
  end if;
  perform 1 from public.bookings b where b.id = p_booking_id for share;
  if not found then
    return 'booking';
  end if;
  select
    p.booking_id,
    p.executing_provider_id,
    p.payee_organisation_id,
    p.payee_kind,
    p.payee_stripe_account_id,
    p.authority_bound_at,
    p.amount_minor,
    p.currency,
    p.stripe_checkout_session_id
    into
      v_booking, v_provider, v_org, v_kind, v_account, v_bound_at,
      v_amount, v_currency, v_session
    from public.sbg_booking_payments p
   where p.id = p_payment_id
   for share;
  if not found then
    return 'payment';
  end if;
  if v_booking is distinct from p_booking_id then
    return 'booking';
  end if;
  if v_org is null or v_provider is null or v_account is null or v_kind is null or v_bound_at is null then
    return 'unbound';
  end if;
  if p_executing_provider_id is null or p_executing_provider_id is distinct from v_provider then
    return 'provider';
  end if;

  select b.hotel_id into v_hotel from public.bookings b where b.id = v_booking;
  select c.stripe_account_id
    into v_hotel_account
    from public.sbg_stripe_connections c
   where c.hotel_id = v_hotel
     and c.disconnected_at is null;
  v_event_account := pg_catalog.btrim(coalesce(p_account_id, ''));
  if v_kind = 'independent_operator'
     and v_hotel_account is not null
     and v_event_account = v_hotel_account then
    return 'hotel_account_not_payee';
  end if;
  if v_event_account = '' or v_event_account is distinct from v_account then
    return 'wrong_account';
  end if;
  if p_session_id is null or v_session is null or p_session_id is distinct from v_session then
    return 'session';
  end if;
  if p_amount_minor is null or p_amount_minor is distinct from v_amount then
    return 'amount';
  end if;
  v_event_currency := pg_catalog.lower(pg_catalog.btrim(coalesce(p_currency, '')));
  if v_event_currency = '' or v_event_currency is distinct from pg_catalog.lower(pg_catalog.btrim(v_currency)) then
    return 'currency';
  end if;
  return 'matched';
end;
$assess$;

revoke all on table public.sbg_organisation_stripe_connections from public;
revoke all on function public.sbg_organisation_stripe_account_guard() from public;
revoke all on function public.sbg_hotel_stripe_account_guard() from public;
revoke all on function public.sbg_booking_payment_authority_guard() from public;
revoke all on function public.sbg_resolve_executing_payee(uuid) from public;
revoke all on function public.sbg_bind_payment_authority(uuid) from public;
revoke all on function public.sbg_payment_authority_drift(uuid) from public;
revoke all on function public.sbg_assess_payment_authority_event(uuid, uuid, uuid, text, text, integer, text) from public;

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke all on table public.sbg_organisation_stripe_connections from aether_runtime';
    execute 'revoke all on function public.sbg_resolve_executing_payee(uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_bind_payment_authority(uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_payment_authority_drift(uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_assess_payment_authority_event(uuid, uuid, uuid, text, text, integer, text) from aether_runtime';
    execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke all on table public.sbg_organisation_stripe_connections from aether_app';
    execute 'revoke all on function public.sbg_resolve_executing_payee(uuid) from aether_app';
    execute 'revoke all on function public.sbg_bind_payment_authority(uuid) from aether_app';
    execute 'revoke all on function public.sbg_payment_authority_drift(uuid) from aether_app';
    execute 'revoke all on function public.sbg_assess_payment_authority_event(uuid, uuid, uuid, text, text, integer, text) from aether_app';
    execute 'grant execute on function public.sbg_resolve_executing_payee(uuid) to aether_app';
    execute 'grant execute on function public.sbg_bind_payment_authority(uuid) to aether_app';
    execute 'grant execute on function public.sbg_payment_authority_drift(uuid) to aether_app';
    execute 'grant execute on function public.sbg_assess_payment_authority_event(uuid, uuid, uuid, text, text, integer, text) to aether_app';
    execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from aether_app';
    execute 'revoke update (payee_organisation_id, executing_provider_id, payee_stripe_account_id, payee_kind, authority_bound_at) on table public.sbg_booking_payments from aether_app';
  end if;
end
$priv$;

comment on table public.sbg_organisation_stripe_connections is
  'Current Stripe account of an organisation. Not the immutable account of an existing payment attempt. Not derived from bookings.hotel_id.';
comment on function public.sbg_resolve_executing_payee(uuid) is
  'Current payee for a new attempt, from the recorded executing provider. Fails closed. Does not write a payment or open Checkout.';
comment on function public.sbg_bind_payment_authority(uuid) is
  'Binds an existing payment attempt once. A second call returns the stored account and does not follow a later connection change.';
comment on function public.sbg_assess_payment_authority_event(uuid, uuid, uuid, text, text, integer, text) is
  'Compares a webhook claim with the bound attempt. Does not insert sbg_stripe_events and does not call sbg_apply_payment_event.';
comment on function public.sbg_expire_provisional_holds(integer) is
  'Expires due unpaid holds. Execute is not granted to aether_app or aether_runtime. Not scheduled.';
