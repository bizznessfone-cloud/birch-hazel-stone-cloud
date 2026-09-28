-- CP27.2 — repair ambiguous RETURNING in sbg_prepare_booking_payment. SOURCE ONLY.
-- Does not edit migrations/0021_cp25_hotel_guest_payments.sql.
-- Do not apply through the generic Production migrator.
-- Do not add this file to ACCEPTED_LEDGER.
-- Production application requires the dedicated 0030 controller and a later authorisation.
--
-- Root cause, reproduced as 42702: RETURNS TABLE creates PL/pgSQL variables
-- for every output name, including booking_id. The 0021 inserted CTE uses an
-- unqualified RETURNING list, so booking_id can mean either the output
-- variable or the target column. Reproduced again after qualification:
-- both "sbg_booking_payments.booking_id" and
-- "public.sbg_booking_payments.booking_id" still raise 42702.
-- #variable_conflict use_column is the minimum compiler directive that lets
-- those qualified target-column references win. It does not rename outputs,
-- does not change the insert/conflict/amount contract, and does not replace
-- any other Domain B function.
--
-- search_path is narrowed to pg_catalog, public for this function only.
-- That is a partial M4 repair. sbg_set_booking_checkout_session and
-- sbg_apply_payment_event are unchanged. Application relations and
-- pg_catalog.btrim / pg_catalog.now are schema-qualified.
--
-- Privileges stay the 0021 contract: PUBLIC has no EXECUTE; aether_app keeps
-- EXECUTE. No table DML grant is added. Pre-existing aether_runtime grants
-- are not revoked and not extended (that would be role-drift remediation).

create or replace function public.sbg_prepare_booking_payment(p_confirmation_token text)
returns table (
  payment_id uuid,
  booking_id uuid,
  hotel_id uuid,
  stripe_account_id text,
  amount_minor integer,
  currency text,
  status text,
  checkout_session_id text,
  checkout_url text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  return query
  with target as (
    select
      b.id as booking_id,
      b.hotel_id,
      b.quoted_amount_minor,
      pg_catalog.btrim(b.quoted_currency) as quoted_currency
    from public.bookings b
    where b.confirmation_token = p_confirmation_token
      and b.cancelled_at is null
    for update
  ),
  connection as (
    select c.hotel_id, c.stripe_account_id
    from public.sbg_stripe_connections c
    join target t on t.hotel_id = c.hotel_id
    where c.disconnected_at is null
    limit 1
  ),
  inserted as (
    insert into public.sbg_booking_payments (booking_id, amount_minor, currency)
    select t.booking_id, t.quoted_amount_minor, t.quoted_currency
    from target t
    join connection c on c.hotel_id = t.hotel_id
    where t.quoted_amount_minor is not null
      and t.quoted_amount_minor > 0
      and t.quoted_currency is not null
    on conflict (booking_id) do update
      set status = case
            when sbg_booking_payments.status in ('failed', 'expired', 'canceled') then 'pending'
            else sbg_booking_payments.status
          end,
          stripe_checkout_session_id = case
            when sbg_booking_payments.status in ('failed', 'expired', 'canceled') then null
            else sbg_booking_payments.stripe_checkout_session_id
          end,
          stripe_checkout_url = case
            when sbg_booking_payments.status in ('failed', 'expired', 'canceled') then null
            else sbg_booking_payments.stripe_checkout_url
          end,
          stripe_payment_intent_id = case
            when sbg_booking_payments.status in ('failed', 'expired', 'canceled') then null
            else sbg_booking_payments.stripe_payment_intent_id
          end,
          updated_at = pg_catalog.now()
    returning
      public.sbg_booking_payments.id,
      public.sbg_booking_payments.booking_id,
      public.sbg_booking_payments.amount_minor,
      public.sbg_booking_payments.currency,
      public.sbg_booking_payments.status,
      public.sbg_booking_payments.stripe_checkout_session_id,
      public.sbg_booking_payments.stripe_checkout_url
  )
  select
    i.id,
    i.booking_id,
    t.hotel_id,
    c.stripe_account_id,
    i.amount_minor,
    i.currency,
    i.status,
    i.stripe_checkout_session_id,
    i.stripe_checkout_url
  from inserted i
  join target t on t.booking_id = i.booking_id
  join connection c on c.hotel_id = t.hotel_id;

  if not found then
    raise exception 'booking payment unavailable';
  end if;
end;
$$;

revoke all on function public.sbg_prepare_booking_payment(text) from public;
grant execute on function public.sbg_prepare_booking_payment(text) to aether_app;
