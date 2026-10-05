/**
 * CP27.2 — 0030 repairs sbg_prepare_booking_payment. PGLite only.
 * No Production connection. No Stripe API. No commerce change.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { OWNER_USER, createHotelForUser, insertAuthUser, openCp26finDb } from "./cp26a4-fixture.ts";

const root = process.cwd();
const MIGRATION = "0030_cp272_fix_prepare_booking_payment.sql";
const SQL = readFileSync(join(root, "migrations", MIGRATION), "utf8");
const PRIOR = readFileSync(join(root, "migrations/0021_cp25_hotel_guest_payments.sql"), "utf8");
const MIGRATION_0029 = readFileSync(join(root, "migrations/0029_cp272_domain_a_checkout_claims.sql"), "utf8");

type PaymentRow = {
  payment_id: string;
  booking_id: string;
  hotel_id: string;
  stripe_account_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  checkout_session_id: string | null;
  checkout_url: string | null;
};

async function rejects(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(run, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, pattern);
    return true;
  });
}

async function prepare(pg: PGlite, token: string): Promise<PaymentRow> {
  const rows = await pg.query<PaymentRow>("select * from sbg_prepare_booking_payment($1)", [token]);
  const row = rows.rows[0];
  if (!row) throw new Error("prepare returned no row");
  return row;
}

async function insertBooking(
  pg: PGlite,
  hotelId: string,
  providerId: string,
  token: string,
  reference: string,
  amount: number | null,
): Promise<string> {
  const rows = await pg.query<{ id: string }>(
    `insert into bookings (
       hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
       guest_name, guest_phone, guest_email, pickup_text, destination_text,
       human_reference, confirmation_token, quoted_amount_minor, quoted_currency
     ) values (
       $1::uuid, $2::uuid, '2026-06-20', '09:00', 60,
       'Guest', '+300000000', 'guest@sbg.test', 'Hotel', 'Airport',
       $3, $4, $5, case when $5::int is null then null else 'EUR' end
     ) returning id::text`,
    [hotelId, providerId, reference, token, amount],
  );
  const id = rows.rows[0]?.id;
  if (!id) throw new Error("booking was not inserted");
  return id;
}

test("0030 is accepted history and does not edit 0021 or Domain A", () => {
  const preflight = readFileSync(join(root, "scripts/production-db-preflight.mjs"), "utf8");
  assert.equal(
    createHash("sha256").update(SQL).digest("hex"),
    "9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f",
  );
  assert.match(preflight, /AUTHORISED_PENDING = \[\];/);
  assert.match(preflight, /"0031_cp3005e2c_organisation_type.sql",\n\];/);
  assert.match(PRIOR, /returning id, booking_id, amount_minor, currency, status, stripe_checkout_session_id, stripe_checkout_url/);
  assert.match(SQL, /public\.sbg_booking_payments\.booking_id/);
  assert.match(SQL, /#variable_conflict use_column/);
  assert.match(SQL, /set search_path = pg_catalog, public/);
  assert.match(SQL, /t\.quoted_amount_minor, t\.quoted_currency/);
  assert.doesNotMatch(SQL, /amount_minor\s*=/);
  assert.doesNotMatch(SQL, /currency\s*=/);
  assert.doesNotMatch(SQL, /create table/i);
  assert.doesNotMatch(SQL, /sbg_domain_a_checkout_claims/);
  assert.doesNotMatch(SQL, /update\s+hotels/i);
  assert.doesNotMatch(SQL, /sbg_organisation_billing/);
  assert.doesNotMatch(SQL, /sbg_property_licence_allocations/);
  assert.doesNotMatch(SQL, /sk_live_|STRIPE_SECRET|DATABASE_URL|AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(SQL, /grant\s+(insert|update|delete)/i);
});

test("0030 removes 42702 and preserves the 0021 payment contract", async () => {
  const pg = await openCp26finDb();
  try {
    await pg.exec(MIGRATION_0029);
    await insertAuthUser(pg, OWNER_USER);
    const hotel = await createHotelForUser(pg, OWNER_USER.id, {
      code: "sbg-test-pay30",
      name: "SBG Pay 0030 [TEST]",
      locality: "Kos",
      ianaTimezone: "Europe/Athens",
      currency: "EUR",
    });
    const beforeStatus = (
      await pg.query<{ status: string }>("select status from hotels where id = $1::uuid", [hotel.hotelId])
    ).rows[0]!.status;
    await pg.query(
      `insert into sbg_stripe_connections (hotel_id, stripe_account_id, livemode)
       values ($1::uuid, 'acct_pay30', false)`,
      [hotel.hotelId],
    );
    const bookingId = await insertBooking(pg, hotel.hotelId, hotel.providerId, "cp30-token", "CP30-1", 4200);
    await rejects(
      () => pg.query("select * from sbg_prepare_booking_payment($1)", ["cp30-token"]),
      /42702|column reference "booking_id" is ambiguous/,
    );
    assert.equal(
      (await pg.query<{ n: number }>("select count(*)::int as n from sbg_booking_payments")).rows[0]!.n,
      0,
    );

    const before = await snapshot(pg);
    const privilegesBefore = await privilegesOf(pg);
    await pg.exec(SQL);
    const afterMigration = await snapshot(pg);
    assert.deepEqual(afterMigration, before);
    const privilegesAfter = await privilegesOf(pg);
    assert.deepEqual(privilegesAfter, privilegesBefore);
    assert.equal(privilegesAfter.sel, true);
    assert.equal(privilegesAfter.ins, false);
    assert.equal(privilegesAfter.upd, false);
    assert.equal(privilegesAfter.del, false);
    assert.equal(privilegesAfter.pub, false);
    assert.equal(privilegesAfter.app, true);
    assert.equal(privilegesAfter.rt, true);
    assert.equal(privilegesAfter.rtIns, true);
    assert.equal(
      (await pg.query<{ status: string }>("select status from hotels where id = $1::uuid", [hotel.hotelId])).rows[0]!.status,
      beforeStatus,
    );

    const first = await prepare(pg, "cp30-token");
    assert.equal(first.booking_id, bookingId);
    assert.equal(first.hotel_id, hotel.hotelId);
    assert.equal(first.stripe_account_id, "acct_pay30");
    assert.equal(Number(first.amount_minor), 4200);
    assert.equal(String(first.currency).trim(), "EUR");
    assert.equal(first.status, "pending");
    assert.equal(first.checkout_session_id, null);
    assert.equal(first.checkout_url, null);

    await pg.exec("set role aether_app");
    const second = await prepare(pg, "cp30-token");
    await pg.exec("reset role");
    assert.equal(second.payment_id, first.payment_id);
    assert.equal(second.status, "pending");
    assert.equal(second.checkout_session_id, null);
    assert.equal(Number(second.amount_minor), 4200);
    assert.equal(String(second.currency).trim(), "EUR");
    assert.equal(
      (await pg.query<{ n: number }>("select count(*)::int as n from sbg_booking_payments")).rows[0]!.n,
      1,
    );

    await pg.query(
      `update sbg_booking_payments
          set status = 'pending',
              stripe_checkout_session_id = 'cs_keep',
              stripe_checkout_url = 'https://checkout.stripe.test/keep',
              stripe_payment_intent_id = 'pi_keep'
        where id = $1::uuid`,
      [first.payment_id],
    );
    const kept = await prepare(pg, "cp30-token");
    assert.equal(kept.status, "pending");
    assert.equal(kept.checkout_session_id, "cs_keep");
    assert.equal(kept.checkout_url, "https://checkout.stripe.test/keep");
    assert.equal(Number(kept.amount_minor), 4200);

    for (const status of ["failed", "expired", "canceled"] as const) {
      await pg.query(
        `update sbg_booking_payments
            set status = $2,
                stripe_checkout_session_id = 'cs_old',
                stripe_checkout_url = 'https://checkout.stripe.test/old',
                stripe_payment_intent_id = 'pi_old'
          where id = $1::uuid`,
        [first.payment_id, status],
      );
      const reset = await prepare(pg, "cp30-token");
      assert.equal(reset.payment_id, first.payment_id);
      assert.equal(reset.status, "pending");
      assert.equal(reset.checkout_session_id, null);
      assert.equal(reset.checkout_url, null);
      assert.equal(Number(reset.amount_minor), 4200);
      const stored = (
        await pg.query<{ intent: string | null }>(
          "select stripe_payment_intent_id as intent from sbg_booking_payments where id = $1::uuid",
          [first.payment_id],
        )
      ).rows[0]!;
      assert.equal(stored.intent, null);
    }

    await pg.query(
      `update sbg_booking_payments
          set status = 'paid',
              stripe_checkout_session_id = 'cs_paid',
              stripe_checkout_url = 'https://checkout.stripe.test/paid',
              stripe_payment_intent_id = 'pi_paid',
              paid_at = now()
        where id = $1::uuid`,
      [first.payment_id],
    );
    const paid = await prepare(pg, "cp30-token");
    assert.equal(paid.status, "paid");
    assert.equal(paid.checkout_session_id, "cs_paid");
    assert.equal(paid.checkout_url, "https://checkout.stripe.test/paid");

    await rejects(() => prepare(pg, "missing-token"), /booking payment unavailable/);
    await pg.query("update bookings set cancelled_at = now() where id = $1::uuid", [bookingId]);
    await rejects(() => prepare(pg, "cp30-token"), /booking payment unavailable/);
    const paidStill = (
      await pg.query<{ status: string }>("select status from sbg_booking_payments where id = $1::uuid", [first.payment_id])
    ).rows[0]!;
    assert.equal(paidStill.status, "paid");

    await insertBooking(pg, hotel.hotelId, hotel.providerId, "cp30-bare", "CP30-BARE", null);
    await rejects(() => prepare(pg, "cp30-bare"), /booking payment unavailable/);
    await insertBooking(pg, hotel.hotelId, hotel.providerId, "cp30-zero", "CP30-ZERO", 0);
    await rejects(() => prepare(pg, "cp30-zero"), /booking payment unavailable/);
    await insertBooking(pg, hotel.hotelId, hotel.providerId, "cp30-disc", "CP30-DISC", 1800);
    await pg.query("update sbg_stripe_connections set disconnected_at = now() where hotel_id = $1::uuid", [hotel.hotelId]);
    await rejects(() => prepare(pg, "cp30-disc"), /booking payment unavailable/);
    assert.equal(
      (await pg.query<{ n: number }>("select count(*)::int as n from sbg_booking_payments")).rows[0]!.n,
      1,
    );

    await rejects(
      () =>
        pg.query(
          "insert into sbg_booking_payments (booking_id, amount_minor, currency) values ($1::uuid, 1800, 'EUR')",
          [bookingId],
        ),
      /23505|duplicate key/,
    );

    const privileges = await privilegesOf(pg);
    assert.equal(privileges.sel, true);
    assert.equal(privileges.ins, false);
    assert.equal(privileges.upd, false);
    assert.equal(privileges.del, false);
    assert.equal(privileges.pub, false);
    assert.equal(privileges.app, true);
    assert.equal(privileges.rt, true);
    assert.equal(privileges.rtIns, privilegesBefore.rtIns);

    const definition = (
      await pg.query<{ def: string; cfg: string }>(
        `select pg_get_functiondef('public.sbg_prepare_booking_payment(text)'::regprocedure) as def,
                proconfig::text as cfg
           from pg_proc
          where proname = 'sbg_prepare_booking_payment'`,
      )
    ).rows[0]!;
    assert.match(definition.def, /public\.sbg_booking_payments\.booking_id/);
    assert.match(definition.def, /#variable_conflict use_column/);
    assert.match(definition.cfg, /search_path=pg_catalog, public/);
    assert.equal(
      (await pg.query<{ status: string }>("select status from hotels where id = $1::uuid", [hotel.hotelId])).rows[0]!.status,
      beforeStatus,
    );
    assert.equal((await snapshot(pg)).claims, 0);
    assert.equal((await snapshot(pg)).licensed, 0);
    assert.equal((await snapshot(pg)).allocations, 0);
  } finally {
    await pg.close();
  }
});

async function privilegesOf(pg: PGlite) {
  const row = (
    await pg.query<{
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
      pub: boolean;
      app: boolean;
      rt: boolean;
      rtIns: boolean;
    }>(
      `select
         has_table_privilege('aether_app', 'public.sbg_booking_payments', 'SELECT') as sel,
         has_table_privilege('aether_app', 'public.sbg_booking_payments', 'INSERT') as ins,
         has_table_privilege('aether_app', 'public.sbg_booking_payments', 'UPDATE') as upd,
         has_table_privilege('aether_app', 'public.sbg_booking_payments', 'DELETE') as del,
         has_function_privilege('public', 'public.sbg_prepare_booking_payment(text)', 'EXECUTE') as pub,
         has_function_privilege('aether_app', 'public.sbg_prepare_booking_payment(text)', 'EXECUTE') as app,
         has_function_privilege('aether_runtime', 'public.sbg_prepare_booking_payment(text)', 'EXECUTE') as rt,
         has_table_privilege('aether_runtime', 'public.sbg_booking_payments', 'INSERT') as "rtIns"`,
    )
  ).rows[0];
  if (!row) throw new Error("privilege probe returned no row");
  return row;
}

async function snapshot(pg: PGlite) {
  const licensed = await pg.query<{ n: number }>(
    "select coalesce(sum(licensed_quantity), 0)::int as n from sbg_organisation_billing",
  );
  const allocations = await pg.query<{ n: number }>(
    "select count(*)::int as n from sbg_property_licence_allocations",
  );
  const claims = await pg.query<{ n: number }>("select count(*)::int as n from sbg_domain_a_checkout_claims");
  const payments = await pg.query<{ n: number }>("select count(*)::int as n from sbg_booking_payments");
  return {
    licensed: licensed.rows[0]!.n,
    allocations: allocations.rows[0]!.n,
    claims: claims.rows[0]!.n,
    payments: payments.rows[0]!.n,
  };
}
