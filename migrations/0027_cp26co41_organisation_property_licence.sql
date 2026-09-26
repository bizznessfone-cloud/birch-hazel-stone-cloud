-- CP26C-O4.1 — organisation and property-licence persistence
-- SOURCE ONLY. Do not apply through the generic Production migrator.
-- Do not add this file to ACCEPTED_LEDGER or AUTHORISED_PENDING.
-- Production application requires a later dedicated controller.
--
-- Does not modify migrations 0001–0026.
-- Does not replace sbg_apply_billing_event.
-- Does not attach existing hotels. organisation_id stays null.
-- Does not write hotels.status. Does not touch Domain B or the catalogue.
-- Does not insert a price version. available licences are derived, not stored.

create table if not exists sbg_organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  created_by_user_id text not null references "user" ("id") on delete restrict,
  constraint sbg_organisations_name_present check (char_length(btrim(name)) > 0)
);

-- Role is an extensible label, not a closed billing_owner/operator taxonomy.
-- billing_authority is the only billing capability this migration understands.
create table if not exists sbg_organisation_members (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references sbg_organisations (id) on delete restrict,
  user_id text not null references "user" ("id") on delete restrict,
  role text not null,
  billing_authority boolean not null default false,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  constraint sbg_organisation_members_role_token
    check (role ~ '^[a-z][a-z0-9_]{0,40}$')
);

create unique index if not exists sbg_organisation_members_active_uidx
  on sbg_organisation_members (organisation_id, user_id)
  where removed_at is null;

create index if not exists sbg_organisation_members_user_active_idx
  on sbg_organisation_members (user_id)
  where removed_at is null;

alter table hotels
  add column if not exists organisation_id uuid;

alter table hotels
  drop constraint if exists hotels_organisation_id_fkey;

alter table hotels
  add constraint hotels_organisation_id_fkey
  foreign key (organisation_id) references sbg_organisations (id) on delete restrict;

create index if not exists hotels_organisation_id_idx
  on hotels (organisation_id)
  where organisation_id is not null;

create table if not exists sbg_organisation_billing (
  organisation_id uuid primary key references sbg_organisations (id) on delete restrict,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  status text not null default 'inactive',
  billing_interval text,
  licensed_quantity integer not null default 0,
  price_version_id uuid references sbg_saas_price_versions (id) on delete restrict,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  last_stripe_event_created bigint,
  last_stripe_event_id text,
  updated_at timestamptz not null default now(),
  constraint sbg_organisation_billing_status_check
    check (status in (
      'inactive', 'incomplete', 'incomplete_expired', 'trialing', 'active',
      'past_due', 'paused', 'unpaid', 'canceled'
    )),
  constraint sbg_organisation_billing_interval_v1
    check (billing_interval is null or billing_interval = 'month'),
  constraint sbg_organisation_billing_quantity_nonnegative
    check (licensed_quantity >= 0),
  constraint sbg_organisation_billing_ordering_pair_check
    check (
      (last_stripe_event_created is null and last_stripe_event_id is null)
      or
      (last_stripe_event_created is not null and last_stripe_event_id is not null)
    )
);

create unique index if not exists sbg_organisation_billing_customer_uidx
  on sbg_organisation_billing (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists sbg_organisation_billing_subscription_uidx
  on sbg_organisation_billing (stripe_subscription_id)
  where stripe_subscription_id is not null;

create table if not exists sbg_property_licence_allocations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references sbg_organisations (id) on delete restrict,
  hotel_id uuid not null references hotels (id) on delete restrict,
  allocated_at timestamptz not null default now(),
  released_at timestamptz,
  allocated_by_user_id text not null references "user" ("id") on delete restrict,
  released_by_user_id text references "user" ("id") on delete restrict
);

create unique index if not exists sbg_property_licence_one_active_idx
  on sbg_property_licence_allocations (hotel_id)
  where released_at is null;

create index if not exists sbg_property_licence_org_active_idx
  on sbg_property_licence_allocations (organisation_id)
  where released_at is null;

