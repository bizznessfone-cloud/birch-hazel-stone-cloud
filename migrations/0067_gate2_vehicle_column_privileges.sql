-- Gate 2 Stage 2A — narrow aether_runtime vehicle writes. SOURCE ONLY.
-- Does not edit migrations 0001–0066. Does not reserve a vehicle.
--
-- 0011 granted aether_runtime table-level INSERT and UPDATE on vehicles.
-- A table-level UPDATE covers luggage_capacity and the ownership columns.
-- A column REVOKE does not remove a table-level grant, so the table
-- privilege is revoked and the desk columns are granted again.
-- upsertVehicle writes name, capacity, and active, and inserts
-- name, capacity, active, owned_by_provider_id, operated_by_provider_id.
-- luggage_capacity is not granted. DELETE remains the 0011 table grant.

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke insert, update on table public.vehicles from aether_runtime';
    execute 'grant insert (name, capacity, active, owned_by_provider_id, operated_by_provider_id) on table public.vehicles to aether_runtime';
    execute 'grant update (name, capacity, active) on table public.vehicles to aether_runtime';
  end if;
end
$priv$;
