-- Gate 2 Stage 6E — checkout claim generation. SOURCE ONLY.
-- Does not edit migration 0077. Not production-admitted.
-- A claim generation is the ownership token of one in-flight Checkout call.
-- Recovery of the same attempt increments it. A stale caller cannot store,
-- release, or expire over that newer claim.

alter table public.sbg_booking_payments
  add column if not exists checkout_claim_generation integer not null default 0;

alter table public.sbg_booking_payments
  drop constraint if exists sbg_booking_payments_checkout_claim_generation_check;

alter table public.sbg_booking_payments
  add constraint sbg_booking_payments_checkout_claim_generation_check
  check (checkout_claim_generation >= 0);

comment on column public.sbg_booking_payments.checkout_claim_generation is
  'Ownership token of the current Checkout claim. Incremented on every new claim and every recovery. Release and store must present the observed value.';

create or replace function public.sbg_booking_payment_authority_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $guard$
begin
  if current_user in (
    'aether_app', 'aether_runtime', 'aether_webhook', 'aether_mailer',
    'aether_payment_gateway', 'aether_expiry', 'aether_expiry_runner',
    'sbg_capacity_writer', 'sbg_fleet_writer'
  ) then
    if tg_op = 'INSERT' then
      if new.payee_organisation_id is not null
         or new.executing_provider_id is not null
         or new.payee_stripe_account_id is not null
         or new.payee_kind is not null
         or new.authority_bound_at is not null
         or new.checkout_attempt is distinct from 0
         or new.checkout_claim_at is not null
         or new.checkout_claim_generation is distinct from 0
         or new.stripe_checkout_session_id is not null
         or new.stripe_checkout_url is not null then
        raise exception 'payment authority is not directly writable' using errcode = '42501';
      end if;
    elsif new.payee_organisation_id is distinct from old.payee_organisation_id
       or new.executing_provider_id is distinct from old.executing_provider_id
       or new.payee_stripe_account_id is distinct from old.payee_stripe_account_id
       or new.payee_kind is distinct from old.payee_kind
       or new.authority_bound_at is distinct from old.authority_bound_at
       or new.checkout_attempt is distinct from old.checkout_attempt
       or new.checkout_claim_at is distinct from old.checkout_claim_at
       or new.checkout_claim_generation is distinct from old.checkout_claim_generation
       or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id
       or new.stripe_checkout_url is distinct from old.stripe_checkout_url then
      raise exception 'payment authority is not directly writable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$guard$;

drop function if exists public.sbg_claim_capacity_checkout(uuid);
drop function if exists public.sbg_store_capacity_checkout_session(uuid, integer, text, text);
drop function if exists public.sbg_release_capacity_checkout_claim(uuid, integer);

