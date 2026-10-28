-- Gate 2: explicit operator organisation to executing provider authorisation.
-- NOT authorised for production. No implicit grants, no seed data, no API.
-- A hotel relationship alone is insufficient for booking visibility.
create table if not exists public.sbg_operator_provider_authorisations (
  id uuid primary key default gen_random_uuid(),
  operator_organisation_id uuid not null references public.sbg_organisations(id),
  hotel_id uuid not null references public.hotels(id),
  provider_id uuid not null references public.providers(id),
  authorised_by_user_id text not null references public."user"(id),
  authorised_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint sbg_operator_provider_auth_unique
    unique (operator_organisation_id, hotel_id, provider_id),
  constraint sbg_operator_provider_auth_revoked_after
    check (revoked_at is null or revoked_at >= authorised_at)
);
create index if not exists sbg_operator_provider_auth_hotel_provider_idx
  on public.sbg_operator_provider_authorisations(hotel_id, provider_id);
revoke all on public.sbg_operator_provider_authorisations from public;
revoke all on public.sbg_operator_provider_authorisations from aether_runtime;
revoke all on public.sbg_operator_provider_authorisations from aether_app;
alter table public.sbg_operator_provider_authorisations enable row level security;
-- No RLS policies and no runtime write/read capability.
comment on table public.sbg_operator_provider_authorisations is
  'Draft explicit operator/provider/hotel authorisation. Empty on installation; separate approval and enforcement required before any booking disclosure.';
