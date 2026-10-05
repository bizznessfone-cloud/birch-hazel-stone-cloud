-- CP30.05E-2C.1 — versioned organisation acceptance evidence only.
-- Does not modify migrations 0001–0031.
-- Does not write an acceptance row. An existing organisation has no acceptance.
-- Does not change organisation classification, membership, billing quantity,
-- property allocation, or cardinality.
-- Does not add a runtime privilege.
-- Apply only inside one transaction. This file has no BEGIN/COMMIT so the
-- controller owns the transaction boundary.

create table if not exists sbg_organisation_acceptances (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references sbg_organisations (id) on delete restrict,
  accepted_by_user_id text not null references "user" ("id") on delete restrict,
  agreement_version text not null,
  accepted_at timestamptz not null default now(),
  constraint sbg_organisation_acceptances_version_token
    check (agreement_version ~ '^[a-z0-9][a-z0-9._/-]{0,120}$')
);

comment on table sbg_organisation_acceptances is
  'Append-only evidence that one authenticated user recorded one explicit agreement version for one organisation. Not a boolean, not access, not a membership role, not a licence, and not per property. No row means no evidence. A later version is a new row.';

comment on column sbg_organisation_acceptances.agreement_version is
  'Durable version token chosen by a later checkpoint. Not a migration date and not a requirement that privacy and commercial terms are the same event.';

create unique index if not exists sbg_organisation_acceptances_version_uidx
  on sbg_organisation_acceptances (organisation_id, accepted_by_user_id, agreement_version);

create or replace function sbg_reject_organisation_acceptance_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $e2c1$
begin
  raise exception 'organisation acceptance evidence is immutable' using errcode = '42501';
end;
$e2c1$;

drop trigger if exists sbg_organisation_acceptances_immutable on sbg_organisation_acceptances;
create trigger sbg_organisation_acceptances_immutable
  before update or delete on sbg_organisation_acceptances
  for each row execute function sbg_reject_organisation_acceptance_mutation();

drop trigger if exists sbg_organisation_acceptances_no_truncate on sbg_organisation_acceptances;
create trigger sbg_organisation_acceptances_no_truncate
  before truncate on sbg_organisation_acceptances
  for each statement execute function sbg_reject_organisation_acceptance_mutation();

revoke all on table sbg_organisation_acceptances from public;
revoke all on table sbg_organisation_acceptances from aether_app;
revoke all on function sbg_reject_organisation_acceptance_mutation() from public;
revoke all on function sbg_reject_organisation_acceptance_mutation() from aether_app;
