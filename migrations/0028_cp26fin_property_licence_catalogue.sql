-- CP26 FINALISATION — property-licence catalogue cutover.
-- Forward only. Does not modify migrations 0001–0027.
-- Does not redesign organisation, allocation, or hotel billing.
-- Does not seed a monetary amount. Does not create a Stripe mapping.
-- Does not enable commerce. Does not attach hotels. Does not write hotels.status.

-- Fail closed unless the commercial and organisation state is the expected empty baseline.
do $cutover$
begin
  if (select count(*) from sbg_saas_price_versions) <> 0 then
    raise exception 'UNEXPECTED COMMERCIAL STATE: price versions exist' using errcode = '23514';
  end if;
  if (select count(*) from sbg_saas_stripe_mappings) <> 0 then
    raise exception 'UNEXPECTED COMMERCIAL STATE: stripe mappings exist' using errcode = '23514';
  end if;
  if exists (select 1 from sbg_saas_plans where code = 'property_licence') then
    raise exception 'UNEXPECTED COMMERCIAL STATE: property_licence already present' using errcode = '23514';
  end if;
  if (
    select count(*) from sbg_saas_plans
     where code in ('basic', 'pro', 'premium') and active
  ) <> 3 then
    raise exception 'UNEXPECTED COMMERCIAL STATE: historical plans are not the active trio' using errcode = '23514';
  end if;
  if (select count(*) from sbg_saas_plans) <> 3 then
    raise exception 'UNEXPECTED COMMERCIAL STATE: unexpected plan rows' using errcode = '23514';
  end if;
  if (select count(*) from sbg_saas_commerce_locks where id = 1 and not live_mapping_enabled and not live_checkout_enabled) <> 1 then
    raise exception 'UNEXPECTED COMMERCIAL STATE: commerce locks are not dormant' using errcode = '23514';
  end if;
  if (select count(*) from sbg_organisations) <> 0
     or (select count(*) from sbg_organisation_members) <> 0
     or (select count(*) from sbg_organisation_billing) <> 0
     or (select count(*) from sbg_property_licence_allocations) <> 0
     or (select count(*) from hotels where organisation_id is not null) <> 0
  then
    raise exception 'UNEXPECTED COMMERCIAL STATE: organisation or allocation rows exist' using errcode = '23514';
  end if;
end;
$cutover$;

alter table sbg_saas_plans drop constraint sbg_saas_plans_code_check;

alter table sbg_saas_plans
  add constraint sbg_saas_plans_code_check
  check (code in ('basic', 'pro', 'premium', 'property_licence'));

insert into sbg_saas_plans (code, name, description, sort_order, active)
values (
  'property_licence',
  'Property Licence',
  'SCAN. BOOK. GO. property licence. One active allocation consumes one licence.',
  40,
  true
);

update sbg_saas_plans
   set active = false,
       updated_at = now()
 where code in ('basic', 'pro', 'premium');

-- Historical tier codes cannot receive a new price version, even if later marked active.
-- Inactive plans cannot receive a new price version. No amount is inserted here.
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
  if p_plan_code in ('basic', 'pro', 'premium') then
    raise exception 'historical plan cannot receive a price version' using errcode = '23514';
  end if;
  if not exists (select 1 from sbg_saas_plans where code = p_plan_code and active) then
    raise exception 'plan inactive' using errcode = '23514';
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

insert into sbg_owner_audit_events (actor_user_id, action, target_type, target_id, metadata)
select null, 'catalogue.plan.created', 'commercial_plan', 'property_licence',
       jsonb_build_object('source', 'migration:0028')
where not exists (
  select 1 from sbg_owner_audit_events a
   where a.action = 'catalogue.plan.created'
     and a.target_type = 'commercial_plan'
     and a.target_id = 'property_licence'
     and a.metadata->>'source' = 'migration:0028'
);

insert into sbg_owner_audit_events (actor_user_id, action, target_type, target_id, metadata)
select null, 'catalogue.plan.updated', 'commercial_plan', p.code,
       jsonb_build_object('source', 'migration:0028', 'active', false)
from (values ('basic'), ('pro'), ('premium')) as p(code)
where not exists (
  select 1 from sbg_owner_audit_events a
   where a.action = 'catalogue.plan.updated'
     and a.target_type = 'commercial_plan'
     and a.target_id = p.code
     and a.metadata->>'source' = 'migration:0028'
);
