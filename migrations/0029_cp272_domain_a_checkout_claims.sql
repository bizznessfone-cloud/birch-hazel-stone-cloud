-- CP27.2 — Domain A organisation checkout claims. SOURCE ONLY.
-- Do not apply through the generic Production migrator.
-- Do not add this file to ACCEPTED_LEDGER.
-- Production application requires the dedicated 0029 controller and a later authorisation.
--
-- Does not modify migrations 0001–0028.
-- Does not write licensed_quantity, property allocations, hotels.status,
-- Stripe subscription rows, or Domain B payment rows.
-- Does not call Stripe. The exclusive claim transaction ends before any network call.
--
-- State machine (one row per organisation):
--   available: no row, or state = claimed and expires_at <= now() and no session
--   claimed:   state = claimed, session columns null, expires_at > now()
--   session_attached: state = session_attached, session id and url both present
--
-- Expiry frees only a pre-session claim. A session_attached row is never
-- replaced because its expires_at elapsed. Release expires a pre-session
-- claim only. It does not clear an attached Checkout Session.

create table if not exists sbg_domain_a_checkout_claims (
  organisation_id uuid primary key
    references sbg_organisations (id) on delete restrict,
  claimed_by_user_id text not null references "user" (id) on delete restrict,
  quantity integer not null,
  claim_token uuid not null,
  state text not null,
  stripe_checkout_session_id text,
  stripe_checkout_url text,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint sbg_domain_a_checkout_claims_quantity_check
    check (quantity between 1 and 49),
  constraint sbg_domain_a_checkout_claims_state_check
    check (state in ('claimed', 'session_attached')),
  constraint sbg_domain_a_checkout_claims_session_shape_check
    check (
      (
        state = 'claimed'
        and stripe_checkout_session_id is null
        and stripe_checkout_url is null
      )
      or
      (
        state = 'session_attached'
        and stripe_checkout_session_id is not null
        and stripe_checkout_url is not null
      )
    )
);

revoke all on table sbg_domain_a_checkout_claims from public;
revoke all on table sbg_domain_a_checkout_claims from aether_runtime;
revoke all on table sbg_domain_a_checkout_claims from aether_app;
grant select on table sbg_domain_a_checkout_claims to aether_app;