alter table sbg_stripe_events
  add column if not exists organisation_id uuid;

alter table sbg_stripe_events
  drop constraint if exists sbg_stripe_events_organisation_id_fkey;

alter table sbg_stripe_events
  add constraint sbg_stripe_events_organisation_id_fkey
  foreign key (organisation_id) references sbg_organisations (id) on delete restrict;

alter table sbg_stripe_events
  drop constraint if exists sbg_stripe_events_identity_exclusive;

alter table sbg_stripe_events
  add constraint sbg_stripe_events_identity_exclusive
  check (hotel_id is null or organisation_id is null);

-- Derived. Not a stored balance. May be negative when Stripe quantity
-- falls below still-active allocations; that breach does not delete rows.
create or replace view sbg_organisation_licence_balance as
select
  o.id as organisation_id,
  coalesce(b.licensed_quantity, 0)::integer as licensed_quantity,
  coalesce(a.active_allocations, 0)::integer as active_allocations,
  (coalesce(b.licensed_quantity, 0) - coalesce(a.active_allocations, 0))::integer as available_licences
from sbg_organisations o
left join sbg_organisation_billing b on b.organisation_id = o.id
left join lateral (
  select count(*)::integer as active_allocations
  from sbg_property_licence_allocations p
  where p.organisation_id = o.id
    and p.released_at is null
) a on true;

revoke all on table sbg_organisations from public;
revoke all on table sbg_organisation_members from public;
revoke all on table sbg_organisation_billing from public;
revoke all on table sbg_property_licence_allocations from public;
revoke all on table sbg_organisation_licence_balance from public;
revoke all on table sbg_organisations from aether_app;
revoke all on table sbg_organisation_members from aether_app;
revoke all on table sbg_organisation_billing from aether_app;
revoke all on table sbg_property_licence_allocations from aether_app;
revoke all on table sbg_organisation_licence_balance from aether_app;
grant select on table sbg_organisations to aether_app;
grant select on table sbg_organisation_members to aether_app;
grant select on table sbg_organisation_billing to aether_app;
grant select on table sbg_property_licence_allocations to aether_app;
grant select on table sbg_organisation_licence_balance to aether_app;

create or replace function sbg_organisation_reject_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $o41$
begin
  raise exception 'organisation commercial history cannot be deleted' using errcode = '42501';
end;
$o41$;

