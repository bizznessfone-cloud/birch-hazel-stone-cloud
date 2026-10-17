-- Gate 2 Contract 2: enable the existing hotel-owner-authorised provider setter
-- for session-bound server actions. NOT approved for production migration.
-- No provider booking-read, dispatch or payment privileges are granted.
grant execute on function public.sbg_set_operator_provider_authorisation_for_user(text,uuid,uuid,uuid,boolean) to aether_app;
comment on function public.sbg_set_operator_provider_authorisation_for_user(text,uuid,uuid,uuid,boolean) is
  'Hotel billing-authority provider authorisation through authenticated server action only; does not activate bookings or payments.';
