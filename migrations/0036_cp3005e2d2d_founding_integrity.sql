-- CP30.05E-2D-2D A3-M36 — one founding organisation per creator, and only
-- the single effective agreement version can authorise a new property.
-- Does not edit migrations 0001–0035.
-- Does not merge, delete, rename, or reassign organisations.
-- Does not seed a legal Terms version. terms-v1 stays prohibited.
-- Does not write an acceptance row. Historical acceptance rows stay.
-- Not authorised for Production apply. AUTHORISED_PENDING stays empty.
-- Apply only inside one transaction. This file has no BEGIN/COMMIT.
-- If a creator already has more than one organisation, this file raises
-- and must not continue to the unique index.

do $m36dup$
declare
  v_report text;
begin
  select string_agg(
           d.created_by_user_id || ' count=' || d.n::text || ' ids=' || d.ids,
           '; ' order by d.created_by_user_id
         )
    into v_report
    from (
      select o.created_by_user_id,
             count(*)::integer as n,
             string_agg(o.id::text, ',' order by o.created_at, o.id) as ids
        from public.sbg_organisations o
       group by o.created_by_user_id
      having count(*) > 1
    ) d;
  if v_report is not null then
    raise exception 'founding organisation duplicates exist: %', v_report
      using errcode = '23505';
  end if;
end
$m36dup$;

create unique index if not exists sbg_organisations_one_founding_creator_uidx
  on sbg_organisations (created_by_user_id);

comment on index sbg_organisations_one_founding_creator_uidx is
  'One organisation created by a user. Membership of someone else''s organisation is still allowed. Multiple hotels on one organisation are still allowed.';

alter table sbg_approved_property_agreement_versions
  add column if not exists effective boolean not null default false;

create unique index if not exists sbg_approved_property_agreement_versions_one_effective_uidx
  on sbg_approved_property_agreement_versions (effective)
  where effective;

comment on column sbg_approved_property_agreement_versions.effective is
  'At most one row may be true. Only that version authorises a new property. A false row is retained history and does not authorise creation. No legal version is seeded. aether_app cannot change this column.';

