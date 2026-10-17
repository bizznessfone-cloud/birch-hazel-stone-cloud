-- Gate 2 explicit provider authorisation management. Offline preparation only.
-- NOT authorised for production; no UI, endpoint, booking visibility or commerce.
-- p_user_id must come from the authenticated server session, never request input.
create or replace function public.sbg_set_operator_provider_authorisation_for_user(
  p_user_id text,
  p_hotel_id uuid,
  p_provider_id uuid,
  p_operator_organisation_id uuid,
  p_enable boolean
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $provider_auth$
declare
  v_owner_org uuid;
begin
  if p_user_id is null or btrim(p_user_id) = ''
     or p_hotel_id is null or p_provider_id is null
     or p_operator_organisation_id is null or p_enable is null then
    raise exception 'operator provider authorisation denied' using errcode = '42501';
  end if;
  if not exists (select 1 from public."user" u where u.id = p_user_id) then
    raise exception 'operator provider authorisation denied' using errcode = '42501';
  end if;
  select h.organisation_id into v_owner_org
    from public.hotels h where h.id = p_hotel_id for update;
  if v_owner_org is null or not exists (
    select 1 from public.sbg_organisations o
    join public.sbg_organisation_members m on m.organisation_id = o.id
    where o.id = v_owner_org and o.organisation_type = 'hotel'
      and m.user_id = p_user_id and m.billing_authority = true
      and m.removed_at is null
  ) then
    raise exception 'operator provider authorisation denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.sbg_organisations o
    where o.id = p_operator_organisation_id and o.organisation_type = 'transfer_operator'
  ) or exists (
    select 1 from public.sbg_organisation_members m
    where m.organisation_id = p_operator_organisation_id
      and m.user_id = p_user_id and m.removed_at is null
  ) then
    raise exception 'operator provider authorisation denied' using errcode = '42501';
  end if;
  -- Only an already-active hotel/provider agreement can be authorised.
  if not exists (
    select 1 from public.hotel_provider_agreements a
    where a.hotel_id = p_hotel_id and a.provider_id = p_provider_id and a.active = true
  ) then
    raise exception 'operator provider authorisation denied' using errcode = '42501';
  end if;
  -- Provider authorisation cannot bootstrap a property grant.
  if not exists (
    select 1 from public.sbg_operator_property_grants g
    where g.hotel_id = p_hotel_id and g.operator_organisation_id = p_operator_organisation_id
      and g.revoked_at is null
  ) then
    raise exception 'operator provider authorisation denied' using errcode = '42501';
  end if;
  if p_enable then
    insert into public.sbg_operator_provider_authorisations
      (operator_organisation_id, hotel_id, provider_id, authorised_by_user_id)
    values (p_operator_organisation_id, p_hotel_id, p_provider_id, p_user_id)
    on conflict (operator_organisation_id, hotel_id, provider_id)
    do update set revoked_at = null, authorised_at = now(),
      authorised_by_user_id = excluded.authorised_by_user_id;
  else
    update public.sbg_operator_provider_authorisations
      set revoked_at = greatest(now(), authorised_at)
    where operator_organisation_id = p_operator_organisation_id
      and hotel_id = p_hotel_id and provider_id = p_provider_id
      and revoked_at is null;
  end if;
  return true;
end;
$provider_auth$;
revoke all on function public.sbg_set_operator_provider_authorisation_for_user(text,uuid,uuid,uuid,boolean) from public;
revoke all on function public.sbg_set_operator_provider_authorisation_for_user(text,uuid,uuid,uuid,boolean) from aether_runtime;
revoke all on function public.sbg_set_operator_provider_authorisation_for_user(text,uuid,uuid,uuid,boolean) from aether_app;
-- No app EXECUTE: authorisation policy must pass isolation tests first.
comment on function public.sbg_set_operator_provider_authorisation_for_user(text,uuid,uuid,uuid,boolean) is
  'Draft hotel-owner provider-specific operator authorisation, inaccessible to application role pending review.';
