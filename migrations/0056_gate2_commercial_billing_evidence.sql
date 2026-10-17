-- Contract 4: authenticated commercial billing evidence, read only.
-- Existing organisation subscription and licence allocations remain authoritative.
-- Does not infer operator ownership from a property grant or modify billing.
create or replace function public.sbg_commercial_billing_evidence_for_user(p_user_id text)
returns table (
  billing_status text,
  purchased_quantity integer,
  allocated_quantity integer,
  available_quantity integer,
  allocation_integrity_ok boolean
)
language plpgsql security definer set search_path = pg_catalog, public
as $evidence$
declare v_org uuid; v_count integer; v_type text;
begin
  if p_user_id is null or btrim(p_user_id) = '' or not exists (
    select 1 from public."user" u where u.id = p_user_id
  ) then raise exception 'account unavailable' using errcode = '42501'; end if;
  select count(*)::integer, (array_agg(o.id))[1], (array_agg(o.organisation_type))[1]
    into v_count, v_org, v_type
    from public.sbg_organisations o where o.created_by_user_id = p_user_id;
  if v_count <> 1 or v_type not in ('hotel','transfer_operator') or not exists (
    select 1 from public.sbg_organisation_members m
    where m.organisation_id = v_org and m.user_id = p_user_id
      and m.billing_authority and m.removed_at is null
  ) then raise exception 'billing authority unavailable' using errcode = '42501'; end if;
  return query
  select coalesce(b.status, 'inactive')::text,
    coalesce(b.licensed_quantity, 0)::integer,
    coalesce(x.active_allocations, 0)::integer,
    (coalesce(b.licensed_quantity, 0) - coalesce(x.active_allocations, 0))::integer,
    not exists (
      select 1 from public.sbg_property_licence_allocations a
      join public.hotels h on h.id = a.hotel_id
      where a.organisation_id = v_org and a.released_at is null
        and (h.organisation_id is distinct from v_org
          or (v_type = 'transfer_operator' and not exists (
            select 1 from public.sbg_operator_property_grants g
            where g.operator_organisation_id = v_org and g.hotel_id = a.hotel_id
              and g.revoked_at is null)))
    )
  from (select 1) seed
  left join public.sbg_organisation_billing b on b.organisation_id = v_org
  left join public.sbg_organisation_licence_balance x on x.organisation_id = v_org;
end;
$evidence$;
revoke all on function public.sbg_commercial_billing_evidence_for_user(text)
  from public, aether_runtime, aether_app;
grant execute on function public.sbg_commercial_billing_evidence_for_user(text) to aether_app;
