-- Gate 2: authenticated, organisation-scoped property licence release.
-- Source-only function. No app EXECUTE, endpoint, Stripe or production activation.
create or replace function public.sbg_release_property_licence_for_user(
  p_user_id text, p_allocation_id uuid
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $release$
declare v_org uuid; v_hotel uuid; v_released timestamptz;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_allocation_id is null
     or not exists (select 1 from public."user" u where u.id = p_user_id) then
    raise exception 'licence release denied' using errcode = '42501';
  end if;
  select a.organisation_id, a.hotel_id, a.released_at
    into v_org, v_hotel, v_released
    from public.sbg_property_licence_allocations a
    where a.id = p_allocation_id for update;
  if v_org is null or not exists (
    select 1 from public.sbg_organisation_members m
    where m.organisation_id = v_org and m.user_id = p_user_id
      and m.billing_authority = true and m.removed_at is null
  ) then
    raise exception 'licence release denied' using errcode = '42501';
  end if;
  -- Idempotent release retains original actor and timestamp on replay.
  if v_released is not null then return true; end if;
  update public.sbg_property_licence_allocations
     set released_at = now(), released_by_user_id = p_user_id
   where id = p_allocation_id and released_at is null;
  if not found then
    raise exception 'licence release denied' using errcode = '42501';
  end if;
  return true;
end;
$release$;
revoke all on function public.sbg_release_property_licence_for_user(text,uuid)
  from public, aether_runtime, aether_app;
-- App EXECUTE deliberately withheld until release-contract integration is verified.
