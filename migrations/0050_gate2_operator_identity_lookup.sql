-- Gate 2 Contract 1: exact operator identity resolution, not public discovery.
-- NOT authorised for production. Never grants access or exposes memberships.
-- The authenticated hotel billing authority must supply the exact organisation UUID.
create or replace function public.sbg_resolve_operator_for_hotel_owner(
  p_user_id text, p_hotel_id uuid, p_operator_organisation_id uuid
) returns table(operator_organisation_id uuid, operator_name text)
language plpgsql security definer
set search_path = pg_catalog, public
as $operator_lookup$
declare v_owner_org uuid;
begin
  if p_user_id is null or btrim(p_user_id) = ''
     or p_hotel_id is null or p_operator_organisation_id is null then return; end if;
  select h.organisation_id into v_owner_org
    from public.hotels h where h.id = p_hotel_id;
  if v_owner_org is null or not exists (
    select 1 from public.sbg_organisations o
    join public.sbg_organisation_members m on m.organisation_id = o.id
    where o.id = v_owner_org and o.organisation_type = 'hotel'
      and m.user_id = p_user_id and m.billing_authority = true
      and m.removed_at is null
  ) then return; end if;
  -- Reject self-authorisation and reveal no member/contact information.
  if exists (
    select 1 from public.sbg_organisation_members m
    where m.organisation_id = p_operator_organisation_id
      and m.user_id = p_user_id and m.removed_at is null
  ) then return; end if;
  return query
    select o.id, o.name::text from public.sbg_organisations o
    where o.id = p_operator_organisation_id
      and o.organisation_type = 'transfer_operator'
      and exists (
        select 1 from public.sbg_organisation_members m
        where m.organisation_id = o.id and m.removed_at is null
      );
end;
$operator_lookup$;
revoke all on function public.sbg_resolve_operator_for_hotel_owner(text,uuid,uuid) from public;
revoke all on function public.sbg_resolve_operator_for_hotel_owner(text,uuid,uuid) from aether_runtime;
revoke all on function public.sbg_resolve_operator_for_hotel_owner(text,uuid,uuid) from aether_app;
grant execute on function public.sbg_resolve_operator_for_hotel_owner(text,uuid,uuid) to aether_app;
comment on function public.sbg_resolve_operator_for_hotel_owner(text,uuid,uuid) is
  'Exact-ID hotel-owner confirmation of independent operator identity; no search, contact data, grants or activation.';
