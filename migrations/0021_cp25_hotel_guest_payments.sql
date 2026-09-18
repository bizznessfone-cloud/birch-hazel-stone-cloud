-- CP25 — hotel-owned guest transfer payments via Stripe Connect direct charges
-- Source-only checkpoint. Apply only through the controlled migration process.

create table if not exists sbg_booking_payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings (id) on delete cascade,
  stripe_checkout_session_id text unique,
  stripe_checkout_url text,
  stripe_payment_intent_id text unique,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  constraint sbg_booking_payment_status_check
    check (status in ('pending','paid','failed','expired','canceled'))
);

revoke all on table sbg_booking_payments from public;
grant select on table sbg_booking_payments to aether_app;

create or replace function sbg_prepare_booking_payment(p_confirmation_token text)
returns table (payment_id uuid, booking_id uuid, hotel_id uuid, stripe_account_id text, amount_minor integer, currency text, status text, checkout_session_id text)
language plpgsql security definer set search_path = public
as $$
begin
  return query
  with target as (
    select b.id as booking_id, b.hotel_id, b.quoted_amount_minor, btrim(b.quoted_currency) as quoted_currency
    from bookings b
    where b.confirmation_token = p_confirmation_token and b.cancelled_at is null
    for update
  ),
  connection as (
    select c.hotel_id, c.stripe_account_id
    from sbg_stripe_connections c
    join target t on t.hotel_id = c.hotel_id
    where c.disconnected_at is null
    limit 1
  ),
  inserted as (
    insert into sbg_booking_payments (booking_id, amount_minor, currency)
    select t.booking_id, t.quoted_amount_minor, t.quoted_currency
    from target t
    join connection c on c.hotel_id = t.hotel_id
    where t.quoted_amount_minor is not null and t.quoted_amount_minor > 0 and t.quoted_currency is not null
    on conflict (booking_id) do update set updated_at = now()
    returning id, booking_id, amount_minor, currency, status, stripe_checkout_session_id
  )
  select i.id, i.booking_id, t.hotel_id, c.stripe_account_id, i.amount_minor, i.currency, i.status, i.stripe_checkout_session_id
  from inserted i
  join target t on t.booking_id = i.booking_id
  join connection c on c.hotel_id = t.hotel_id;

  if not found then raise exception 'booking payment unavailable'; end if;
end;
$$;

create or replace function sbg_set_booking_checkout_session(p_payment_id uuid, p_checkout_session_id text)
returns void language sql security definer set search_path = public
as $
  update sbg_booking_payments
     set stripe_checkout_session_id = p_checkout_session_id, updated_at = now()
   where id = p_payment_id and status = 'pending';
$$;

create or replace function sbg_apply_payment_event(
  p_event_id text, p_event_type text, p_booking_id uuid, p_payment_id uuid,
  p_payment_intent_id text, p_status text
)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  insert into sbg_stripe_events (event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (event_id) do nothing;
  if not found then return false; end if;

  update sbg_booking_payments
     set stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id),
         status = p_status,
         paid_at = case when p_status = 'paid' then coalesce(paid_at, now()) else paid_at end,
         updated_at = now()
   where id = p_payment_id and booking_id = p_booking_id;
  return true;
end;
$$;

revoke all on function sbg_prepare_booking_payment(text) from public;
revoke all on function sbg_set_booking_checkout_session(uuid,text) from public;
revoke all on function sbg_apply_payment_event(text,text,uuid,uuid,text,text) from public;
grant execute on function sbg_prepare_booking_payment(text) to aether_app;
grant execute on function sbg_set_booking_checkout_session(uuid,text) to aether_app;
grant execute on function sbg_apply_payment_event(text,text,uuid,uuid,text,text) to aether_app;