create or replace function sbg_organisation_member_billing(p_user_id text, p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $o41$
  select exists (
    select 1
      from sbg_organisation_members
     where organisation_id = p_organisation_id
       and user_id = p_user_id
       and billing_authority
       and removed_at is null
  );
$o41$;

create or replace function sbg_reject_cross_aggregate_stripe_identity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $o41$
begin
  if new.stripe_customer_id is not null then
    if tg_table_name = 'sbg_organisation_billing'
       and exists (
         select 1 from sbg_billing_accounts
          where stripe_customer_id = new.stripe_customer_id
       ) then
      raise exception 'stripe customer already belongs to a hotel billing account'
        using errcode = '23505';
    end if;
    if tg_table_name = 'sbg_billing_accounts'
       and exists (
         select 1 from sbg_organisation_billing
          where stripe_customer_id = new.stripe_customer_id
       ) then
      raise exception 'stripe customer already belongs to an organisation'
        using errcode = '23505';
    end if;
  end if;
  if new.stripe_subscription_id is not null then
    if tg_table_name = 'sbg_organisation_billing'
       and exists (
         select 1 from sbg_billing_accounts
          where stripe_subscription_id = new.stripe_subscription_id
       ) then
      raise exception 'stripe subscription already belongs to a hotel billing account'
        using errcode = '23505';
    end if;
    if tg_table_name = 'sbg_billing_accounts'
       and exists (
         select 1 from sbg_organisation_billing
          where stripe_subscription_id = new.stripe_subscription_id
       ) then
      raise exception 'stripe subscription already belongs to an organisation'
        using errcode = '23505';
    end if;
  end if;
  return new;
end;
$o41$;

create or replace function sbg_property_licence_allocation_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $o41$
declare
  v_hotel_org uuid;
  v_licensed integer;
  v_active integer;
begin
  if new.released_at is not null then
    return new;
  end if;
  select organisation_id into v_hotel_org from hotels where id = new.hotel_id;
  if v_hotel_org is null or v_hotel_org is distinct from new.organisation_id then
    raise exception 'property is not attached to this organisation' using errcode = '42501';
  end if;
  select licensed_quantity into v_licensed
    from sbg_organisation_billing
   where organisation_id = new.organisation_id
   for update;
  if not found then
    raise exception 'no purchased property licences' using errcode = '23514';
  end if;
  select count(*)::integer into v_active
    from sbg_property_licence_allocations
   where organisation_id = new.organisation_id
     and released_at is null
     and id is distinct from new.id;
  if v_active + 1 > v_licensed then
    raise exception 'no available property licence' using errcode = '23514';
  end if;
  return new;
end;
$o41$;

drop trigger if exists sbg_organisations_no_delete on sbg_organisations;
create trigger sbg_organisations_no_delete
  before delete on sbg_organisations
  for each row execute function sbg_organisation_reject_delete();
drop trigger if exists sbg_organisations_no_truncate on sbg_organisations;
create trigger sbg_organisations_no_truncate
  before truncate on sbg_organisations
  for each statement execute function sbg_organisation_reject_delete();
drop trigger if exists sbg_organisation_members_no_delete on sbg_organisation_members;
create trigger sbg_organisation_members_no_delete
  before delete on sbg_organisation_members
  for each row execute function sbg_organisation_reject_delete();
drop trigger if exists sbg_organisation_members_no_truncate on sbg_organisation_members;
create trigger sbg_organisation_members_no_truncate
  before truncate on sbg_organisation_members
  for each statement execute function sbg_organisation_reject_delete();
drop trigger if exists sbg_organisation_billing_no_delete on sbg_organisation_billing;
create trigger sbg_organisation_billing_no_delete
  before delete on sbg_organisation_billing
  for each row execute function sbg_organisation_reject_delete();
drop trigger if exists sbg_organisation_billing_no_truncate on sbg_organisation_billing;
create trigger sbg_organisation_billing_no_truncate
  before truncate on sbg_organisation_billing
  for each statement execute function sbg_organisation_reject_delete();
drop trigger if exists sbg_property_licence_no_delete on sbg_property_licence_allocations;
create trigger sbg_property_licence_no_delete
  before delete on sbg_property_licence_allocations
  for each row execute function sbg_organisation_reject_delete();
drop trigger if exists sbg_property_licence_no_truncate on sbg_property_licence_allocations;
create trigger sbg_property_licence_no_truncate
  before truncate on sbg_property_licence_allocations
  for each statement execute function sbg_organisation_reject_delete();
drop trigger if exists sbg_property_licence_allocation_guard on sbg_property_licence_allocations;
create trigger sbg_property_licence_allocation_guard
  before insert or update on sbg_property_licence_allocations
  for each row execute function sbg_property_licence_allocation_guard();
drop trigger if exists sbg_organisation_billing_stripe_identity on sbg_organisation_billing;
create trigger sbg_organisation_billing_stripe_identity
  before insert or update of stripe_customer_id, stripe_subscription_id
  on sbg_organisation_billing
  for each row execute function sbg_reject_cross_aggregate_stripe_identity();
drop trigger if exists sbg_billing_accounts_stripe_identity on sbg_billing_accounts;
create trigger sbg_billing_accounts_stripe_identity
  before insert or update of stripe_customer_id, stripe_subscription_id
  on sbg_billing_accounts
  for each row execute function sbg_reject_cross_aggregate_stripe_identity();

create or replace function sbg_create_organisation_for_user(
  p_user_id text,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $o41$
declare
  v_id uuid;
begin
  if p_user_id is null or not exists (select 1 from "user" where id = p_user_id) then
    raise exception 'account not found' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'invalid organisation name' using errcode = '22023';
  end if;
  insert into sbg_organisations (name, created_by_user_id)
  values (btrim(p_name), p_user_id)
  returning id into v_id;
  insert into sbg_organisation_members (organisation_id, user_id, role, billing_authority)
  values (v_id, p_user_id, 'member', true);
  return v_id;
end;
$o41$;

create or replace function sbg_add_organisation_member(
  p_actor_user_id text,
  p_organisation_id uuid,
  p_user_id text,
  p_role text,
  p_billing_authority boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $o41$
declare
  v_id uuid;
begin
  if not sbg_organisation_member_billing(p_actor_user_id, p_organisation_id) then
    raise exception 'organisation billing authority required' using errcode = '42501';
  end if;
  if p_user_id is null or not exists (select 1 from "user" where id = p_user_id) then
    raise exception 'account not found' using errcode = '22023';
  end if;
  if p_role is null or p_role !~ '^[a-z][a-z0-9_]{0,40}$' or p_billing_authority is null then
    raise exception 'invalid organisation membership' using errcode = '22023';
  end if;
  insert into sbg_organisation_members (
    organisation_id, user_id, role, billing_authority
  )
  values (p_organisation_id, p_user_id, p_role, p_billing_authority)
  returning id into v_id;
  return v_id;
end;
$o41$;

create or replace function sbg_remove_organisation_member(
  p_actor_user_id text,
  p_organisation_id uuid,
  p_user_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $o41$
declare
  v_billing boolean;
  v_others integer;
begin
  if not sbg_organisation_member_billing(p_actor_user_id, p_organisation_id) then
    raise exception 'organisation billing authority required' using errcode = '42501';
  end if;
  select billing_authority into v_billing
    from sbg_organisation_members
   where organisation_id = p_organisation_id
     and user_id = p_user_id
     and removed_at is null
   for update;
  if not found then
    raise exception 'organisation member not found' using errcode = 'P0002';
  end if;
  if v_billing then
    select count(*)::integer into v_others
      from sbg_organisation_members
     where organisation_id = p_organisation_id
       and billing_authority
       and removed_at is null
       and user_id is distinct from p_user_id;
    if v_others = 0 then
      raise exception 'last organisation billing member' using errcode = '23514';
    end if;
  end if;
  update sbg_organisation_members
     set removed_at = now()
   where organisation_id = p_organisation_id
     and user_id = p_user_id
     and removed_at is null;
end;
$o41$;

create or replace function sbg_attach_hotel_to_organisation(
  p_actor_user_id text,
  p_organisation_id uuid,
  p_hotel_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $o41$
declare
  v_current uuid;
  v_status text;
begin
  if not sbg_organisation_member_billing(p_actor_user_id, p_organisation_id) then
    raise exception 'organisation billing authority required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from app_hotel_accounts
     where user_id = p_actor_user_id and hotel_id = p_hotel_id
  ) then
    raise exception 'hotel is not owned by account' using errcode = '42501';
  end if;
  select organisation_id, status into v_current, v_status
    from hotels
   where id = p_hotel_id
   for update;
  if not found then
    raise exception 'hotel not found' using errcode = 'P0002';
  end if;
  if v_current is not null then
    raise exception 'hotel is already attached' using errcode = '23505';
  end if;
  update hotels
     set organisation_id = p_organisation_id
   where id = p_hotel_id
     and organisation_id is null
     and status is not distinct from v_status;
  if not found then
    raise exception 'hotel attachment failed' using errcode = '40001';
  end if;
end;
$o41$;

create or replace function sbg_allocate_property_licence(
  p_actor_user_id text,
  p_organisation_id uuid,
  p_hotel_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $o41$
declare
  v_id uuid;
  v_status text;
begin
  if not sbg_organisation_member_billing(p_actor_user_id, p_organisation_id) then
    raise exception 'organisation billing authority required' using errcode = '42501';
  end if;
  select status into v_status from hotels where id = p_hotel_id for update;
  if not found then
    raise exception 'hotel not found' using errcode = 'P0002';
  end if;
  insert into sbg_property_licence_allocations (
    organisation_id, hotel_id, allocated_by_user_id
  )
  values (p_organisation_id, p_hotel_id, p_actor_user_id)
  returning id into v_id;
  if (select status from hotels where id = p_hotel_id) is distinct from v_status then
    raise exception 'allocation changed hotel publication' using errcode = '42501';
  end if;
  return v_id;
end;
$o41$;

create or replace function sbg_release_property_licence(
  p_actor_user_id text,
  p_allocation_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $o41$
declare
  v_org uuid;
  v_released timestamptz;
  v_hotel uuid;
  v_status text;
begin
  select organisation_id, released_at, hotel_id
    into v_org, v_released, v_hotel
    from sbg_property_licence_allocations
   where id = p_allocation_id
   for update;
  if not found then
    raise exception 'licence allocation not found' using errcode = 'P0002';
  end if;
  if not sbg_organisation_member_billing(p_actor_user_id, v_org) then
    raise exception 'organisation billing authority required' using errcode = '42501';
  end if;
  if v_released is not null then
    raise exception 'licence allocation already released' using errcode = '23514';
  end if;
  select status into v_status from hotels where id = v_hotel;
  update sbg_property_licence_allocations
     set released_at = now(),
         released_by_user_id = p_actor_user_id
   where id = p_allocation_id
     and released_at is null;
  if (select status from hotels where id = v_hotel) is distinct from v_status then
    raise exception 'release changed hotel publication' using errcode = '42501';
  end if;
end;
$o41$;

-- Organisation ordered apply. Does not replace the 10-argument hotel function.
-- A Stripe quantity below the active allocation count is stored as-is.
-- Allocations, hotels, bookings and audit rows are not released or deleted.
create or replace function sbg_apply_organisation_billing_event(
  p_event_id text,
  p_event_type text,
  p_event_created bigint,
  p_organisation_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_price_id text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_licensed_quantity integer,
  p_billing_interval text,
  p_price_version_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $o41$
declare
  v_inserted text;
  v_org uuid;
  v_status text;
  v_sub_id text;
  v_last_created bigint;
  v_last_event_id text;
  v_customer text;
  v_subscription text;
  v_price text;
begin
  if p_event_id is null or length(btrim(p_event_id)) = 0
     or p_organisation_id is null
     or p_event_created is null
     or p_event_created < 0
  then
    return 'rejected';
  end if;

  insert into sbg_stripe_events (event_id, event_type, hotel_id, organisation_id, stripe_created)
  values (p_event_id, p_event_type, null, p_organisation_id, p_event_created)
  on conflict (event_id) do nothing
  returning event_id into v_inserted;

  if v_inserted is null then
    return 'duplicate';
  end if;

  select id into v_org from sbg_organisations where id = p_organisation_id for update;
  if v_org is null then
    update sbg_stripe_events set outcome = 'rejected' where event_id = p_event_id;
    return 'rejected';
  end if;

  select status, stripe_subscription_id, last_stripe_event_created, last_stripe_event_id
    into v_status, v_sub_id, v_last_created, v_last_event_id
    from sbg_organisation_billing
   where organisation_id = p_organisation_id
   for update;

  if p_status is null or p_status not in (
    'inactive', 'incomplete', 'incomplete_expired', 'trialing', 'active',
    'past_due', 'paused', 'unpaid', 'canceled'
  )
     or p_licensed_quantity is null
     or p_licensed_quantity < 0
     or p_billing_interval is distinct from 'month'
     or p_cancel_at_period_end is null
     or (
       p_price_version_id is not null
       and not exists (select 1 from sbg_saas_price_versions where id = p_price_version_id)
     )
  then
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

  v_customer := nullif(btrim(coalesce(p_customer_id, '')), '');
  v_subscription := nullif(btrim(coalesce(p_subscription_id, '')), '');
  v_price := nullif(btrim(coalesce(p_price_id, '')), '');

  if v_sub_id is not null
     and v_subscription is not null
     and v_sub_id is distinct from v_subscription
     and v_status in ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'unpaid')
  then
    update sbg_stripe_events set outcome = 'rejected' where event_id = p_event_id;
    return 'rejected';
  end if;

  if v_customer is not null and exists (
    select 1 from sbg_billing_accounts where stripe_customer_id = v_customer
  ) then
    update sbg_stripe_events set outcome = 'rejected' where event_id = p_event_id;
    return 'rejected';
  end if;
  if v_subscription is not null and exists (
    select 1 from sbg_billing_accounts where stripe_subscription_id = v_subscription
  ) then
    update sbg_stripe_events set outcome = 'rejected' where event_id = p_event_id;
    return 'rejected';
  end if;

  begin
    insert into sbg_organisation_billing (
      organisation_id,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_price_id,
      status,
      billing_interval,
      licensed_quantity,
      price_version_id,
      current_period_end,
      cancel_at_period_end,
      last_stripe_event_created,
      last_stripe_event_id,
      updated_at
    )
    values (
      p_organisation_id,
      v_customer,
      v_subscription,
      v_price,
      p_status,
      p_billing_interval,
      p_licensed_quantity,
      p_price_version_id,
      p_current_period_end,
      p_cancel_at_period_end,
      p_event_created,
      p_event_id,
      now()
    )
    on conflict (organisation_id) do update
      set stripe_customer_id = coalesce(excluded.stripe_customer_id, sbg_organisation_billing.stripe_customer_id),
          stripe_subscription_id = coalesce(excluded.stripe_subscription_id, sbg_organisation_billing.stripe_subscription_id),
          stripe_price_id = coalesce(excluded.stripe_price_id, sbg_organisation_billing.stripe_price_id),
          status = excluded.status,
          billing_interval = excluded.billing_interval,
          licensed_quantity = excluded.licensed_quantity,
          price_version_id = coalesce(excluded.price_version_id, sbg_organisation_billing.price_version_id),
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
$o41$;

revoke all on function sbg_organisation_reject_delete() from public;
revoke all on function sbg_organisation_member_billing(text, uuid) from public;
revoke all on function sbg_reject_cross_aggregate_stripe_identity() from public;
revoke all on function sbg_property_licence_allocation_guard() from public;
revoke all on function sbg_create_organisation_for_user(text, text) from public;
revoke all on function sbg_add_organisation_member(text, uuid, text, text, boolean) from public;
revoke all on function sbg_remove_organisation_member(text, uuid, text) from public;
revoke all on function sbg_attach_hotel_to_organisation(text, uuid, uuid) from public;
revoke all on function sbg_allocate_property_licence(text, uuid, uuid) from public;
revoke all on function sbg_release_property_licence(text, uuid) from public;
revoke all on function sbg_apply_organisation_billing_event(text, text, bigint, uuid, text, text, text, text, timestamptz, boolean, integer, text, uuid) from public;
revoke all on function sbg_organisation_reject_delete() from aether_app;
revoke all on function sbg_organisation_member_billing(text, uuid) from aether_app;
revoke all on function sbg_reject_cross_aggregate_stripe_identity() from aether_app;
revoke all on function sbg_property_licence_allocation_guard() from aether_app;
grant execute on function sbg_create_organisation_for_user(text, text) to aether_app;
grant execute on function sbg_add_organisation_member(text, uuid, text, text, boolean) to aether_app;
grant execute on function sbg_remove_organisation_member(text, uuid, text) to aether_app;
grant execute on function sbg_attach_hotel_to_organisation(text, uuid, uuid) to aether_app;
grant execute on function sbg_allocate_property_licence(text, uuid, uuid) to aether_app;
grant execute on function sbg_release_property_licence(text, uuid) to aether_app;
grant execute on function sbg_apply_organisation_billing_event(text, text, bigint, uuid, text, text, text, text, timestamptz, boolean, integer, text, uuid) to aether_app;
