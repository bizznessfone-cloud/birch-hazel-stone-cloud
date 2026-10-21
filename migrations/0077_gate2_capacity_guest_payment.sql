-- Gate 2 Stage 6D — capacity guest payment claim. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0076.
-- Does not open live checkout or schedule expiry.
--
-- sbg_prepare_booking_payment still requires a hotel row in
-- sbg_stripe_connections and returns that hotel account. That account is not
-- the executing payee. An external operator is paid through
-- sbg_organisation_stripe_connections, resolved by sbg_bind_payment_authority.
-- These functions create the payment row without a hotel connection. They do
-- not choose a Stripe account. The application must charge bound_stripe_account_id
-- and must not fall back to the hotel connection or the SBG subscription account.
--
-- The checkout claim is the concurrency control. A Stripe idempotency key is
-- only the identity of one attempt. It does not allow a second chargeable session.

alter table public.sbg_booking_payments
  add column if not exists checkout_attempt integer not null default 0,
  add column if not exists checkout_claim_at timestamptz;

alter table public.sbg_booking_payments
  drop constraint if exists sbg_booking_payments_checkout_attempt_check;

alter table public.sbg_booking_payments
  add constraint sbg_booking_payments_checkout_attempt_check
  check (checkout_attempt >= 0);

comment on column public.sbg_booking_payments.checkout_attempt is
  'One Stripe Checkout attempt. The next attempt is a new number. Recovery of an unstored session reuses the current number.';

comment on column public.sbg_booking_payments.checkout_claim_at is
  'Set before Stripe is called. A fresh claim blocks a second session. Cleared only when the session is stored or the unstored session is expired.';

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
       or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id
       or new.stripe_checkout_url is distinct from old.stripe_checkout_url then
      raise exception 'payment authority is not directly writable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$guard$;

