/**
 * Gate 2 Stage 3D. Full migration chain through 0069 on disposable PostgreSQL.
 * Payment, hold, expiry, refund, and concurrency against the 0069 definitions.
 * Not checkout and not Neon.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";

const ADMIN_URL = process.env.STAGE_G2S3_PG_URL;
const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
}

async function apply(client: pg.Client, names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await client.query(readFileSync(new URL(name, MIGRATIONS), "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${name}: ${message}`);
    }
  }
}

async function resetCluster(adminUrl: URL): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const databases = await admin.query<{ datname: string }>(
      `select datname from pg_database
        where datallowconn and datname not in ('postgres', 'template0', 'template1')`,
    );
    for (const row of databases.rows) {
      if (!/^[a-z0-9_]+$/.test(row.datname)) continue;
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()`,
        [row.datname],
      );
      await admin.query(`drop database if exists ${row.datname}`);
    }
    for (const role of ["sbg_fleet_writer", "aether_payment_gateway", "aether_expiry_runner", "aether_expiry", "aether_app", "aether_runtime", "aether_webhook", "aether_mailer", "sbg_capacity_writer"]) {
      const exists = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
      if (exists.rowCount === 0) continue;
      await admin.query(`drop owned by ${role}`);
      await admin.query(`revoke ${role} from postgres`).catch((err: { code?: string }) => {
        if (err.code !== "42704" && err.code !== "0LP01") throw err;
      });
      await admin.query(`drop role ${role}`);
    }
    await admin.query("create database neondb");
  } finally {
    await admin.end().catch(() => undefined);
  }
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = "/neondb";
  return dbUrl.toString();
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

const ACCEPT = `select * from public.sbg_accept_verified_payment_event(
  $1::boolean, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::integer, $10, $11, $12
)`;

test("0069 payment, expiry, privilege, and legacy concurrency", { timeout: 180_000 }, async () => {
  if (!ADMIN_URL) assert.fail("BLOCKED — LOCAL POSTGRESQL TEST NOT RUN");
  const adminUrl = new URL(ADMIN_URL);
  if (adminUrl.hostname !== "127.0.0.1" && adminUrl.hostname !== "localhost") {
    assert.fail(`BLOCKED — refusing non-local host ${adminUrl.hostname}`);
  }
  adminUrl.pathname = "/postgres";
  const dbUrl = await resetCluster(adminUrl);
  const root = await connect(dbUrl);
  const left = await connect(dbUrl);
  const right = await connect(dbUrl);
  try {
    await apply(root, migrationFiles());
    const last = migrationFiles().at(-1);
    assert.equal(last, "0078_gate2_capacity_checkout_claim_generation.sql");

    const owners = await root.query<{ proname: string; owner: string }>(
      `select p.proname, r.rolname as owner
         from pg_proc p
         join pg_roles r on r.oid = p.proowner
        where p.proname in (
          'sbg_capacity_lock_vehicle', 'sbg_capacity_lock_scope', 'sbg_capacity_settle',
          'sbg_reserve_capacity', 'sbg_release_capacity', 'sbg_reassign_capacity_vehicle',
          'sbg_assign_capacity_driver', 'sbg_assess_capacity', 'sbg_accept_verified_payment_event',
          'sbg_expire_provisional_holds', 'sbg_dispatch_set_vehicle', 'sbg_apply_payment_event'
        )
        order by p.proname`,
    );
    const ownerOf = Object.fromEntries(owners.rows.map((row) => [row.proname, row.owner]));
    for (const name of [
      "sbg_capacity_lock_vehicle",
      "sbg_capacity_settle",
      "sbg_reserve_capacity",
      "sbg_release_capacity",
      "sbg_reassign_capacity_vehicle",
      "sbg_assign_capacity_driver",
    ]) {
      assert.equal(ownerOf[name], "sbg_capacity_writer", name);
    }
    assert.equal(ownerOf.sbg_capacity_lock_scope, "postgres");
    assert.notEqual(ownerOf.sbg_assess_capacity, "sbg_capacity_writer");
    const triggers = (await root.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgrelid = 'public.bookings'::regclass and not tgisinternal
        order by tgname`,
    )).rows.map((row) => row.tgname);
    assert.ok(triggers.indexOf("bookings_capacity_managed_guard") < triggers.indexOf("bookings_dispatch_admission_guard"));
    assert.ok(triggers.indexOf("bookings_dispatch_admission_guard") < triggers.indexOf("bookings_lifecycle_column_guard"));
    assert.ok(triggers.indexOf("bookings_lifecycle_column_guard") < triggers.indexOf("bookings_occupies_before"));
    const member = await root.query<{ writer: boolean }>(
      `select exists (
         select 1 from pg_auth_members m
           join pg_roles granted on granted.oid = m.roleid
           join pg_roles who on who.oid = m.member
          where granted.rolname = 'sbg_capacity_writer'
            and who.rolname in ('postgres', 'aether_app', 'aether_runtime', 'aether_webhook', 'aether_mailer')
       ) as writer`,
    );
    assert.equal(member.rows[0]!.writer, false);

    await root.query(
      `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
       values ('user-1','Ada','ada@example.com',true,now(),now())`,
    );
    const hotelOrg = (await root.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Hotel', 'user-1', 'hotel') returning id`,
    )).rows[0]!.id;
    const hotel = (await root.query<{ id: string }>(
      `insert into hotels (code, name, iana_timezone, organisation_id)
       values ('s3d', 'Stage Hotel', 'Europe/Athens', $1::uuid) returning id`,
      [hotelOrg],
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity)
       values ($1::uuid, 'active', 1)`,
      [hotelOrg],
    );
    await root.query(
      `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
       values ($1::uuid, $2::uuid, 'user-1')`,
      [hotelOrg, hotel],
    );
    const provider = (await root.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('s3dp', 'Stage Provider', 'in_house') returning id`,
    )).rows[0]!.id;
    await root.query(
      `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
      [hotel, provider],
    );
    await root.query(
      `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode) values ($1::uuid, 'acct_legacy_s3d', false)`,
      [hotel],
    );
    await root.query(
      `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
       values ($1::uuid, 'acct_hotel_s3d', false)`,
      [hotelOrg],
    );
    const airport = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, code, name)
       values ($1::uuid, 'airport', 'ath', 'Athens Airport') returning id`,
      [provider],
    )).rows[0]!.id;
    const door = (await root.query<{ id: string }>(
      `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
       values ($1::uuid, 'hotel', $2::uuid, 'door', 'Stage Door') returning id`,
      [provider, hotel],
    )).rows[0]!.id;
    await root.query(
      `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 45)`,
      [provider, airport, door],
    );
    await root.query(
      `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
       values ($1::uuid, $2::uuid, $3::uuid, 35), ($1::uuid, $3::uuid, $2::uuid, 30)`,
      [provider, airport, door],
    );
    for (let isodow = 1; isodow <= 7; isodow += 1) {
      await root.query(
        `insert into sbg_provider_hours (provider_id, isodow, opens_local, closes_local)
         values ($1::uuid, $2, '08:00', '20:00')`,
        [provider, isodow],
      );
    }
    const van = (await root.query<{ id: string }>(
      `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Van', 7, 4, true, $1::uuid, $1::uuid) returning id`,
      [provider],
    )).rows[0]!.id;
    const otherVan = (await root.query<{ id: string }>(
      `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
       values ('Other', 7, 4, true, $1::uuid, $1::uuid) returning id`,
      [provider],
    )).rows[0]!.id;

    let n = 0;
    async function booking(date: string, time = "10:00"): Promise<string> {
      n += 1;
      const id = (await root.query<{ id: string }>(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, passenger_count, luggage_count,
           pickup_text, destination_text, human_reference, confirmation_token
         ) values (
           $1::uuid, $2::uuid, $3::date, $4::time, 60,
           'Ada', '+302100000000', 'ada@example.com', 2, 1,
           'Door', 'Airport', $5, $6
         ) returning id`,
        [hotel, provider, date, time, `S3D-${n}`, `token-s3d-${n}`],
      )).rows[0]!.id;
      return id;
    }

    async function paymentFor(bookingId: string, session: string): Promise<string> {
      const id = (await root.query<{ id: string }>(
        `insert into sbg_booking_payments (
           booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url
         ) values ($1::uuid, 4500, 'EUR', $2, 'https://checkout.stripe.test/s3d') returning id`,
        [bookingId, session],
      )).rows[0]!.id;
      await root.query(`select * from public.sbg_bind_payment_authority($1::uuid)`, [bookingId]);
      return id;
    }

    async function accept(
      bookingId: string,
      paymentId: string,
      eventId: string,
      eventType: string,
      paymentStatus: string,
      intent: string | null,
    ) {
      const session = (await root.query<{ stripe_checkout_session_id: string }>(
        `select stripe_checkout_session_id from sbg_booking_payments where id = $1::uuid`,
        [paymentId],
      )).rows[0]!.stripe_checkout_session_id;
      return root.query<{ transition_outcome: string; transition_lifecycle: string; transition_event_recorded: boolean }>(
        ACCEPT,
        [true, eventId, eventType, bookingId, paymentId, provider, "acct_hotel_s3d", session, 4500, "EUR", paymentStatus, intent],
      );
    }

    async function state(bookingId: string) {
      return (await root.query<{
        lifecycle_state: string;
        vehicle_id: string | null;
        capacity_managed: boolean;
        cancelled_at: string | null;
        status: string | null;
        events: number;
      }>(
        `select b.lifecycle_state,
                b.vehicle_id::text as vehicle_id,
                b.capacity_managed,
                b.cancelled_at::text as cancelled_at,
                p.status,
                (select count(*)::int from sbg_stripe_events) as events
           from bookings b
           left join sbg_booking_payments p on p.booking_id = b.id
          where b.id = $1::uuid`,
        [bookingId],
      )).rows[0]!;
    }

    const legacyPaid = await booking("2026-07-01");
    await root.query(`select * from public.sbg_open_provisional_hold($1::uuid, 1800)`, [legacyPaid]);
    const legacyPayment = await paymentFor(legacyPaid, "cs_s3d_legacy");
    const legacyOk = await accept(legacyPaid, legacyPayment, "evt_s3d_legacy", "checkout.session.completed", "paid", "pi_s3d_legacy");
    assert.equal(legacyOk.rows[0]!.transition_outcome, "confirmed_paid");
    assert.equal(legacyOk.rows[0]!.transition_event_recorded, true);
    const legacyAgain = await accept(legacyPaid, legacyPayment, "evt_s3d_legacy", "checkout.session.completed", "paid", "pi_s3d_legacy");
    assert.equal(legacyAgain.rows[0]!.transition_outcome, "duplicate");
    const legacySecond = await accept(legacyPaid, legacyPayment, "evt_s3d_legacy_2", "checkout.session.completed", "paid", "pi_s3d_legacy_2");
    assert.equal(legacySecond.rows[0]!.transition_outcome, "ignored_after_settlement");
    const legacyState = await state(legacyPaid);
    assert.equal(legacyState.lifecycle_state, "confirmed_paid");
    assert.equal(legacyState.vehicle_id, null);
    assert.equal(legacyState.capacity_managed, false);
    const legacyEvents = await root.query<{ event_id: string; n: number }>(
      `select event_id, count(*)::int as n from sbg_stripe_events
        where event_id in ('evt_s3d_legacy', 'evt_s3d_legacy_2')
        group by event_id order by event_id`,
    );
    assert.deepEqual(legacyEvents.rows, [
      { event_id: "evt_s3d_legacy", n: 1 },
      { event_id: "evt_s3d_legacy_2", n: 1 },
    ]);

    const legacyLate = await booking("2026-07-02");
    await root.query(`select * from public.sbg_open_provisional_hold($1::uuid, 1800)`, [legacyLate]);
    const legacyLatePayment = await paymentFor(legacyLate, "cs_s3d_late");
    await root.query(`update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid`, [legacyLate]);
    const lateLegacy = await accept(legacyLate, legacyLatePayment, "evt_s3d_late", "checkout.session.completed", "paid", "pi_s3d_late");
    assert.equal(lateLegacy.rows[0]!.transition_outcome, "late_payment");
    const lateLegacyState = await state(legacyLate);
    assert.equal(lateLegacyState.lifecycle_state, "expired");
    assert.notEqual(lateLegacyState.lifecycle_state, "confirmed_paid");
    assert.equal(lateLegacyState.status, "received_after_expiry");

    const legacySession = await booking("2026-07-03");
    await root.query(`select * from public.sbg_open_provisional_hold($1::uuid, 1800)`, [legacySession]);
    const legacySessionPayment = await paymentFor(legacySession, "cs_s3d_session");
    const sessionResult = await accept(legacySession, legacySessionPayment, "evt_s3d_session", "checkout.session.expired", "expired", null);
    assert.equal(sessionResult.rows[0]!.transition_outcome, "payment_canceled");
    const sessionState = await state(legacySession);
    assert.equal(sessionState.lifecycle_state, "awaiting_payment");
    assert.equal(sessionState.status, "expired");

    const legacyFail = await booking("2026-07-04");
    await root.query(`select * from public.sbg_open_provisional_hold($1::uuid, 1800)`, [legacyFail]);
    const legacyFailPayment = await paymentFor(legacyFail, "cs_s3d_fail");
    const failLegacy = await accept(legacyFail, legacyFailPayment, "evt_s3d_fail", "checkout.session.async_payment_failed", "unpaid", null);
    assert.equal(failLegacy.rows[0]!.transition_outcome, "payment_failed");
    assert.equal((await state(legacyFail)).lifecycle_state, "failed");

    const legacyRefund = await booking("2026-07-05");
    await root.query(`select * from public.sbg_open_provisional_hold($1::uuid, 1800)`, [legacyRefund]);
    const legacyRefundPayment = await paymentFor(legacyRefund, "cs_s3d_refund");
    await accept(legacyRefund, legacyRefundPayment, "evt_s3d_refund_pay", "checkout.session.completed", "paid", "pi_s3d_refund");
    const refundLegacy = await accept(legacyRefund, legacyRefundPayment, "evt_s3d_refund", "charge.refunded", "paid", "pi_s3d_refund");
    assert.equal(refundLegacy.rows[0]!.transition_outcome, "refunded");
    assert.equal((await state(legacyRefund)).lifecycle_state, "refunded");
    assert.equal((await state(legacyRefund)).capacity_managed, false);

    const legacyApply = await booking("2026-07-06");
    await root.query(`select * from public.sbg_open_provisional_hold($1::uuid, 1800)`, [legacyApply]);
    const legacyApplyPayment = await paymentFor(legacyApply, "cs_s3d_apply");
    const applied = await root.query<{ ok: boolean }>(
      `select public.sbg_apply_payment_event('evt_s3d_apply', 'checkout.session.completed', $1::uuid, $2::uuid, 'pi_apply', 'paid', 'acct_legacy_s3d') as ok`,
      [legacyApply, legacyApplyPayment],
    );
    assert.equal(applied.rows[0]!.ok, true);
    const appliedAgain = await root.query<{ ok: boolean }>(
      `select public.sbg_apply_payment_event('evt_s3d_apply', 'checkout.session.completed', $1::uuid, $2::uuid, 'pi_apply', 'paid', 'acct_legacy_s3d') as ok`,
      [legacyApply, legacyApplyPayment],
    );
    assert.equal(appliedAgain.rows[0]!.ok, false);
    const applyEvents = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_stripe_events where event_id = 'evt_s3d_apply'`,
    );
    assert.equal(applyEvents.rows[0]!.n, 1);
    const applyBooking = await state(legacyApply);
    assert.equal(applyBooking.lifecycle_state, "awaiting_payment");
    assert.equal(applyBooking.status, "paid");

    const reserved = await booking("2026-07-11");
    const reservedResult = await root.query(
      `select * from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [reserved, airport, door, van],
    );
    assert.equal(reservedResult.rows[0]!.reserve_outcome, "reserved");
    const reservedPayment = await paymentFor(reserved, "cs_s3d_cap");
    const capOk = await accept(reserved, reservedPayment, "evt_s3d_cap", "checkout.session.completed", "paid", "pi_s3d_cap");
    assert.equal(capOk.rows[0]!.transition_outcome, "confirmed_paid");
    const capDup = await accept(reserved, reservedPayment, "evt_s3d_cap", "checkout.session.completed", "paid", "pi_s3d_cap");
    assert.equal(capDup.rows[0]!.transition_outcome, "duplicate");
    const capState = await state(reserved);
    assert.equal(capState.lifecycle_state, "confirmed_paid");
    assert.equal(capState.vehicle_id, van);
    assert.equal(capState.capacity_managed, true);
    const capEvents = await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_stripe_events where event_id = 'evt_s3d_cap'`,
    );
    assert.equal(capEvents.rows[0]!.n, 1);
    const notCleared = await root.query<{ expired_booking_id: string }>(
      `select * from public.sbg_expire_provisional_holds(20)`,
    );
    assert.equal(notCleared.rows.some((row) => row.expired_booking_id === reserved), false);
    assert.equal((await state(reserved)).vehicle_id, van);

    const failedCap = await booking("2026-07-12");
    assert.equal((await root.query(
      `select reserve_outcome from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [failedCap, airport, door, otherVan],
    )).rows[0]!.reserve_outcome, "reserved");
    const failedPayment = await paymentFor(failedCap, "cs_s3d_cap_fail");
    const failed = await accept(failedCap, failedPayment, "evt_s3d_cap_fail", "checkout.session.async_payment_failed", "unpaid", null);
    assert.equal(failed.rows[0]!.transition_outcome, "payment_failed");
    const failedState = await state(failedCap);
    assert.equal(failedState.lifecycle_state, "failed");
    assert.equal(failedState.vehicle_id, null);

    const refundCap = await booking("2026-07-13");
    assert.equal((await root.query(
      `select reserve_outcome from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [refundCap, airport, door, van],
    )).rows[0]!.reserve_outcome, "reserved");
    const refundPayment = await paymentFor(refundCap, "cs_s3d_cap_refund");
    await accept(refundCap, refundPayment, "evt_s3d_cap_pay", "checkout.session.completed", "paid", "pi_s3d_cap_pay");
    const refunded = await accept(refundCap, refundPayment, "evt_s3d_cap_refund", "charge.refunded", "paid", "pi_s3d_cap_pay");
    assert.equal(refunded.rows[0]!.transition_outcome, "refunded");
    const refundState = await state(refundCap);
    assert.equal(refundState.lifecycle_state, "refunded");
    assert.equal(refundState.vehicle_id, null);
    assert.ok(refundState.cancelled_at);

    const dueCap = await booking("2026-07-14");
    assert.equal((await root.query(
      `select reserve_outcome from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [dueCap, airport, door, otherVan],
    )).rows[0]!.reserve_outcome, "reserved");
    await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
    await root.query(`update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid`, [dueCap]);
    await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    const expired = await root.query<{ expired_booking_id: string }>(
      `select * from public.sbg_expire_provisional_holds(20)`,
    );
    assert.equal(expired.rows.some((row) => row.expired_booking_id === dueCap), true);
    const expiredState = await state(dueCap);
    assert.equal(expiredState.lifecycle_state, "expired");
    assert.equal(expiredState.vehicle_id, null);

    const unburned = await booking("2026-07-15");
    assert.equal((await root.query(
      `select reserve_outcome from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [unburned, airport, door, van],
    )).rows[0]!.reserve_outcome, "reserved");
    const unburnedPayment = await paymentFor(unburned, "cs_s3d_unburned");
    const notApplied = await root.query<{ ok: boolean }>(
      `select public.sbg_apply_payment_event('evt_s3d_unburned', 'checkout.session.completed', $1::uuid, $2::uuid, 'pi_unburned', 'paid', 'acct_hotel_s3d') as ok`,
      [unburned, unburnedPayment],
    );
    assert.equal(notApplied.rows[0]!.ok, false);
    assert.equal((await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_stripe_events where event_id = 'evt_s3d_unburned'`,
    )).rows[0]!.n, 0);
    const recovered = await accept(unburned, unburnedPayment, "evt_s3d_unburned", "checkout.session.completed", "paid", "pi_unburned");
    assert.equal(recovered.rows[0]!.transition_outcome, "confirmed_paid");
    assert.equal((await state(unburned)).vehicle_id, van);
    assert.equal((await root.query<{ n: number }>(
      `select count(*)::int as n from sbg_stripe_events where event_id = 'evt_s3d_unburned'`,
    )).rows[0]!.n, 1);

    const skip = await booking("2026-07-16");
    await root.query(`select * from public.sbg_open_provisional_hold($1::uuid, 60)`, [skip]);
    await root.query(`update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid`, [skip]);
    await left.query("begin");
    await left.query(`select id from bookings where id = $1::uuid for update`, [skip]);
    const started = Date.now();
    const skipped = await right.query<{ expired_booking_id: string }>(
      `select * from public.sbg_expire_provisional_holds(20)`,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `legacy expiry waited ${elapsed}ms`);
    assert.equal(skipped.rows.some((row) => row.expired_booking_id === skip), false);
    await left.query("commit");
    const skippedLater = await root.query<{ expired_booking_id: string }>(
      `select * from public.sbg_expire_provisional_holds(20)`,
    );
    assert.equal(skippedLater.rows.some((row) => row.expired_booking_id === skip), true);
    assert.equal((await state(skip)).lifecycle_state, "expired");
    assert.equal((await state(skip)).capacity_managed, false);

    const raced = await booking("2026-07-17");
    assert.equal((await root.query(
      `select reserve_outcome from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [raced, airport, door, otherVan],
    )).rows[0]!.reserve_outcome, "reserved");
    const racedPayment = await paymentFor(raced, "cs_s3d_race");
    await root.query("alter table public.bookings disable trigger bookings_capacity_managed_guard");
    await root.query(`update bookings set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid`, [raced]);
    await root.query("alter table public.bookings enable trigger bookings_capacity_managed_guard");
    const acceptSql = [true, "evt_s3d_race", "checkout.session.completed", raced, racedPayment, provider, "acct_hotel_s3d", "cs_s3d_race", 4500, "EUR", "paid", "pi_s3d_race"];
    const [raceAccept, raceExpire] = await Promise.allSettled([
      left.query(ACCEPT, acceptSql),
      right.query(`select * from public.sbg_expire_provisional_holds(20)`),
    ]);
    if (raceAccept.status === "rejected") {
      const code = (raceAccept.reason as { code?: string }).code;
      const message = raceAccept.reason instanceof Error ? raceAccept.reason.message : String(raceAccept.reason);
      assert.equal(code, "40001");
      assert.match(message, /capacity_lock_retry/);
      const retried = await left.query<{ transition_outcome: string }>(ACCEPT, acceptSql);
      assert.notEqual(retried.rows[0]!.transition_outcome, "confirmed_paid");
    } else {
      assert.notEqual(raceAccept.value.rows[0]!.transition_outcome, "confirmed_paid");
    }
    assert.equal(raceExpire.status, "fulfilled");
    const raceState = await state(raced);
    assert.notEqual(raceState.lifecycle_state, "confirmed_paid");
    assert.equal(raceState.vehicle_id, null);
    assert.equal(raceState.lifecycle_state, "expired");

    const desk = await booking("2026-07-18", "15:00");
    await root.query("begin");
    await root.query("set local session authorization aether_app");
    await root.query(`select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`, [desk, otherVan]);
    await root.query("commit");
    const deskState = await state(desk);
    assert.equal(deskState.vehicle_id, otherVan);
    assert.equal(deskState.capacity_managed, false);
    await root.query(`update bookings set cancelled_at = clock_timestamp() where id = $1::uuid`, [desk]);

    await root.query("begin");
    await root.query("set local session authorization aether_app");
    const denied = await root.query(
      `update bookings set vehicle_id = null where id = $1::uuid`,
      [unburned],
    ).then(() => ({ ok: true })).catch((err: { code?: string }) => ({ ok: false, code: err.code }));
    await root.query("rollback");
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, "42501");
    assert.equal((await state(unburned)).vehicle_id, van);

    await root.query("begin");
    await root.query("set local session authorization aether_app");
    const noExpire = await root.query(`select * from public.sbg_expire_provisional_holds(1)`)
      .then(() => ({ ok: true }))
      .catch((err: { code?: string }) => ({ ok: false, code: err.code }));
    await root.query("rollback");
    assert.equal(noExpire.ok, false);
    if (!noExpire.ok) assert.equal(noExpire.code, "42501");

    const held = await booking("2026-07-19");
    assert.equal((await root.query(
      `select reserve_outcome from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [held, airport, door, van],
    )).rows[0]!.reserve_outcome, "reserved");
    await root.query("begin");
    await root.query("set local session authorization aether_app");
    const dispatchDenied = await root.query(
      `select public.sbg_dispatch_set_vehicle($1::uuid, $2::uuid)`,
      [held, otherVan],
    ).then(() => ({ ok: true })).catch((err: { code?: string }) => ({ ok: false, code: err.code }));
    await root.query("rollback");
    assert.equal(dispatchDenied.ok, false);
    if (!dispatchDenied.ok) assert.equal(dispatchDenied.code, "42501");
    await root.query("begin");
    await root.query("set local session authorization aether_app");
    const released = await root.query<{ reserve_outcome: string }>(
      `select * from public.sbg_release_capacity($1::uuid)`,
      [held],
    );
    await root.query("commit");
    assert.equal(released.rows[0]!.reserve_outcome, "released");
    const releasedState = await state(held);
    assert.equal(releasedState.lifecycle_state, "cancelled");
    assert.equal(releasedState.vehicle_id, null);

    const move = await booking("2026-07-20");
    assert.equal((await root.query(
      `select reserve_outcome from public.sbg_reserve_capacity($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [move, airport, door, otherVan],
    )).rows[0]!.reserve_outcome, "reserved");
    const movePayment = await paymentFor(move, "cs_s3d_move");
    await accept(move, movePayment, "evt_s3d_move", "checkout.session.completed", "paid", "pi_s3d_move");
    await root.query("begin");
    await root.query("set local session authorization aether_runtime");
    const moved = await root.query<{ reserve_outcome: string }>(
      `select * from public.sbg_reassign_capacity_vehicle($1::uuid, $2::uuid)`,
      [move, van],
    );
    await root.query("commit");
    assert.equal(moved.rows[0]!.reserve_outcome, "reassigned");
    assert.equal((await state(move)).vehicle_id, van);
    assert.equal((await state(move)).lifecycle_state, "confirmed_paid");
  } finally {
    await left.end().catch(() => undefined);
    await right.end().catch(() => undefined);
    await root.end().catch(() => undefined);
  }
});
