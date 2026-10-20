-- Gate 2 Stage 4C — isolated guest-payment authority. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0069.
-- Does not open Checkout, schedule expiry, or set a role password.
-- rolpassword stays null. Activation sets it out of band, never in this file.
--
-- aether_payment_gateway is LOGIN and INHERIT. It receives privileges only by
-- membership of aether_webhook, and only after that role is proven to have no
-- table ACL and no execute grant except admission and guest correlation.
-- aether_expiry_runner inherits aether_expiry, which can expire holds and
-- cannot confirm a payment. Neither login is a member of aether_app.

do $need$
begin
  if not exists (select 1 from pg_roles where rolname = 'aether_webhook') then
    raise exception 'aether_webhook is required before isolated payment authority';
  end if;
end
$need$;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'aether_payment_gateway') then
    create role aether_payment_gateway
      login
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls
      inherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aether_expiry') then
    create role aether_expiry
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls
      inherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aether_expiry_runner') then
    create role aether_expiry_runner
      login
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls
      inherit;
  end if;
end
$roles$;

alter role aether_payment_gateway with
  login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit;
alter role aether_expiry with
  nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit;
alter role aether_expiry_runner with
  login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit;

create or replace function public.sbg_correlate_guest_payment(
  p_payment_id uuid,
  p_payment_intent_id text
) returns table (
  correlate_booking_id uuid,
  correlate_payment_id uuid,
  correlate_executing_provider_id uuid,
  correlate_session_id text,
  correlate_amount_minor integer,
  correlate_currency text,
  correlate_capacity_managed boolean,
  correlate_lifecycle text,
  correlate_payment_status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $correlate$
begin
  if p_payment_id is null and p_payment_intent_id is null then
    return;
  end if;
  if p_payment_intent_id is not null and (
       p_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
       or char_length(p_payment_intent_id) > 255
     ) then
    return;
  end if;
  return query
  select
    b.id,
    p.id,
    p.executing_provider_id,
    p.stripe_checkout_session_id,
    p.amount_minor,
    p.currency,
    b.capacity_managed,
    b.lifecycle_state,
    p.status
    from public.sbg_booking_payments p
    join public.bookings b on b.id = p.booking_id
   where (p_payment_id is null or p.id = p_payment_id)
     and (p_payment_intent_id is null or p.stripe_payment_intent_id = p_payment_intent_id);
end;
$correlate$;

revoke all on function public.sbg_correlate_guest_payment(uuid, text) from public;

do $corr$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke all on function public.sbg_correlate_guest_payment(uuid, text) from aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke all on function public.sbg_correlate_guest_payment(uuid, text) from aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_mailer') then
    execute 'revoke all on function public.sbg_correlate_guest_payment(uuid, text) from aether_mailer';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_expiry') then
    execute 'revoke all on function public.sbg_correlate_guest_payment(uuid, text) from aether_expiry';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_expiry_runner') then
    execute 'revoke all on function public.sbg_correlate_guest_payment(uuid, text) from aether_expiry_runner';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_payment_gateway') then
    execute 'revoke all on function public.sbg_correlate_guest_payment(uuid, text) from aether_payment_gateway';
  end if;
  if exists (select 1 from pg_roles where rolname = 'sbg_capacity_writer') then
    execute 'revoke all on function public.sbg_correlate_guest_payment(uuid, text) from sbg_capacity_writer';
  end if;
  execute 'revoke all on function public.sbg_correlate_guest_payment(uuid, text) from aether_webhook';
  execute 'grant execute on function public.sbg_correlate_guest_payment(uuid, text) to aether_webhook';
end
$corr$;

do $audit$
declare
  v_bad text;
begin
  if exists (
    select 1
      from pg_auth_members m
      join pg_roles member_role on member_role.oid = m.member
     where member_role.rolname = 'aether_webhook'
  ) then
    raise exception 'blocked: aether_webhook is a member of another role';
  end if;

  select string_agg(p.proname, ', ' order by p.proname)
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and exists (
       select 1
         from aclexplode(p.proacl) a
         join pg_roles r on r.oid = a.grantee
        where r.rolname = 'aether_webhook'
          and a.privilege_type = 'EXECUTE'
     )
     and p.proname not in (
       'sbg_accept_verified_payment_event',
       'sbg_correlate_guest_payment'
     );
  if v_bad is not null then
    raise exception 'blocked: aether_webhook execute is broader than admission: %', v_bad;
  end if;

  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'sbg_accept_verified_payment_event'
       and exists (
         select 1
           from aclexplode(p.proacl) a
           join pg_roles r on r.oid = a.grantee
          where r.rolname = 'aether_webhook'
            and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'blocked: aether_webhook cannot execute verified payment admission';
  end if;

  select string_agg(c.relname, ', ' order by c.relname)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm', 'S')
     and exists (
       select 1
         from aclexplode(c.relacl) a
         join pg_roles r on r.oid = a.grantee
        where r.rolname = 'aether_webhook'
     );
  if v_bad is not null then
    raise exception 'blocked: aether_webhook has relation privileges: %', v_bad;
  end if;

  select string_agg(a.attname, ', ' order by a.attname)
    into v_bad
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and a.attacl is not null
     and exists (
       select 1
         from aclexplode(a.attacl) x
         join pg_roles r on r.oid = x.grantee
        where r.rolname = 'aether_webhook'
     );
  if v_bad is not null then
    raise exception 'blocked: aether_webhook has column privileges: %', v_bad;
  end if;

  if exists (
    select 1
      from aclexplode((
        select nspacl from pg_namespace where nspname = 'public'
      )) a
      join pg_roles r on r.oid = a.grantee
     where r.rolname = 'aether_webhook'
       and a.privilege_type = 'CREATE'
  ) then
    raise exception 'blocked: aether_webhook can create in schema public';
  end if;
end
$audit$;

grant aether_webhook to aether_payment_gateway;
grant aether_expiry to aether_expiry_runner;

revoke aether_payment_gateway from aether_app;
revoke aether_payment_gateway from aether_runtime;
revoke aether_payment_gateway from aether_webhook;
revoke aether_payment_gateway from aether_mailer;
revoke aether_payment_gateway from aether_expiry;
revoke aether_payment_gateway from aether_expiry_runner;
revoke aether_webhook from aether_app;
revoke aether_webhook from aether_runtime;
revoke aether_webhook from aether_mailer;
revoke aether_webhook from aether_expiry;
revoke aether_webhook from aether_expiry_runner;
revoke aether_expiry from aether_app;
revoke aether_expiry from aether_runtime;
revoke aether_expiry from aether_webhook;
revoke aether_expiry from aether_mailer;
revoke aether_expiry from aether_payment_gateway;
revoke aether_expiry_runner from aether_app;
revoke aether_expiry_runner from aether_runtime;
revoke aether_expiry_runner from aether_webhook;
revoke aether_expiry_runner from aether_mailer;
revoke aether_expiry_runner from aether_payment_gateway;

do $expire$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from aether_runtime';
  end if;
  execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from aether_webhook';
  execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from aether_payment_gateway';
  execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from aether_mailer';
  execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from public';
  execute 'revoke all on function public.sbg_expire_provisional_holds(integer) from aether_expiry';
  execute 'grant execute on function public.sbg_expire_provisional_holds(integer) to aether_expiry';
end
$expire$;

grant connect on database postgres to aether_payment_gateway;
grant connect on database neondb to aether_payment_gateway;
grant connect on database postgres to aether_expiry_runner;
grant connect on database neondb to aether_expiry_runner;
grant usage on schema public to aether_payment_gateway;
grant usage on schema public to aether_expiry_runner;
revoke create on schema public from aether_payment_gateway;
revoke create on schema public from aether_expiry_runner;
revoke create on schema public from aether_expiry;

revoke all on all tables in schema public from aether_payment_gateway;
revoke all on all tables in schema public from aether_expiry_runner;
revoke all on all tables in schema public from aether_expiry;
revoke all on all sequences in schema public from aether_payment_gateway;
revoke all on all sequences in schema public from aether_expiry_runner;
revoke all on all sequences in schema public from aether_expiry;
revoke all on all functions in schema public from aether_payment_gateway;
revoke all on all functions in schema public from aether_expiry_runner;

comment on role aether_payment_gateway is
  'LOGIN inheriting only aether_webhook. No password in source. Not granted to aether_app. Direct table DML is revoked.';
comment on role aether_expiry is
  'NOLOGIN execute on sbg_expire_provisional_holds only. Cannot confirm a payment.';
comment on role aether_expiry_runner is
  'LOGIN inheriting aether_expiry. Not scheduled. No password in source.';
comment on function public.sbg_correlate_guest_payment(uuid, text) is
  'Read-only correlation of a guest payment by id or stored payment intent. Does not confirm, insert an event, or return the payee account.';