create or replace function public.sbg_prepare_capacity_guest_payment(p_confirmation_token text)
returns table (
  payment_id uuid,
  booking_id uuid,
  amount_minor integer,
  currency text,
  status text,
  checkout_session_id text,
  checkout_url text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $prepare$
#variable_conflict use_column
declare
  v_booking uuid;
  v_amount integer;
  v_currency text;
  v_payable boolean;
  v_expired boolean;
begin
  if p_confirmation_token is null or pg_catalog.btrim(p_confirmation_token) = '' then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  select b.id, b.quoted_amount_minor, pg_catalog.btrim(b.quoted_currency)
    into v_booking, v_amount, v_currency
    from public.bookings b
   where b.confirmation_token = p_confirmation_token
   for update;
  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  select
    b.capacity_managed
      and b.lifecycle_state = 'awaiting_payment'
      and b.cancelled_at is null
      and b.vehicle_id is not null
      and b.hold_expires_at is not null
      and b.hold_expires_at > pg_catalog.clock_timestamp()
      and v_amount is not null
      and v_amount > 0
      and v_currency is not null
      and char_length(v_currency) = 3,
    b.hold_expires_at is not null and b.hold_expires_at <= pg_catalog.clock_timestamp()
    into v_payable, v_expired
    from public.bookings b
   where b.id = v_booking;
  if v_expired then
    raise exception 'hold_expired' using errcode = 'P0001';
  end if;
  if not v_payable then
    raise exception 'booking_not_payable' using errcode = 'P0001';
  end if;

  insert into public.sbg_booking_payments (booking_id, amount_minor, currency)
  values (v_booking, v_amount, v_currency)
  on conflict (booking_id) do update
    set status = case
          when public.sbg_booking_payments.status in ('failed', 'expired', 'canceled') then 'pending'
          else public.sbg_booking_payments.status
        end,
        stripe_checkout_session_id = case
          when public.sbg_booking_payments.status in ('failed', 'expired', 'canceled') then null
          else public.sbg_booking_payments.stripe_checkout_session_id
        end,
        stripe_checkout_url = case
          when public.sbg_booking_payments.status in ('failed', 'expired', 'canceled') then null
          else public.sbg_booking_payments.stripe_checkout_url
        end,
        stripe_payment_intent_id = case
          when public.sbg_booking_payments.status in ('failed', 'expired', 'canceled') then null
          else public.sbg_booking_payments.stripe_payment_intent_id
        end,
        checkout_claim_at = case
          when public.sbg_booking_payments.status in ('failed', 'expired', 'canceled') then null
          else public.sbg_booking_payments.checkout_claim_at
        end,
        updated_at = pg_catalog.clock_timestamp()
  where public.sbg_booking_payments.status is distinct from 'paid'
    and public.sbg_booking_payments.status is distinct from 'received_after_expiry';
  if not found then
    raise exception 'booking_not_payable' using errcode = 'P0001';
  end if;

  return query
  select p.id, p.booking_id, p.amount_minor, p.currency, p.status,
         p.stripe_checkout_session_id, p.stripe_checkout_url
    from public.sbg_booking_payments p
   where p.booking_id = v_booking;
end;
$prepare$;

create or replace function public.sbg_claim_capacity_checkout(p_payment_id uuid)
returns table (
  claim_outcome text,
  claim_attempt integer,
  claim_session_id text,
  claim_url text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $claim$
declare
  v_booking uuid;
  v_status text;
  v_session text;
  v_url text;
  v_attempt integer;
  v_claim timestamptz;
  v_open boolean;
begin
  select p.booking_id, p.status, p.stripe_checkout_session_id, p.stripe_checkout_url,
         p.checkout_attempt, p.checkout_claim_at
    into v_booking, v_status, v_session, v_url, v_attempt, v_claim
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
    claim_session_id := null;
    claim_url := null;
    return next;
    return;
  end if;
  if v_claim is not null then
    update public.sbg_booking_payments
       set checkout_claim_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where id = p_payment_id
       and stripe_checkout_session_id is null
       and status = 'pending';
    claim_outcome := 'recover';
    claim_attempt := v_attempt;
    claim_session_id := null;
    claim_url := null;
    return next;
    return;
  end if;

  update public.sbg_booking_payments
     set checkout_attempt = checkout_attempt + 1,
         checkout_claim_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   where id = p_payment_id
     and stripe_checkout_session_id is null
     and checkout_claim_at is null
     and status = 'pending'
  returning checkout_attempt into v_attempt;
  if not found then
    raise exception 'checkout_in_progress' using errcode = 'P0001';
  end if;
  claim_outcome := 'claimed';
  claim_attempt := v_attempt;
  claim_session_id := null;
  claim_url := null;
  return next;
end;
$claim$;

create or replace function public.sbg_store_capacity_checkout_session(
  p_payment_id uuid,
  p_attempt integer,
  p_session_id text,
  p_url text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $store$
begin
  if p_session_id is null or p_session_id !~ '^cs_[A-Za-z0-9_]+$'
     or p_url is null or left(p_url, 8) <> 'https://' then
    return 'rejected';
  end if;
  update public.sbg_booking_payments
     set stripe_checkout_session_id = p_session_id,
         stripe_checkout_url = p_url,
         checkout_claim_at = null,
         updated_at = pg_catalog.clock_timestamp()
   where id = p_payment_id
     and status = 'pending'
     and checkout_attempt = p_attempt
     and checkout_claim_at is not null
     and (
       stripe_checkout_session_id is null
       or stripe_checkout_session_id = p_session_id
     );
  if found then
    return 'stored';
  end if;
  return 'rejected';
end;
$store$;

create or replace function public.sbg_release_capacity_checkout_claim(
  p_payment_id uuid,
  p_attempt integer
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
     and stripe_checkout_session_id is null
     and checkout_claim_at is not null;
  if found then
    return 'released';
  end if;
  return 'held';
end;
$release$;

revoke all on function public.sbg_prepare_capacity_guest_payment(text) from public;
revoke all on function public.sbg_claim_capacity_checkout(uuid) from public;
revoke all on function public.sbg_store_capacity_checkout_session(uuid, integer, text, text) from public;
revoke all on function public.sbg_release_capacity_checkout_claim(uuid, integer) from public;

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
      execute format('revoke all on function public.sbg_prepare_capacity_guest_payment(text) from %I', v_role);
      execute format('revoke all on function public.sbg_claim_capacity_checkout(uuid) from %I', v_role);
      execute format('revoke all on function public.sbg_store_capacity_checkout_session(uuid, integer, text, text) from %I', v_role);
      execute format('revoke all on function public.sbg_release_capacity_checkout_claim(uuid, integer) from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'grant execute on function public.sbg_prepare_capacity_guest_payment(text) to aether_app';
    execute 'grant execute on function public.sbg_claim_capacity_checkout(uuid) to aether_app';
    execute 'grant execute on function public.sbg_store_capacity_checkout_session(uuid, integer, text, text) to aether_app';
    execute 'grant execute on function public.sbg_release_capacity_checkout_claim(uuid, integer) to aether_app';
  end if;
end
$priv$;

comment on function public.sbg_prepare_capacity_guest_payment(text) is
  'Insert or reuse the quoted payment for a live capacity hold. Does not read a hotel Stripe connection and does not return a charge account.';

comment on function public.sbg_claim_capacity_checkout(uuid) is
  'Serialise Checkout creation. stored and in_progress must not call Stripe. recover reuses the current attempt.';
