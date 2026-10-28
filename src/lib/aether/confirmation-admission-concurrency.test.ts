import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";

const { Client } = pg;
const ADMIN_URL = process.env.STAGE_E_PG_URL;
const EVIDENCE_PATH = "/tmp/stage-e-concurrency-evidence.json";

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
  "0064_gate2_paid_confirmation_admission.sql",
];

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

test("two mailer sessions cannot hold the same confirmation claim", async () => {
  if (!ADMIN_URL) assert.fail("CONCURRENCY GATE NOT PASSED: STAGE_E_PG_URL is unset");
  const adminUrl = new URL(ADMIN_URL);
  assertLocal(adminUrl);
  adminUrl.pathname = "/postgres";
  const admin = await connect(adminUrl.toString());
  const version = (await admin.query<{ version: string }>("select version()")).rows[0]!.version;
  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = 'stage_e_gate' and pid <> pg_backend_pid()`,
  );
  await admin.query("drop database if exists stage_e_gate");
  await admin.query("create database stage_e_gate");
  await admin.end();

  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = "/stage_e_gate";
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
  const hotelOrg = (
    await setup.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Hotel E', 'user-1', 'hotel') returning id`,
    )
  ).rows[0]!.id;
  const hotel = (
    await setup.query<{ id: string }>(
      `insert into hotels (code, name, organisation_id) values ('ce', 'Hotel E', $1::uuid) returning id`,
      [hotelOrg],
    )
  ).rows[0]!.id;
  await setup.query(
    `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity) values ($1::uuid, 'active', 1)`,
    [hotelOrg],
  );
  await setup.query(
    `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
     values ($1::uuid, $2::uuid, 'user-1')`,
    [hotelOrg, hotel],
  );
  const provider = (
    await setup.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('ce', 'Provider E', 'in_house') returning id`,
    )
  ).rows[0]!.id;
  await setup.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
    [hotel, provider],
  );
  await setup.query(
    `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode) values ($1::uuid, 'acct_legacy_ce', false)`,
    [hotel],
  );
  await setup.query(
    `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
     values ($1::uuid, 'acct_hotel_ce', false)`,
    [hotelOrg],
  );
  const booking = (
    await setup.query<{ id: string }>(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, pickup_text, destination_text,
         human_reference, confirmation_token
       ) values (
         $1::uuid, $2::uuid, '2026-01-15', '09:00', 60,
         'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport', 'EM-C', 'token-EM-C'
       ) returning id`,
      [hotel, provider],
    )
  ).rows[0]!.id;
  await setup.query(`select * from sbg_open_provisional_hold($1::uuid, 1800)`, [booking]);
  await setup.query(
    `insert into sbg_booking_payments (booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url)
     values ($1::uuid, 4500, 'EUR', 'cs_mail_c', 'https://checkout.stripe.test/session')`,
    [booking],
  );
  await setup.query(`select * from sbg_bind_payment_authority($1::uuid)`, [booking]);
  await setup.query(
    `update sbg_booking_payments set status = 'paid', paid_at = clock_timestamp() where booking_id = $1::uuid`,
    [booking],
  );
  await setup.query(
    `update bookings set lifecycle_state = 'confirmed_paid', confirmed_paid_at = clock_timestamp() where id = $1::uuid`,
    [booking],
  );

  const holder = await connect(dbUrl.toString());
  const waiter = await connect(dbUrl.toString());
  const observer = await connect(dbUrl.toString());
  const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const waiterPid = (await waiter.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  assert.notEqual(holderPid, waiterPid);
  await holder.query("begin");
  await holder.query("select id from bookings where id = $1::uuid for update", [booking]);
  const pending = waiter.query(`select * from sbg_claim_confirmation_email($1::uuid)`, [booking]);
  const started = Date.now();
  let waited: { wait_event_type: string; wait_event: string } | null = null;
  while (Date.now() - started < 4000) {
    const found = await observer.query<{ wait_event_type: string | null; wait_event: string | null }>(
      `select wait_event_type, wait_event from pg_stat_activity where pid = $1`,
      [waiterPid],
    );
    if (found.rows[0]?.wait_event_type === "Lock") {
      waited = { wait_event_type: "Lock", wait_event: found.rows[0]!.wait_event ?? "" };
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!waited) assert.fail("CONCURRENCY GATE NOT PASSED: the second mailer did not wait on a lock");
  const winner = await holder.query<{ email_outcome: string }>(
    `select * from sbg_claim_confirmation_email($1::uuid)`,
    [booking],
  );
  await holder.query("commit");
  const loser = await pending;
  const final = await setup.query<{ n: number; state: string; attempts: number }>(
    `select count(*)::int as n, max(state) as state, max(attempt_count) as attempts
       from sbg_confirmation_email_outbox where booking_id = $1::uuid`,
    [booking],
  );
  const evidence = {
    serverVersion: version,
    holderPid,
    waiterPid,
    independentConnections: true,
    waitEventType: waited.wait_event_type,
    waitEvent: waited.wait_event,
    winner: winner.rows[0]!.email_outcome,
    loser: loser.rows[0]!.email_outcome,
    rows: final.rows[0]!.n,
    state: final.rows[0]!.state,
    attempts: final.rows[0]!.attempts,
  };
  writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  assert.equal(winner.rows[0]!.email_outcome, "claimed");
  assert.equal(loser.rows[0]!.email_outcome, "claim_held");
  assert.equal(final.rows[0]!.n, 1);
  assert.equal(final.rows[0]!.state, "claimed");
  assert.equal(final.rows[0]!.attempts, 1);
  await holder.end();
  await waiter.end();
  await observer.end();
  await setup.end();
});
