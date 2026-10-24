-- Gate 2 preparation only: approved-version acceptance evidence.
-- No legal content or approved version is seeded. Never apply to production without approval.
-- Explicit client-selected version must match the single effective approved version.
create or replace function public.sbg_accept_approved_founding_agreement_for_user(
  p_user_id text, p_agreement_version text
)
returns table (agreement_version text, already_accepted boolean)
language plpgsql security definer
set search_path = pg_catalog, public
as $accept$
declare
  v_org uuid;
  v_count integer;
begin
  if p_user_id is null or btrim(p_user_id) = '' or not exists (
    select 1 from public."user" u where u.id = p_user_id
  ) then
    raise exception 'account not found' using errcode = '42501';
  end if;
  if p_agreement_version is null or p_agreement_version = 'terms-v1' or not exists (
    select 1 from public.sbg_approved_property_agreement_versions v
    where v.agreement_version = p_agreement_version and v.effective
  ) then
    raise exception 'approved agreement unavailable' using errcode = '42501';
  end if;
  select count(*)::integer, (array_agg(o.id))[1] into v_count, v_org
    from public.sbg_organisations o where o.created_by_user_id = p_user_id;
  if v_count <> 1 or not exists (
    select 1 from public.sbg_organisations o
    join public.sbg_organisation_members m on m.organisation_id = o.id
    where o.id = v_org and o.organisation_type = 'hotel'
      and m.user_id = p_user_id and m.billing_authority and m.removed_at is null
  ) then
    raise exception 'founding organisation unavailable' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.sbg_organisation_acceptances a
    where a.organisation_id = v_org and a.accepted_by_user_id = p_user_id
      and a.agreement_version = p_agreement_version
  ) then
    return query select p_agreement_version, true;
    return;
  end if;
  insert into public.sbg_organisation_acceptances
    (organisation_id, accepted_by_user_id, agreement_version)
  values (v_org, p_user_id, p_agreement_version);
  return query select p_agreement_version, false;
end;
$accept$;
revoke all on function public.sbg_accept_approved_founding_agreement_for_user(text,text) from public;
revoke all on function public.sbg_accept_approved_founding_agreement_for_user(text,text) from aether_runtime;
revoke all on function public.sbg_accept_approved_founding_agreement_for_user(text,text) from aether_app;
grant execute on function public.sbg_accept_approved_founding_agreement_for_user(text,text) to aether_app;
