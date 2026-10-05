-- CP30.05E-2C — organisation type foundation only.
-- Does not modify migrations 0001–0030.
-- Does not classify existing rows. NULL means unclassified, not hotel.
-- Does not change membership role, billing quantity, allocation, or
-- hotels.organisation_id cardinality. One organisation may still own many hotels.
-- Does not grant privileges. Does not replace sbg_create_organisation_for_user.
-- Apply only inside one transaction. This file has no BEGIN/COMMIT so the
-- controller owns the transaction boundary.

alter table sbg_organisations
  add column if not exists organisation_type text;

alter table sbg_organisations
  drop constraint if exists sbg_organisations_organisation_type_check;

alter table sbg_organisations
  add constraint sbg_organisations_organisation_type_check
  check (
    organisation_type is null
    or organisation_type in ('hotel', 'transfer_operator')
  );

comment on column sbg_organisations.organisation_type is
  'Commercial classification only: hotel or transfer_operator. NULL is unclassified. Not a membership role, licence count, or entitlement.';
