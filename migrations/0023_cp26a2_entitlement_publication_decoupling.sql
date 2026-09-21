-- CP26A.2 — entitlement / publication decoupling
-- Source-only checkpoint. Apply only through the controlled migration process.
--
-- Replaces sbg_sync_hotel_entitlement so SaaS billing and Stripe Connect
-- cannot promote or demote hotels.status. Publication remains the
-- operational guest-booking gate, written only by onboarding/provision.
-- Domain A (sbg_billing_accounts) and Domain B (sbg_stripe_connections,
-- sbg_booking_payments) are untouched. No DML against existing hotel rows.

create or replace function sbg_sync_hotel_entitlement(p_hotel_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_status text;
begin
  select status into v_current_status
    from hotels
   where id = p_hotel_id;

  if v_current_status is null then
    raise exception 'hotel not found' using errcode = 'P0002';
  end if;

  return v_current_status;
end;
$$;

revoke all on function sbg_sync_hotel_entitlement(uuid) from public;
grant execute on function sbg_sync_hotel_entitlement(uuid) to aether_app;