-- Reject a second founding organisation. Do not return or rename the existing one.
create or replace function sbg_create_organisation_for_user(
  p_user_id text,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $m36create$
declare
  v_id uuid;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'account not found' using errcode = '22023';
  end if;
  perform 1
    from public."user" u
   where u.id = p_user_id
   for update;
  if not found then
    raise exception 'account not found' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'invalid organisation name' using errcode = '22023';
  end if;
  if exists (
    select 1
      from public.sbg_organisations o
     where o.created_by_user_id = p_user_id
  ) then
    raise exception 'founding organisation already exists' using errcode = '23505';
  end if;
  insert into public.sbg_organisations (name, created_by_user_id)
  values (btrim(p_name), p_user_id)
  returning id into v_id;
  insert into public.sbg_organisation_members (
    organisation_id, user_id, role, billing_authority
  )
  values (v_id, p_user_id, 'member', true);
  return v_id;
exception
  when unique_violation then
    if SQLERRM not like '%sbg_organisations_one_founding_creator_uidx%' then
      raise;
    end if;
    raise exception 'founding organisation already exists' using errcode = '23505';
end;
$m36create$;

-- Same contract as 0033, plus the creator unique index as a backstop.
create or replace function sbg_ensure_founding_organisation(
  p_user_id text,
  p_name text
)
returns table (
  organisation_id uuid,
  name text,
  organisation_type text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $m36ensure$
declare
  v_name text;
  v_ids uuid[];
  v_org uuid;
  v_billing boolean;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'account not found' using errcode = '22023';
  end if;

  perform 1
    from public."user" u
   where u.id = p_user_id
   for update;
  if not found then
    raise exception 'account not found' using errcode = '22023';
  end if;

  v_name := btrim(p_name);
  if v_name is null
     or char_length(v_name) < 1
     or char_length(v_name) > 160
     or v_name ~ '[[:cntrl:]]' then
    raise exception 'invalid organisation name' using errcode = '22023';
  end if;

  select coalesce(array_agg(o.id), '{}'::uuid[])
    into v_ids
    from public.sbg_organisations o
   where o.created_by_user_id = p_user_id;

  if coalesce(array_length(v_ids, 1), 0) > 1 then
    raise exception 'founding organisation is ambiguous' using errcode = '42501';
  end if;

  if coalesce(array_length(v_ids, 1), 0) = 1 then
    v_org := v_ids[1];
    select exists (
      select 1
        from public.sbg_organisation_members m
       where m.organisation_id = v_org
         and m.user_id = p_user_id
         and m.billing_authority
         and m.removed_at is null
    ) into v_billing;
    if not coalesce(v_billing, false) then
      raise exception 'founding organisation is ambiguous' using errcode = '42501';
    end if;
    return query
      select o.id, o.name, o.organisation_type
        from public.sbg_organisations o
       where o.id = v_org;
    return;
  end if;

  if exists (
    select 1
      from public.sbg_organisation_members m
     where m.user_id = p_user_id
       and m.billing_authority
       and m.removed_at is null
  ) then
    raise exception 'founding organisation is ambiguous' using errcode = '42501';
  end if;

  insert into public.sbg_organisations (name, created_by_user_id)
  values (v_name, p_user_id)
  returning id into v_org;

  insert into public.sbg_organisation_members (
    organisation_id, user_id, role, billing_authority
  )
  values (v_org, p_user_id, 'member', true);

  return query
    select o.id, o.name, o.organisation_type
      from public.sbg_organisations o
     where o.id = v_org;
  return;
exception
  when unique_violation then
    if SQLERRM not like '%sbg_organisations_one_founding_creator_uidx%' then
      raise;
    end if;
    select coalesce(array_agg(o.id), '{}'::uuid[])
      into v_ids
      from public.sbg_organisations o
     where o.created_by_user_id = p_user_id;
    if coalesce(array_length(v_ids, 1), 0) is distinct from 1 then
      raise exception 'founding organisation is ambiguous' using errcode = '42501';
    end if;
    v_org := v_ids[1];
    select exists (
      select 1
        from public.sbg_organisation_members m
       where m.organisation_id = v_org
         and m.user_id = p_user_id
         and m.billing_authority
         and m.removed_at is null
    ) into v_billing;
    if not coalesce(v_billing, false) then
      raise exception 'founding organisation is ambiguous' using errcode = '42501';
    end if;
    return query
      select o.id, o.name, o.organisation_type
        from public.sbg_organisations o
       where o.id = v_org;
    return;
end;
$m36ensure$;

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
as $m36property$
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

  -- Only the one effective version. A superseded approval row does not count.
  -- terms-v1 never counts. An empty table fails closed. No client version.
  select a.agreement_version
    into v_terms
    from public.sbg_organisation_acceptances a
    join public.sbg_approved_property_agreement_versions v
      on v.agreement_version = a.agreement_version
     and v.effective
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
$m36property$;

comment on function sbg_create_organisation_for_user(text, text) is
  'Creates one organisation and a billing member for a user who has created none. Locks the user row. A second create raises founding organisation already exists and does not rename or replace the first.';

comment on function sbg_ensure_founding_organisation(text, text) is
  'Returns the caller''s one founding organisation when they still have billing authority. Creates it only when they have none. Does not rename. The creator unique index rejects a second insert.';

comment on function sbg_create_founding_property_for_user(text, text, text, text, text, text) is
  'Creates and attaches one hotel for the caller''s single hotel founding organisation. Requires acceptance of the one effective agreement version. Superseded versions and terms-v1 do not qualify. No version is seeded.';

revoke all on table sbg_approved_property_agreement_versions from public;
revoke all on table sbg_approved_property_agreement_versions from aether_runtime;
revoke all on table sbg_approved_property_agreement_versions from aether_app;

revoke all on function sbg_create_organisation_for_user(text, text) from public;
revoke all on function sbg_create_organisation_for_user(text, text) from aether_runtime;
grant execute on function sbg_create_organisation_for_user(text, text) to aether_app;

revoke all on function sbg_ensure_founding_organisation(text, text) from public;
revoke all on function sbg_ensure_founding_organisation(text, text) from aether_runtime;
grant execute on function sbg_ensure_founding_organisation(text, text) to aether_app;

revoke all on function sbg_create_founding_property_for_user(text, text, text, text, text, text) from public;
revoke all on function sbg_create_founding_property_for_user(text, text, text, text, text, text) from aether_runtime;
revoke all on function sbg_create_founding_property_for_user(text, text, text, text, text, text) from aether_app;
grant execute on function sbg_create_founding_property_for_user(text, text, text, text, text, text) to aether_app;
