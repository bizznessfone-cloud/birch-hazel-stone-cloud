-- Gate 2: permit authenticated application service to invoke guarded licence release.
-- The SQL function itself verifies the payer organisation's billing authority.
-- Source only; no UI, production admission or Stripe side effects.
grant execute on function public.sbg_release_property_licence_for_user(text,uuid) to aether_app;
revoke all on function public.sbg_release_property_licence_for_user(text,uuid)
  from public, aether_runtime;
