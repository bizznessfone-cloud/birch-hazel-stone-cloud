-- Aether Transfer — CP12 multi-tenant hotel platform
-- Organisations, memberships, owner-vs-operator assets, executing provider.
-- Does NOT replace occupies, bookings_occupies_before, GiST EXCLUDE,
-- or aether_athens_instant().

-- 1. Providers
create table if not exists providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  kind text not null default 'external',
  created_at timestamptz not null default now(),
  constraint providers_kind_check
    check (kind in ('in_house', 'external')),
  constraint providers_code_format
    check (
      code ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'
      and char_length(code) between 2 and 32
    ),
  constraint providers_name_present
    check (char_length(btrim(name)) > 0)
);

-- 2. Agreements
create table if not exists hotel_provider_agreements (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels (id) on delete restrict,
  provider_id uuid not null references providers (id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint hotel_provider_agreements_pair unique (hotel_id, provider_id)
);

-- 3. Memberships
create table if not exists operator_memberships (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete cascade,
  org_kind text not null,
  hotel_id uuid references hotels (id) on delete restrict,
  provider_id uuid references providers (id) on delete restrict,
  access_class text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint operator_memberships_xor check (
    (
      org_kind = 'hotel'
      and hotel_id is not null
      and provider_id is null
      and access_class = 'hotel_desk'
    )
    or
    (
      org_kind = 'provider'
      and provider_id is not null
      and hotel_id is null
      and access_class = 'provider_dispatcher'
    )
  )
);

-- 4–7. Nullable columns
alter table vehicles
  add column if not exists owned_by_hotel_id uuid references hotels (id) on delete restrict,
  add column if not exists owned_by_provider_id uuid references providers (id) on delete restrict,
  add column if not exists operated_by_provider_id uuid references providers (id) on delete restrict;

alter table drivers
  add column if not exists employed_by_hotel_id uuid references hotels (id) on delete restrict,
  add column if not exists employed_by_provider_id uuid references providers (id) on delete restrict,
  add column if not exists dispatched_by_provider_id uuid references providers (id) on delete restrict;

alter table bookings
  add column if not exists executing_provider_id uuid references providers (id) on delete restrict;

alter table sessions
  add column if not exists membership_id uuid references operator_memberships (id) on delete restrict;

-- 8–12. Backfill (legacy shared provider — do not invent hotel ownership)
insert into providers (code, name, kind)
select 'legacy', 'Legacy Operations', 'external'
where not exists (select 1 from providers where code = 'legacy');

insert into hotel_provider_agreements (hotel_id, provider_id, active)
select h.id, p.id, true
from hotels h
cross join providers p
where p.code = 'legacy'
  and not exists (
    select 1 from hotel_provider_agreements a
    where a.hotel_id = h.id and a.provider_id = p.id
  );

insert into operator_memberships (operator_id, org_kind, provider_id, access_class, active)
select o.id, 'provider', p.id, 'provider_dispatcher', true
from operators o
cross join providers p
where p.code = 'legacy'
  and not exists (
    select 1 from operator_memberships m
    where m.operator_id = o.id
      and m.provider_id = p.id
      and m.access_class = 'provider_dispatcher'
      and m.active
  );

update vehicles v
set
  owned_by_provider_id = p.id,
  operated_by_provider_id = p.id
from providers p
where p.code = 'legacy'
  and v.operated_by_provider_id is null;

update drivers d
set
  employed_by_provider_id = p.id,
  dispatched_by_provider_id = p.id
from providers p
where p.code = 'legacy'
  and d.dispatched_by_provider_id is null;

update bookings b
set executing_provider_id = a.provider_id
from hotel_provider_agreements a
where a.hotel_id = b.hotel_id
  and a.active
  and b.executing_provider_id is null;

update sessions s
set membership_id = m.id
from operator_memberships m
join providers p on p.id = m.provider_id and p.code = 'legacy'
where s.operator_id = m.operator_id
  and m.active
  and m.org_kind = 'provider'
  and s.membership_id is null;

-- 13. Fail closed on unresolved rows
do $aether$
begin
  if exists (select 1 from vehicles where operated_by_provider_id is null
             or (owned_by_hotel_id is null and owned_by_provider_id is null)
             or (owned_by_hotel_id is not null and owned_by_provider_id is not null)) then
    raise exception 'cp12 backfill: vehicles missing or ambiguous ownership/operation';
  end if;
  if exists (select 1 from drivers where dispatched_by_provider_id is null
             or (employed_by_hotel_id is null and employed_by_provider_id is null)
             or (employed_by_hotel_id is not null and employed_by_provider_id is not null)) then
    raise exception 'cp12 backfill: drivers missing or ambiguous employment/dispatch';
  end if;
  if exists (select 1 from bookings where executing_provider_id is null) then
    raise exception 'cp12 backfill: bookings missing executing_provider_id';
  end if;
  if exists (select 1 from sessions where membership_id is null) then
    raise exception 'cp12 backfill: sessions missing membership_id';
  end if;
  if exists (
    select 1 from operators o
    where not exists (
      select 1 from operator_memberships m
      where m.operator_id = o.id and m.active
    )
  ) then
    raise exception 'cp12 backfill: operators missing active membership';
  end if;
end
$aether$;

-- 14–16. CHECKs, NOT NULL, unique indexes
alter table vehicles
  drop constraint if exists vehicles_owner_xor;
alter table vehicles
  add constraint vehicles_owner_xor check (
    (owned_by_hotel_id is not null and owned_by_provider_id is null)
    or
    (owned_by_hotel_id is null and owned_by_provider_id is not null)
  );
alter table vehicles
  alter column operated_by_provider_id set not null;

alter table drivers
  drop constraint if exists drivers_employer_xor;
alter table drivers
  add constraint drivers_employer_xor check (
    (employed_by_hotel_id is not null and employed_by_provider_id is null)
    or
    (employed_by_hotel_id is null and employed_by_provider_id is not null)
  );
alter table drivers
  alter column dispatched_by_provider_id set not null;

alter table bookings
  alter column executing_provider_id set not null;

alter table sessions
  alter column membership_id set not null;

create unique index if not exists hotel_provider_agreements_one_active
  on hotel_provider_agreements (hotel_id)
  where active;

create unique index if not exists operator_memberships_active_hotel_hat
  on operator_memberships (operator_id, hotel_id)
  where active and hotel_id is not null;

create unique index if not exists operator_memberships_active_provider_hat
  on operator_memberships (operator_id, provider_id)
  where active and provider_id is not null;

-- 17. Access-path indexes
create index if not exists bookings_hotel_date_time_idx
  on bookings (hotel_id, transfer_date, pickup_time);
create index if not exists bookings_executing_provider_date_idx
  on bookings (executing_provider_id, transfer_date);
create index if not exists hotel_provider_agreements_provider_active_idx
  on hotel_provider_agreements (provider_id)
  where active;
create index if not exists vehicles_operated_by_provider_idx
  on vehicles (operated_by_provider_id);
create index if not exists drivers_dispatched_by_provider_idx
  on drivers (dispatched_by_provider_id);
create index if not exists operator_memberships_operator_active_idx
  on operator_memberships (operator_id)
  where active;
create index if not exists sessions_membership_idx
  on sessions (membership_id);

-- Runtime DML (role may be absent on PGLite tests that skip 0011)
do $aether$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'grant select, insert, update, delete on table providers to aether_runtime';
    execute 'grant select, insert, update, delete on table hotel_provider_agreements to aether_runtime';
    execute 'grant select, insert, update, delete on table operator_memberships to aether_runtime';
  end if;
end
$aether$;

insert into aether_meta (key, value)
values
  ('schema_phase', '12'),
  ('checkpoint', '12')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
