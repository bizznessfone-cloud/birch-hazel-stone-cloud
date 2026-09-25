-- CP26C-O3.2 — commercial catalogue persistence
-- SOURCE ONLY. Do not apply through the generic Production migrator.
-- Production application requires a dedicated later controller/checkpoint.
-- Canonical BASIC / PRO / PREMIUM amounts remain UNDEFINED.
-- No billing-account changes. No hotels.status writes. No Stripe calls.

create table if not exists sbg_saas_plans (
  code text primary key,
  name text not null,
  description text not null default '',
  sort_order integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sbg_saas_plans_code_check check (code in ('basic', 'pro', 'premium')),
  constraint sbg_saas_plans_name_present check (char_length(btrim(name)) > 0)
);

create table if not exists sbg_saas_price_versions (
  id uuid primary key default gen_random_uuid(),
  plan_code text not null references sbg_saas_plans(code),
  currency text not null,
  amount_minor integer not null,
  billing_interval text not null,
  interval_count smallint not null,
  effective_from timestamptz,
  retired_at timestamptz,
  purchasable boolean not null default false,
  created_at timestamptz not null default now(),
  created_by_user_id text not null references "user"("id") on delete restrict,
  constraint sbg_saas_price_currency_v1 check (currency = 'EUR'),
  constraint sbg_saas_price_amount_positive check (amount_minor > 0),
  constraint sbg_saas_price_interval_v1 check (billing_interval = 'month'),
  constraint sbg_saas_price_interval_count_v1 check (interval_count = 1),
  constraint sbg_saas_price_retired_not_purchasable check (retired_at is null or not purchasable)
);

create unique index if not exists sbg_saas_price_versions_one_purchasable_idx
  on sbg_saas_price_versions(plan_code, currency, billing_interval)
  where purchasable;
create index if not exists sbg_saas_price_versions_history_idx
  on sbg_saas_price_versions(plan_code, created_at desc);

create table if not exists sbg_saas_stripe_mappings (
  id uuid primary key default gen_random_uuid(),
  price_version_id uuid not null references sbg_saas_price_versions(id),
  environment text not null,
  stripe_product_id text not null,
  stripe_price_id text not null,
  status text not null,
  created_at timestamptz not null default now(),
  mapped_at timestamptz not null default now(),
  actor_user_id text references "user"("id") on delete restrict,
  constraint sbg_saas_mapping_environment check (environment in ('test', 'live')),
  constraint sbg_saas_mapping_product_id check (stripe_product_id ~ '^prod_[A-Za-z0-9_]+$'),
  constraint sbg_saas_mapping_price_id check (stripe_price_id ~ '^price_[A-Za-z0-9_]+$'),
  constraint sbg_saas_mapping_status check (status in ('verified', 'replaced')),
  constraint sbg_saas_mapping_price_unique unique (stripe_price_id)
);

create unique index if not exists sbg_saas_mapping_one_verified_idx
  on sbg_saas_stripe_mappings(price_version_id, environment)
  where status = 'verified';

create table if not exists sbg_saas_commerce_locks (
  id smallint primary key,
  live_mapping_enabled boolean not null default false,
  live_checkout_enabled boolean not null default false,
  constraint sbg_saas_commerce_locks_singleton check (id = 1)
);

revoke all on table sbg_saas_plans from public;
revoke all on table sbg_saas_price_versions from public;
revoke all on table sbg_saas_stripe_mappings from public;
revoke all on table sbg_saas_commerce_locks from public;
revoke all on table sbg_saas_plans from aether_app;
revoke all on table sbg_saas_price_versions from aether_app;
revoke all on table sbg_saas_stripe_mappings from aether_app;
revoke all on table sbg_saas_commerce_locks from aether_app;
grant select on table sbg_saas_plans to aether_app;
grant select on table sbg_saas_price_versions to aether_app;
grant select on table sbg_saas_stripe_mappings to aether_app;
grant select on table sbg_saas_commerce_locks to aether_app;

