-- Gate 2: read-only, session-bound operator property discovery.
-- Review/disposable only. Production migration admission is NOT authorised.
-- No guest data, booking data, provider authorisation or payment metadata.
create or replace function public.sbg_operator_properties_for_user(p_user_id text)
returns table(hotel_id uuid, hotel_name text)
language plpgsql security definer
set search_path = pg_catalog, public
as $operator_properties$
declare v_count integer;
begin
  if p_user_id is null or btrim(p_user_id) = '' then return; end if;
  if not exists (select 1 from public."user" where id = p_user_id) then return; end if;
  select count(distinct o.id)::integer into v_count
    from public.sbg_organisations o
    join public.sbg_organisation_members m on m.organisation_id = o.id
   where m.user_id = p_user_id and m.removed_at is null
     and o.organisation_type = 'transfer_operator';
  if v_count <> 1 then return; end if;
  return query
    select h.id, h.name::text
      from public.sbg_organisations o
      join public.sbg_organisation_members m on m.organisation_id = o.id
      join public.sbg_operator_property_grants g on g.operator_organisation_id = o.id
      join public.hotels h on h.id = g.hotel_id
     where m.user_id = p_user_id and m.removed_at is null
       and o.organisation_type = 'transfer_operator'
       and g.revoked_at is null and h.organisation_id is not null
     order by h.name, h.id
     limit 100;
end;
$operator_properties$;
revoke all on function public.sbg_operator_properties_for_user(text) from public;
revoke all on function public.sbg_operator_properties_for_user(text) from aether_runtime;
revoke all on function public.sbg_operator_properties_for_user(text) from aether_app;
grant execute on function public.sbg_operator_properties_for_user(text) to aether_app;
comment on function public.sbg_operator_properties_for_user(text) is
  'Read-only active explicit operator property grants. No booking, payment, provider or ownership authority.';
