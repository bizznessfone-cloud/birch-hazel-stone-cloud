/**
 * CP26A.4 — local SaaS tenant foundation: ownership, configured-not-live,
 * billing resolution, dormancy, Domain B non-regression, fixture policy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BookingError, createBooking, getPublicHotel, getPublicHotelBySlug } from "./booking.ts";
import {
  SaasCommerceError,
  assertDomainACommerceAllowed,
} from "./saas-commerce.server.ts";
import { createSubscriptionCheckout } from "./stripe.server.ts";
import {
  FIXTURE_HOTEL,
  LOCAL_FIXTURE_CODE_PREFIX,
  LOCAL_FIXTURE_EMAIL_DOMAIN,
  LOCAL_FIXTURE_EMAIL_PREFIX,
  LOCAL_FIXTURE_NAME_MARKER,
  OTHER_USER,
  OWNER_USER,
  SECOND_HOTEL,
  ZERO_USER,
  addDestinationForUser,
  applyBillingEvent,
  asBookingDb,
  createHotelForUser,
  createServiceForUser,
  hotelStatus,
  insertAuthUser,
  loadOwnedHotels,
  onboardConfiguredFixture,
  openCp26a4Db,
  promoteConfiguredForUser,
  saveConnectForUser,
  setBillingPriceForUser,
  syncEntitlement,
} from "./cp26a4-fixture.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const FOREIGN_HOTEL_ID = "00000000-0000-0000-0000-000000000099";

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function expectSqlFailure(fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn();
  } catch (err) {
    assert.match(errMessage(err), match);
    return err;
  }
  assert.fail(`expected SQL failure matching ${match}`);
}

async function expectBookingCode(fn: () => Promise<unknown>, code: BookingError["code"]) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof BookingError, `expected BookingError, got ${err}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

test("CP26A.4 local fixture identity is disposable and non-Production", () => {
  assert.equal(OWNER_USER.email.startsWith(LOCAL_FIXTURE_EMAIL_PREFIX), true);
  assert.equal(OWNER_USER.email.endsWith(`@${LOCAL_FIXTURE_EMAIL_DOMAIN}`), true);
  assert.equal(FIXTURE_HOTEL.code.startsWith(LOCAL_FIXTURE_CODE_PREFIX), true);
  assert.match(FIXTURE_HOTEL.name, new RegExp(LOCAL_FIXTURE_NAME_MARKER.replace(/[[\]]/g, "\\$&")));
  assert.doesNotMatch(OWNER_USER.email, /scan-book-go|gmail|demo-kos/i);
  assert.notEqual(FIXTURE_HOTEL.code, "demo-kos");
  assert.notEqual(FIXTURE_HOTEL.code, "gate");
  assert.notEqual(FIXTURE_HOTEL.code, "harbor");
  assert.doesNotMatch(read("src/lib/aether/cp26a4-fixture.ts"), /sbg-verify|AETHER_DATABASE_OWNER_URL|sk_live|STRIPE_SECRET_KEY/);
  assert.doesNotMatch(read("src/routes/app.onboarding.tsx"), /cp26a4-fixture/);
  assert.doesNotMatch(read("src/routes/app.billing.tsx"), /cp26a4-fixture/);
  assert.doesNotMatch(read("src/lib/aether/onboarding-fns.ts"), /cp26a4-fixture/);
  assert.doesNotMatch(read("src/lib/aether/stripe-fns.ts"), /cp26a4-fixture/);
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["test:aether"], /cp26a4\.test\.ts/);
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkg.scripts.build, /cp26a4/);
});

test("CP26A.4 user creates owned unconfigured hotel; foreign user is denied", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    const created = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
    const status = await hotelStatus(pg, created.hotelId);
    assert.equal(status, "unconfigured");

    const links = await pg.query<{ user_id: string; hotel_id: string }>(
      "select user_id, hotel_id from app_hotel_accounts where hotel_id = $1::uuid",
      [created.hotelId],
    );
    assert.equal(links.rows.length, 1);
    assert.equal(links.rows[0]!.user_id, OWNER_USER.id);
    assert.equal(links.rows[0]!.hotel_id, created.hotelId);

    const owned = await loadOwnedHotels(pg, OWNER_USER.id);
    assert.equal(owned.length, 1);
    assert.equal(owned[0]!.id, created.hotelId);
    assert.equal(owned[0]!.code, FIXTURE_HOTEL.code);
    assert.equal(owned[0]!.status, "unconfigured");

    const otherView = await loadOwnedHotels(pg, OTHER_USER.id);
    assert.deepEqual(otherView, []);

    const denied = await expectSqlFailure(
      () => createServiceForUser(pg, OTHER_USER.id, created.hotelId, "Hijack"),
      /hotel is not owned by account/i,
    );
    assert.equal(errCode(denied), "42501");

    await expectSqlFailure(
      () => addDestinationForUser(pg, OTHER_USER.id, created.hotelId, "airport", "Stolen", 1000),
      /hotel is not owned by account/i,
    );
    await expectSqlFailure(
      () => promoteConfiguredForUser(pg, OTHER_USER.id, created.hotelId),
      /hotel is not owned by account/i,
    );
    await expectSqlFailure(
      () => setBillingPriceForUser(pg, OTHER_USER.id, created.hotelId, "price_sbg_test"),
      /hotel ownership mismatch/i,
    );
    await expectSqlFailure(
      () => createServiceForUser(pg, OWNER_USER.id, FOREIGN_HOTEL_ID, "Nope"),
      /hotel is not owned by account/i,
    );
    await expectSqlFailure(
      () => setBillingPriceForUser(pg, OWNER_USER.id, FOREIGN_HOTEL_ID, "price_sbg_test"),
      /hotel ownership mismatch/i,
    );
  } finally {
    await pg.close();
  }
});

test("CP26A.4 onboarding reaches configured and not live", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const created = await createHotelForUser(pg, OWNER_USER.id, FIXTURE_HOTEL);
    assert.equal(await hotelStatus(pg, created.hotelId), "unconfigured");

    const serviceId = await createServiceForUser(pg, OWNER_USER.id, created.hotelId, FIXTURE_HOTEL.serviceName);
    const destinationId = await addDestinationForUser(
      pg,
      OWNER_USER.id,
      created.hotelId,
      FIXTURE_HOTEL.destinationKind,
      FIXTURE_HOTEL.destinationName,
      FIXTURE_HOTEL.amountMinor,
    );
    const agreements = await pg.query<{ n: string }>(
      "select count(*)::text as n from hotel_provider_agreements where hotel_id = $1::uuid and active",
      [created.hotelId],
    );
    assert.equal(Number(agreements.rows[0]!.n), 1);
    assert.ok(serviceId);
    assert.ok(destinationId);

    const promoted = await promoteConfiguredForUser(pg, OWNER_USER.id, created.hotelId);
    assert.equal(promoted, true);
    assert.equal(await hotelStatus(pg, created.hotelId), "configured");
    assert.notEqual(await hotelStatus(pg, created.hotelId), "live");

    const provision = read("src/lib/aether/provision.ts");
    assert.match(provision, /promoteHotelToLive/);
    assert.doesNotMatch(read("src/lib/aether/cp26a4-fixture.ts"), /promoteHotelToLive/);
  } finally {
    await pg.close();
  }
});

test("CP26A.4 entitlement and billing/Connect cannot publish the fixture live", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");

    assert.equal(await syncEntitlement(pg, fixture.hotelId), "configured");
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");

    await setBillingPriceForUser(pg, OWNER_USER.id, fixture.hotelId, "price_sbg_test_basic");
    await applyBillingEvent(pg, fixture.hotelId, "active");
    await saveConnectForUser(pg, OWNER_USER.id, fixture.hotelId, "acct_sbg_test_fixture", false);

    assert.equal(await syncEntitlement(pg, fixture.hotelId), "configured");
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");

    const billing = await pg.query<{ status: string }>(
      "select status from sbg_billing_accounts where hotel_id = $1::uuid",
      [fixture.hotelId],
    );
    assert.equal(billing.rows[0]!.status, "active");
    const connect = await pg.query<{ disconnected_at: string | null }>(
      "select disconnected_at from sbg_stripe_connections where hotel_id = $1::uuid",
      [fixture.hotelId],
    );
    assert.equal(connect.rows[0]!.disconnected_at, null);
  } finally {
    await pg.close();
  }
});

test("CP26A.4 configured fixture is not publicly bookable; slug is not a live gate", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    const db = asBookingDb(pg);
    const owned = await loadOwnedHotels(pg, OWNER_USER.id);
    assert.ok(owned[0]!.public_slug.length > 0);

    await expectBookingCode(() => getPublicHotel(db, FIXTURE_HOTEL.code), "hotel_not_live");
    await expectBookingCode(() => getPublicHotelBySlug(db, owned[0]!.public_slug), "hotel_not_live");
    await expectBookingCode(
      () =>
        createBooking(db, {
          hotelCode: FIXTURE_HOTEL.code,
          destinationId: fixture.destinationId,
          transferDate: "2026-01-15",
          pickupTime: "09:00",
          durationMinutes: 60,
          guestName: "Ada Guest",
          guestPhone: "+302101234567",
          guestEmail: "ada@example.com",
          passengerCount: 2,
          luggageCount: 1,
          pickupText: "SBG Test Kos",
        }),
      "hotel_not_live",
    );

    const preview = read("src/routes/app.hotels.$hotelId.preview.tsx");
    assert.match(preview, /getOnboardingState/);
    assert.match(preview, /preview/);
    const guestBook = read("src/components/aether/guest-book.tsx");
    assert.match(guestBook, /nextDisabled=\{props\.preview/);
    assert.match(guestBook, /This is a preview\. No booking will be created/);
    const qr = read("src/routes/app.hotels.$hotelId.qr.tsx");
    assert.match(qr, /public_slug/);
  } finally {
    await pg.close();
  }
});

test("CP26A.4 billing ownership resolves configured-not-live hotel; live and Connect are not required", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    await insertAuthUser(pg, ZERO_USER);
    const fixture = await onboardConfiguredFixture(pg, OWNER_USER.id);
    assert.equal(await hotelStatus(pg, fixture.hotelId), "configured");

    await setBillingPriceForUser(pg, OWNER_USER.id, fixture.hotelId, "price_sbg_test_basic");
    const billing = await pg.query<{
      stripe_customer_id: string | null;
      stripe_price_id: string | null;
      status: string;
    }>(
      "select stripe_customer_id, stripe_price_id, status from sbg_billing_accounts where hotel_id = $1::uuid",
      [fixture.hotelId],
    );
    assert.equal(billing.rows[0]!.stripe_price_id, "price_sbg_test_basic");
    assert.equal(billing.rows[0]!.status, "inactive");

    const connection = await pg.query(
      "select stripe_account_id from sbg_stripe_connections where hotel_id = $1::uuid",
      [fixture.hotelId],
    );
    assert.equal(connection.rows.length, 0);

    const second = await createHotelForUser(pg, OWNER_USER.id, SECOND_HOTEL);
    await setBillingPriceForUser(pg, OWNER_USER.id, second.hotelId, "price_sbg_test_pro");
    const prices = await pg.query<{ hotel_id: string; stripe_price_id: string | null }>(
      "select hotel_id, stripe_price_id from sbg_billing_accounts where hotel_id = any($1::uuid[])",
      [[fixture.hotelId, second.hotelId]],
    );
    const byHotel = Object.fromEntries(prices.rows.map((row) => [row.hotel_id, row.stripe_price_id]));
    assert.equal(byHotel[fixture.hotelId], "price_sbg_test_basic");
    assert.equal(byHotel[second.hotelId], "price_sbg_test_pro");

    const owned = await loadOwnedHotels(pg, OWNER_USER.id);
    assert.equal(owned.length, 2);
    assert.equal(owned[0]!.code, FIXTURE_HOTEL.code);
    assert.equal(owned[1]!.code, SECOND_HOTEL.code);

    const zeroHotels = await loadOwnedHotels(pg, ZERO_USER.id);
    assert.deepEqual(zeroHotels, []);
    await expectSqlFailure(
      () => setBillingPriceForUser(pg, ZERO_USER.id, fixture.hotelId, "price_sbg_test_basic"),
      /hotel ownership mismatch/i,
    );
    await expectSqlFailure(
      () => setBillingPriceForUser(pg, OWNER_USER.id, FOREIGN_HOTEL_ID, "price_sbg_test_basic"),
      /hotel ownership mismatch/i,
    );
    await expectSqlFailure(
      () => setBillingPriceForUser(pg, OTHER_USER.id, fixture.hotelId, "price_sbg_test_basic"),
      /hotel ownership mismatch/i,
    );

    const stripeFns = read("src/lib/aether/stripe-fns.ts");
    assert.match(stripeFns, /select hotel_id as id from app_hotel_accounts where user_id = \$1 and hotel_id = \$2::uuid/);
    assert.match(stripeFns, /getBillingState/);
    assert.doesNotMatch(stripeFns, /hotels\.status|hotel_not_live|status === ['"]live['"]/);
    assert.doesNotMatch(stripeFns, /promoteHotelToLive/);
    const billingRoute = read("src/routes/app.billing.tsx");
    assert.match(billingRoute, /hotelId: z\.string\(\)\.uuid\(\)/);
    assert.match(billingRoute, /Select a hotel first/);
    assert.doesNotMatch(billingRoute, /hotels\[0\]/);
  } finally {
    await pg.close();
  }
});

test("CP26A.4 Domain A Checkout remains fail-closed before any Stripe network", async () => {
  const cases: Array<{ commerce?: string; key?: string }> = [
    {},
    { commerce: "off", key: "sk_test_cp26a4" },
    { commerce: "nope", key: "sk_test_cp26a4" },
    { key: "sk_live_cp26a4_placeholder" },
    { commerce: "test", key: "sk_live_cp26a4_placeholder" },
  ];
  for (const row of cases) {
    const env: NodeJS.Dict<string> = {};
    if (row.commerce !== undefined) env.SBG_SAAS_COMMERCE = row.commerce;
    if (row.key !== undefined) env.STRIPE_SECRET_KEY = row.key;
    assert.throws(() => assertDomainACommerceAllowed(env), SaasCommerceError);
  }

  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("network must not run");
  }) as typeof fetch;
  const prevCommerce = process.env.SBG_SAAS_COMMERCE;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  try {
    delete process.env.SBG_SAAS_COMMERCE;
    process.env.STRIPE_SECRET_KEY = "sk_live_cp26a4_placeholder";
    await assert.rejects(
      () =>
        createSubscriptionCheckout({
          priceId: "price_test",
          hotelId: FOREIGN_HOTEL_ID,
          userId: OWNER_USER.id,
          successUrl: "https://scan-book-go.vercel.app/app/billing?checkout=success",
          cancelUrl: "https://scan-book-go.vercel.app/app/billing?checkout=cancel",
        }),
      SaasCommerceError,
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevCommerce === undefined) delete process.env.SBG_SAAS_COMMERCE;
    else process.env.SBG_SAAS_COMMERCE = prevCommerce;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevKey;
  }
});

test("CP26A.4 Domain B guest payments stay separate from Domain A and publication", () => {
  const guestFns = read("src/lib/aether/guest-payment-fns.ts");
  const stripe = read("src/lib/aether/stripe.server.ts");
  const paymentSql = read("migrations/0021_cp25_hotel_guest_payments.sql");
  const commerce = read("src/lib/aether/saas-commerce.server.ts");
  const entitlement = read("migrations/0023_cp26a2_entitlement_publication_decoupling.sql");

  assert.match(guestFns, /sbg_prepare_booking_payment/);
  assert.doesNotMatch(guestFns, /sbg_billing_accounts/);
  assert.doesNotMatch(guestFns, /SBG_SAAS_COMMERCE|assertDomainACommerceAllowed/);
  assert.match(stripe, /createGuestTransferCheckout/);
  const guestFn = stripe.slice(stripe.indexOf("export async function createGuestTransferCheckout"));
  assert.match(guestFn, /Stripe-Account|accountId/);
  assert.doesNotMatch(guestFn, /assertDomainACommerceAllowed/);
  assert.doesNotMatch(guestFn, /application_fee/);
  assert.doesNotMatch(paymentSql, /application_fee/);
  assert.doesNotMatch(paymentSql, /update hotels set status/i);
  assert.doesNotMatch(commerce, /sbg_booking_payments/);
  const body = entitlement.slice(entitlement.indexOf("as $$"), entitlement.lastIndexOf("$$"));
  assert.doesNotMatch(body, /sbg_booking_payments/);
  assert.doesNotMatch(body, /sbg_billing_accounts/);
});

test("CP26A.4 local SaaS fixture does not disturb demo-kos or seeded hotels", async () => {
  const pg = await openCp26a4Db();
  try {
    await insertAuthUser(pg, OWNER_USER);
    const seeded = await pg.query<{ code: string; status: string }>(
      "select code, status from hotels where code in ('gate', 'harbor') order by code",
    );
    assert.deepEqual(
      seeded.rows.map((row) => [row.code, row.status]),
      [
        ["gate", "unconfigured"],
        ["harbor", "unconfigured"],
      ],
    );

    const demo = await pg.query<{ id: string }>(
      `insert into hotels (code, name, locality, iana_timezone, currency, status)
       values ('demo-kos', 'Aether Demo Hotel', 'Kos', 'Europe/Athens', 'EUR', 'live')
       returning id`,
    );
    const demoId = demo.rows[0]!.id;
    await pg.query(
      `insert into hotel_destinations (hotel_id, kind, name, sort_order, amount_minor, active)
       values ($1::uuid, 'airport', 'KOS', 10, 4500, true)`,
      [demoId],
    );

    await onboardConfiguredFixture(pg, OWNER_USER.id);

    const after = await pg.query<{ code: string; status: string }>(
      "select code, status from hotels where code in ('demo-kos', 'gate', 'harbor', $1) order by code",
      [FIXTURE_HOTEL.code],
    );
    const map = Object.fromEntries(after.rows.map((row) => [row.code, row.status]));
    assert.equal(map["demo-kos"], "live");
    assert.equal(map.gate, "unconfigured");
    assert.equal(map.harbor, "unconfigured");
    assert.equal(map[FIXTURE_HOTEL.code], "configured");

    const db = asBookingDb(pg);
    const publicDemo = await getPublicHotel(db, "demo-kos");
    assert.equal(publicDemo.code, "demo-kos");
    await expectBookingCode(() => getPublicHotel(db, FIXTURE_HOTEL.code), "hotel_not_live");

    const accounts = await pg.query<{ code: string }>(
      `select h.code from app_hotel_accounts aha
         join hotels h on h.id = aha.hotel_id
        where aha.user_id = $1`,
      [OWNER_USER.id],
    );
    assert.deepEqual(
      accounts.rows.map((row) => row.code),
      [FIXTURE_HOTEL.code],
    );
  } finally {
    await pg.close();
  }
});

test("CP26A.4 fixture policy document records the three classes and CP26C risk", () => {
  const policy = read("docs/FIXTURE_POLICY.md");
  assert.match(policy, /LOCAL \/ TEST/);
  assert.match(policy, /verify-\*@sbg\.test/);
  assert.match(policy, /sbg-test-\*/);
  assert.match(policy, /PRODUCTION VERIFICATION/);
  assert.match(policy, /exactly one operator identity/);
  assert.match(policy, /not live/);
  assert.match(policy, /password manager/);
  assert.match(policy, /never pasted into chat\/Grok/);
  assert.match(policy, /OPERATIONAL DEMO/);
  assert.match(policy, /demo-kos/);
  assert.match(policy, /`SBG_SAAS_COMMERCE=test` is \*\*process-global\*\*/);
  assert.match(policy, /established CP26A\.5/);
  assert.doesNotMatch(policy, /sk_live_|postgres:\/\//);
});