create or replace function sbg_catalogue_require_owner(p_actor_user_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $catalogue$
declare
  v_revoked_at timestamptz;
begin
  if p_actor_user_id is null or char_length(btrim(p_actor_user_id)) = 0 then
    raise exception 'not a platform owner' using errcode = '42501';
  end if;
  select revoked_at into v_revoked_at
    from sbg_platform_owners
   where user_id = p_actor_user_id
   for share;
  if not found or v_revoked_at is not null then
    raise exception 'not a platform owner' using errcode = '42501';
  end if;
end;
$catalogue$;

create or replace function sbg_catalogue_reject_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $catalogue$
begin
  raise exception 'catalogue history cannot be deleted' using errcode = '42501';
end;
$catalogue$;

create or replace function sbg_catalogue_plan_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $catalogue$
begin
  if new.code is distinct from old.code then
    raise exception 'plan code is immutable' using errcode = '42501';
  end if;
  return new;
end;
$catalogue$;

create or replace function sbg_catalogue_price_version_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $catalogue$
begin
  if new.id is distinct from old.id
     or new.plan_code is distinct from old.plan_code
     or new.currency is distinct from old.currency
     or new.amount_minor is distinct from old.amount_minor
     or new.billing_interval is distinct from old.billing_interval
     or new.interval_count is distinct from old.interval_count
     or new.created_at is distinct from old.created_at
     or new.created_by_user_id is distinct from old.created_by_user_id then
    raise exception 'commercial price terms are immutable' using errcode = '42501';
  end if;
  if old.effective_from is not null and new.effective_from is distinct from old.effective_from then
    raise exception 'effective_from is immutable after activation' using errcode = '42501';
  end if;
  if old.retired_at is not null and new.retired_at is distinct from old.retired_at then
    raise exception 'retired_at is immutable after retirement' using errcode = '42501';
  end if;
  if old.retired_at is not null and new.purchasable then
    raise exception 'retired price cannot be purchasable' using errcode = '23514';
  end if;
  return new;
end;
$catalogue$;

create or replace function sbg_owner_audit_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $catalogue$
begin
  raise exception 'owner audit is append-only' using errcode = '42501';
end;
$catalogue$;

drop trigger if exists sbg_saas_plans_no_delete on sbg_saas_plans;
create trigger sbg_saas_plans_no_delete before delete on sbg_saas_plans
for each row execute function sbg_catalogue_reject_delete();
drop trigger if exists sbg_saas_plans_no_truncate on sbg_saas_plans;
create trigger sbg_saas_plans_no_truncate before truncate on sbg_saas_plans
for each statement execute function sbg_catalogue_reject_delete();
drop trigger if exists sbg_saas_plans_code_guard on sbg_saas_plans;
create trigger sbg_saas_plans_code_guard before update on sbg_saas_plans
for each row execute function sbg_catalogue_plan_guard();
drop trigger if exists sbg_saas_price_versions_guard on sbg_saas_price_versions;
create trigger sbg_saas_price_versions_guard before update on sbg_saas_price_versions
for each row execute function sbg_catalogue_price_version_guard();
drop trigger if exists sbg_saas_price_versions_no_delete on sbg_saas_price_versions;
create trigger sbg_saas_price_versions_no_delete before delete on sbg_saas_price_versions
for each row execute function sbg_catalogue_reject_delete();
drop trigger if exists sbg_saas_price_versions_no_truncate on sbg_saas_price_versions;
create trigger sbg_saas_price_versions_no_truncate before truncate on sbg_saas_price_versions
for each statement execute function sbg_catalogue_reject_delete();
drop trigger if exists sbg_saas_stripe_mappings_no_delete on sbg_saas_stripe_mappings;
create trigger sbg_saas_stripe_mappings_no_delete before delete on sbg_saas_stripe_mappings
for each row execute function sbg_catalogue_reject_delete();
drop trigger if exists sbg_saas_stripe_mappings_no_truncate on sbg_saas_stripe_mappings;
create trigger sbg_saas_stripe_mappings_no_truncate before truncate on sbg_saas_stripe_mappings
for each statement execute function sbg_catalogue_reject_delete();
drop trigger if exists sbg_owner_audit_immutable on sbg_owner_audit_events;
create trigger sbg_owner_audit_immutable before update or delete on sbg_owner_audit_events
for each row execute function sbg_owner_audit_immutable();
drop trigger if exists sbg_owner_audit_no_truncate on sbg_owner_audit_events;
create trigger sbg_owner_audit_no_truncate before truncate on sbg_owner_audit_events
for each statement execute function sbg_owner_audit_immutable();

create or replace function sbg_catalogue_update_plan(
  p_actor_user_id text,
  p_plan_code text,
  p_name text,
  p_description text,
  p_sort_order integer,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $catalogue$
declare
  v_before jsonb;
  v_after jsonb;
begin
  perform sbg_catalogue_require_owner(p_actor_user_id);
  select jsonb_build_object('name', name, 'description', description, 'sort_order', sort_order, 'active', active)
    into v_before from sbg_saas_plans where code = p_plan_code for update;
  if not found then raise exception 'plan not found' using errcode = 'P0002'; end if;
  if p_name is null or char_length(btrim(p_name)) = 0 or p_sort_order is null or p_active is null then
    raise exception 'invalid plan' using errcode = '22023';
  end if;
  update sbg_saas_plans
     set name = btrim(p_name), description = coalesce(p_description, ''), sort_order = p_sort_order,
         active = p_active, updated_at = now()
   where code = p_plan_code;
  select jsonb_build_object('name', name, 'description', description, 'sort_order', sort_order, 'active', active)
    into v_after from sbg_saas_plans where code = p_plan_code;
  insert into sbg_owner_audit_events(actor_user_id, action, target_type, target_id, metadata)
  values (p_actor_user_id, 'catalogue.plan.updated', 'commercial_plan', p_plan_code,
          jsonb_build_object('before', v_before, 'after', v_after));
end;
$catalogue$;

create or replace function sbg_catalogue_create_price_version(
  p_actor_user_id text,
  p_plan_code text,
  p_amount_minor integer,
  p_currency text default 'EUR',
  p_billing_interval text default 'month',
  p_interval_count smallint default 1
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $catalogue$
declare
  v_id uuid;
begin
  perform sbg_catalogue_require_owner(p_actor_user_id);
  if not exists (select 1 from sbg_saas_plans where code = p_plan_code) then
    raise exception 'plan not found' using errcode = 'P0002';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_currency <> 'EUR'
     or p_billing_interval <> 'month' or p_interval_count <> 1 then
    raise exception 'invalid commercial price' using errcode = '22023';
  end if;
  insert into sbg_saas_price_versions(plan_code, currency, amount_minor, billing_interval, interval_count, created_by_user_id)
  values (p_plan_code, p_currency, p_amount_minor, p_billing_interval, p_interval_count, p_actor_user_id)
  returning id into v_id;
  insert into sbg_owner_audit_events(actor_user_id, action, target_type, target_id, metadata)
  values (p_actor_user_id, 'catalogue.price.created', 'commercial_price_version', v_id::text,
          jsonb_build_object('plan_code', p_plan_code, 'currency', p_currency, 'amount_minor', p_amount_minor,
                             'interval', p_billing_interval, 'interval_count', p_interval_count));
  return v_id;
end;
$catalogue$;

create or replace function sbg_catalogue_activate_price_version(
  p_actor_user_id text,
  p_price_version_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $catalogue$
declare
  v_plan_code text;
  v_currency text;
  v_interval text;
  v_retired_at timestamptz;
  v_plan_active boolean;
  v_previous uuid;
begin
  perform sbg_catalogue_require_owner(p_actor_user_id);
  select plan_code, currency, billing_interval, retired_at
    into v_plan_code, v_currency, v_interval, v_retired_at
    from sbg_saas_price_versions where id = p_price_version_id;
  if not found then raise exception 'price version not found' using errcode = 'P0002'; end if;
  select active into v_plan_active from sbg_saas_plans where code = v_plan_code for update;
  if not v_plan_active then raise exception 'plan inactive' using errcode = '23514'; end if;
  if v_retired_at is not null then raise exception 'price version retired' using errcode = '23514'; end if;
  select id into v_previous from sbg_saas_price_versions
   where plan_code = v_plan_code and currency = v_currency and billing_interval = v_interval and purchasable
   limit 1;
  update sbg_saas_price_versions set purchasable = false
   where plan_code = v_plan_code and currency = v_currency and billing_interval = v_interval and purchasable;
  update sbg_saas_price_versions
     set purchasable = true, effective_from = coalesce(effective_from, now())
   where id = p_price_version_id;
  insert into sbg_owner_audit_events(actor_user_id, action, target_type, target_id, metadata)
  values (p_actor_user_id, 'catalogue.price.activated', 'commercial_price_version', p_price_version_id::text,
          jsonb_build_object('previous_purchasable_version_id', v_previous));
end;
$catalogue$;

create or replace function sbg_catalogue_retire_price_version(
  p_actor_user_id text,
  p_price_version_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $catalogue$
declare
  v_plan_code text;
  v_retired_at timestamptz;
begin
  perform sbg_catalogue_require_owner(p_actor_user_id);
  select plan_code, retired_at into v_plan_code, v_retired_at
    from sbg_saas_price_versions where id = p_price_version_id for update;
  if not found then raise exception 'price version not found' using errcode = 'P0002'; end if;
  if v_retired_at is not null then raise exception 'price version already retired' using errcode = '23514'; end if;
  update sbg_saas_price_versions set retired_at = now(), purchasable = false where id = p_price_version_id;
  insert into sbg_owner_audit_events(actor_user_id, action, target_type, target_id, metadata)
  values (p_actor_user_id, 'catalogue.price.retired', 'commercial_price_version', p_price_version_id::text,
          jsonb_build_object('plan_code', v_plan_code));
end;
$catalogue$;

create or replace function sbg_catalogue_record_stripe_mapping(
  p_actor_user_id text,
  p_price_version_id uuid,
  p_environment text,
  p_stripe_product_id text,
  p_stripe_price_id text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $catalogue$
declare
  v_id uuid;
  v_previous uuid;
  v_live_mapping_enabled boolean;
begin
  perform sbg_catalogue_require_owner(p_actor_user_id);
  if p_environment not in ('test', 'live') then raise exception 'invalid Stripe environment' using errcode = '22023'; end if;
  if p_stripe_product_id !~ '^prod_[A-Za-z0-9_]+$' or p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$' then
    raise exception 'invalid Stripe identifier' using errcode = '22023';
  end if;
  if not exists (select 1 from sbg_saas_price_versions where id = p_price_version_id) then
    raise exception 'price version not found' using errcode = 'P0002';
  end if;
  select live_mapping_enabled into v_live_mapping_enabled from sbg_saas_commerce_locks where id = 1 for share;
  if p_environment = 'live' and not coalesce(v_live_mapping_enabled, false) then
    raise exception 'live Stripe mapping is locked' using errcode = '42501';
  end if;
  select id into v_previous from sbg_saas_stripe_mappings
   where price_version_id = p_price_version_id and environment = p_environment and status = 'verified'
   for update;
  if v_previous is not null then
    update sbg_saas_stripe_mappings set status = 'replaced' where id = v_previous;
  end if;
  insert into sbg_saas_stripe_mappings(price_version_id, environment, stripe_product_id, stripe_price_id, status, actor_user_id)
  values (p_price_version_id, p_environment, p_stripe_product_id, p_stripe_price_id, 'verified', p_actor_user_id)
  returning id into v_id;
  if v_previous is not null then
    insert into sbg_owner_audit_events(actor_user_id, action, target_type, target_id, metadata)
    values (p_actor_user_id, 'catalogue.stripe_mapping.replaced', 'commercial_stripe_mapping', v_previous::text,
            jsonb_build_object('replacement_mapping_id', v_id, 'environment', p_environment));
  end if;
  insert into sbg_owner_audit_events(actor_user_id, action, target_type, target_id, metadata)
  values (p_actor_user_id, 'catalogue.stripe_mapping.created', 'commercial_stripe_mapping', v_id::text,
          jsonb_build_object('price_version_id', p_price_version_id, 'environment', p_environment,
                             'product_id', p_stripe_product_id, 'price_id', p_stripe_price_id, 'status', 'verified'));
  return v_id;
end;
$catalogue$;

create or replace function sbg_resolve_domain_a_checkout_price(
  p_plan_code text,
  p_environment text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $catalogue$
declare
  v_price_id text;
  v_count integer;
  v_live_checkout_enabled boolean;
begin
  if p_environment not in ('test', 'live') then raise exception 'invalid commerce environment' using errcode = '22023'; end if;
  if not exists (select 1 from sbg_saas_plans where code = p_plan_code and active) then
    raise exception 'plan unavailable' using errcode = 'P0002';
  end if;
  if p_environment = 'live' then
    select live_checkout_enabled into v_live_checkout_enabled from sbg_saas_commerce_locks where id = 1;
    if not coalesce(v_live_checkout_enabled, false) then raise exception 'live checkout is locked' using errcode = '42501'; end if;
  end if;
  select count(*), min(m.stripe_price_id)
    into v_count, v_price_id
    from sbg_saas_price_versions v
    join sbg_saas_stripe_mappings m on m.price_version_id = v.id
   where v.plan_code = p_plan_code and v.currency = 'EUR' and v.billing_interval = 'month'
     and v.interval_count = 1 and v.purchasable and v.retired_at is null
     and m.environment = p_environment and m.status = 'verified';
  if v_count <> 1 or v_price_id is null then raise exception 'checkout price unavailable' using errcode = 'P0002'; end if;
  return v_price_id;
end;
$catalogue$;

revoke all on function sbg_catalogue_require_owner(text) from public;
revoke all on function sbg_catalogue_plan_guard() from public;
revoke all on function sbg_catalogue_reject_delete() from public;
revoke all on function sbg_catalogue_price_version_guard() from public;
revoke all on function sbg_owner_audit_immutable() from public;
revoke all on function sbg_catalogue_update_plan(text,text,text,text,integer,boolean) from public;
revoke all on function sbg_catalogue_create_price_version(text,text,integer,text,text,smallint) from public;
revoke all on function sbg_catalogue_activate_price_version(text,uuid) from public;
revoke all on function sbg_catalogue_retire_price_version(text,uuid) from public;
revoke all on function sbg_catalogue_record_stripe_mapping(text,uuid,text,text,text) from public;
revoke all on function sbg_resolve_domain_a_checkout_price(text,text) from public;
revoke all on function sbg_catalogue_require_owner(text) from aether_app;
revoke all on function sbg_catalogue_plan_guard() from aether_app;
revoke all on function sbg_catalogue_reject_delete() from aether_app;
revoke all on function sbg_catalogue_price_version_guard() from aether_app;
revoke all on function sbg_owner_audit_immutable() from aether_app;
revoke all on function sbg_catalogue_record_stripe_mapping(text,uuid,text,text,text) from aether_app;
grant execute on function sbg_catalogue_update_plan(text,text,text,text,integer,boolean) to aether_app;
grant execute on function sbg_catalogue_create_price_version(text,text,integer,text,text,smallint) to aether_app;
grant execute on function sbg_catalogue_activate_price_version(text,uuid) to aether_app;
grant execute on function sbg_catalogue_retire_price_version(text,uuid) to aether_app;
grant execute on function sbg_resolve_domain_a_checkout_price(text,text) to aether_app;

insert into sbg_saas_plans(code, name, description, sort_order, active)
values ('basic', 'Basic', '', 10, true), ('pro', 'Pro', '', 20, true), ('premium', 'Premium', '', 30, true)
on conflict (code) do nothing;

insert into sbg_saas_commerce_locks(id, live_mapping_enabled, live_checkout_enabled)
values (1, false, false)
on conflict (id) do nothing;

insert into sbg_owner_audit_events(actor_user_id, action, target_type, target_id, metadata)
select null, 'catalogue.plan.created', 'commercial_plan', p.code, jsonb_build_object('source', 'migration:0026')
from (values ('basic'), ('pro'), ('premium')) as p(code)
where not exists (
  select 1 from sbg_owner_audit_events a
  where a.action = 'catalogue.plan.created' and a.target_type = 'commercial_plan'
    and a.target_id = p.code and a.metadata->>'source' = 'migration:0026'
);
