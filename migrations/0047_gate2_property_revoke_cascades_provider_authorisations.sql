-- Gate 2 disclosure hardening: provider grants are invalidated when the
-- hotel/operator property grant is revoked, including after regrant.
-- No runtime EXECUTE or booking exposure; isolated migration only.
create or replace function public.sbg_set_operator_property_grant_for_user(
  p_user_id text, p_hotel_id uuid, p_operator_organisation_id uuid, p_enable boolean
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $operator_grant$
declare
  v_owner_org uuid;
begin
  if p_user_id is null or btrim(p_user_id) = ''
    or p_hotel_id is null or p_operator_organisation_id is null or p_enable is null
    or not exists (select 1 from public."user" where id = p_user_id) then
    raise exception 'operator grant not authorised' using errcode = '42501';
  end if;
  select h.organisation_id into v_owner_org from public.hotels h
    where h.id = p_hotel_id for update;
  if v_owner_org is null or not exists (
    select 1 from public.sbg_organisations o
    join public.sbg_organisation_members m on m.organisation_id = o.id
    where o.id = v_owner_org and o.organisation_type = 'hotel'
      and m.user_id = p_user_id and m.billing_authority = true
      and m.removed_at is null
  ) or not exists (
    select 1 from public.sbg_organisations o
    where o.id = p_operator_organisation_id and o.organisation_type = 'transfer_operator'
  ) or exists (
    select 1 from public.sbg_organisation_members m
    where m.user_id = p_user_id and m.organisation_id = p_operator_organisation_id
      and m.removed_at is null
  ) then
    raise exception 'operator grant not authorised' using errcode = '42501';
  end if;
  if p_enable then
    insert into public.sbg_operator_property_grants
      (operator_organisation_id, hotel_id, granted_by_user_id)
    values (p_operator_organisation_id, p_hotel_id, p_user_id)
    on conflict (operator_organisation_id, hotel_id)
    do update set revoked_at = null, granted_at = now(),
      granted_by_user_id = excluded.granted_by_user_id;
  else
    update public.sbg_operator_property_grants
      set revoked_at = greatest(now(), granted_at)
    where operator_organisation_id = p_operator_organisation_id
      and hotel_id = p_hotel_id and revoked_at is null;
    -- A future property regrant must not resurrect old provider permissions.
    update public.sbg_operator_provider_authorisations
      set revoked_at = greatest(now(), authorised_at)
    where operator_organisation_id = p_operator_organisation_id
      and hotel_id = p_hotel_id and revoked_at is null;
  end if;
  return true;
end;
$operator_grant$;
revoke all on function public.sbg_set_operator_property_grant_for_user(text,uuid,uuid,boolean) from public;
revoke all on function public.sbg_set_operator_property_grant_for_user(text,uuid,uuid,boolean) from aether_runtime;
revoke all on function public.sbg_set_operator_property_grant_for_user(text,uuid,uuid,boolean) from aether_app;
grant execute on function public.sbg_set_operator_property_grant_for_user(text,uuid,uuid,boolean) to aether_app;
