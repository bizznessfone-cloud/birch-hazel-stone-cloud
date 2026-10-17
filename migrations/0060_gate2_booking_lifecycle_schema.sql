-- Gate 2 Stage A — booking lifecycle schema. SOURCE ONLY.
-- Not production-admitted. Does not edit migrations 0001–0059.
-- Does not change GiST exclusions, the occupancy trigger, duration,
-- checkout, webhooks, confirmation email, or dispatch.
--
-- bookings.status remains the operational label. It is not payment evidence.
-- A booking row, confirmation token, or previously sent email is not payment evidence.

alter table public.bookings
  add column if not exists lifecycle_state text,
  add column if not exists hold_expires_at timestamptz,
  add column if not exists confirmed_paid_at timestamptz;

-- Pre-existing and not-yet-migrated inserts stay readable and unconfirmed.
update public.bookings
   set lifecycle_state = 'legacy_unreconciled'
 where lifecycle_state is null;

alter table public.bookings
  alter column lifecycle_state set default 'legacy_unreconciled';

alter table public.bookings
  alter column lifecycle_state set not null;

alter table public.bookings
  drop constraint if exists bookings_lifecycle_state_check;
alter table public.bookings
  add constraint bookings_lifecycle_state_check
  check (lifecycle_state in (
    'legacy_unreconciled',
    'awaiting_payment',
    'payment_processing',
    'confirmed_paid',
    'expired',
    'failed',
    'cancelled',
    'refunded'
  ));

alter table public.bookings
  drop constraint if exists bookings_lifecycle_hold_required_check;
alter table public.bookings
  add constraint bookings_lifecycle_hold_required_check
  check (
    lifecycle_state not in ('awaiting_payment', 'payment_processing')
    or hold_expires_at is not null
  );

alter table public.bookings
  drop constraint if exists bookings_lifecycle_hold_finite_check;
alter table public.bookings
  add constraint bookings_lifecycle_hold_finite_check
  check (
    hold_expires_at is null
    or (hold_expires_at > '-infinity'::timestamptz and hold_expires_at < 'infinity'::timestamptz)
  );

alter table public.bookings
  drop constraint if exists bookings_lifecycle_confirmed_at_check;
alter table public.bookings
  add constraint bookings_lifecycle_confirmed_at_check
  check (lifecycle_state <> 'confirmed_paid' or confirmed_paid_at is not null);

alter table public.bookings
  drop constraint if exists bookings_lifecycle_confirmed_at_finite_check;
alter table public.bookings
  add constraint bookings_lifecycle_confirmed_at_finite_check
  check (
    confirmed_paid_at is null
    or (confirmed_paid_at > '-infinity'::timestamptz and confirmed_paid_at < 'infinity'::timestamptz)
  );

-- Confirmation evidence cannot be attached to an unreconciled or still-open hold.
alter table public.bookings
  drop constraint if exists bookings_lifecycle_confirmed_state_check;
alter table public.bookings
  add constraint bookings_lifecycle_confirmed_state_check
  check (
    confirmed_paid_at is null
    or lifecycle_state in ('confirmed_paid', 'cancelled', 'refunded')
  );

alter table public.bookings
  drop constraint if exists bookings_lifecycle_legacy_unconfirmed_check;
alter table public.bookings
  add constraint bookings_lifecycle_legacy_unconfirmed_check
  check (
    lifecycle_state <> 'legacy_unreconciled'
    or (hold_expires_at is null and confirmed_paid_at is null)
  );

comment on column public.bookings.lifecycle_state is
  'Server lifecycle. legacy_unreconciled is not payment confirmation and does not admit dispatch. confirmed_paid_at is necessary but not payment-row evidence.';
comment on column public.bookings.hold_expires_at is
  'Absolute timestamptz deadline for an open hold. Null for legacy rows.';
comment on column public.bookings.confirmed_paid_at is
  'Absolute timestamptz set only by a later verified-payment transition. Not proof that a payment row exists.';

-- Cross-table payment evidence cannot be a CHECK. Stage D must provide one
-- transactional transition function before confirmed_paid is writable by the app.

alter table public.sbg_booking_payments
  drop constraint if exists sbg_booking_payment_status_check;
alter table public.sbg_booking_payments
  add constraint sbg_booking_payment_status_check
  check (status in (
    'pending',
    'paid',
    'failed',
    'expired',
    'canceled',
    'received_after_expiry'
  ));

comment on constraint sbg_booking_payment_status_check on public.sbg_booking_payments is
  'received_after_expiry records a late capture. It is not paid and does not confirm the booking.';

-- Application roles must not write lifecycle fields directly.
-- Table-level UPDATE granted in 0011 still covers new columns for aether_runtime,
-- so a guard trigger enforces the restriction without rewriting that grant.
create or replace function public.sbg_bookings_lifecycle_column_guard()
returns trigger
language plpgsql
as $guard$
begin
  if current_user in ('aether_app', 'aether_runtime') then
    if tg_op = 'INSERT' then
      if new.lifecycle_state is distinct from 'legacy_unreconciled'
         or new.hold_expires_at is not null
         or new.confirmed_paid_at is not null then
        raise exception 'lifecycle fields are not directly writable'
          using errcode = '42501';
      end if;
    elsif new.lifecycle_state is distinct from old.lifecycle_state
       or new.hold_expires_at is distinct from old.hold_expires_at
       or new.confirmed_paid_at is distinct from old.confirmed_paid_at then
      raise exception 'lifecycle fields are not directly writable'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$guard$;

revoke all on function public.sbg_bookings_lifecycle_column_guard() from public;

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'aether_app') then
    execute 'revoke all on function public.sbg_bookings_lifecycle_column_guard() from aether_app';
    execute 'revoke update (lifecycle_state, hold_expires_at, confirmed_paid_at) on table public.bookings from aether_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aether_runtime') then
    execute 'revoke all on function public.sbg_bookings_lifecycle_column_guard() from aether_runtime';
    execute 'revoke update (lifecycle_state, hold_expires_at, confirmed_paid_at) on table public.bookings from aether_runtime';
  end if;
end
$priv$;

revoke update (lifecycle_state, hold_expires_at, confirmed_paid_at) on table public.bookings from public;

drop trigger if exists bookings_lifecycle_column_guard on public.bookings;
create trigger bookings_lifecycle_column_guard
  before insert or update on public.bookings
  for each row
  execute function public.sbg_bookings_lifecycle_column_guard();

comment on function public.sbg_bookings_lifecycle_column_guard() is
  'Rejects direct lifecycle writes by aether_app and aether_runtime. A later security-definer transition may write them.';
