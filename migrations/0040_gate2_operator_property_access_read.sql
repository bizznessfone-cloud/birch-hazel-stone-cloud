-- Gate 2 operator property access lookup. Disposable/review branch ONLY.
-- No issuance or revocation here. No production migration approval.
-- Authenticated server passes its session user ID; clients never select an
-- operator organisation. Ambiguous memberships fail closed.
create or replace function public.sbg_operator_can_access_property_for_user(
  p_user_id text, p_hotel_id uuid
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $operator_access$
declare
  v_count integer;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_hotel_id is null then
    return false;
  end if;
  if not exists (select 1 from public."user" u where u.id = p_user_id) then
    return false;
  end if;

  -- The user must have exactly one active transfer-operator membership.
  -- This prevents choosing an organisation by manipulating request inputs.
  select count(distinct o.id)::integer into v_count
    from public.sbg_organisations o
    join public.sbg_organisation_members m on m.organisation_id = o.id
   where m.user_id = p_user_id and m.removed_at is null
     and o.organisation_type = 'transfer_operator';
  if v_count <> 1 then
    return false;
  end if;

  return exists (
    select 1
      from public.sbg_organisations o
      join public.sbg_organisation_members m on m.organisation_id = o.id
      join public.sbg_operator_property_grants g
        on g.operator_organisation_id = o.id
      join public.hotels h on h.id = g.hotel_id
     where m.user_id = p_user_id
       and m.removed_at is null
       and o.organisation_type = 'transfer_operator'
       and g.hotel_id = p_hotel_id
       and g.revoked_at is null
       and h.organisation_id is not null
  );
end;
$operator_access$;
revoke all on function public.sbg_operator_can_access_property_for_user(text,uuid) from public;
revoke all on function public.sbg_operator_can_access_property_for_user(text,uuid) from aether_runtime;
revoke all on function public.sbg_operator_can_access_property_for_user(text,uuid) from aether_app;
grant execute on function public.sbg_operator_can_access_property_for_user(text,uuid) to aether_app;
comment on function public.sbg_operator_can_access_property_for_user(text,uuid) is
  'Session-bound, read-only operator grant lookup. Does not confer hotel ownership, billing authority, booking access or grant management.';
