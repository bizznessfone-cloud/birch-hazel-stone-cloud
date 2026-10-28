-- Gate 2: extend the existing allocation guard to authorised operator service.
-- Source only; never activates operations or changes subscription quantities.
create or replace function public.sbg_property_licence_allocation_guard()
returns trigger language plpgsql set search_path = pg_catalog, public
as $guard$
declare owner_org uuid; kind text; bought integer; used_count integer;
begin
  if new.released_at is not null then return new; end if;
  select h.organisation_id into owner_org from public.hotels h
    where h.id = new.hotel_id for update;
  select o.organisation_type into kind from public.sbg_organisations o
    where o.id = new.organisation_id;
  if owner_org is null or kind is null then
    raise exception 'allocation denied' using errcode = '42501';
  end if;
  if kind = 'hotel' then
    if owner_org is distinct from new.organisation_id then
      raise exception 'property ownership required' using errcode = '42501';
    end if;
  elsif kind = 'transfer_operator' then
    if owner_org = new.organisation_id or not exists (
      select 1 from public.sbg_operator_property_grants g
      join public.sbg_operator_provider_authorisations pa
        on pa.operator_organisation_id = g.operator_organisation_id
        and pa.hotel_id = g.hotel_id and pa.revoked_at is null
      join public.hotel_provider_agreements ha
        on ha.hotel_id = pa.hotel_id and ha.provider_id = pa.provider_id
        and ha.active = true
      where g.operator_organisation_id = new.organisation_id
        and g.hotel_id = new.hotel_id and g.revoked_at is null
    ) then raise exception 'provider permission required' using errcode = '42501'; end if;
  else
    raise exception 'classification denied' using errcode = '42501';
  end if;
  select b.licensed_quantity into bought from public.sbg_organisation_billing b
    where b.organisation_id = new.organisation_id for update;
  if not found then raise exception 'no licences purchased' using errcode = '23514'; end if;
  select count(*)::integer into used_count from public.sbg_property_licence_allocations a
    where a.organisation_id = new.organisation_id and a.released_at is null
      and a.id is distinct from new.id;
  if used_count + 1 > bought then
    raise exception 'licence quantity exceeded' using errcode = '23514';
  end if;
  return new;
end;
$guard$;
