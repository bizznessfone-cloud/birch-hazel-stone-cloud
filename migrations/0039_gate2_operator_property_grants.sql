-- Gate 2 operator-to-property grants: isolated preparation only.
-- NOT authorised for production. No grants are seeded or inferred.
-- A hotel owning organisation and an independent transfer operator are distinct.
-- This table is intentionally inaccessible to aether_app until a separately
-- reviewed, session-bound grant issuance/revocation API exists.
create table if not exists public.sbg_operator_property_grants (
  id uuid primary key default gen_random_uuid(),
  operator_organisation_id uuid not null references public.sbg_organisations(id),
  hotel_id uuid not null references public.hotels(id),
  granted_by_user_id text not null references public."user"(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint sbg_operator_property_grants_revocation_time
    check (revoked_at is null or revoked_at >= granted_at),
  constraint sbg_operator_property_grants_unique_pair
    unique (operator_organisation_id, hotel_id)
);
create index if not exists sbg_operator_property_grants_hotel_idx
  on public.sbg_operator_property_grants(hotel_id);
comment on table public.sbg_operator_property_grants is
  'Explicit hotel/operator authorisation only. No automatic access from operator classification or hotel ownership. Grant issuance and enforcement are not implemented by this migration.';
revoke all on public.sbg_operator_property_grants from public;
revoke all on public.sbg_operator_property_grants from aether_runtime;
revoke all on public.sbg_operator_property_grants from aether_app;
alter table public.sbg_operator_property_grants enable row level security;
-- No RLS policies: direct access fails closed for non-owners.
