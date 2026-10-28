-- Gate 2 Stage D — verified payment transition. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0062.
-- Does not open Checkout, send email, admit dispatch, or mount the webhook.
-- Does not replace sbg_apply_payment_event or sbg_prepare_booking_payment.
--
-- Trust boundary: this database does not check Stripe's signature.
-- verifyStripeSignature in src/lib/aether/stripe.server.ts is the only
-- cryptographic check. The webhook process may call this function only after
-- that check returns true, and only as aether_webhook. p_signature_verified
-- is that caller's attestation, not a signature. aether_app, aether_runtime,
-- and public cannot execute this function.
--
-- Lock order: booking row, then payment row. Same order as expiry.
-- The Stripe event id is inserted only after the frozen Stage C binding
-- matches, and in the same transaction as the payment and lifecycle writes.
-- A mismatch does not insert the event id.
-- The live route still calls sbg_apply_payment_event. That function cannot
-- set confirmed_paid. It remains able to mark a payment paid without this
-- transition. Do not point the new flow at it.

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'aether_webhook') then
    create role aether_webhook nologin;
  end if;
end
$role$;

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

  select b.lifecycle_state, b.hold_expires_at
    into v_lifecycle, v_hold
    from public.bookings b
   where b.id = p_booking_id
   for update;
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
        update public.bookings
           set lifecycle_state = 'expired'
         where id = p_booking_id
           and lifecycle_state = v_lifecycle
           and confirmed_paid_at is null;
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
        update public.bookings
           set lifecycle_state = 'failed'
         where id = p_booking_id
           and lifecycle_state = v_lifecycle
           and confirmed_paid_at is null;
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
    update public.bookings
       set lifecycle_state = 'refunded'
     where id = p_booking_id
       and lifecycle_state = 'confirmed_paid'
       and confirmed_paid_at is not null;
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

revoke all on function public.sbg_accept_verified_payment_event(
  boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text
) from public;

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke all on function public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text) from aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke all on function public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text) from aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_webhook') then
    execute 'revoke all on function public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text) from aether_webhook';
    execute 'grant execute on function public.sbg_accept_verified_payment_event(boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text) to aether_webhook';
  end if;
end
$priv$;

comment on function public.sbg_accept_verified_payment_event(
  boolean, text, text, uuid, uuid, uuid, text, text, integer, text, text, text
) is
  'Atomic verified-payment transition for aether_webhook only. Does not verify a Stripe signature. Does not call sbg_apply_payment_event. Not mounted on the public webhook.';
comment on role aether_webhook is
  'Execute-only role for the verified payment transition. No table DML. Not granted to aether_app.';
