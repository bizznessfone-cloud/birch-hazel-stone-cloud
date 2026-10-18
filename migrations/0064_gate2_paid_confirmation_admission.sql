-- Gate 2 Stage E — paid confirmation email claim and dispatch admission.
-- SOURCE ONLY. Not production-admitted. Does not edit migrations 0001–0063.
-- Does not send email, open Checkout, mount the webhook, or change GiST,
-- the occupancy trigger, Athens time, or duration.
--
-- Legacy rows stay legacy_unreconciled. This migration does not convert them.
-- Paid confirmation email is refused for legacy rows.
-- A legacy assignment is still allowed when the booking is not cancelled and
-- the vehicle or driver belongs to that booking's executing provider.
-- Every other lifecycle must be confirmed_paid, with a paid bound payment
-- and a still-valid executing-provider resolution, before a resource is assigned.
--
-- Email is claimed here and delivered outside any database transaction.
-- A claim is not proof that a message was sent.

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'aether_mailer') then
    create role aether_mailer nologin;
  end if;
end
$role$;

create table if not exists public.sbg_confirmation_email_outbox (
  booking_id uuid primary key references public.bookings (id),
  claim_token uuid not null,
  state text not null,
  attempt_count integer not null,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  sent_at timestamptz,
  provider_code text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint sbg_confirmation_email_state_check
    check (state in ('claimed', 'sent', 'failed')),
  constraint sbg_confirmation_email_attempt_check
    check (attempt_count >= 1 and attempt_count <= 5),
  constraint sbg_confirmation_email_provider_code_check
    check (
      provider_code is null
      or (
        char_length(provider_code) between 1 and 40
        and provider_code ~ '^[a-z0-9_]+$'
      )
    )
);

comment on table public.sbg_confirmation_email_outbox is
  'One paid-confirmation claim per booking. claimed is an attempt, not delivery. sent is terminal.';

revoke all on table public.sbg_confirmation_email_outbox from public;

