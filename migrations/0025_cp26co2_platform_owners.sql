-- CP26C-O2 — platform Owner grant + audit foundation
-- SOURCE ONLY. Do not apply through the generic Production migrator.
-- Production application requires a dedicated single-use controller and an
-- explicit later checkpoint. Do not modify 0001–0024.
--
-- Runtime (aether_app) receives SELECT only. First Owner grant is owner-plane
-- (schema owner / AETHER_DATABASE_OWNER_URL). Subsequent grant/revoke is a
-- SECURITY DEFINER requiring an already-active Owner. Cannot revoke the last
-- active Owner from runtime.
--
-- No commercial catalogue tables (O3). No hotels.status writes. No Domain B.

create table if not exists sbg_platform_owners (
  user_id text primary key references "user" ("id"),
  granted_at timestamptz not null default now(),
  granted_by_user_id text references "user" ("id"),
  revoked_at timestamptz,
  revoked_by_user_id text references "user" ("id"),
  note text not null default '',
  constraint sbg_platform_owners_note_len check (char_length(note) <= 240),
  constraint sbg_platform_owners_user_present check (char_length(btrim(user_id)) > 0)
);

create index if not exists sbg_platform_owners_active_idx
  on sbg_platform_owners (user_id)
  where revoked_at is null;

create table if not exists sbg_owner_audit_events (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_user_id text references "user" ("id") on delete restrict,
  action text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  constraint sbg_owner_audit_action_present check (char_length(btrim(action)) > 0),
  constraint sbg_owner_audit_target_present check (char_length(btrim(target_type)) > 0)
);

create index if not exists sbg_owner_audit_at_idx
  on sbg_owner_audit_events (at desc);

revoke all on table sbg_platform_owners from public;
revoke all on table sbg_owner_audit_events from public;
revoke all on table sbg_platform_owners from aether_app;
revoke all on table sbg_owner_audit_events from aether_app;

grant select on table sbg_platform_owners to aether_app;
grant select on table sbg_owner_audit_events to aether_app;

-- Owner Overview reads Domain A event outcomes. 0020 withheld SELECT.
revoke all on table sbg_stripe_events from aether_app;
grant select on table sbg_stripe_events to aether_app;


create or replace function sbg_bootstrap_platform_owner(
  p_user_id text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $owner$
declare
  v_note text;
begin
  if p_user_id is null or char_length(btrim(p_user_id)) = 0 then
    raise exception 'account not found' using errcode = '22023';
  end if;
  if not exists (select 1 from "user" where id = p_user_id) then
    raise exception 'account not found' using errcode = '22023';
  end if;
  if exists (select 1 from sbg_platform_owners where revoked_at is null) then
    raise exception 'platform owner already exists' using errcode = '23505';
  end if;

  v_note := left(btrim(coalesce(p_note, '')), 240);

  insert into sbg_platform_owners (
    user_id, granted_at, granted_by_user_id, revoked_at, revoked_by_user_id, note
  )
  values (p_user_id, now(), null, null, null, v_note)
  on conflict (user_id) do update
    set granted_at = now(),
        granted_by_user_id = null,
        revoked_at = null,
        revoked_by_user_id = null,
        note = excluded.note;

  insert into sbg_owner_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  )
  values (
    p_user_id,
    'owner.granted',
    'platform_owner',
    p_user_id,
    jsonb_build_object('bootstrap', true, 'note', v_note)
  );
end;
$owner$;


create or replace function sbg_grant_platform_owner(
  p_actor_user_id text,
  p_user_id text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $owner$
declare
  v_note text;
begin
  if p_actor_user_id is null or char_length(btrim(p_actor_user_id)) = 0
     or p_user_id is null or char_length(btrim(p_user_id)) = 0 then
    raise exception 'account not found' using errcode = '22023';
  end if;
  if not exists (
    select 1 from sbg_platform_owners
     where user_id = p_actor_user_id and revoked_at is null
  ) then
    raise exception 'not a platform owner' using errcode = '42501';
  end if;
  if not exists (select 1 from "user" where id = p_user_id) then
    raise exception 'account not found' using errcode = '22023';
  end if;
  if exists (
    select 1 from sbg_platform_owners
     where user_id = p_user_id and revoked_at is null
  ) then
    raise exception 'platform owner already granted' using errcode = '23505';
  end if;

  v_note := left(btrim(coalesce(p_note, '')), 240);

  insert into sbg_platform_owners (
    user_id, granted_at, granted_by_user_id, revoked_at, revoked_by_user_id, note
  )
  values (p_user_id, now(), p_actor_user_id, null, null, v_note)
  on conflict (user_id) do update
    set granted_at = now(),
        granted_by_user_id = p_actor_user_id,
        revoked_at = null,
        revoked_by_user_id = null,
        note = excluded.note;

  insert into sbg_owner_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  )
  values (
    p_actor_user_id,
    'owner.granted',
    'platform_owner',
    p_user_id,
    jsonb_build_object('bootstrap', false, 'note', v_note)
  );
end;
$owner$;


create or replace function sbg_revoke_platform_owner(
  p_actor_user_id text,
  p_user_id text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $owner$
declare
  v_note text;
  v_active integer;
begin
  if p_actor_user_id is null or char_length(btrim(p_actor_user_id)) = 0
     or p_user_id is null or char_length(btrim(p_user_id)) = 0 then
    raise exception 'account not found' using errcode = '22023';
  end if;
  if not exists (
    select 1 from sbg_platform_owners
     where user_id = p_actor_user_id and revoked_at is null
  ) then
    raise exception 'not a platform owner' using errcode = '42501';
  end if;
  if not exists (
    select 1 from sbg_platform_owners
     where user_id = p_user_id and revoked_at is null
  ) then
    raise exception 'platform owner not active' using errcode = 'P0002';
  end if;

  select count(*)::int into v_active
    from sbg_platform_owners
   where revoked_at is null;
  if v_active <= 1 then
    raise exception 'cannot revoke the last platform owner' using errcode = '23514';
  end if;

  v_note := left(btrim(coalesce(p_note, '')), 240);

  update sbg_platform_owners
     set revoked_at = now(),
         revoked_by_user_id = p_actor_user_id,
         note = case when v_note = '' then note else v_note end
   where user_id = p_user_id
     and revoked_at is null;

  insert into sbg_owner_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  )
  values (
    p_actor_user_id,
    'owner.revoked',
    'platform_owner',
    p_user_id,
    jsonb_build_object('note', v_note)
  );
end;
$owner$;

revoke all on function sbg_bootstrap_platform_owner(text, text) from public;
revoke all on function sbg_grant_platform_owner(text, text, text) from public;
revoke all on function sbg_revoke_platform_owner(text, text, text) from public;

-- Bootstrap remains owner-plane. Runtime may grant/revoke only as an active Owner.
grant execute on function sbg_grant_platform_owner(text, text, text) to aether_app;
grant execute on function sbg_revoke_platform_owner(text, text, text) to aether_app;
