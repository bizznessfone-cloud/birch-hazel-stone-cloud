-- Gate 2: isolated provider-scoped booking projection.
-- NOT authorised for production; no application EXECUTE, endpoint, or UI.
-- The application must derive p_user_id from the authenticated server session.
create or replace function public.sbg_list_operator_provider_booking_summaries_for_user(
  p_user_id text, p_hotel_id uuid, p_provider_id uuid, p_limit integer default 50
) returns table (
  "bookingId" uuid,
  "humanReference" text,
  "transferDate" text,
  "pickupTime" text,
  "passengerCount" integer,
  "luggageCount" integer,
  "pickupText" text,
  "destinationText" text,
  "cancelled" boolean
)
language plpgsql security definer
set search_path = pg_catalog, public
as $provider_bookings$
begin
  if p_user_id is null or btrim(p_user_id) = ''
     or p_hotel_id is null or p_provider_id is null
     or p_limit is null or p_limit < 1 or p_limit > 100
     or not public.sbg_operator_can_access_provider_for_user(p_user_id, p_hotel_id, p_provider_id) then
    raise exception 'operator provider booking access denied' using errcode = '42501';
  end if;
  return query
    select b.id, b.human_reference::text,
           b.transfer_date::text, b.pickup_time::text,
           b.passenger_count, b.luggage_count,
           b.pickup_text::text, b.destination_text::text,
           (b.cancelled_at is not null)
      from public.bookings b
     where b.hotel_id = p_hotel_id
       and b.executing_provider_id = p_provider_id
     order by b.transfer_date desc, b.pickup_time desc, b.id
     limit p_limit;
end;
$provider_bookings$;
revoke all on function public.sbg_list_operator_provider_booking_summaries_for_user(text,uuid,uuid,integer) from public;
revoke all on function public.sbg_list_operator_provider_booking_summaries_for_user(text,uuid,uuid,integer) from aether_runtime;
revoke all on function public.sbg_list_operator_provider_booking_summaries_for_user(text,uuid,uuid,integer) from aether_app;
comment on function public.sbg_list_operator_provider_booking_summaries_for_user(text,uuid,uuid,integer) is
  'Draft provider-specific booking summary projection. No application execution until disclosure policy is approved.';