create or replace function public.sbg_claim_confirmation_email(p_booking_id uuid)
returns table (
  email_outcome text,
  email_booking_id uuid,
  email_claim_token uuid,
  email_attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $claim$
declare
  v_lifecycle text;
  v_confirmed timestamptz;
  v_cancelled timestamptz;
  v_provider uuid;
  v_payment_status text;
  v_paid_at timestamptz;
  v_payment_provider uuid;
  v_bound boolean;
  v_state text;
  v_token uuid;
  v_attempts integer;
  v_expires timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_booking_id is null then
    email_outcome := 'booking';
    return next;
    return;
  end if;

  select b.lifecycle_state, b.confirmed_paid_at, b.cancelled_at, b.executing_provider_id
    into v_lifecycle, v_confirmed, v_cancelled, v_provider
    from public.bookings b
   where b.id = p_booking_id
   for update;
  if not found then
    email_outcome := 'booking';
    return next;
    return;
  end if;

  select p.status, p.paid_at, p.executing_provider_id,
         (
           p.payee_organisation_id is not null
           and p.payee_stripe_account_id is not null
           and p.payee_kind is not null
           and p.authority_bound_at is not null
         )
    into v_payment_status, v_paid_at, v_payment_provider, v_bound
    from public.sbg_booking_payments p
   where p.booking_id = p_booking_id
   for update;

  if v_lifecycle is distinct from 'confirmed_paid'
     or v_confirmed is null
     or v_cancelled is not null
     or v_payment_status is distinct from 'paid'
     or v_paid_at is null
     or v_bound is not true
     or v_payment_provider is distinct from v_provider then
    insert into public.audit_events (actor_type, action, booking_id, payload)
    values (
      'mailer',
      'confirmation_email_refused',
      p_booking_id,
      pg_catalog.jsonb_build_object('reason', 'email_not_admitted', 'lifecycle', v_lifecycle)
    );
    email_outcome := 'email_not_admitted';
    email_booking_id := p_booking_id;
    return next;
    return;
  end if;

  select o.state, o.claim_token, o.attempt_count, o.claim_expires_at
    into v_state, v_token, v_attempts, v_expires
    from public.sbg_confirmation_email_outbox o
   where o.booking_id = p_booking_id
   for update;

  if found and v_state = 'sent' then
    email_outcome := 'already_sent';
    email_booking_id := p_booking_id;
    email_attempt_count := v_attempts;
  elsif found and v_state = 'claimed' and v_expires > v_now then
    email_outcome := 'claim_held';
    email_booking_id := p_booking_id;
    email_attempt_count := v_attempts;
  elsif found and v_attempts >= 5 then
    email_outcome := 'retries_exhausted';
    email_booking_id := p_booking_id;
    email_attempt_count := v_attempts;
  elsif found then
    v_attempts := v_attempts + 1;
    v_token := pg_catalog.gen_random_uuid();
    update public.sbg_confirmation_email_outbox
       set claim_token = v_token,
           state = 'claimed',
           attempt_count = v_attempts,
           claimed_at = v_now,
           claim_expires_at = v_now + interval '5 minutes',
           updated_at = v_now
     where booking_id = p_booking_id;
    email_outcome := case when v_state = 'failed' then 'retry' else 'reclaimed' end;
    email_booking_id := p_booking_id;
    email_claim_token := v_token;
    email_attempt_count := v_attempts;
  else
    v_token := pg_catalog.gen_random_uuid();
    insert into public.sbg_confirmation_email_outbox (
      booking_id, claim_token, state, attempt_count, claimed_at, claim_expires_at
    ) values (
      p_booking_id, v_token, 'claimed', 1, v_now, v_now + interval '5 minutes'
    );
    email_outcome := 'claimed';
    email_booking_id := p_booking_id;
    email_claim_token := v_token;
    email_attempt_count := 1;
  end if;

  insert into public.audit_events (actor_type, action, booking_id, payload)
  values (
    'mailer',
    'confirmation_email_' || email_outcome,
    p_booking_id,
    pg_catalog.jsonb_build_object('outcome', email_outcome, 'attempt', email_attempt_count)
  );
  return next;
end;
$claim$;

create or replace function public.sbg_record_confirmation_email_result(
  p_booking_id uuid,
  p_claim_token uuid,
  p_result text,
  p_provider_code text
) returns table (
  email_outcome text,
  email_state text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $record$
declare
  v_state text;
  v_token uuid;
  v_expires timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_result is distinct from 'sent' and p_result is distinct from 'failed' then
    email_outcome := 'claim_mismatch';
    return next;
    return;
  end if;
  if p_result = 'failed' and (
    p_provider_code is null
    or p_provider_code !~ '^[a-z0-9_]+$'
    or char_length(p_provider_code) > 40
  ) then
    email_outcome := 'claim_mismatch';
    return next;
    return;
  end if;

  select o.state, o.claim_token, o.claim_expires_at
    into v_state, v_token, v_expires
    from public.sbg_confirmation_email_outbox o
   where o.booking_id = p_booking_id
   for update;
  if not found or v_state is distinct from 'claimed' or v_token is distinct from p_claim_token then
    email_outcome := 'claim_mismatch';
    email_state := v_state;
    return next;
    return;
  end if;
  if v_expires <= v_now then
    email_outcome := 'claim_expired';
    email_state := v_state;
    return next;
    return;
  end if;

  if p_result = 'sent' then
    update public.sbg_confirmation_email_outbox
       set state = 'sent',
           sent_at = v_now,
           provider_code = 'accepted',
           updated_at = v_now
     where booking_id = p_booking_id;
    email_outcome := 'sent';
    email_state := 'sent';
  else
    update public.sbg_confirmation_email_outbox
       set state = 'failed',
           provider_code = p_provider_code,
           updated_at = v_now
     where booking_id = p_booking_id;
    email_outcome := 'failed';
    email_state := 'failed';
  end if;

  insert into public.audit_events (actor_type, action, booking_id, payload)
  values (
    'mailer',
    'confirmation_email_result',
    p_booking_id,
    pg_catalog.jsonb_build_object('outcome', email_outcome, 'provider_code', coalesce(p_provider_code, 'accepted'))
  );
  return next;
end;
$record$;

create or replace function public.sbg_read_confirmation_email_payload(p_claim_token uuid)
returns table (
  payload_booking_id uuid,
  payload_recipient text,
  payload_guest_name text,
  payload_reference text,
  payload_transfer_date date,
  payload_pickup_time time,
  payload_duration_minutes integer,
  payload_pickup text,
  payload_destination text,
  payload_passengers integer,
  payload_luggage integer,
  payload_hotel_name text,
  payload_confirmation_token text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $payload$
begin
  return query
  select
    b.id,
    b.guest_email,
    b.guest_name,
    b.human_reference,
    b.transfer_date,
    b.pickup_time,
    b.duration_minutes,
    b.pickup_text,
    b.destination_text,
    b.passenger_count,
    b.luggage_count,
    h.name,
    b.confirmation_token
  from public.sbg_confirmation_email_outbox o
  join public.bookings b on b.id = o.booking_id
  join public.hotels h on h.id = b.hotel_id
  where o.claim_token = p_claim_token
    and o.state = 'claimed'
    and o.claim_expires_at > pg_catalog.clock_timestamp();
end;
$payload$;

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

  -- Historical rows keep the pre-payment dispatch path. They are not converted.
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

drop trigger if exists bookings_dispatch_admission_guard on public.bookings;
create trigger bookings_dispatch_admission_guard
  before insert or update on public.bookings
  for each row
  execute function public.sbg_bookings_dispatch_admission_guard();

revoke all on function public.sbg_claim_confirmation_email(uuid) from public;
revoke all on function public.sbg_record_confirmation_email_result(uuid, uuid, text, text) from public;
revoke all on function public.sbg_read_confirmation_email_payload(uuid) from public;
revoke all on function public.sbg_bookings_dispatch_admission_guard() from public;

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke all on table public.sbg_confirmation_email_outbox from aether_app';
    execute 'revoke all on function public.sbg_claim_confirmation_email(uuid) from aether_app';
    execute 'revoke all on function public.sbg_record_confirmation_email_result(uuid, uuid, text, text) from aether_app';
    execute 'revoke all on function public.sbg_read_confirmation_email_payload(uuid) from aether_app';
    execute 'revoke all on function public.sbg_bookings_dispatch_admission_guard() from aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke all on table public.sbg_confirmation_email_outbox from aether_runtime';
    execute 'revoke all on function public.sbg_claim_confirmation_email(uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_record_confirmation_email_result(uuid, uuid, text, text) from aether_runtime';
    execute 'revoke all on function public.sbg_read_confirmation_email_payload(uuid) from aether_runtime';
    execute 'revoke all on function public.sbg_bookings_dispatch_admission_guard() from aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_mailer') then
    execute 'revoke all on table public.sbg_confirmation_email_outbox from aether_mailer';
    execute 'revoke all on function public.sbg_claim_confirmation_email(uuid) from aether_mailer';
    execute 'revoke all on function public.sbg_record_confirmation_email_result(uuid, uuid, text, text) from aether_mailer';
    execute 'revoke all on function public.sbg_read_confirmation_email_payload(uuid) from aether_mailer';
    execute 'grant execute on function public.sbg_claim_confirmation_email(uuid) to aether_mailer';
    execute 'grant execute on function public.sbg_record_confirmation_email_result(uuid, uuid, text, text) to aether_mailer';
    execute 'grant execute on function public.sbg_read_confirmation_email_payload(uuid) to aether_mailer';
  end if;
end
$priv$;

comment on function public.sbg_claim_confirmation_email(uuid) is
  'Claims one paid-confirmation attempt for aether_mailer. Does not send email and does not return guest details. A live claim lasts 5 minutes. At most 5 attempts.';
comment on function public.sbg_record_confirmation_email_result(uuid, uuid, text, text) is
  'Records the provider result for the live claim token. sent is delivery. failed is retryable until five attempts.';
comment on function public.sbg_read_confirmation_email_payload(uuid) is
  'Guest payload for the mailer role only, and only while the claim token is live. Not proof of delivery.';
comment on function public.sbg_bookings_dispatch_admission_guard() is
  'Blocks assignment unless the booking is legacy_unreconciled or confirmed_paid with a paid, still-authorised executing provider. Does not change GiST.';
comment on role aether_mailer is
  'Execute-only role for the paid confirmation claim. No table DML. Not granted to aether_app.';
