import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";

const { Client } = pg;

const CHAIN = [
  "0001_auth.sql",
  "0002_foundation.sql",
  "0003_occupancy.sql",
  "0005_time_domain.sql",
  "0012_cp12_tenancy.sql",
  "0018_cp22_saas_onboarding.sql",
  "0020_cp24_stripe_billing.sql",
  "0021_cp25_hotel_guest_payments.sql",
  "0024_cp26b2_ordered_billing_events.sql",
  "0025_cp26co2_platform_owners.sql",
  "0026_cp26co3_commercial_catalogue.sql",
  "0027_cp26co41_organisation_property_licence.sql",
  "0031_cp3005e2c_organisation_type.sql",
  "0039_gate2_operator_property_grants.sql",
  "0043_gate2_operator_provider_authorisations.sql",
  "0060_gate2_booking_lifecycle_schema.sql",
  "0061_gate2_provisional_hold_operations.sql",
  "0062_gate2_executing_provider_payment_authority.sql",
  "0063_gate2_verified_payment_transition.sql",
];

const ADMIN_URL = process.env.STAGE_D_PG_URL;
const EVIDENCE_PATH = "/tmp/stage-d-concurrency-evidence.json";

type Evidence = {
  name: string;
  holderPid: number;
  waiterPid: number;
  independentConnections: boolean;
  waitEventType: string | null;
  waitEvent: string | null;
  elapsedMs?: number;
  outcome: string | null;
  finalLifecycle: string;
  finalPaymentStatus: string;
  confirmedPaidAt: string | null;
  eventCount: number;
};

const evidence: Evidence[] = [];

function assertLocal(url: URL): void {
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    assert.fail(`CONCURRENCY GATE NOT PASSED: refusing non-local database host ${url.hostname}`);
  }
}

async function connect(connectionString: string): Promise<pg.Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function waitForLock(observer: pg.Client, pid: number): Promise<{ wait_event_type: string; wait_event: string }> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const found = await observer.query<{ wait_event_type: string | null; wait_event: string | null }>(
      `select wait_event_type, wait_event from pg_stat_activity where pid = $1`,
      [pid],
    );
    const row = found.rows[0];
    if (row?.wait_event_type === "Lock") {
      return { wait_event_type: row.wait_event_type, wait_event: row.wait_event ?? "" };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("CONCURRENCY GATE NOT PASSED: the second session did not wait on a lock");
}

