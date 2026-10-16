-- Gate 2 isolated provider-scoped eligibility predicate.
-- NOT production approved. No runtime EXECUTE, endpoint or booking disclosure.
-- Caller identity must be server-session-derived if ever exposed.
create or replace function public.sbg_operator_can_access_provider_for_user(
  p_user_id text, p_hotel_id uuid, p_provider_id uuid
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $provider_access$
declare
  v_operator_org uuid;
begin
  if p_user_id is null or btrim(p_user_id) = ''
     or p_hotel_id is null or p_provider_id is null then
    return false;
  end if;
  if not public.sbg_operator_can_access_property_for_user(p_user_id, p_hotel_id) then
    return false;
  end if;
  -- A user with multiple active operator memberships is not allowed to
  -- choose a different organisation through caller-controlled inputs.
  select o.id into v_operator_org
    from public.sbg_organisations o
    join public.sbg_organisation_members m on m.organisation_id = o.id
   where m.user_id = p_user_id and m.removed_at is null
     and o.organisation_type = 'transfer_operator';
  return exists (
    select 1 from public.sbg_operator_provider_authorisations a
    join public.sbg_operator_property_grants g
      on g.operator_organisation_id = a.operator_organisation_id
     and g.hotel_id = a.hotel_id and g.revoked_at is null
    join public.hotel_provider_agreements hpa
      on hpa.hotel_id = a.hotel_id and hpa.provider_id = a.provider_id
     and hpa.active = true
    where a.operator_organisation_id = v_operator_org
      and a.hotel_id = p_hotel_id and a.provider_id = p_provider_id
      and a.revoked_at is null
  );
end;
$provider_access$;
revoke all on function public.sbg_operator_can_access_provider_for_user(text,uuid,uuid) from public;
revoke all on function public.sbg_operator_can_access_provider_for_user(text,uuid,uuid) from aether_runtime;
revoke all on function public.sbg_operator_can_access_provider_for_user(text,uuid,uuid) from aether_app;
comment on function public.sbg_operator_can_access_provider_for_user(text,uuid,uuid) is
  'Isolated deny-by-default operator/provider eligibility predicate. Not an app capability or booking access authorisation.';
