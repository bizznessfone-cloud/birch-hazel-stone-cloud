-- Gate 2 operator booking list: isolated, read-only and privacy restricted.
-- NOT authorised for production. No public endpoint or UI activation.
-- The application must supply p_user_id exclusively from its authenticated session.
-- A grant allows a hotel relationship, but this function never returns contact,
-- payment, confirmation token, vehicle, driver or hotel owner administration.
create or replace function public.sbg_list_operator_booking_summaries_for_user(
  p_user_id text, p_hotel_id uuid, p_limit integer default 50
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
as $operator_bookings$
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_hotel_id is null
     or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'operator booking access denied' using errcode = '42501';
  end if;
  if not public.sbg_operator_can_access_property_for_user(p_user_id, p_hotel_id) then
    raise exception 'operator booking access denied' using errcode = '42501';
  end if;
  return query
    select b.id, b.human_reference::text,
           b.transfer_date::text, b.pickup_time::text,
           b.passenger_count, b.luggage_count,
           b.pickup_text::text, b.destination_text::text,
           (b.cancelled_at is not null)
      from public.bookings b
     where b.hotel_id = p_hotel_id
     order by b.transfer_date desc, b.pickup_time desc, b.id
     limit p_limit;
end;
$operator_bookings$;
revoke all on function public.sbg_list_operator_booking_summaries_for_user(text,uuid,integer) from public;
revoke all on function public.sbg_list_operator_booking_summaries_for_user(text,uuid,integer) from aether_runtime;
revoke all on function public.sbg_list_operator_booking_summaries_for_user(text,uuid,integer) from aether_app;
-- Intentionally NO EXECUTE grant to aether_app yet: database function is
-- migration-tested in isolation before exposure or commercial authorisation.
comment on function public.sbg_list_operator_booking_summaries_for_user(text,uuid,integer) is
  'Draft restricted operator booking projection; no app-role EXECUTE until scope and disclosure policy are approved.';
