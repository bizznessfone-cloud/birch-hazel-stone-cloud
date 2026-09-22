-- CP26B.2 — ordered Domain A (SBG SaaS) billing event persistence
-- Source-only. Apply only through the dedicated CP26B.2 controller.
-- Does not modify 0001–0023. Does not write hotels.status.
-- Domain B payment apply (sbg_apply_payment_event) is untouched.
--
-- Ordering primitive: Stripe event.created is Unix seconds (integer).
-- Stored as bigint so comparisons equal Stripe's second-resolution clock
-- without timestamptz conversion or timezone artefacts.

alter table sbg_billing_accounts
  add column if not exists last_stripe_event_created bigint,
  add column if not exists last_stripe_event_id text,
  add column if not exists cancel_at_period_end boolean;

alter table sbg_billing_accounts
  drop constraint if exists sbg_billing_ordering_pair_check;

alter table sbg_billing_accounts
  add constraint sbg_billing_ordering_pair_check
  check (
    (last_stripe_event_created is null and last_stripe_event_id is null)
    or
    (last_stripe_event_created is not null and last_stripe_event_id is not null)
  );

alter table sbg_stripe_events
  add column if not exists hotel_id uuid,
  add column if not exists stripe_created bigint,
  add column if not exists outcome text;

alter table sbg_stripe_events
  drop constraint if exists sbg_stripe_event_outcome_check;

alter table sbg_stripe_events
  add constraint sbg_stripe_event_outcome_check
  check (
    outcome is null
    or outcome in ('applied', 'duplicate', 'stale', 'ambiguous', 'rejected')
  );

-- Remove last-write-wins signature so it cannot remain executable.
drop function if exists sbg_apply_billing_event(text, text, uuid, text, text, text, text, timestamptz);

create or replace function sbg_apply_billing_event(
  p_event_id text,
  p_event_type text,
  p_event_created bigint,
  p_hotel_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_price_id text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted text;
  v_hotel_id uuid;
  v_status text;
  v_sub_id text;
  v_last_created bigint;
  v_last_event_id text;
begin
  if p_event_id is null or length(btrim(p_event_id)) = 0
     or p_hotel_id is null
     or p_event_created is null
     or p_event_created < 0
  then
    return 'rejected';
  end if;

  insert into sbg_stripe_events (event_id, event_type, hotel_id, stripe_created)
  values (p_event_id, p_event_type, p_hotel_id, p_event_created)
  on conflict (event_id) do nothing
  returning event_id into v_inserted;

  if v_inserted is null then
    return 'duplicate';
  end if;

  -- Hotel row lock serialises concurrent applies for this hotel, including
  -- the first-insert case where no billing row yet exists to FOR UPDATE.
  select id into v_hotel_id from hotels where id = p_hotel_id for update;
  if v_hotel_id is null then
    update sbg_stripe_events set outcome = 'rejected' where event_id = p_event_id;
    return 'rejected';
  end if;

  select status, stripe_subscription_id, last_stripe_event_created, last_stripe_event_id
    into v_status, v_sub_id, v_last_created, v_last_event_id
    from sbg_billing_accounts
   where hotel_id = p_hotel_id
   for update;

  if p_status is null or p_status not in (
    'inactive',
    'incomplete',
    'incomplete_expired',
    'trialing',
    'active',
    'past_due',
    'paused',
    'unpaid',
    'canceled'
  ) then
    update sbg_stripe_events set outcome = 'rejected' where event_id = p_event_id;
    return 'rejected';
  end if;

  if v_last_created is not null then
    if p_event_created < v_last_created then
      update sbg_stripe_events set outcome = 'stale' where event_id = p_event_id;
      return 'stale';
    end if;
    if p_event_created = v_last_created then
      if p_event_id = v_last_event_id then
        update sbg_stripe_events set outcome = 'duplicate' where event_id = p_event_id;
        return 'duplicate';
      end if;
      update sbg_stripe_events set outcome = 'ambiguous' where event_id = p_event_id;
      return 'ambiguous';
    end if;
  end if;

  if v_sub_id is not null
     and p_subscription_id is not null
     and v_sub_id is distinct from p_subscription_id
     and v_status in ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'unpaid')
  then
    update sbg_stripe_events set outcome = 'rejected' where event_id = p_event_id;
    return 'rejected';
  end if;

  begin
    insert into sbg_billing_accounts (
      hotel_id,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_price_id,
      status,
      current_period_end,
      cancel_at_period_end,
      last_stripe_event_created,
      last_stripe_event_id,
      updated_at
    )
    values (
      p_hotel_id,
      p_customer_id,
      p_subscription_id,
      p_price_id,
      p_status,
      p_current_period_end,
      p_cancel_at_period_end,
      p_event_created,
      p_event_id,
      now()
    )
    on conflict (hotel_id) do update
      set stripe_customer_id = coalesce(excluded.stripe_customer_id, sbg_billing_accounts.stripe_customer_id),
          stripe_subscription_id = coalesce(excluded.stripe_subscription_id, sbg_billing_accounts.stripe_subscription_id),
          stripe_price_id = coalesce(excluded.stripe_price_id, sbg_billing_accounts.stripe_price_id),
          status = excluded.status,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end,
          last_stripe_event_created = excluded.last_stripe_event_created,
          last_stripe_event_id = excluded.last_stripe_event_id,
          updated_at = now();
  exception
    when unique_violation then
      update sbg_stripe_events set outcome = 'rejected' where event_id = p_event_id;
      return 'rejected';
  end;

  update sbg_stripe_events set outcome = 'applied' where event_id = p_event_id;
  return 'applied';
end;
$$;

revoke all on function sbg_apply_billing_event(text, text, bigint, uuid, text, text, text, text, timestamptz, boolean) from public;
grant execute on function sbg_apply_billing_event(text, text, bigint, uuid, text, text, text, text, timestamptz, boolean) to aether_app;
