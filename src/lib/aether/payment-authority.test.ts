import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  assessPaymentAuthorityEvent,
  bindPaymentAuthority,
  readPaymentAuthorityDrift,
  resolveExecutingPayee,
} from "./payment-authority.ts";

const SQL = readFileSync(
  new URL("../../../migrations/0062_gate2_executing_provider_payment_authority.sql", import.meta.url),
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
];

type Kind = "in_house" | "external";

type World = {
  hotelOrg: string;
  operatorOrg: string | null;
  hotel: string;
  provider: string;
  account: string;
  legacy: string;
  booking: string;
};

function dbOf(pg: PGlite) {
  return {
    query: async <T>(text: string, params?: unknown[]) => (await pg.query<T>(text, params)).rows,
  };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.equal(err instanceof Error ? err.message : String(err), code);
    return;
  }
  assert.fail(`expected ${code}`);
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
  return pg;
}

let seq = 0;

async function provision(
  pg: PGlite,
  kind: Kind,
  options?: { shareHotelAccount?: boolean },
): Promise<World> {
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
      [`h${n}`, `Hotel ${n}`, hotelOrg],
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity)
     values ($1::uuid, 'active', 1)`,
    [hotelOrg],
  );
  if (operatorOrg) {
    await pg.query(
      `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity)
       values ($1::uuid, 'active', 1)`,
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
      [`p${n}`, `Provider ${n}`, kind],
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
    [hotel, provider],
  );
  const legacy = `acct_legacy_${n}`;
  await pg.query(
    `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode) values ($1::uuid, $2, false)`,
    [hotel, legacy],
  );
  const account = options?.shareHotelAccount ? legacy : kind === "in_house" ? `acct_hotel_${n}` : `acct_operator_${n}`;
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
      [hotel, provider, `PT-${n}`, `token-PT-${n}`],
    )
  ).rows[0]!.id;
  return { hotelOrg, operatorOrg, hotel, provider, account, legacy, booking };
}

async function insertPayment(pg: PGlite, bookingId: string, session = "cs_test_bound"): Promise<string> {
  const rows = await pg.query<{ id: string }>(
    `insert into sbg_booking_payments (
       booking_id, amount_minor, currency, stripe_checkout_session_id, stripe_checkout_url
     ) values ($1::uuid, 4500, 'EUR', $2, 'https://checkout.stripe.test/session')
     returning id`,
    [bookingId, session],
  );
  return rows.rows[0]!.id;
}

test("0062 is source-only and does not replace the live payment functions", () => {
  const preflight = readFileSync(new URL("../../../scripts/production-db-preflight.mjs", import.meta.url), "utf8");
  assert.equal(preflight.includes("0062_gate2_executing_provider_payment_authority.sql"), false);
  assert.doesNotMatch(SQL, /pg_cron|cron\.schedule/);
  assert.doesNotMatch(SQL, /create or replace function public\.sbg_prepare_booking_payment/);
  assert.doesNotMatch(SQL, /create or replace function public\.sbg_apply_payment_event/);
  assert.doesNotMatch(SQL, /insert into (public\.)?sbg_stripe_events/);
  assert.match(SQL, /revoke all on function public\.sbg_expire_provisional_holds\(integer\) from aether_app/);
  const domainB = readFileSync(new URL("./domain-b-payment.ts", import.meta.url), "utf8");
  const guestPay = readFileSync(new URL("./guest-payment-fns.ts", import.meta.url), "utf8");
  const activation = readFileSync(new URL("./commercial-activation-assessment.ts", import.meta.url), "utf8");
  assert.match(domainB, /c\.hotel_id = b\.hotel_id/);
  assert.doesNotMatch(guestPay, /sbg_bind_payment_authority|assessPaymentAuthorityEvent/);
  assert.match(activation, /operationalActivationAllowed: false/);
});

test("hotel and operator payees resolve from the executing provider, not the hotel connection", async () => {
  const pg = await openDb();
  const db = dbOf(pg);
  const hotel = await provision(pg, "in_house");
  const hotelPayee = await resolveExecutingPayee(db, hotel.booking);
  assert.equal(hotelPayee.payeeKind, "hotel_in_house");
  assert.equal(hotelPayee.payeeOrganisationId, hotel.hotelOrg);
  assert.equal(hotelPayee.providerId, hotel.provider);
  assert.equal(hotelPayee.stripeAccountId, hotel.account);
  assert.notEqual(hotelPayee.stripeAccountId, hotel.legacy);

  const shared = await provision(pg, "in_house", { shareHotelAccount: true });
  const sharedPayee = await resolveExecutingPayee(db, shared.booking);
  assert.equal(sharedPayee.stripeAccountId, shared.legacy);
  assert.equal(sharedPayee.payeeOrganisationId, shared.hotelOrg);

  const operator = await provision(pg, "external");
  const operatorPayee = await resolveExecutingPayee(db, operator.booking);
  assert.equal(operatorPayee.payeeKind, "independent_operator");
  assert.equal(operatorPayee.payeeOrganisationId, operator.operatorOrg);
  assert.notEqual(operatorPayee.payeeOrganisationId, operator.hotelOrg);
  assert.equal(operatorPayee.stripeAccountId, operator.account);
  assert.notEqual(operatorPayee.stripeAccountId, operator.legacy);

  await assert.rejects(
    () =>
      pg.query(
        `update sbg_organisation_stripe_connections
            set stripe_account_id = $2
          where organisation_id = $1::uuid`,
        [operator.operatorOrg, operator.legacy],
      ),
    (err: unknown) => err instanceof Error && err.message.includes("hotel_account_not_payee"),
  );
  const args = await pg.query<{ args: string }>(
    `select pg_get_function_identity_arguments(oid) as args
       from pg_proc where proname = 'sbg_bind_payment_authority'`,
  );
  assert.equal(args.rows[0]!.args, "p_booking_id uuid");
  await pg.close();
});

test("missing authority fails closed and does not bind a payment", async () => {
  const pg = await openDb();
  const db = dbOf(pg);
  const cases: Array<{ kind: Kind; alter: (world: World) => Promise<void>; code: string }> = [
    {
      kind: "in_house",
      code: "inactive_agreement",
      alter: async (world) => {
        await pg.query("update hotel_provider_agreements set active = false where provider_id = $1::uuid", [
          world.provider,
        ]);
      },
    },
    {
      kind: "in_house",
      code: "licence_missing",
      alter: async (world) => {
        await pg.query(
          "update sbg_property_licence_allocations set released_at = allocated_at where hotel_id = $1::uuid",
          [world.hotel],
        );
      },
    },
    {
      kind: "in_house",
      code: "subscription_inactive",
      alter: async (world) => {
        await pg.query("update sbg_organisation_billing set status = 'trialing' where organisation_id = $1::uuid", [
          world.hotelOrg,
        ]);
      },
    },
    {
      kind: "external",
      code: "subscription_inactive",
      alter: async (world) => {
        await pg.query("update sbg_organisation_billing set status = 'past_due' where organisation_id = $1::uuid", [
          world.operatorOrg,
        ]);
      },
    },
    {
      kind: "in_house",
      code: "subscription_inactive",
      alter: async (world) => {
        await pg.query(
          "update sbg_organisation_billing set licensed_quantity = 0 where organisation_id = $1::uuid",
          [world.hotelOrg],
        );
      },
    },
    {
      kind: "external",
      code: "stripe_disconnected",
      alter: async (world) => {
        await pg.query(
          "update sbg_organisation_stripe_connections set disconnected_at = connected_at where organisation_id = $1::uuid",
          [world.operatorOrg],
        );
      },
    },
    {
      kind: "external",
      code: "grant_revoked",
      alter: async (world) => {
        await pg.query(
          "update sbg_operator_property_grants set revoked_at = granted_at where hotel_id = $1::uuid",
          [world.hotel],
        );
      },
    },
    {
      kind: "external",
      code: "authorisation_revoked",
      alter: async (world) => {
        await pg.query(
          "update sbg_operator_provider_authorisations set revoked_at = authorised_at where hotel_id = $1::uuid",
          [world.hotel],
        );
      },
    },
    {
      kind: "in_house",
      code: "ambiguous_authority",
      alter: async (world) => {
        await pg.query("update hotels set organisation_id = null where id = $1::uuid", [world.hotel]);
      },
    },
  ];
  for (const item of cases) {
    const world = await provision(pg, item.kind);
    await insertPayment(pg, world.booking, `cs_${world.booking}`);
    await item.alter(world);
    await expectCode(() => resolveExecutingPayee(db, world.booking), item.code);
    await expectCode(() => bindPaymentAuthority(db, world.booking), item.code);
    const bound = await pg.query<{ payee_stripe_account_id: string | null }>(
      "select payee_stripe_account_id from sbg_booking_payments where booking_id = $1::uuid",
      [world.booking],
    );
    assert.equal(bound.rows[0]!.payee_stripe_account_id, null);
  }

  const doubled = await provision(pg, "external");
  const second = (
    await pg.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Second operator', 'user-1', 'transfer_operator') returning id`,
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into sbg_operator_property_grants (operator_organisation_id, hotel_id, granted_by_user_id)
     values ($1::uuid, $2::uuid, 'user-1')`,
    [second, doubled.hotel],
  );
  await pg.query(
    `insert into sbg_operator_provider_authorisations
       (operator_organisation_id, hotel_id, provider_id, authorised_by_user_id)
     values ($1::uuid, $2::uuid, $3::uuid, 'user-1')`,
    [second, doubled.hotel, doubled.provider],
  );
  await expectCode(() => resolveExecutingPayee(db, doubled.booking), "ambiguous_authority");

  const mixed = await provision(pg, "in_house");
  const intruder = (
    await pg.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Intruder', 'user-1', 'transfer_operator') returning id`,
    )
  ).rows[0]!.id;
  await pg.query(
    `insert into sbg_operator_property_grants (operator_organisation_id, hotel_id, granted_by_user_id)
     values ($1::uuid, $2::uuid, 'user-1')`,
    [intruder, mixed.hotel],
  );
  await pg.query(
    `insert into sbg_operator_provider_authorisations
       (operator_organisation_id, hotel_id, provider_id, authorised_by_user_id)
     values ($1::uuid, $2::uuid, $3::uuid, 'user-1')`,
    [intruder, mixed.hotel, mixed.provider],
  );
  await expectCode(() => resolveExecutingPayee(db, mixed.booking), "ambiguous_authority");

  const bare = await provision(pg, "in_house");
  await expectCode(() => bindPaymentAuthority(db, bare.booking), "payment_attempt_missing");
  await pg.close();
});

