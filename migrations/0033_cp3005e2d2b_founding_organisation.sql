-- CP30.05E-2D-2B — atomic self-service founding organisation.
-- Does not modify migrations 0001–0032.
-- Does not set organisation_type. NULL stays unclassified.
-- Does not create, attach, rename, or publish a hotel/property.
-- Does not write billing, allocation, acceptance, or Stripe.
-- Does not add UNIQUE(user_id). A user may still belong to other organisations.
-- Not authorised for Production apply. AUTHORISED_PENDING stays empty.
-- Apply only inside one transaction. This file has no BEGIN/COMMIT so a
-- later controller would own that boundary. Do not run it now.

-- Lookup for "organisations this user created". Not a uniqueness constraint.
create index if not exists sbg_organisations_created_by_idx
  on sbg_organisations (created_by_user_id);

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
as $e2d2b$
declare
  v_name text;
  v_ids uuid[];
  v_org uuid;
  v_billing boolean;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'account not found' using errcode = '22023';
  end if;

  -- Serialize this user's founding calls against each other.
  -- Does not lock other users. Does not lock memberships they merely joined.
  -- The historical hotel-checkout creator does not take this lock; that path
  -- stays a separate compatibility problem for a later checkpoint.
  perform 1
    from public."user"
   where id = p_user_id
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

  select coalesce(array_agg(id), '{}'::uuid[])
    into v_ids
    from public.sbg_organisations
   where created_by_user_id = p_user_id;

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

  -- No organisation created by this user.
  -- A billing seat on someone else's organisation is not claimed and is not
  -- a signal to open a second self-service organisation beside it.
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
end;
$e2d2b$;

comment on function sbg_ensure_founding_organisation(text, text) is
  'V1 self-service founding. Returns the one organisation this user created when they still have an active billing membership on it. Otherwise creates that organisation and a member row (role member, billing_authority true) in the same call. Does not set organisation_type, create a hotel, or write billing, allocation, or acceptance.';

revoke all on function sbg_ensure_founding_organisation(text, text) from public;
revoke all on function sbg_ensure_founding_organisation(text, text) from aether_runtime;
revoke all on function sbg_ensure_founding_organisation(text, text) from aether_app;
grant execute on function sbg_ensure_founding_organisation(text, text) to aether_app;
