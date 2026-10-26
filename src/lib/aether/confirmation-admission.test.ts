import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  claimPaidConfirmation,
  deliverPaidConfirmation,
  readPaidConfirmationPayload,
} from "./confirmation-admission.ts";

const SQL = readFileSync(
  new URL("../../../migrations/0064_gate2_paid_confirmation_admission.sql", import.meta.url),
  "utf8",
);

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

type Kind = "in_house" | "external";

type World = {
  hotelOrg: string;
  operatorOrg: string | null;
  provider: string;
  booking: string;
  payment: string;
};

function dbOf(pg: PGlite) {
  return {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
  };
}

async function openDb(): Promise<PGlite> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  await pg.exec("create role aether_app nologin");
  await pg.exec("create role aether_runtime nologin");
  for (const name of CHAIN) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  await pg.exec(
    `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
     values ('user-1','Ada','ada@example.com',true,now(),now())`,
  );
  await pg.exec("grant select, update (vehicle_id, driver_id) on bookings to aether_app");
  return pg;
}

let seq = 0;

async function provision(pg: PGlite, kind: Kind): Promise<World> {
  const n = ++seq;
  const hotelOrg = (
    await pg.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ($1, 'user-1', 'hotel') returning id`,
      [`Hotel ${n}`],
    )
  ).rows[0]!.id;
  const operatorOrg =
    kind === "external"
      ? (
          await pg.query<{ id: string }>(
            `insert into sbg_organisations (name, created_by_user_id, organisation_type)
             values ($1, 'user-1', 'transfer_operator') returning id`,
            [`Operator ${n}`],
          )
        ).rows[0]!.id
      : null;
  const hotel = (
    await pg.query<{ id: string }>(
      `insert into hotels (code, name, organisation_id) values ($1, $2, $3::uuid) returning id`,
      [`e${n}`, `Hotel ${n}`, hotelOrg],
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity) values ($1::uuid, 'active', 1)`,
    [hotelOrg],
  );
  if (operatorOrg) {
    await pg.query(
      `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity) values ($1::uuid, 'active', 1)`,
      [operatorOrg],
    );
  }
  await pg.query(
    `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
     values ($1::uuid, $2::uuid, 'user-1')`,
    [hotelOrg, hotel],
  );
  const provider = (
    await pg.query<{ id: string }>(
      `insert into providers (code, name, kind) values ($1, $2, $3) returning id`,
      [`e${n}`, `Provider ${n}`, kind],
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
    [hotel, provider],
  );
  const account = kind === "in_house" ? `acct_hotel_e${n}` : `acct_operator_e${n}`;
  await pg.query(
    `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode) values ($1::uuid, $2, false)`,
    [hotel, `acct_legacy_e${n}`],
  );
  await pg.query(
    `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
     values ($1::uuid, $2, false)`,
    [kind === "in_house" ? hotelOrg : operatorOrg, account],
  );
  if (operatorOrg) {
    await pg.query(
      `insert into sbg_operator_property_grants (operator_organisation_id, hotel_id, granted_by_user_id)
       values ($1::uuid, $2::uuid, 'user-1')`,
      [operatorOrg, hotel],
    );
    await pg.query(
      `insert into sbg_operator_provider_authorisations
         (operator_organisation_id, hotel_id, provider_id, authorised_by_user_id)
       values ($1::uuid, $2::uuid, $3::uuid, 'user-1')`,
      [operatorOrg, hotel, provider],
    );
  }
  const booking = (
    await pg.query<{ id: string }>(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, pickup_text, destination_text,
         human_reference, confirmation_token
       ) values (
         $1::uuid, $2::uuid, '2026-01-15', '09:00', 60,
         'Ada Guest', '+302101234567', 'ada@example.com', 'Lobby', 'Airport', $3, $4
       ) returning id`,
      [hotel, provider, `EM-${n}`, `token-EM-${n}`],
    )
  ).rows[0]!.id;
  await pg.query(`select * from sbg_open_provisional_hold($1::uuid, 1800)`, [booking]);
  const payment = (
    await pg.query<{ id: string }>(
      `insert into sbg_booking_payments (
         booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url
       ) values ($1::uuid, 4500, 'EUR', $2, 'https://checkout.stripe.test/session')
       returning id`,
      [booking, `cs_mail_${n}`],
    )
  ).rows[0]!.id;
  await pg.query(`select * from sbg_bind_payment_authority($1::uuid)`, [booking]);
  return { hotelOrg, operatorOrg, provider, booking, payment };
}

async function markPaid(pg: PGlite, world: World): Promise<void> {
  await pg.query(
    `update sbg_booking_payments set status = 'paid', paid_at = clock_timestamp() where id = $1::uuid`,
    [world.payment],
  );
  await pg.query(
    `update bookings set lifecycle_state = 'confirmed_paid', confirmed_paid_at = clock_timestamp() where id = $1::uuid`,
    [world.booking],
  );
}

async function asMailer<T>(pg: PGlite, fn: () => Promise<T>): Promise<T> {
  await pg.exec("set role aether_mailer");
  try {
    return await fn();
  } finally {
    await pg.exec("reset role");
  }
}

async function vehicle(pg: PGlite, providerId: string, name: string): Promise<string> {
  const rows = await pg.query<{ id: string }>(
    `insert into vehicles (name, owned_by_provider_id, operated_by_provider_id)
     values ($1, $2::uuid, $2::uuid) returning id`,
    [name, providerId],
  );
  return rows.rows[0]!.id;
}

async function driver(pg: PGlite, providerId: string, name: string): Promise<string> {
  const rows = await pg.query<{ id: string }>(
    `insert into drivers (name, employed_by_provider_id, dispatched_by_provider_id)
     values ($1, $2::uuid, $2::uuid) returning id`,
    [name, providerId],
  );
  return rows.rows[0]!.id;
}

test("0064 is source-only and guest creation does not send mail", () => {
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  const guest = readFileSync(new URL("./guest-create.ts", import.meta.url), "utf8");
  const admission = readFileSync(new URL("./confirmation-admission.ts", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../../routes/api/stripe/webhook.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../../routes/confirmed.$token.tsx", import.meta.url), "utf8");
  assert.equal(preflight.includes("0064_gate2_paid_confirmation_admission.sql"), false);
  assert.doesNotMatch(SQL, /pg_cron|cron\.schedule/);
  assert.doesNotMatch(SQL, /create or replace function public\.sbg_apply_payment_event/);
  assert.doesNotMatch(guest, /sendConfirmationEmail/);
  assert.match(guest, /assertGuestCreateRateLimit/);
  assert.doesNotMatch(admission, /api\.resend\.com|sendConfirmationEmail/);
  assert.doesNotMatch(webhook, /sbg_claim_confirmation_email|sbg_accept_verified_payment_event/);
  assert.doesNotMatch(page, /Your transfer is booked/);
  assert.match(page, /startGuestPayment/);
  assert.match(page, /guestCanStartPayment/);
  assert.doesNotMatch(page, /payment=success/);
  assert.match(SQL, /legacy_unreconciled/);
});

test("only one live claim is issued, and unpaid lifecycles are refused", async () => {
  const pg = await openDb();
  const db = dbOf(pg);
  const paid = await provision(pg, "in_house");
  await markPaid(pg, paid);
  const first = await asMailer(pg, () => claimPaidConfirmation(db, paid.booking));
  assert.equal(first.outcome, "claimed");
  assert.equal(first.attemptCount, 1);
  assert.ok(first.claimToken);
  const payload = await asMailer(pg, () => readPaidConfirmationPayload(db, first.claimToken!));
  assert.equal(payload?.recipient, "ada@example.com");
  assert.match(payload?.reference ?? "", /^EM-/);
  const held = await asMailer(pg, () => claimPaidConfirmation(db, paid.booking));
  assert.equal(held.outcome, "claim_held");
  assert.equal(held.claimToken, null);
  const rows = await pg.query<{ n: number }>(
    `select count(*)::int as n from sbg_confirmation_email_outbox where booking_id = $1::uuid`,
    [paid.booking],
  );
  assert.equal(rows.rows[0]!.n, 1);

  const delivered = await asMailer(pg, () =>
    deliverPaidConfirmation(db, paid.booking, async () => "sent"),
  );
  assert.equal(delivered.outcome, "claim_held");
  assert.equal(delivered.result, null);

  await pg.query(
    `update sbg_confirmation_email_outbox set claim_expires_at = clock_timestamp() - interval '1 second'
      where booking_id = $1::uuid`,
    [paid.booking],
  );
  const failed = await asMailer(pg, () =>
    deliverPaidConfirmation(db, paid.booking, async () => {
      throw new Error("provider down");
    }),
  );
  assert.equal(failed.outcome, "reclaimed");
  assert.equal(failed.result, "failed");
  assert.equal(failed.attemptCount, 2);
  const audit = await pg.query<{ n: number }>(
    `select count(*)::int as n from audit_events
      where booking_id = $1::uuid and action = 'confirmation_email_result'`,
    [paid.booking],
  );
  assert.equal(audit.rows[0]!.n, 1);
  const retry = await asMailer(pg, () =>
    deliverPaidConfirmation(db, paid.booking, async () => "sent"),
  );
  assert.equal(retry.outcome, "retry");
  assert.equal(retry.result, "sent");
  const again = await asMailer(pg, () => claimPaidConfirmation(db, paid.booking));
  assert.equal(again.outcome, "already_sent");
  assert.equal(await asMailer(pg, () => readPaidConfirmationPayload(db, retry.claimToken!)), null);

  const refused: Array<[string, string]> = [
    ["awaiting_payment", "pending"],
    ["payment_processing", "pending"],
    ["expired", "pending"],
    ["failed", "failed"],
    ["cancelled", "paid"],
    ["refunded", "paid"],
    ["legacy_unreconciled", "paid"],
  ];
  for (const [lifecycle, status] of refused) {
    const world = await provision(pg, "external");
    if (lifecycle === "legacy_unreconciled") {
      await pg.query(
        `update bookings set lifecycle_state = 'legacy_unreconciled', hold_expires_at = null where id = $1::uuid`,
        [world.booking],
      );
    } else if (lifecycle === "confirmed_paid") {
      await markPaid(pg, world);
    } else if (lifecycle === "cancelled" || lifecycle === "refunded") {
      await markPaid(pg, world);
      await pg.query(`update bookings set lifecycle_state = $2 where id = $1::uuid`, [world.booking, lifecycle]);
    } else {
      await pg.query(`update bookings set lifecycle_state = $2 where id = $1::uuid`, [world.booking, lifecycle]);
    }
    if (status !== "pending") {
      await pg.query(`update sbg_booking_payments set status = $2 where id = $1::uuid`, [world.payment, status]);
    }
    const result = await asMailer(pg, () => claimPaidConfirmation(db, world.booking));
    assert.equal(result.outcome, "email_not_admitted", lifecycle);
    assert.equal(result.claimToken, null);
  }

  await pg.exec("set role aether_app");
  await assert.rejects(() => claimPaidConfirmation(db, paid.booking), /permission denied/);
  await pg.exec("reset role");
  const privileges = await pg.query<{ mailer: boolean; app: boolean; runtime: boolean; write: boolean }>(
    `select
       has_function_privilege('aether_mailer', 'public.sbg_claim_confirmation_email(uuid)', 'execute') as mailer,
       has_function_privilege('aether_app', 'public.sbg_claim_confirmation_email(uuid)', 'execute') as app,
       has_function_privilege('aether_runtime', 'public.sbg_claim_confirmation_email(uuid)', 'execute') as runtime,
       has_table_privilege('aether_mailer', 'public.sbg_confirmation_email_outbox', 'insert') as write`,
  );
  assert.equal(privileges.rows[0]!.mailer, true);
  assert.equal(privileges.rows[0]!.app, false);
  assert.equal(privileges.rows[0]!.runtime, false);
  assert.equal(privileges.rows[0]!.write, false);
  const resultShape = await pg.query<{ result: string }>(
    `select pg_get_function_result(oid) as result
       from pg_proc where proname = 'sbg_claim_confirmation_email'`,
  );
  assert.match(resultShape.rows[0]!.result, /email_outcome/);
  assert.doesNotMatch(resultShape.rows[0]!.result, /guest|recipient|email_address/);
  await pg.close();
});

test("dispatch admits only a paid authorised booking and keeps GiST", async () => {
  const pg = await openDb();
  const unpaid = await provision(pg, "in_house");
  const van = await vehicle(pg, unpaid.provider, "Van unpaid");
  await assert.rejects(
    () => pg.query(`update bookings set vehicle_id = $1::uuid where id = $2::uuid`, [van, unpaid.booking]),
    /dispatch_not_admitted/,
  );
  await pg.exec("set role aether_app");
  await assert.rejects(
    () => pg.query(`update bookings set vehicle_id = $1::uuid where id = $2::uuid`, [van, unpaid.booking]),
    /dispatch_not_admitted|permission denied/,
  );
  await pg.exec("reset role");
  assert.equal(
    (await pg.query<{ vehicle_id: string | null }>(`select vehicle_id from bookings where id = $1::uuid`, [unpaid.booking]))
      .rows[0]!.vehicle_id,
    null,
  );

  const legacy = await provision(pg, "in_house");
  await pg.query(
    `update bookings set lifecycle_state = 'legacy_unreconciled', hold_expires_at = null where id = $1::uuid`,
    [legacy.booking],
  );
  const legacyVan = await vehicle(pg, legacy.provider, "Van legacy");
  await pg.query(`update bookings set vehicle_id = $1::uuid where id = $2::uuid`, [legacyVan, legacy.booking]);
  const otherProvider = (
    await pg.query<{ id: string }>(
      `insert into providers (code, name, kind) values ('other-e', 'Other', 'external') returning id`,
    )
  ).rows[0]!.id;
  const foreign = await vehicle(pg, otherProvider, "Foreign");
  await assert.rejects(
    () => pg.query(`update bookings set vehicle_id = $1::uuid where id = $2::uuid`, [foreign, legacy.booking]),
    /dispatch_not_admitted/,
  );

  const paid = await provision(pg, "external");
  await markPaid(pg, paid);
  const own = await vehicle(pg, paid.provider, "Van paid");
  await pg.query(`update bookings set vehicle_id = $1::uuid where id = $2::uuid`, [own, paid.booking]);
  await pg.query(
    `update sbg_operator_provider_authorisations set revoked_at = clock_timestamp()
      where provider_id = $1::uuid`,
    [paid.provider],
  );
  const second = await driver(pg, paid.provider, "Pat revoked");
  await assert.rejects(
    () => pg.query(`update bookings set driver_id = $1::uuid where id = $2::uuid`, [second, paid.booking]),
    /dispatch_not_admitted/,
  );
  await pg.query(`update bookings set vehicle_id = null where id = $1::uuid`, [paid.booking]);
  assert.equal(
    (await pg.query<{ vehicle_id: string | null }>(`select vehicle_id from bookings where id = $1::uuid`, [paid.booking]))
      .rows[0]!.vehicle_id,
    null,
  );

  const cancelled = await provision(pg, "in_house");
  await markPaid(pg, cancelled);
  await pg.query(`update bookings set cancelled_at = clock_timestamp() where id = $1::uuid`, [cancelled.booking]);
  const cancelledVan = await vehicle(pg, cancelled.provider, "Van cancelled");
  await assert.rejects(
    () => pg.query(`update bookings set vehicle_id = $1::uuid where id = $2::uuid`, [cancelledVan, cancelled.booking]),
    /dispatch_not_admitted/,
  );

  const left = await provision(pg, "in_house");
  await markPaid(pg, left);
  const shared = await vehicle(pg, left.provider, "Van shared");
  await pg.query(`update bookings set vehicle_id = $1::uuid where id = $2::uuid`, [shared, left.booking]);
  const twin = (
    await pg.query<{ id: string }>(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, pickup_text, destination_text,
         human_reference, confirmation_token, lifecycle_state, hold_expires_at, confirmed_paid_at
       )
       select hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
              guest_name, guest_phone, 'ada-2@example.com', pickup_text, destination_text,
              human_reference || 'B', confirmation_token || 'B', 'confirmed_paid', hold_expires_at, confirmed_paid_at
         from bookings where id = $1::uuid
       returning id`,
      [left.booking],
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into sbg_booking_payments (
       booking_id, amount_minor, currency, status, paid_at, stripe_checkout_session_id,
       executing_provider_id, payee_organisation_id, payee_stripe_account_id, payee_kind, authority_bound_at
     )
     select $2::uuid, amount_minor, currency, status, paid_at, stripe_checkout_session_id || 'B',
            executing_provider_id, payee_organisation_id, payee_stripe_account_id, payee_kind, authority_bound_at
       from sbg_booking_payments where booking_id = $1::uuid`,
    [left.booking, twin],
  );
  await assert.rejects(
    () => pg.query(`update bookings set vehicle_id = $1::uuid where id = $2::uuid`, [shared, twin]),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return !message.includes("dispatch_not_admitted") && (message.includes("23P01") || /exclusion|overlap|occupies/i.test(message));
    },
  );
  await pg.close();
});