create or replace function sbg_claim_domain_a_checkout(
  p_actor_user_id text,
  p_organisation_id uuid,
  p_quantity integer,
  p_ttl_seconds integer
)
returns table (
  outcome text,
  claim_token uuid,
  stripe_checkout_session_id text,
  stripe_checkout_url text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $c29$
declare
  v_status text;
  v_state text;
  v_token uuid;
  v_session text;
  v_url text;
  v_expires timestamptz;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 49 then
    raise exception 'property licence quantity is not authorised'
      using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 1200 then
    raise exception 'checkout claim ttl is not authorised'
      using errcode = '22023';
  end if;

  perform 1
    from public.sbg_organisations
   where id = p_organisation_id
   for update;
  if not found then
    raise exception 'organisation not found'
      using errcode = 'P0002';
  end if;

  if not public.sbg_organisation_member_billing(p_actor_user_id, p_organisation_id) then
    raise exception 'organisation billing authority required'
      using errcode = '42501';
  end if;

  select b.status
    into v_status
    from public.sbg_organisation_billing b
   where b.organisation_id = p_organisation_id
   for update;
  if found and v_status in (
    'incomplete', 'trialing', 'active', 'past_due', 'paused', 'unpaid'
  ) then
    outcome := 'subscription_exists';
    claim_token := null;
    stripe_checkout_session_id := null;
    stripe_checkout_url := null;
    return next;
    return;
  end if;

  select c.state, c.claim_token, c.stripe_checkout_session_id, c.stripe_checkout_url, c.expires_at
    into v_state, v_token, v_session, v_url, v_expires
    from public.sbg_domain_a_checkout_claims c
   where c.organisation_id = p_organisation_id
   for update;

  if found and v_state = 'session_attached' then
    outcome := 'session_attached';
    claim_token := null;
    stripe_checkout_session_id := v_session;
    stripe_checkout_url := v_url;
    return next;
    return;
  end if;

  if found and v_expires > pg_catalog.clock_timestamp() then
    outcome := 'busy';
    claim_token := null;
    stripe_checkout_session_id := null;
    stripe_checkout_url := null;
    return next;
    return;
  end if;

  v_token := pg_catalog.gen_random_uuid();
  v_expires := pg_catalog.clock_timestamp() + (p_ttl_seconds * interval '1 second');
  if found then
    update public.sbg_domain_a_checkout_claims
       set claimed_by_user_id = p_actor_user_id,
           quantity = p_quantity,
           claim_token = v_token,
           state = 'claimed',
           stripe_checkout_session_id = null,
           stripe_checkout_url = null,
           claimed_at = pg_catalog.clock_timestamp(),
           expires_at = v_expires,
           updated_at = pg_catalog.clock_timestamp()
     where organisation_id = p_organisation_id;
  else
    insert into public.sbg_domain_a_checkout_claims (
      organisation_id, claimed_by_user_id, quantity, claim_token, state,
      claimed_at, expires_at, updated_at
    ) values (
      p_organisation_id, p_actor_user_id, p_quantity, v_token, 'claimed',
      pg_catalog.clock_timestamp(), v_expires, pg_catalog.clock_timestamp()
    );
  end if;

  outcome := 'claimed';
  claim_token := v_token;
  stripe_checkout_session_id := null;
  stripe_checkout_url := null;
  return next;
end;
$c29$;

create or replace function sbg_attach_domain_a_checkout_session(
  p_actor_user_id text,
  p_organisation_id uuid,
  p_claim_token uuid,
  p_session_id text,
  p_checkout_url text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $c29$
declare
  v_state text;
  v_token uuid;
  v_session text;
  v_url text;
  v_expires timestamptz;
begin
  if p_session_id is null
     or p_session_id !~ '^cs_[A-Za-z0-9_]+$'
     or p_checkout_url is null
     or p_checkout_url !~ '^https://[^[:space:]]+$'
  then
    raise exception 'checkout session identity is not authorised'
      using errcode = '22023';
  end if;

  perform 1
    from public.sbg_organisations
   where id = p_organisation_id
   for update;
  if not found then
    raise exception 'organisation not found'
      using errcode = 'P0002';
  end if;
  if not public.sbg_organisation_member_billing(p_actor_user_id, p_organisation_id) then
    raise exception 'organisation billing authority required'
      using errcode = '42501';
  end if;

  select c.state, c.claim_token, c.stripe_checkout_session_id, c.stripe_checkout_url, c.expires_at
    into v_state, v_token, v_session, v_url, v_expires
    from public.sbg_domain_a_checkout_claims c
   where c.organisation_id = p_organisation_id
   for update;
  if not found or v_token is distinct from p_claim_token then
    raise exception 'checkout claim token mismatch'
      using errcode = '42501';
  end if;

  if v_state = 'session_attached' then
    if v_session = p_session_id and v_url = p_checkout_url then
      return 'attached';
    end if;
    raise exception 'checkout session is already attached'
      using errcode = '23514';
  end if;

  if v_expires <= pg_catalog.clock_timestamp() then
    raise exception 'checkout claim has expired'
      using errcode = '22023';
  end if;

  update public.sbg_domain_a_checkout_claims
     set state = 'session_attached',
         stripe_checkout_session_id = p_session_id,
         stripe_checkout_url = p_checkout_url,
         updated_at = pg_catalog.clock_timestamp()
   where organisation_id = p_organisation_id
     and claim_token = p_claim_token
     and state = 'claimed';
  if not found then
    raise exception 'checkout claim token mismatch'
      using errcode = '42501';
  end if;
  return 'attached';
end;
$c29$;

create or replace function sbg_release_domain_a_checkout_claim(
  p_actor_user_id text,
  p_organisation_id uuid,
  p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $c29$
declare
  v_state text;
  v_token uuid;
begin
  perform 1
    from public.sbg_organisations
   where id = p_organisation_id
   for update;
  if not found then
    raise exception 'organisation not found'
      using errcode = 'P0002';
  end if;
  if not public.sbg_organisation_member_billing(p_actor_user_id, p_organisation_id) then
    raise exception 'organisation billing authority required'
      using errcode = '42501';
  end if;

  select c.state, c.claim_token
    into v_state, v_token
    from public.sbg_domain_a_checkout_claims c
   where c.organisation_id = p_organisation_id
   for update;
  if not found or v_token is distinct from p_claim_token then
    raise exception 'checkout claim token mismatch'
      using errcode = '42501';
  end if;
  if v_state = 'session_attached' then
    raise exception 'attached checkout session cannot be released'
      using errcode = '23514';
  end if;

  update public.sbg_domain_a_checkout_claims
     set expires_at = pg_catalog.clock_timestamp() - interval '1 microsecond',
         updated_at = pg_catalog.clock_timestamp()
   where organisation_id = p_organisation_id
     and claim_token = p_claim_token
     and state = 'claimed';
  return 'released';
end;
$c29$;

revoke all on function sbg_claim_domain_a_checkout(text, uuid, integer, integer) from public;
revoke all on function sbg_attach_domain_a_checkout_session(text, uuid, uuid, text, text) from public;
revoke all on function sbg_release_domain_a_checkout_claim(text, uuid, uuid) from public;
revoke all on function sbg_claim_domain_a_checkout(text, uuid, integer, integer) from aether_runtime;
revoke all on function sbg_attach_domain_a_checkout_session(text, uuid, uuid, text, text) from aether_runtime;
revoke all on function sbg_release_domain_a_checkout_claim(text, uuid, uuid) from aether_runtime;
revoke all on function sbg_claim_domain_a_checkout(text, uuid, integer, integer) from aether_app;
revoke all on function sbg_attach_domain_a_checkout_session(text, uuid, uuid, text, text) from aether_app;
revoke all on function sbg_release_domain_a_checkout_claim(text, uuid, uuid) from aether_app;
grant execute on function sbg_claim_domain_a_checkout(text, uuid, integer, integer) to aether_app;
grant execute on function sbg_attach_domain_a_checkout_session(text, uuid, uuid, text, text) to aether_app;
grant execute on function sbg_release_domain_a_checkout_claim(text, uuid, uuid) to aether_app;
