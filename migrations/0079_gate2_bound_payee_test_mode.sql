-- Gate 2 T3A.1 — bound payee test-mode proof. SOURCE ONLY.
-- Does not edit migrations 0001–0078. Not production-admitted.
-- One boolean for one already-bound payment. No account identifier and no
-- table grant. Other organisations stay unreadable.

create function public.sbg_bound_payee_is_test_mode(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $test_mode$
declare
  v_org uuid;
  v_account text;
  v_livemode boolean;
begin
  if p_payment_id is null then
    return false;
  end if;

  select p.payee_organisation_id, p.payee_stripe_account_id
    into v_org, v_account
    from public.sbg_booking_payments p
   where p.id = p_payment_id;
  if v_org is null or v_account is null or char_length(pg_catalog.btrim(v_account)) = 0 then
    return false;
  end if;

  select c.livemode
    into v_livemode
    from public.sbg_organisation_stripe_connections c
   where c.organisation_id = v_org
     and c.stripe_account_id = v_account
     and c.disconnected_at is null;
  return v_livemode is false;
end;
$test_mode$;

revoke all on function public.sbg_bound_payee_is_test_mode(uuid) from public;

do $priv$
declare
  v_role text;
begin
  foreach v_role in array ARRAY[
    'aether_runtime', 'aether_webhook', 'aether_mailer', 'aether_payment_gateway',
    'aether_expiry', 'aether_expiry_runner', 'sbg_capacity_writer', 'sbg_fleet_writer'
  ]
  loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function public.sbg_bound_payee_is_test_mode(uuid) from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'grant execute on function public.sbg_bound_payee_is_test_mode(uuid) to aether_app';
  end if;
end
$priv$;

comment on function public.sbg_bound_payee_is_test_mode(uuid) is
  'True only when that payment''s bound payee connection is still connected and livemode is false. Returns no account identifier and cannot list other organisations.';
