-- Gate 2 Contract 4: authenticated, read-only commercial onboarding snapshot.
-- Does not infer paid entitlement from a grant, create a licence, or activate Stripe.
create or replace function public.sbg_commercial_founding_snapshot_for_user(p_user_id text)
returns table(organisation_exists boolean, organisation_type text,
  approved_agreement_accepted boolean, accessible_property_count integer)
language plpgsql security definer set search_path = pg_catalog, public
as $snapshot$
declare v_org uuid; v_type text; v_n integer; v_count integer;
begin
  if p_user_id is null or btrim(p_user_id) = '' or not exists
    (select 1 from public."user" u where u.id = p_user_id) then
    raise exception 'account unavailable' using errcode = '42501';
  end if;
  select count(*)::integer, (array_agg(o.id))[1],
    (array_agg(o.organisation_type))[1]
    into v_n, v_org, v_type
    from public.sbg_organisations o where o.created_by_user_id = p_user_id;
  if v_n > 1 then raise exception 'ambiguous founding organisation' using errcode = '42501'; end if;
  if v_n = 0 then
    return query select false, null::text, false, 0::integer; return;
  end if;
  if not exists (select 1 from public.sbg_organisation_members m
    where m.organisation_id = v_org and m.user_id = p_user_id
      and m.billing_authority and m.removed_at is null) then
    raise exception 'billing authority required' using errcode = '42501';
  end if;
  if v_type not in ('hotel','transfer_operator') then
    return query select true, null::text, false, 0::integer; return;
  end if;
  -- The same approved version and immutable acceptance evidence for both classifications.
  return query
    select true, v_type,
      exists(select 1 from public.sbg_organisation_acceptances a
        join public.sbg_approved_property_agreement_versions v
          on v.agreement_version = a.agreement_version and v.effective
        join public.sbg_approved_agreement_documents d
          on d.agreement_version = v.agreement_version
        where a.organisation_id = v_org and a.accepted_by_user_id = p_user_id
          and a.agreement_version <> 'terms-v1'
          and d.document_sha256 = encode(sha256(convert_to(d.document_text,'UTF8')),'hex')),
      case when v_type = 'hotel' then
        (select count(*)::integer from public.hotels h where h.organisation_id = v_org)
      else
        (select count(*)::integer from public.sbg_operator_property_grants g
          where g.operator_organisation_id = v_org and g.revoked_at is null)
      end;
end;
$snapshot$;
revoke all on function public.sbg_commercial_founding_snapshot_for_user(text)
 from public, aether_runtime, aether_app;
grant execute on function public.sbg_commercial_founding_snapshot_for_user(text) to aether_app;