test("two postgres sessions race the verified payment transition", async () => {
  if (!ADMIN_URL) {
    assert.fail("CONCURRENCY GATE NOT PASSED: STAGE_D_PG_URL is unset");
  }
  const adminUrl = new URL(ADMIN_URL);
  assertLocal(adminUrl);
  adminUrl.pathname = "/postgres";
  const admin = await connect(adminUrl.toString());
  const version = await admin.query<{ version: string }>("select version()");
  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = 'stage_d_gate' and pid <> pg_backend_pid()`,
  );
  await admin.query("drop database if exists stage_d_gate");
  await admin.query("create database stage_d_gate");
  await admin.end();

  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = "/stage_d_gate";
  const setup = await connect(dbUrl.toString());
  await setup.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'aether_app') then
        create role aether_app nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'aether_runtime') then
        create role aether_runtime nologin;
      end if;
    end $$;
  `);
  for (const name of CHAIN) {
    await setup.query(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  await setup.query(
    `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
     values ('user-1','Ada','ada@example.com',true,now(),now())`,
  );
  const serverVersion = version.rows[0]!.version;

  let n = 0;
  async function world(kind: "in_house" | "external", due: boolean) {
    n += 1;
    const hotelOrg = (
      await setup.query<{ id: string }>(
        `insert into sbg_organisations (name, created_by_user_id, organisation_type)
         values ($1, 'user-1', 'hotel') returning id`,
        [`Hotel ${n}`],
      )
    ).rows[0]!.id;
    const operatorOrg =
      kind === "external"
        ? (
            await setup.query<{ id: string }>(
              `insert into sbg_organisations (name, created_by_user_id, organisation_type)
               values ($1, 'user-1', 'transfer_operator') returning id`,
              [`Operator ${n}`],
            )
          ).rows[0]!.id
        : null;
    const hotel = (
      await setup.query<{ id: string }>(
        `insert into hotels (code, name, organisation_id) values ($1, $2, $3::uuid) returning id`,
        [`c${n}`, `Hotel ${n}`, hotelOrg],
      )
    ).rows[0]!.id;
    await setup.query(
      `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity) values ($1::uuid, 'active', 1)`,
      [hotelOrg],
    );
    if (operatorOrg) {
      await setup.query(
        `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity) values ($1::uuid, 'active', 1)`,
        [operatorOrg],
      );
    }
    await setup.query(
      `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
       values ($1::uuid, $2::uuid, 'user-1')`,
      [hotelOrg, hotel],
    );
    const provider = (
      await setup.query<{ id: string }>(
        `insert into providers (code, name, kind) values ($1, $2, $3) returning id`,
        [`c${n}`, `Provider ${n}`, kind],
      )
    ).rows[0]!.id;
    await setup.query(
      `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
      [hotel, provider],
    );
    const legacy = `acct_legacy_c${n}`;
    await setup.query(
      `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode) values ($1::uuid, $2, false)`,
      [hotel, legacy],
    );
    const account = kind === "in_house" ? `acct_hotel_c${n}` : `acct_operator_c${n}`;
    await setup.query(
      `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
       values ($1::uuid, $2, false)`,
      [kind === "in_house" ? hotelOrg : operatorOrg, account],
    );
    if (operatorOrg) {
      await setup.query(
        `insert into sbg_operator_property_grants (operator_organisation_id, hotel_id, granted_by_user_id)
         values ($1::uuid, $2::uuid, 'user-1')`,
        [operatorOrg, hotel],
      );
      await setup.query(
        `insert into sbg_operator_provider_authorisations
           (operator_organisation_id, hotel_id, provider_id, authorised_by_user_id)
         values ($1::uuid, $2::uuid, $3::uuid, 'user-1')`,
        [operatorOrg, hotel, provider],
      );
    }
    const booking = (
      await setup.query<{ id: string }>(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, pickup_text, destination_text,
           human_reference, confirmation_token
         ) values (
           $1::uuid, $2::uuid, '2026-01-15', '09:00', 60,
           'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport', $3, $4
         ) returning id`,
        [hotel, provider, `C-${n}`, `token-C-${n}`],
      )
    ).rows[0]!.id;
    await setup.query(`select * from sbg_open_provisional_hold($1::uuid, 1800)`, [booking]);
    const payment = (
      await setup.query<{ id: string; stripe_checkout_session_id: string }>(
        `insert into sbg_booking_payments (
           booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url
         ) values ($1::uuid, 4500, 'EUR', $2, 'https://checkout.stripe.test/session')
         returning id, stripe_checkout_session_id`,
        [booking, `cs_conc_${n}`],
      )
    ).rows[0]!;
    await setup.query(`select * from sbg_bind_payment_authority($1::uuid)`, [booking]);
    if (due) {
      await setup.query(
        `update bookings set hold_expires_at = clock_timestamp() - interval '2 seconds' where id = $1::uuid`,
        [booking],
      );
    }
    return {
      hotelOrg,
      operatorOrg,
      hotel,
      provider,
      account,
      booking,
      payment: payment.id,
      session: payment.stripe_checkout_session_id,
    };
  }

  function args(row: Awaited<ReturnType<typeof world>>, eventId: string) {
    return [
      true,
      eventId,
      "checkout.session.completed",
      row.booking,
      row.payment,
      row.provider,
      row.account,
      row.session,
      4500,
      "EUR",
      "paid",
      `pi_${eventId}`,
    ];
  }

  const call = `select * from sbg_accept_verified_payment_event(
    $1::boolean, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::integer, $10, $11, $12
  )`;

  async function finalOf(booking: string, payment: string, eventId: string) {
    const state = await setup.query<{
      lifecycle_state: string;
      confirmed_paid_at: string | null;
      status: string;
      events: number;
    }>(
      `select b.lifecycle_state, b.confirmed_paid_at, p.status,
              (select count(*)::int from sbg_stripe_events e where e.event_id = $3) as events
         from bookings b
         join sbg_booking_payments p on p.id = $2::uuid
        where b.id = $1::uuid`,
      [booking, payment, eventId],
    );
    return state.rows[0]!;
  }

  async function overlap(
    name: string,
    row: Awaited<ReturnType<typeof world>>,
    startWaiter: (waiter: pg.Client) => Promise<pg.QueryResult>,
    finishHolder: (holder: pg.Client) => Promise<void>,
    eventId: string,
  ) {
    const holder = await connect(dbUrl.toString());
    const waiter = await connect(dbUrl.toString());
    const observer = await connect(dbUrl.toString());
    const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    const waiterPid = (await waiter.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    assert.notEqual(holderPid, waiterPid);
    await holder.query("begin");
    await holder.query("select id from bookings where id = $1::uuid for update", [row.booking]);
    const pending = startWaiter(waiter);
    const waited = await waitForLock(observer, waiterPid);
    await finishHolder(holder);
    const result = await pending;
    const outcome = (result.rows[0]?.transition_outcome as string | undefined) ?? null;
    const final = await finalOf(row.booking, row.payment, eventId);
    evidence.push({
      name,
      holderPid,
      waiterPid,
      independentConnections: true,
      waitEventType: waited.wait_event_type,
      waitEvent: waited.wait_event,
      outcome,
      finalLifecycle: final.lifecycle_state,
      finalPaymentStatus: final.status,
      confirmedPaidAt: final.confirmed_paid_at,
      eventCount: final.events,
    });
    await holder.end();
    await waiter.end();
    await observer.end();
    return { outcome, final, result };
  }

  const expiryFirst = await world("in_house", true);
  const expiry = await overlap(
    "expiry_locks_first",
    expiryFirst,
    (waiter) => waiter.query(call, args(expiryFirst, "evt_conc_expiry_first")),
    async (holder) => {
      await holder.query("select * from sbg_expire_provisional_holds(50)");
      await holder.query("commit");
    },
    "evt_conc_expiry_first",
  );
  assert.equal(expiry.outcome, "late_payment");
  assert.equal(expiry.final.lifecycle_state, "expired");
  assert.equal(expiry.final.status, "received_after_expiry");
  assert.equal(expiry.final.confirmed_paid_at, null);

  const paymentFirst = await world("external", true);
  const holder = await connect(dbUrl.toString());
  const waiter = await connect(dbUrl.toString());
  const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const waiterPid = (await waiter.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  await holder.query("begin");
  await holder.query("select id from bookings where id = $1::uuid for update", [paymentFirst.booking]);
  const started = Date.now();
  const skipped = await waiter.query<{ expired_booking_id: string }>("select * from sbg_expire_provisional_holds(50)");
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 1000, `CONCURRENCY GATE NOT PASSED: expiry waited ${elapsedMs}ms`);
  assert.equal(
    skipped.rows.some((row) => row.expired_booking_id === paymentFirst.booking),
    false,
  );
  const paidWhileHeld = await holder.query(call, args(paymentFirst, "evt_conc_payment_first"));
  await holder.query("commit");
  const later = await waiter.query<{ expired_booking_id: string }>("select * from sbg_expire_provisional_holds(50)");
  const paymentFinal = await finalOf(paymentFirst.booking, paymentFirst.payment, "evt_conc_payment_first");
  evidence.push({
    name: "payment_locks_first",
    holderPid,
    waiterPid,
    independentConnections: holderPid !== waiterPid,
    waitEventType: null,
    waitEvent: "skip_locked",
    elapsedMs,
    outcome: paidWhileHeld.rows[0]!.transition_outcome,
    finalLifecycle: paymentFinal.lifecycle_state,
    finalPaymentStatus: paymentFinal.status,
    confirmedPaidAt: paymentFinal.confirmed_paid_at,
    eventCount: paymentFinal.events,
  });
  assert.equal(paidWhileHeld.rows[0]!.transition_outcome, "late_payment");
  assert.equal(paymentFinal.lifecycle_state, "expired");
  assert.equal(paymentFinal.status, "received_after_expiry");
  assert.equal(paymentFinal.confirmed_paid_at, null);
  assert.equal(
    later.rows.some((row) => row.expired_booking_id === paymentFirst.booking),
    false,
  );
  await holder.end();
  await waiter.end();

  const compete = await world("in_house", false);
  const winner = await overlap(
    "two_success_events",
    compete,
    (session) => session.query(call, args(compete, "evt_conc_loser")),
    async (session) => {
      await session.query(call, args(compete, "evt_conc_winner"));
      await session.query("commit");
    },
    "evt_conc_winner",
  );
  assert.equal(winner.result.rows[0]!.transition_outcome, "ignored_after_settlement");
  const winnerEvent = await setup.query<{ n: number; confirmed: number }>(
    `select
       (select count(*)::int from sbg_stripe_events where event_id in ('evt_conc_winner', 'evt_conc_loser')) as n,
       (select count(*)::int from bookings where id = $1::uuid and lifecycle_state = 'confirmed_paid' and confirmed_paid_at is not null) as confirmed`,
    [compete.booking],
  );
  assert.equal(winnerEvent.rows[0]!.n, 2);
  assert.equal(winnerEvent.rows[0]!.confirmed, 1);
  assert.equal(winner.final.status, "paid");
  assert.equal(winner.final.lifecycle_state, "confirmed_paid");
  assert.ok(winner.final.confirmed_paid_at);

  const duplicate = await world("external", false);
  const duplicateRace = await overlap(
    "duplicate_event_id",
    duplicate,
    (session) => session.query(call, args(duplicate, "evt_conc_same")),
    async (session) => {
      await session.query(call, args(duplicate, "evt_conc_same"));
      await session.query("commit");
    },
    "evt_conc_same",
  );
  assert.equal(duplicateRace.outcome, "duplicate");
  assert.equal(duplicateRace.final.events, 1);
  assert.equal(duplicateRace.final.lifecycle_state, "confirmed_paid");
  assert.equal(duplicateRace.final.status, "paid");
  assert.ok(duplicateRace.final.confirmed_paid_at);

  const revoked = await world("external", false);
  const revokedRace = await overlap(
    "authority_revoked_while_waiting",
    revoked,
    (session) => session.query(call, args(revoked, "evt_conc_revoked")),
    async (session) => {
      await session.query(
        `update sbg_operator_provider_authorisations
            set revoked_at = clock_timestamp()
          where hotel_id = $1::uuid and provider_id = $2::uuid`,
        [revoked.hotel, revoked.provider],
      );
      await session.query("commit");
    },
    "evt_conc_revoked",
  );
  assert.equal(revokedRace.outcome, "authority_drift");
  assert.equal(revokedRace.final.events, 0);
  assert.equal(revokedRace.final.lifecycle_state, "awaiting_payment");
  assert.equal(revokedRace.final.status, "pending");
  assert.equal(revokedRace.final.confirmed_paid_at, null);

  const changed = await world("in_house", false);
  const changedRace = await overlap(
    "account_changed_while_waiting",
    changed,
    (session) => session.query(call, args(changed, "evt_conc_account")),
    async (session) => {
      await session.query(
        `update sbg_organisation_stripe_connections
            set stripe_account_id = 'acct_changed_while_waiting'
          where organisation_id = $1::uuid`,
        [changed.hotelOrg],
      );
      await session.query("commit");
    },
    "evt_conc_account",
  );
  assert.equal(changedRace.outcome, "authority_drift");
  assert.equal(changedRace.final.events, 0);
  assert.equal(changedRace.final.lifecycle_state, "awaiting_payment");
  assert.equal(changedRace.final.confirmed_paid_at, null);

  const backends = await setup.query<{ n: number }>(
    `select count(distinct pid)::int as n from pg_stat_activity where datname = current_database()`,
  );
  writeFileSync(
    EVIDENCE_PATH,
    JSON.stringify({ serverVersion, backendSample: backends.rows[0]!.n, cases: evidence }, null, 2),
  );
  console.log(JSON.stringify({ serverVersion, cases: evidence }));
  await setup.end();
});
