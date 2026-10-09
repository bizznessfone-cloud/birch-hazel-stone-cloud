-- CP30.05E-2D-2C — classify the caller's founding organisation and record
-- one provisional Terms acceptance. Does not modify migrations 0001–0033.
-- Does not create or attach a hotel. Does not write billing, allocation, or Stripe.
-- Does not change membership role or billing_authority.
-- Does not backfill organisation_type. Does not insert an acceptance row.
-- terms-v1 is a provisional technical token. It is not a claim that final
-- legal Terms have been published or approved. Privacy is not a second row.
-- p_user_id is trusted only because the server wrapper derived it from the
-- session. These functions do not accept an organisation id, role, billing
-- flag, agreement version, or timestamp.
-- Not authorised for Production apply. AUTHORISED_PENDING stays empty.
-- Apply only inside one transaction. This file has no BEGIN/COMMIT.

-- Internal resolver. Not granted to aether_app. Does not create or mutate.
create or replace function sbg_founding_onboarding_target(p_user_id text)
returns table (
  state text,
  organisation_id uuid,
  organisation_type text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $e2d2c$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_org uuid;
  v_type text;
  v_billing boolean;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'account not found' using errcode = '22023';
  end if;
  if not exists (select 1 from public."user" u where u.id = p_user_id) then
    raise exception 'account not found' using errcode = '22023';
  end if;

  select coalesce(array_agg(o.id order by o.created_at, o.id), '{}'::uuid[])
    into v_ids
    from public.sbg_organisations o
   where o.created_by_user_id = p_user_id;

  if coalesce(array_length(v_ids, 1), 0) > 1 then
    return query select 'ambiguous'::text, null::uuid, null::text;
    return;
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
      return query select 'ambiguous'::text, null::uuid, null::text;
      return;
    end if;
    select o.organisation_type into v_type
      from public.sbg_organisations o
     where o.id = v_org;
    return query select 'ready'::text, v_org, v_type;
    return;
  end if;

  -- A billing seat on someone else's organisation is not this user's founding
  -- organisation and is not something this call may classify or accept.
  if exists (
    select 1
      from public.sbg_organisation_members m
     where m.user_id = p_user_id
       and m.billing_authority
       and m.removed_at is null
  ) then
    return query select 'ambiguous'::text, null::uuid, null::text;
    return;
  end if;

  return query select 'missing'::text, null::uuid, null::text;
end;
$e2d2c$;

create or replace function sbg_classify_founding_organisation(
  p_user_id text,
  p_type text
)
returns table (
  organisation_id uuid,
  organisation_type text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $e2d2c$
#variable_conflict use_column
declare
  v_state text;
  v_org uuid;
  v_current text;
begin
  if p_type is null or p_type not in ('hotel', 'transfer_operator') then
    raise exception 'invalid organisation type' using errcode = '22023';
  end if;

  select t.state, t.organisation_id
    into v_state, v_org
    from public.sbg_founding_onboarding_target(p_user_id) t;

  if v_state = 'missing' then
    raise exception 'founding organisation is missing' using errcode = '22023';
  end if;
  if v_state is distinct from 'ready' or v_org is null then
    raise exception 'founding organisation is ambiguous' using errcode = '42501';
  end if;

  -- Serializes conflicting classification of this organisation. Does not lock
  -- organisations this user merely joined.
  select o.organisation_type
    into v_current
    from public.sbg_organisations o
   where o.id = v_org
   for update;
  if not found then
    raise exception 'founding organisation is missing' using errcode = '22023';
  end if;

  if v_current is null then
    update public.sbg_organisations as o
       set organisation_type = p_type
     where o.id = v_org
       and o.organisation_type is null
    returning o.organisation_type into v_current;
    if not found then
      select o.organisation_type
        into v_current
        from public.sbg_organisations o
       where o.id = v_org;
    end if;
  end if;

  if v_current is null or v_current is distinct from p_type then
    raise exception 'organisation type is already set' using errcode = '42501';
  end if;

  return query select v_org, v_current;
end;
$e2d2c$;

create or replace function sbg_record_founding_terms_acceptance(p_user_id text)
returns table (
  organisation_id uuid,
  agreement_version text,
  already_accepted boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $e2d2c$
#variable_conflict use_column
declare
  v_state text;
  v_org uuid;
  v_type text;
  v_inserted uuid;
begin
  select t.state, t.organisation_id
    into v_state, v_org
    from public.sbg_founding_onboarding_target(p_user_id) t;

  if v_state = 'missing' then
    raise exception 'founding organisation is missing' using errcode = '22023';
  end if;
  if v_state is distinct from 'ready' or v_org is null then
    raise exception 'founding organisation is ambiguous' using errcode = '42501';
  end if;

  select o.organisation_type
    into v_type
    from public.sbg_organisations o
   where o.id = v_org
   for update;
  if not found then
    raise exception 'founding organisation is missing' using errcode = '22023';
  end if;
  if v_type is null then
    raise exception 'organisation is unclassified' using errcode = '22023';
  end if;
  if v_type not in ('hotel', 'transfer_operator') then
    raise exception 'invalid organisation type' using errcode = '22023';
  end if;

  -- Server-owned provisional token. No client version and no client timestamp.
  insert into public.sbg_organisation_acceptances (
    organisation_id, accepted_by_user_id, agreement_version
  )
  values (v_org, p_user_id, 'terms-v1')
  on conflict (organisation_id, accepted_by_user_id, agreement_version) do nothing
  returning id into v_inserted;

  return query select v_org, 'terms-v1'::text, (v_inserted is null);
end;
$e2d2c$;

create or replace function sbg_read_founding_onboarding_state(p_user_id text)
returns table (
  state text,
  organisation_id uuid,
  organisation_type text,
  terms_accepted boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $e2d2c$
#variable_conflict use_column
declare
  v_state text;
  v_org uuid;
  v_type text;
  v_terms boolean;
begin
  select t.state, t.organisation_id, t.organisation_type
    into v_state, v_org, v_type
    from public.sbg_founding_onboarding_target(p_user_id) t;

  v_terms := false;
  if v_state is distinct from 'ready' or v_org is null then
    v_org := null;
    v_type := null;
    v_terms := false;
  else
    select exists (
      select 1
        from public.sbg_organisation_acceptances a
       where a.organisation_id = v_org
         and a.accepted_by_user_id = p_user_id
         and a.agreement_version = 'terms-v1'
    ) into v_terms;
  end if;

  return query select v_state, v_org, v_type, coalesce(v_terms, false);
end;
$e2d2c$;

comment on function sbg_founding_onboarding_target(text) is
  'Internal. Resolves the one organisation this user created when they still have an active billing membership. Does not create, classify, or accept. Not granted to aether_app.';

comment on function sbg_classify_founding_organisation(text, text) is
  'Sets the caller founding organisation type from NULL to hotel or transfer_operator. Same type is idempotent. A different non-NULL type is rejected. Does not change membership role.';

comment on function sbg_record_founding_terms_acceptance(text) is
  'Records one explicit terms-v1 acceptance for the caller founding organisation after it has a type. terms-v1 is provisional, not published legal text. Retry does not insert a second row. Not invoked by organisation creation.';

comment on function sbg_read_founding_onboarding_state(text) is
  'Reads the caller founding organisation type and whether terms-v1 is accepted. Does not write. Ambiguous or missing state returns no organisation id.';

revoke all on function sbg_founding_onboarding_target(text) from public;
revoke all on function sbg_founding_onboarding_target(text) from aether_runtime;
revoke all on function sbg_founding_onboarding_target(text) from aether_app;

revoke all on function sbg_classify_founding_organisation(text, text) from public;
revoke all on function sbg_classify_founding_organisation(text, text) from aether_runtime;
revoke all on function sbg_classify_founding_organisation(text, text) from aether_app;
grant execute on function sbg_classify_founding_organisation(text, text) to aether_app;

revoke all on function sbg_record_founding_terms_acceptance(text) from public;
revoke all on function sbg_record_founding_terms_acceptance(text) from aether_runtime;
revoke all on function sbg_record_founding_terms_acceptance(text) from aether_app;
grant execute on function sbg_record_founding_terms_acceptance(text) to aether_app;

revoke all on function sbg_read_founding_onboarding_state(text) from public;
revoke all on function sbg_read_founding_onboarding_state(text) from aether_runtime;
revoke all on function sbg_read_founding_onboarding_state(text) from aether_app;
grant execute on function sbg_read_founding_onboarding_state(text) to aether_app;
