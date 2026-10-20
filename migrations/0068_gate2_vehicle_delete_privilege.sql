-- Gate 2 Stage 2B — revoke vehicle DELETE. SOURCE ONLY.
-- Does not edit migrations 0001–0067. Does not reserve a vehicle.
--
-- 0011 granted aether_runtime table-level DELETE on vehicles.
-- No application service, database function, or trigger deletes a vehicle.
-- Desk fleet changes are INSERT and UPDATE of name, capacity, and active.
-- aether_app has had no DELETE since 0017 revoked all and did not grant it.
-- This revoke does not change SELECT, INSERT, or UPDATE.

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke delete on table public.vehicles from aether_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke delete on table public.vehicles from aether_app';
  end if;
end
$priv$;
