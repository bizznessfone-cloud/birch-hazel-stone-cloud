-- CP25G.3B — restore aether_app runtime DML on Better Auth identity tables.
-- 0017 revoked these tables as unused. SaaS email/password now requires them.
-- GRANT only. No DDL, no ownership change, no role change, no application data.
-- 0011–0017 remain immutable. Occupancy and tenancy grants are unchanged.

do $aether$
begin
  if not exists (select 1 from pg_roles where rolname = 'aether_app') then
    raise exception 'aether_app missing — 0014 not applied';
  end if;
  if to_regclass('public.user') is null
     or to_regclass('public.session') is null
     or to_regclass('public.account') is null
     or to_regclass('public.verification') is null then
    raise exception 'Better Auth tables missing — 0001_auth.sql not applied';
  end if;
end
$aether$;

revoke all on table "user" from aether_app;
revoke all on table "session" from aether_app;
revoke all on table "account" from aether_app;
revoke all on table "verification" from aether_app;

grant select, insert, update, delete on table "user" to aether_app;
grant select, insert, update, delete on table "session" to aether_app;
grant select, insert, update, delete on table "account" to aether_app;
grant select, insert, update, delete on table "verification" to aether_app;