test("a bound attempt keeps its account when the payee later changes", async () => {
  const pg = await openDb();
  const db = dbOf(pg);
  const world = await provision(pg, "external");
  const paymentId = await insertPayment(pg, world.booking, "cs_test_keep");
  const before = await pg.query<{
    amount_minor: number;
    currency: string;
    stripe_checkout_session_id: string;
    stripe_payment_intent_id: string | null;
    status: string;
    confirmation_token: string;
  }>(
    `select p.amount_minor, p.currency, p.stripe_checkout_session_id, p.stripe_payment_intent_id, p.status,
            b.confirmation_token
       from sbg_booking_payments p
       join bookings b on b.id = p.booking_id
      where p.id = $1::uuid`,
    [paymentId],
  );

  assert.equal((await assessPaymentAuthorityEvent(db, claim(world, paymentId))).toString(), "unbound");
  const first = await bindPaymentAuthority(db, world.booking);
  assert.equal(first.bindingState, "established");
  assert.equal(first.stripeAccountId, world.account);
  const second = await bindPaymentAuthority(db, world.booking);
  assert.equal(second.bindingState, "immutable");
  assert.equal(second.stripeAccountId, world.account);
  assert.equal(second.paymentId, first.paymentId);

  await pg.query(
    `update sbg_organisation_stripe_connections
        set stripe_account_id = 'acct_operator_later'
      where organisation_id = $1::uuid`,
    [world.operatorOrg],
  );
  const current = await resolveExecutingPayee(db, world.booking);
  assert.equal(current.stripeAccountId, "acct_operator_later");
  const again = await bindPaymentAuthority(db, world.booking);
  assert.equal(again.bindingState, "immutable");
  assert.equal(again.stripeAccountId, world.account);
  const drift = await readPaymentAuthorityDrift(db, world.booking);
  assert.equal(drift.state, "account_changed");
  assert.equal(drift.boundAccountId, world.account);
  assert.equal(drift.currentAccountId, "acct_operator_later");

  const replacement = (
    await pg.query<{ id: string }>(
      `insert into sbg_organisations (name, created_by_user_id, organisation_type)
       values ('Replacement', 'user-1', 'transfer_operator') returning id`,
    )
  ).rows[0]!.id;
  await pg.query(
    "update sbg_operator_provider_authorisations set revoked_at = authorised_at where operator_organisation_id = $1::uuid",
    [world.operatorOrg],
  );
  assert.equal((await readPaymentAuthorityDrift(db, world.booking)).state, "current_unresolved");
  await pg.query(
    `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity) values ($1::uuid, 'active', 1)`,
    [replacement],
  );
  await pg.query(
    `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
     values ($1::uuid, 'acct_replacement', false)`,
    [replacement],
  );
  await pg.query(
    `insert into sbg_operator_property_grants (operator_organisation_id, hotel_id, granted_by_user_id)
     values ($1::uuid, $2::uuid, 'user-1')`,
    [replacement, world.hotel],
  );
  await pg.query(
    `insert into sbg_operator_provider_authorisations
       (operator_organisation_id, hotel_id, provider_id, authorised_by_user_id)
     values ($1::uuid, $2::uuid, $3::uuid, 'user-1')`,
    [replacement, world.hotel, world.provider],
  );
  const moved = await readPaymentAuthorityDrift(db, world.booking);
  assert.equal(moved.state, "payee_changed");
  assert.equal(moved.boundOrganisationId, world.operatorOrg);
  assert.equal(moved.currentOrganisationId, replacement);

  const base = claim(world, paymentId);
  assert.equal(await assessPaymentAuthorityEvent(db, base), "matched");
  assert.equal(await assessPaymentAuthorityEvent(db, { ...base, currency: "eur" }), "matched");
  assert.equal(await assessPaymentAuthorityEvent(db, base), "matched");
  assert.equal(await assessPaymentAuthorityEvent(db, { ...base, accountId: world.legacy }), "hotel_account_not_payee");
  assert.equal(await assessPaymentAuthorityEvent(db, { ...base, accountId: "acct_operator_later" }), "wrong_account");
  assert.equal(await assessPaymentAuthorityEvent(db, { ...base, accountId: "acct_replacement" }), "wrong_account");
  assert.equal(await assessPaymentAuthorityEvent(db, { ...base, amountMinor: 4501 }), "amount");
  assert.equal(await assessPaymentAuthorityEvent(db, { ...base, currency: "usd" }), "currency");
  assert.equal(await assessPaymentAuthorityEvent(db, { ...base, sessionId: "cs_other" }), "session");
  assert.equal(
    await assessPaymentAuthorityEvent(db, { ...base, executingProviderId: world.hotelOrg }),
    "provider",
  );
  const other = await provision(pg, "external");
  assert.equal(await assessPaymentAuthorityEvent(db, { ...base, bookingId: other.booking }), "booking");

  const after = await pg.query<{
    amount_minor: number;
    currency: string;
    stripe_checkout_session_id: string;
    stripe_payment_intent_id: string | null;
    status: string;
    confirmation_token: string;
    payee_stripe_account_id: string;
    audits: number;
    events: number;
  }>(
    `select p.amount_minor, p.currency, p.stripe_checkout_session_id, p.stripe_payment_intent_id, p.status,
            b.confirmation_token, p.payee_stripe_account_id,
            (select count(*)::int from audit_events e where e.booking_id = b.id and e.action = 'payment_authority_bound') as audits,
            (select count(*)::int from sbg_stripe_events) as events
       from sbg_booking_payments p
       join bookings b on b.id = p.booking_id
      where p.id = $1::uuid`,
    [paymentId],
  );
  assert.deepEqual(
    {
      amount_minor: Number(after.rows[0]!.amount_minor),
      currency: after.rows[0]!.currency.trim(),
      stripe_checkout_session_id: after.rows[0]!.stripe_checkout_session_id,
      stripe_payment_intent_id: after.rows[0]!.stripe_payment_intent_id,
      status: after.rows[0]!.status,
      confirmation_token: after.rows[0]!.confirmation_token,
    },
    {
      amount_minor: Number(before.rows[0]!.amount_minor),
      currency: before.rows[0]!.currency.trim(),
      stripe_checkout_session_id: before.rows[0]!.stripe_checkout_session_id,
      stripe_payment_intent_id: before.rows[0]!.stripe_payment_intent_id,
      status: before.rows[0]!.status,
      confirmation_token: before.rows[0]!.confirmation_token,
    },
  );
  assert.equal(after.rows[0]!.payee_stripe_account_id, world.account);
  assert.equal(Number(after.rows[0]!.audits), 1);
  assert.equal(Number(after.rows[0]!.events), 0);

  const prepare = await pg.query<{ src: string }>(
    "select prosrc as src from pg_proc where proname = 'sbg_prepare_booking_payment'",
  );
  const apply = await pg.query<{ src: string }>(
    "select prosrc as src from pg_proc where proname = 'sbg_apply_payment_event'",
  );
  assert.match(prepare.rows[0]!.src, /sbg_stripe_connections/);
  assert.match(apply.rows[0]!.src, /insert into sbg_stripe_events/);
  await pg.close();
});

