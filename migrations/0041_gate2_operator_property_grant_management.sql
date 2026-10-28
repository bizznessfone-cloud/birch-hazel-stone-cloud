-- Gate 2: hotel-authorised operator grant issuance and revocation.
-- NOT authorised for production; no implicit grants or Stripe side effects.
-- The server must derive p_user_id from its authenticated session.
create or replace function public.sbg_set_operator_property_grant_for_user(
  p_user_id text,
  p_hotel_id uuid,
  p_operator_organisation_id uuid,
  p_enable boolean
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $grant_write$
declare
  v_owner_org uuid;
  v_owner_count integer;
begin
  if p_user_id is null or btrim(p_user_id) = ''
     or p_hotel_id is null or p_operator_organisation_id is null
     or p_enable is null then
    raise exception 'operator grant not authorised' using errcode = '42501';
  end if;
  if not exists (select 1 from public."user" u where u.id = p_user_id) then
    raise exception 'operator grant not authorised' using errcode = '42501';
  end if;
  -- Lock the hotel to serialize ownership changes and grant modifications.
  select h.organisation_id into v_owner_org
    from public.hotels h where h.id = p_hotel_id for update;
  if v_owner_org is null then
    raise exception 'operator grant not authorised' using errcode = '42501';
  end if;
  select count(*)::integer into v_owner_count
    from public.sbg_organisations o
    join public.sbg_organisation_members m on m.organisation_id = o.id
   where o.id = v_owner_org
     and o.organisation_type = 'hotel'
     and m.user_id = p_user_id
     and m.billing_authority = true
     and m.removed_at is null;
  if v_owner_count <> 1 then
    raise exception 'operator grant not authorised' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.sbg_organisations o
    where o.id = p_operator_organisation_id
      and o.organisation_type = 'transfer_operator'
  ) then
    raise exception 'operator grant not authorised' using errcode = '42501';
  end if;
  -- No operator can self-approve, even if it also holds a hotel seat.
  if exists (
    select 1 from public.sbg_organisation_members m
    where m.organisation_id = p_operator_organisation_id
      and m.user_id = p_user_id and m.removed_at is null
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
       and hotel_id = p_hotel_id
       and revoked_at is null;
  end if;
  return true;
end;
$grant_write$;
revoke all on function public.sbg_set_operator_property_grant_for_user(text,uuid,uuid,boolean) from public;
revoke all on function public.sbg_set_operator_property_grant_for_user(text,uuid,uuid,boolean) from aether_runtime;
revoke all on function public.sbg_set_operator_property_grant_for_user(text,uuid,uuid,boolean) from aether_app;
grant execute on function public.sbg_set_operator_property_grant_for_user(text,uuid,uuid,boolean) to aether_app;
comment on function public.sbg_set_operator_property_grant_for_user(text,uuid,uuid,boolean) is
  'Explicit hotel billing-authority approval or revocation for an independent operator. Session user ID must be server-derived. Does not grant hotel ownership or payment privileges.';