create function public.sbg_claim_capacity_checkout(p_payment_id uuid)
returns table (
  claim_outcome text,
  claim_attempt integer,
  claim_generation integer,
  claim_session_id text,
  claim_url text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $claim$
#variable_conflict use_column
declare
  v_booking uuid;
  v_status text;
  v_session text;
  v_url text;
  v_attempt integer;
  v_generation integer;
  v_claim timestamptz;
  v_open boolean;
begin
  select p.booking_id, p.status, p.stripe_checkout_session_id, p.stripe_checkout_url,
         p.checkout_attempt, p.checkout_claim_generation, p.checkout_claim_at
    into v_booking, v_status, v_session, v_url, v_attempt, v_generation, v_claim
    from public.sbg_booking_payments p
   where p.id = p_payment_id
   for update;
  if not found then
    raise exception 'payment_attempt_missing' using errcode = 'P0002';
  end if;

  perform 1
    from public.bookings b
   where b.id = v_booking
   for update;

  select
    b.capacity_managed
      and b.lifecycle_state = 'awaiting_payment'
      and b.cancelled_at is null
      and b.vehicle_id is not null
      and b.hold_expires_at is not null
      and b.hold_expires_at > pg_catalog.clock_timestamp()
    into v_open
    from public.bookings b
   where b.id = v_booking;
  if not coalesce(v_open, false) then
    raise exception 'hold_expired' using errcode = 'P0001';
  end if;

  if v_session is not null and v_status = 'pending' then
    claim_outcome := 'stored';
    claim_attempt := v_attempt;
    claim_generation := v_generation;
    claim_session_id := v_session;
    claim_url := v_url;
    return next;
    return;
  end if;
  if v_status is distinct from 'pending' then
    raise exception 'booking_not_payable' using errcode = 'P0001';
  end if;
  if v_claim is not null and v_claim > pg_catalog.clock_timestamp() - interval '2 minutes' then
    claim_outcome := 'in_progress';
    claim_attempt := v_attempt;
    claim_generation := v_generation;
    claim_session_id := null;
    claim_url := null;
    return next;
    return;
  end if;
  if v_claim is not null then
    update public.sbg_booking_payments
       set checkout_claim_at = pg_catalog.clock_timestamp(),
           checkout_claim_generation = checkout_claim_generation + 1,
           updated_at = pg_catalog.clock_timestamp()
     where id = p_payment_id
       and stripe_checkout_session_id is null
       and status = 'pending'
    returning checkout_claim_generation into v_generation;
    if not found then
      raise exception 'checkout_in_progress' using errcode = 'P0001';
    end if;
    claim_outcome := 'recover';
    claim_attempt := v_attempt;
    claim_generation := v_generation;
    claim_session_id := null;
    claim_url := null;
    return next;
    return;
  end if;

  update public.sbg_booking_payments
     set checkout_attempt = checkout_attempt + 1,
         checkout_claim_generation = checkout_claim_generation + 1,
         checkout_claim_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   where id = p_payment_id
     and stripe_checkout_session_id is null
     and checkout_claim_at is null
     and status = 'pending'
  returning checkout_attempt, checkout_claim_generation into v_attempt, v_generation;
  if not found then
    raise exception 'checkout_in_progress' using errcode = 'P0001';
  end if;
  claim_outcome := 'claimed';
  claim_attempt := v_attempt;
  claim_generation := v_generation;
  claim_session_id := null;
  claim_url := null;
  return next;
end;
$claim$;

create function public.sbg_require_payable_capacity_checkout(p_payment_id uuid)
returns table (
  payable_session_id text,
  payable_url text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $require$
#variable_conflict use_column
declare
  v_booking uuid;
  v_status text;
  v_session text;
  v_url text;
  v_expired boolean;
  v_payable boolean;
begin
  select p.booking_id, p.status, p.stripe_checkout_session_id, p.stripe_checkout_url
    into v_booking, v_status, v_session, v_url
    from public.sbg_booking_payments p
   where p.id = p_payment_id
   for update;
  if not found then
    raise exception 'payment_attempt_missing' using errcode = 'P0002';
  end if;

  perform 1
    from public.bookings b
   where b.id = v_booking
   for update;

  select
    b.hold_expires_at is not null and b.hold_expires_at <= pg_catalog.clock_timestamp(),
    b.capacity_managed
      and b.lifecycle_state = 'awaiting_payment'
      and b.cancelled_at is null
      and b.vehicle_id is not null
      and b.hold_expires_at is not null
      and b.hold_expires_at > pg_catalog.clock_timestamp()
      and v_status = 'pending'
      and v_session is not null
      and v_url is not null
      and left(v_url, 8) = 'https://'
    into v_expired, v_payable
    from public.bookings b
   where b.id = v_booking;
  if coalesce(v_expired, false) then
    raise exception 'hold_expired' using errcode = 'P0001';
  end if;
  if not coalesce(v_payable, false) then
    raise exception 'booking_not_payable' using errcode = 'P0001';
  end if;
  payable_session_id := v_session;
  payable_url := v_url;
  return next;
end;
$require$;

create function public.sbg_settle_capacity_checkout_attempt(
  p_payment_id uuid,
  p_attempt integer,
  p_generation integer,
  p_session_id text,
  p_url text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $settle$
declare
  v_booking uuid;
  v_status text;
  v_session text;
  v_attempt integer;
  v_generation integer;
  v_claim timestamptz;
  v_expired boolean;
  v_payable boolean;
  v_valid boolean;
begin
  if p_session_id is not null and p_session_id ~ '^cs_[A-Za-z0-9_]+$'
     and p_url is not null and left(p_url, 8) = 'https://' then
    v_valid := true;
  else
    v_valid := false;
  end if;

  select p.booking_id, p.status, p.stripe_checkout_session_id, p.checkout_attempt,
         p.checkout_claim_generation, p.checkout_claim_at
    into v_booking, v_status, v_session, v_attempt, v_generation, v_claim
    from public.sbg_booking_payments p
   where p.id = p_payment_id
   for update;
  if not found then
    raise exception 'payment_attempt_missing' using errcode = 'P0002';
  end if;

  perform 1
    from public.bookings b
   where b.id = v_booking
   for update;

  select
    b.hold_expires_at is not null and b.hold_expires_at <= pg_catalog.clock_timestamp(),
    b.capacity_managed
      and b.lifecycle_state = 'awaiting_payment'
      and b.cancelled_at is null
      and b.vehicle_id is not null
      and b.hold_expires_at is not null
      and b.hold_expires_at > pg_catalog.clock_timestamp()
      and v_status = 'pending'
    into v_expired, v_payable
    from public.bookings b
   where b.id = v_booking;

  if v_session is not null and v_session = p_session_id then
    if coalesce(v_payable, false) and not coalesce(v_expired, false) then
      return 'authoritative';
    end if;
    return 'not_payable';
  end if;
  if v_session is not null and v_session is distinct from p_session_id then
    return 'expire_unstored';
  end if;

  if v_generation = p_generation
     and v_attempt = p_attempt
     and v_claim is not null
     and v_session is null then
    if coalesce(v_payable, false) and not coalesce(v_expired, false) and v_valid and v_status = 'pending' then
      update public.sbg_booking_payments
         set stripe_checkout_session_id = p_session_id,
             stripe_checkout_url = p_url,
             checkout_claim_at = null,
             updated_at = pg_catalog.clock_timestamp()
       where id = p_payment_id
         and stripe_checkout_session_id is null
         and checkout_claim_generation = p_generation
         and checkout_attempt = p_attempt
         and status = 'pending';
      if found then
        return 'stored';
      end if;
      return 'superseded';
    end if;
    update public.sbg_booking_payments
       set checkout_claim_at = null,
           updated_at = pg_catalog.clock_timestamp()
     where id = p_payment_id
       and stripe_checkout_session_id is null
       and checkout_claim_generation = p_generation
       and checkout_attempt = p_attempt;
    return 'expire_unstored';
  end if;

  if coalesce(v_expired, false) or not coalesce(v_payable, false) then
    return 'not_payable';
  end if;
  return 'superseded';
end;
$settle$;

create function public.sbg_release_capacity_checkout_claim(
  p_payment_id uuid,
  p_attempt integer,
  p_generation integer
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $release$
begin
  update public.sbg_booking_payments
     set checkout_claim_at = null,
         updated_at = pg_catalog.clock_timestamp()
   where id = p_payment_id
     and checkout_attempt = p_attempt
     and checkout_claim_generation = p_generation
     and stripe_checkout_session_id is null
     and checkout_claim_at is not null;
  if found then
    return 'released';
  end if;
  return 'held';
end;
$release$;

revoke all on function public.sbg_claim_capacity_checkout(uuid) from public;
revoke all on function public.sbg_require_payable_capacity_checkout(uuid) from public;
revoke all on function public.sbg_settle_capacity_checkout_attempt(uuid, integer, integer, text, text) from public;
revoke all on function public.sbg_release_capacity_checkout_claim(uuid, integer, integer) from public;

do $priv$
declare
  v_role text;
begin
  foreach v_role in array ARRAY[
    'aether_runtime', 'aether_webhook', 'aether_mailer', 'aether_payment_gateway',
    'aether_expiry', 'aether_expiry_runner', 'sbg_capacity_writer', 'sbg_fleet_writer'
  ]
  loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function public.sbg_claim_capacity_checkout(uuid) from %I', v_role);
      execute format('revoke all on function public.sbg_require_payable_capacity_checkout(uuid) from %I', v_role);
      execute format('revoke all on function public.sbg_settle_capacity_checkout_attempt(uuid, integer, integer, text, text) from %I', v_role);
      execute format('revoke all on function public.sbg_release_capacity_checkout_claim(uuid, integer, integer) from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'grant execute on function public.sbg_claim_capacity_checkout(uuid) to aether_app';
    execute 'grant execute on function public.sbg_require_payable_capacity_checkout(uuid) to aether_app';
    execute 'grant execute on function public.sbg_settle_capacity_checkout_attempt(uuid, integer, integer, text, text) to aether_app';
    execute 'grant execute on function public.sbg_release_capacity_checkout_claim(uuid, integer, integer) to aether_app';
  end if;
end
$priv$;

comment on function public.sbg_claim_capacity_checkout(uuid) is
  'Serialise Checkout creation. Recovery keeps the attempt and increments the claim generation.';

comment on function public.sbg_settle_capacity_checkout_attempt(uuid, integer, integer, text, text) is
  'Store a session only for the observed claim generation. authoritative means that exact session is already stored and must not be expired.';

comment on function public.sbg_release_capacity_checkout_claim(uuid, integer, integer) is
  'Release only the observed claim generation. A newer recovery of the same attempt is held.';
