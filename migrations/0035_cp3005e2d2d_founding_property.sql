-- CP30.05E-2D-2D A3-M35 — create one hotel and attach it to the caller's
-- founding organisation in the same statement.
-- Does not edit migrations 0001–0034.
-- Does not seed an approved Terms version. terms-v1 cannot pass this gate.
-- Does not take an organisation id, agreement version, role, or billing flag.
-- Does not write acceptance, billing, allocation, or Stripe.
-- Does not classify an organisation or create one.
-- Not authorised for Production apply. AUTHORISED_PENDING stays empty.
-- Apply only inside one transaction. This file has no BEGIN/COMMIT.

-- Empty on purpose. A later reviewed migration may insert one legally
-- approved version. terms-v1 is rejected by the constraint, not merely by
-- convention. aether_app cannot write this table. A disposable test database
-- may insert a non-legal fixture version; this file does not.
create table if not exists sbg_approved_property_agreement_versions (
  agreement_version text primary key,
  constraint sbg_approved_property_agreement_versions_token
    check (agreement_version ~ '^[a-z0-9][a-z0-9._/-]{0,120}$'),
  constraint sbg_approved_property_agreement_versions_not_provisional
    check (agreement_version <> 'terms-v1')
);

comment on table sbg_approved_property_agreement_versions is
  'Agreement versions that may authorise founding property creation. No row means none are approved. terms-v1 is forbidden. Not a client argument and not an environment bypass.';

-- The historical creator did not lock the user, so it could insert a second
-- organisation while property creation had already counted one. It now takes
-- the same user lock as founding ensure and property creation. It still does
-- not refuse a second organisation after the lock holder commits.
create or replace function sbg_create_organisation_for_user(
  p_user_id text,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $m35lock$
declare
  v_id uuid;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'account not found' using errcode = '22023';
  end if;
  perform 1
    from "user"
   where id = p_user_id
   for update;
  if not found then
    raise exception 'account not found' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'invalid organisation name' using errcode = '22023';
  end if;
  insert into sbg_organisations (name, created_by_user_id)
  values (btrim(p_name), p_user_id)
  returning id into v_id;
  insert into sbg_organisation_members (organisation_id, user_id, role, billing_authority)
  values (v_id, p_user_id, 'member', true);
  return v_id;
end;
$m35lock$;

create or replace function sbg_create_founding_property_for_user(
  p_user_id text,
  p_code text,
  p_name text,
  p_locality text,
  p_iana_timezone text,
  p_currency text
)
returns table (
  hotel_id uuid,
  provider_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $m35$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_org uuid;
  v_count integer;
  v_type text;
  v_billing boolean;
  v_terms text;
  v_hotel_id uuid;
  v_provider_id uuid;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'account not found' using errcode = '22023';
  end if;

  -- Serialize founding creators that take this lock. Released only when the
  -- calling transaction ends, so a failed statement rolls the hotel back too.
  perform 1
    from public."user" u
   where u.id = p_user_id
   for update;
  if not found then
    raise exception 'account not found' using errcode = '22023';
  end if;

  select coalesce(array_agg(o.id order by o.created_at, o.id), '{}'::uuid[])
    into v_ids
    from public.sbg_organisations o
   where o.created_by_user_id = p_user_id;

  if coalesce(array_length(v_ids, 1), 0) > 1 then
    raise exception 'founding organisation is ambiguous' using errcode = '42501';
  end if;

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    if exists (
      select 1
        from public.sbg_organisation_members m
       where m.user_id = p_user_id
         and m.billing_authority
         and m.removed_at is null
    ) then
      raise exception 'founding organisation is ambiguous' using errcode = '42501';
    end if;
    raise exception 'founding organisation is missing' using errcode = '22023';
  end if;

  v_org := v_ids[1];
  select o.organisation_type
    into v_type
    from public.sbg_organisations o
   where o.id = v_org
   for update;
  if not found then
    raise exception 'founding organisation is missing' using errcode = '22023';
  end if;

  select count(*)::integer
    into v_count
    from public.sbg_organisations o
   where o.created_by_user_id = p_user_id;
  if v_count is distinct from 1 or v_org is null then
    raise exception 'founding organisation is ambiguous' using errcode = '42501';
  end if;

  if v_type is null then
    raise exception 'organisation is unclassified' using errcode = '22023';
  end if;
  if v_type is distinct from 'hotel' then
    raise exception 'organisation type is not hotel' using errcode = '42501';
  end if;

  select m.billing_authority
    into v_billing
    from public.sbg_organisation_members m
   where m.organisation_id = v_org
     and m.user_id = p_user_id
     and m.removed_at is null
   for update;
  if not found or v_billing is distinct from true then
    raise exception 'organisation billing authority required' using errcode = '42501';
  end if;

  -- No client version. terms-v1 is never sufficient, including when a row
  -- exists. An empty approval table fails closed.
  select a.agreement_version
    into v_terms
    from public.sbg_organisation_acceptances a
    join public.sbg_approved_property_agreement_versions v
      on v.agreement_version = a.agreement_version
   where a.organisation_id = v_org
     and a.accepted_by_user_id = p_user_id
     and a.agreement_version <> 'terms-v1'
     and v.agreement_version <> 'terms-v1'
   limit 1;
  if v_terms is null or v_terms = 'terms-v1' then
    raise exception 'terms are not approved for property creation' using errcode = '42501';
  end if;

  select c.hotel_id, c.provider_id
    into v_hotel_id, v_provider_id
    from public.sbg_create_hotel_for_user(
      p_user_id, p_code, p_name, p_locality, p_iana_timezone, p_currency
    ) c;
  if v_hotel_id is null or v_provider_id is null then
    raise exception 'hotel was not created' using errcode = 'P0001';
  end if;

  perform public.sbg_attach_hotel_to_organisation(p_user_id, v_org, v_hotel_id);

  perform 1
    from public.hotels h
   where h.id = v_hotel_id
     and h.organisation_id = v_org;
  if not found then
    raise exception 'hotel attachment failed' using errcode = '40001';
  end if;

  return query select v_hotel_id, v_provider_id;
end;
$m35$;

comment on function sbg_create_organisation_for_user(text, text) is
  'Creates an organisation and a billing member. Locks the user row first so it cannot insert a second organisation during founding property creation. A second organisation after that transaction commits is still possible.';

comment on function sbg_create_founding_property_for_user(text, text, text, text, text, text) is
  'Creates one hotel, in-house provider, agreement, and hotel account, then attaches that hotel to the caller single hotel founding organisation. Requires an approved agreement version other than terms-v1. No version is seeded, so the call fails closed. Does not accept an organisation id. A failure rolls the statement back.';

revoke all on table sbg_approved_property_agreement_versions from public;
revoke all on table sbg_approved_property_agreement_versions from aether_runtime;
revoke all on table sbg_approved_property_agreement_versions from aether_app;

revoke all on function sbg_create_organisation_for_user(text, text) from public;
revoke all on function sbg_create_organisation_for_user(text, text) from aether_runtime;
grant execute on function sbg_create_organisation_for_user(text, text) to aether_app;

revoke all on function sbg_create_founding_property_for_user(text, text, text, text, text, text) from public;
revoke all on function sbg_create_founding_property_for_user(text, text, text, text, text, text) from aether_runtime;
revoke all on function sbg_create_founding_property_for_user(text, text, text, text, text, text) from aether_app;
grant execute on function sbg_create_founding_property_for_user(text, text, text, text, text, text) to aether_app;
