-- Gate 2: read-only eligibility for the founding property's approved-agreement gate.
-- Prepared for isolated testing only. Never apply to production without separate authorisation.
-- Does not approve, publish, accept, or seed any agreement.
create or replace function public.sbg_founding_property_eligibility_for_user(p_user_id text)
returns table (eligible boolean, reason text)
language plpgsql security definer
set search_path = pg_catalog, public
as $eligibility$
declare
  v_org uuid;
  v_count integer;
begin
  if p_user_id is null or btrim(p_user_id) = '' or not exists (
    select 1 from public."user" u where u.id = p_user_id
  ) then
    return query select false, 'unauthorized'::text;
    return;
  end if;
  select count(*)::integer, min(o.id)
    into v_count, v_org
    from public.sbg_organisations o
   where o.created_by_user_id = p_user_id;
  if v_count <> 1 then
    return query select false, 'organisation_unavailable'::text;
    return;
  end if;
  if not exists (
    select 1 from public.sbg_organisations o
    join public.sbg_organisation_members m on m.organisation_id = o.id
    where o.id = v_org and o.organisation_type = 'hotel'
      and m.user_id = p_user_id and m.billing_authority
      and m.removed_at is null
  ) then
    return query select false, 'organisation_ineligible'::text;
    return;
  end if;
  if not exists (
    select 1
      from public.sbg_organisation_acceptances a
      join public.sbg_approved_property_agreement_versions v
        on v.agreement_version = a.agreement_version and v.effective
     where a.organisation_id = v_org
       and a.accepted_by_user_id = p_user_id
       and a.agreement_version <> 'terms-v1'
       and v.agreement_version <> 'terms-v1'
  ) then
    return query select false, 'agreement_required'::text;
    return;
  end if;
  return query select true, 'ready'::text;
end;
$eligibility$;
revoke all on function public.sbg_founding_property_eligibility_for_user(text) from public;
revoke all on function public.sbg_founding_property_eligibility_for_user(text) from aether_runtime;
revoke all on function public.sbg_founding_property_eligibility_for_user(text) from aether_app;
grant execute on function public.sbg_founding_property_eligibility_for_user(text) to aether_app;
