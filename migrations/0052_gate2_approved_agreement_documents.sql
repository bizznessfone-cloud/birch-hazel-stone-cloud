-- Gate 2 Contract 3: legal document publication contract. Offline only.
-- No legal text or approved version is seeded. Publishing requires separate authorisation.
-- A document must exist before its version can become effective.
-- Requires pgcrypto for SHA-256. Install in the migration transaction.
create extension if not exists pgcrypto with schema public;

create table if not exists public.sbg_approved_agreement_documents (
  agreement_version text primary key references public.sbg_approved_property_agreement_versions(agreement_version) on delete restrict,
  document_text text not null,
  document_sha256 text not null,
  published_at timestamptz not null default now(),
  constraint sbg_approved_agreement_documents_text check (length(btrim(document_text)) > 0),
  constraint sbg_approved_agreement_documents_hash check (document_sha256 ~ '^[0-9a-f]{64}$')
);
create or replace function public.sbg_reject_agreement_document_mutation()
returns trigger language plpgsql set search_path = pg_catalog, public as $immut$
begin
  raise exception 'published agreement documents are immutable' using errcode = '42501';
end;
$immut$;
drop trigger if exists sbg_approved_agreement_documents_immutable on public.sbg_approved_agreement_documents;
create trigger sbg_approved_agreement_documents_immutable before update or delete or truncate
on public.sbg_approved_agreement_documents for each statement
execute function public.sbg_reject_agreement_document_mutation();

create or replace function public.sbg_guard_effective_agreement_document()
returns trigger language plpgsql set search_path = pg_catalog, public as $guard$
begin
  if new.effective and not exists (
    select 1 from public.sbg_approved_agreement_documents d
    where d.agreement_version = new.agreement_version
      and d.document_sha256 = encode(public.digest(convert_to(d.document_text, 'UTF8'), 'sha256'), 'hex')
  ) then
    raise exception 'effective agreement requires published verified document' using errcode = '42501';
  end if;
  return new;
end;
$guard$;
-- pgcrypto is required for digest and is provided by the existing database setup.
drop trigger if exists sbg_effective_agreement_requires_document on public.sbg_approved_property_agreement_versions;
create trigger sbg_effective_agreement_requires_document before insert or update
on public.sbg_approved_property_agreement_versions for each row
execute function public.sbg_guard_effective_agreement_document();

create or replace function public.sbg_read_effective_founding_agreement()
returns table(agreement_version text, document_text text, document_sha256 text)
language sql security definer set search_path = pg_catalog, public as $read$
  select v.agreement_version, d.document_text, d.document_sha256
  from public.sbg_approved_property_agreement_versions v
  join public.sbg_approved_agreement_documents d using(agreement_version)
  where v.effective and v.agreement_version <> 'terms-v1'
    and d.document_sha256 = encode(public.digest(convert_to(d.document_text, 'UTF8'), 'sha256'), 'hex');
$read$;
revoke all on public.sbg_approved_agreement_documents from public, aether_runtime, aether_app;
revoke all on function public.sbg_read_effective_founding_agreement() from public, aether_runtime, aether_app;
grant execute on function public.sbg_read_effective_founding_agreement() to aether_app;
