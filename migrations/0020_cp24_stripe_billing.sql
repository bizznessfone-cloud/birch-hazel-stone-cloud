-- CP24 — SBG subscription billing + hotel Stripe Connect state
-- Source-only checkpoint. Apply only through the controlled migration process.

create table if not exists sbg_billing_accounts (
  hotel_id uuid primary key references hotels (id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  status text not null default 'inactive',
  current_period_end timestamptz,
  updated_at timestamptz not null default now(),
  constraint sbg_billing_status_check
    check (status in ('inactive','incomplete','trialing','active','past_due','paused','unpaid','canceled','incomplete_expired'))
);

create unique index if not exists sbg_billing_customer_uidx
  on sbg_billing_accounts (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists sbg_billing_subscription_uidx
  on sbg_billing_accounts (stripe_subscription_id)
  where stripe_subscription_id is not null;

create table if not exists sbg_stripe_connections (
  hotel_id uuid primary key references hotels (id) on delete cascade,
  stripe_account_id text not null unique,
  livemode boolean not null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz
);

create table if not exists sbg_stripe_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

revoke all on table sbg_billing_accounts from public;
revoke all on table sbg_stripe_connections from public;
revoke all on table sbg_stripe_events from public;

grant select on table sbg_billing_accounts to aether_app;
grant select on table sbg_stripe_connections to aether_app;

create or replace function sbg_save_stripe_connection_for_user(
  p_user_id text,
  p_hotel_id uuid,
  p_stripe_account_id text,
  p_livemode boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from app_hotel_accounts
     where user_id = p_user_id
       and hotel_id = p_hotel_id
  ) then
    raise exception 'hotel ownership mismatch';
  end if;

  insert into sbg_stripe_connections (
    hotel_id, stripe_account_id, livemode, connected_at, disconnected_at
  )
  values (
    p_hotel_id, p_stripe_account_id, p_livemode, now(), null
  )
  on conflict (hotel_id) do update
    set stripe_account_id = excluded.stripe_account_id,
        livemode = excluded.livemode,
        connected_at = excluded.connected_at,
        disconnected_at = null;
end;
$$;

create or replace function sbg_set_billing_price_for_user(
  p_user_id text,
  p_hotel_id uuid,
  p_stripe_price_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from app_hotel_accounts
     where user_id = p_user_id
       and hotel_id = p_hotel_id
  ) then
    raise exception 'hotel ownership mismatch';
  end if;

  insert into sbg_billing_accounts (hotel_id, stripe_price_id, status, updated_at)
  values (p_hotel_id, p_stripe_price_id, 'inactive', now())
  on conflict (hotel_id) do update
    set stripe_price_id = excluded.stripe_price_id,
        updated_at = now();
end;
$$;

create or replace function sbg_apply_billing_event(
  p_event_id text,
  p_event_type text,
  p_hotel_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_price_id text,
  p_status text,
  p_current_period_end timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into sbg_stripe_events (event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (event_id) do nothing;

  if not found then
    return false;
  end if;

  insert into sbg_billing_accounts (
    hotel_id,
    stripe_customer_id,
    stripe_subscription_id,
    stripe_price_id,
    status,
    current_period_end,
    updated_at
  )
  values (
    p_hotel_id,
    p_customer_id,
    p_subscription_id,
    p_price_id,
    p_status,
    p_current_period_end,
    now()
  )
  on conflict (hotel_id) do update
    set stripe_customer_id = coalesce(excluded.stripe_customer_id, sbg_billing_accounts.stripe_customer_id),
        stripe_subscription_id = coalesce(excluded.stripe_subscription_id, sbg_billing_accounts.stripe_subscription_id),
        stripe_price_id = coalesce(excluded.stripe_price_id, sbg_billing_accounts.stripe_price_id),
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        updated_at = now();

  return true;
end;
$$;

create or replace function sbg_disconnect_stripe_for_hotel(
  p_hotel_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update sbg_stripe_connections
     set disconnected_at = now()
   where hotel_id = p_hotel_id;
$$;

revoke all on function sbg_save_stripe_connection_for_user(text,uuid,text,boolean) from public;
revoke all on function sbg_set_billing_price_for_user(text,uuid,text) from public;
revoke all on function sbg_apply_billing_event(text,text,uuid,text,text,text,text,timestamptz) from public;
revoke all on function sbg_disconnect_stripe_for_hotel(uuid) from public;

grant execute on function sbg_save_stripe_connection_for_user(text,uuid,text,boolean) to aether_app;
grant execute on function sbg_set_billing_price_for_user(text,uuid,text) to aether_app;
grant execute on function sbg_apply_billing_event(text,text,uuid,text,text,text,text,timestamptz) to aether_app;
grant execute on function sbg_disconnect_stripe_for_hotel(uuid) to aether_app;

create or replace function sbg_disconnect_stripe_by_account(
  p_stripe_account_id text
)
returns void
language sql
security definer
set search_path = public
as $$
  update sbg_stripe_connections
     set disconnected_at = now()
   where stripe_account_id = p_stripe_account_id;
$$;

revoke all on function sbg_disconnect_stripe_by_account(text) from public;
grant execute on function sbg_disconnect_stripe_by_account(text) to aether_app;

create or replace function sbg_sync_hotel_entitlement(p_hotel_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_billing_status text;
  v_connected boolean;
  v_current_status text;
begin
  select status into v_billing_status
    from sbg_billing_accounts
   where hotel_id = p_hotel_id;

  select exists (
    select 1 from sbg_stripe_connections
     where hotel_id = p_hotel_id
       and disconnected_at is null
  ) into v_connected;

  select status into v_current_status from hotels where id = p_hotel_id for update;
  if v_current_status is null then
    raise exception 'hotel not found' using errcode = 'P0002';
  end if;

  if v_billing_status in ('active', 'trialing')
     and v_connected
     and exists (select 1 from hotel_services where hotel_id = p_hotel_id and active)
     and exists (select 1 from hotel_destinations where hotel_id = p_hotel_id and active)
     and (select count(*) from hotel_provider_agreements where hotel_id = p_hotel_id and active) = 1 then
    update hotels set status = 'live' where id = p_hotel_id and status <> 'live';
    return 'live';
  end if;

  if v_current_status = 'live' then
    update hotels set status = 'configured' where id = p_hotel_id;
  end if;
  return 'configured';
end;
$$;

revoke all on function sbg_sync_hotel_entitlement(uuid) from public;
grant execute on function sbg_sync_hotel_entitlement(uuid) to aether_app;