function claim(world: World, paymentId: string) {
  return {
    bookingId: world.booking,
    paymentId,
    executingProviderId: world.provider,
    accountId: world.account,
    sessionId: "cs_test_keep",
    amountMinor: 4500,
    currency: "EUR",
  };
}

test("application roles cannot redirect a payment or bulk-expire holds", async () => {
  const pg = await openDb();
  const db = dbOf(pg);
  const world = await provision(pg, "in_house");
  await insertPayment(pg, world.booking, "cs_role");
  const priv = await pg.query<{ app_bind: boolean; app_expire: boolean; runtime_resolve: boolean; app_update: boolean }>(
    `select
       has_function_privilege('aether_app', 'public.sbg_bind_payment_authority(uuid)', 'execute') as app_bind,
       has_function_privilege('aether_app', 'public.sbg_expire_provisional_holds(integer)', 'execute') as app_expire,
       has_function_privilege('aether_runtime', 'public.sbg_resolve_executing_payee(uuid)', 'execute') as runtime_resolve,
       has_table_privilege('aether_app', 'public.sbg_organisation_stripe_connections', 'update') as app_update`,
  );
  assert.equal(priv.rows[0]!.app_bind, true);
  assert.equal(priv.rows[0]!.app_expire, false);
  assert.equal(priv.rows[0]!.runtime_resolve, false);
  assert.equal(priv.rows[0]!.app_update, false);

  await pg.exec("set role aether_app");
  const bound = await bindPaymentAuthority(db, world.booking);
  assert.equal(bound.bindingState, "established");
  await assert.rejects(
    () => pg.query("select * from sbg_expire_provisional_holds(1)"),
    (err: unknown) => err instanceof Error && /permission denied/i.test(err.message),
  );
  await pg.exec("reset role");
  await pg.exec("grant select, update on table public.sbg_booking_payments to aether_runtime");
  await pg.exec("set role aether_runtime");
  await assert.rejects(
    () =>
      pg.query("update sbg_booking_payments set payee_stripe_account_id = 'acct_evil' where booking_id = $1::uuid", [
        world.booking,
      ]),
    (err: unknown) => err instanceof Error && err.message.includes("payment authority is not directly writable"),
  );
  await assert.rejects(
    () => pg.query("select * from sbg_resolve_executing_payee($1::uuid)", [world.booking]),
    (err: unknown) => err instanceof Error && /permission denied/i.test(err.message),
  );
  await pg.exec("reset role");
  const kept = await pg.query<{ payee_stripe_account_id: string }>(
    "select payee_stripe_account_id from sbg_booking_payments where booking_id = $1::uuid",
    [world.booking],
  );
  assert.equal(kept.rows[0]!.payee_stripe_account_id, world.account);
  await pg.close();
});

test("this file does not claim a multi-session preparation race", () => {
  assert.match(SQL, /from public\.bookings b\s+where b\.id = p_booking_id\s+for update/i);
  assert.match(SQL, /binding_state := 'immutable'/);
  assert.match(SQL, /Stage D must not call it/);
});
