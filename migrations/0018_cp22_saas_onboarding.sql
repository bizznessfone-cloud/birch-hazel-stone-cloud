-- SCAN / BOOK / GO — CP22 V1 operator onboarding foundation
-- Adds only the product-layer ownership/service seam required by the V1 wizard.
-- Hardened booking, occupancy, tenancy and Ops tables remain unchanged.
--
-- Production runtime does NOT receive table DML for hotel provisioning objects.
-- Narrow SECURITY DEFINER functions, owned by the migration/schema owner, expose
-- only the specific onboarding capabilities required by the authenticated app.
-- The caller identity is the verified Better Auth user id supplied by the app.
--
-- No password values, no role creation, no ownership transfers, no RLS.

create table if not exists app_hotel_accounts (
  user_id text not null references "user" ("id") on delete cascade,
  hotel_id uuid not null references hotels (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, hotel_id)
);

create index if not exists app_hotel_accounts_hotel_idx
  on app_hotel_accounts (hotel_id);

create table if not exists hotel_services (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete cascade,
  kind text not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint hotel_services_kind_check check (kind in ('transfer')),
  constraint hotel_services_name_present check (char_length(btrim(name)) > 0)
);

create unique index if not exists hotel_services_hotel_kind_active_uidx
  on hotel_services (hotel_id, kind)
  where active;

create index if not exists hotel_services_hotel_idx
  on hotel_services (hotel_id);

revoke all on table app_hotel_accounts from aether_app;
revoke all on table hotel_services from aether_app;
grant select on table app_hotel_accounts, hotel_services to aether_app;

revoke all on all functions in schema public from aether_app;

-- ---------------------------------------------------------------------------
-- Narrow onboarding capabilities.
-- These functions are deliberately the only runtime path that mutates the
-- onboarding-owned hotel/service/destination objects.
-- ---------------------------------------------------------------------------

