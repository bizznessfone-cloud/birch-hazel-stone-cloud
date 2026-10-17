-- Gate 2 review-only provider activation eligibility read.
-- This is a status predicate, NOT activation, dispatch or booking access.
-- Production migration NOT authorised.
create or replace function public.sbg_operator_provider_activation_for_user(p_user_id text, p_hotel_id uuid)
returns table(provider_authorised boolean, provider_id uuid)
language plpgsql security definer
set search_path = pg_catalog, public
as $activation$
declare v_operator_org uuid;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_hotel_id is null then return; end if;
  if not public.sbg_operator_can_access_property_for_user(p_user_id, p_hotel_id) then return; end if;
  select o.id into v_operator_org
    from public.sbg_organisations o
    join public.sbg_organisation_members m on m.organisation_id = o.id
   where m.user_id = p_user_id and m.removed_at is null
     and o.organisation_type = 'transfer_operator';
  -- V1: one active provider agreement per hotel. Explicit provider authorisation
  -- is also required; property grants alone cannot imply activation.
  return query
    select true, a.provider_id
      from public.sbg_operator_provider_authorisations a
      join public.hotel_provider_agreements hpa
        on hpa.hotel_id = a.hotel_id and hpa.provider_id = a.provider_id
       and hpa.active = true
     where a.operator_organisation_id = v_operator_org
       and a.hotel_id = p_hotel_id and a.revoked_at is null
     limit 1;
end;
$activation$;
revoke all on function public.sbg_operator_provider_activation_for_user(text,uuid) from public;
revoke all on function public.sbg_operator_provider_activation_for_user(text,uuid) from aether_runtime;
revoke all on function public.sbg_operator_provider_activation_for_user(text,uuid) from aether_app;
grant execute on function public.sbg_operator_provider_activation_for_user(text,uuid) to aether_app;
comment on function public.sbg_operator_provider_activation_for_user(text,uuid) is
  'Session-scoped provider authorisation status only; never enables booking, dispatch, Stripe or live operations.';