create or replace function sbg_create_hotel_for_user(
  p_user_id text,
  p_code text,
  p_name text,
  p_locality text,
  p_iana_timezone text,
  p_currency text
)
returns table (
  hotel_id uuid,
  provider_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $aether$
declare
  v_hotel_id uuid;
  v_provider_id uuid;
  v_provider_code text;
begin
  if not exists (select 1 from "user" where id = p_user_id) then
    raise exception 'account not found' using errcode = '22023';
  end if;

  if p_code is null or p_code !~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$' then
    raise exception 'invalid hotel code' using errcode = '22023';
  end if;
  if char_length(p_code) < 2 or char_length(p_code) > 32 then
    raise exception 'invalid hotel code' using errcode = '22023';
  end if;
  if lower(p_code) in ('gate', 'harbor') then
    raise exception 'reserved hotel code' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'invalid hotel name' using errcode = '22023';
  end if;
  if p_locality is null or char_length(btrim(p_locality)) = 0 then
    raise exception 'invalid locality' using errcode = '22023';
  end if;
  if p_iana_timezone is null
     or not exists (select 1 from pg_timezone_names where name = btrim(p_iana_timezone)) then
    raise exception 'invalid IANA timezone' using errcode = '22023';
  end if;
  if p_currency is null or upper(btrim(p_currency)) !~ '^[A-Z]{3}$' then
    raise exception 'invalid currency' using errcode = '22023';
  end if;

  insert into hotels (code, name, locality, iana_timezone, currency, status)
  values (
    lower(btrim(p_code)),
    btrim(p_name),
    btrim(p_locality),
    btrim(p_iana_timezone),
    upper(btrim(p_currency)),
    'unconfigured'
  )
  returning id into v_hotel_id;

  v_provider_code := 'sbg-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);

  insert into providers (code, name, kind)
  values (v_provider_code, btrim(p_name) || ' Transfers', 'in_house')
  returning id into v_provider_id;

  insert into hotel_provider_agreements (hotel_id, provider_id, active)
  values (v_hotel_id, v_provider_id, true);

  insert into app_hotel_accounts (user_id, hotel_id)
  values (p_user_id, v_hotel_id);

  return query select v_hotel_id, v_provider_id;
exception
  when unique_violation then
    raise exception 'hotel code already exists' using errcode = '23505';
end;
$aether$;

create or replace function sbg_create_service_for_user(
  p_user_id text,
  p_hotel_id uuid,
  p_kind text,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $aether$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from app_hotel_accounts
    where user_id = p_user_id and hotel_id = p_hotel_id
  ) then
    raise exception 'hotel is not owned by account' using errcode = '42501';
  end if;

  if p_kind <> 'transfer' then
    raise exception 'unsupported service' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'invalid service name' using errcode = '22023';
  end if;
  if exists (
    select 1 from hotel_services
    where hotel_id = p_hotel_id and kind = p_kind and active
  ) then
    raise exception 'active service already exists' using errcode = '23505';
  end if;

  insert into hotel_services (hotel_id, kind, name, active)
  values (p_hotel_id, p_kind, btrim(p_name), true)
  returning id into v_id;

  return v_id;
end;
$aether$;

create or replace function sbg_add_destination_for_user(
  p_user_id text,
  p_hotel_id uuid,
  p_kind text,
  p_name text,
  p_amount_minor integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $aether$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from app_hotel_accounts
    where user_id = p_user_id and hotel_id = p_hotel_id
  ) then
    raise exception 'hotel is not owned by account' using errcode = '42501';
  end if;

  if p_kind not in ('airport', 'port', 'hotel', 'other') then
    raise exception 'invalid destination kind' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'invalid destination name' using errcode = '22023';
  end if;
  if p_amount_minor is null or p_amount_minor < 0 then
    raise exception 'invalid destination amount' using errcode = '22023';
  end if;

  insert into hotel_destinations (hotel_id, kind, name, amount_minor)
  values (p_hotel_id, p_kind, btrim(p_name), p_amount_minor)
  returning id into v_id;

  return v_id;
end;
$aether$;

create or replace function sbg_promote_configured_for_user(
  p_user_id text,
  p_hotel_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $aether$
declare
  v_status text;
begin
  if not exists (
    select 1 from app_hotel_accounts
    where user_id = p_user_id and hotel_id = p_hotel_id
  ) then
    raise exception 'hotel is not owned by account' using errcode = '42501';
  end if;

  select status into v_status from hotels where id = p_hotel_id for update;
  if v_status is null then
    raise exception 'hotel not found' using errcode = 'P0002';
  end if;
  if v_status = 'live' then
    return true;
  end if;
  if v_status <> 'unconfigured' then
    return false;
  end if;
  if not exists (
    select 1 from hotel_services
    where hotel_id = p_hotel_id and active
  ) then
    raise exception 'at least one active service is required' using errcode = '23514';
  end if;
  if not exists (
    select 1 from hotel_destinations
    where hotel_id = p_hotel_id and active
  ) then
    raise exception 'at least one active destination is required' using errcode = '23514';
  end if;
  if (select count(*) from hotel_provider_agreements where hotel_id = p_hotel_id and active) <> 1 then
    raise exception 'exactly one active provider agreement is required' using errcode = '23514';
  end if;

  update hotels set status = 'configured'
   where id = p_hotel_id and status = 'unconfigured';

  return true;
end;
$aether$;

revoke all on function sbg_create_hotel_for_user(text,text,text,text,text,text) from public;
revoke all on function sbg_create_service_for_user(text,uuid,text,text) from public;
revoke all on function sbg_add_destination_for_user(text,uuid,text,text,integer) from public;
revoke all on function sbg_promote_configured_for_user(text,uuid) from public;

grant execute on function sbg_create_hotel_for_user(text,text,text,text,text,text) to aether_app;
grant execute on function sbg_create_service_for_user(text,uuid,text,text) to aether_app;
grant execute on function sbg_add_destination_for_user(text,uuid,text,text,integer) to aether_app;
grant execute on function sbg_promote_configured_for_user(text,uuid) to aether_app;

insert into aether_meta (key, value)
values ('checkpoint', '22')
on conflict (key) do update set value = excluded.value, updated_at = now();
