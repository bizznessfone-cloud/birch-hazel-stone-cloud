/** Gate 2 isolated migration verification. No Neon, production or credentials. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { openCp272PaymentDb, insertAuthUser, OWNER_USER, OTHER_USER, ZERO_USER } from "./cp26a4-fixture.ts";

test("operator grant storage is deny-by-default and creates no access grants", async () => {
  const pg = await openCp272PaymentDb();
  try {
    const migrations = [
      "0031_cp3005e2c_organisation_type.sql",
      "0032_cp3005e2c1_organisation_acceptance.sql",
      "0033_cp3005e2d2b_founding_organisation.sql",
      "0034_cp3005e2d2c_founding_classification_acceptance.sql",
      "0035_cp3005e2d2d_founding_property.sql",
      "0036_cp3005e2d2d_founding_integrity.sql",
      "0037_gate2_founding_property_eligibility.sql",
      "0038_gate2_approved_agreement_acceptance.sql",
      "0039_gate2_operator_property_grants.sql",
      "0040_gate2_operator_property_access_read.sql",
      "0041_gate2_operator_property_grant_management.sql",
      "0042_gate2_operator_booking_summaries.sql",
      "0043_gate2_operator_provider_authorisations.sql",
      "0044_gate2_operator_provider_authorisation_management.sql",
      "0045_gate2_operator_provider_access_read.sql",
      "0046_gate2_operator_provider_booking_summaries.sql",
    ];
    for (const name of migrations) await pg.exec(readFileSync(`migrations/${name}`, "utf8"));
    const denied = await pg.query<{ allowed: boolean }>(
      "select public.sbg_operator_can_access_property_for_user($1, $2::uuid) as allowed",
      ["nonexistent-user", "11111111-1111-4111-8111-111111111111"],
    );
    assert.equal(denied.rows[0]?.allowed, false, "missing identity cannot gain access");
    const count = await pg.query<{ count: number }>("select count(*)::int as count from public.sbg_operator_property_grants");
    assert.equal(count.rows[0]?.count, 0, "migration must not create any implicit hotel/operator relationship");
    const policies = await pg.query<{ count: number }>(
      "select count(*)::int as count from pg_policies where schemaname = 'public' and tablename = 'sbg_operator_property_grants'",
    );
    assert.equal(policies.rows[0]?.count, 0, "no permissive RLS policy may be installed");
    const privileges = await pg.query<{ role: string; permitted: boolean }>(
      `select role, has_table_privilege(role, 'public.sbg_operator_property_grants', 'SELECT, INSERT, UPDATE, DELETE') as permitted
         from (values ('aether_app'), ('aether_runtime')) as r(role)`,
    );
    assert.ok(privileges.rows.every(row => row.permitted === false), "runtime roles must not access grant storage");
    const providerAuth = await pg.query<{ count: number }>(
      "select count(*)::int as count from public.sbg_operator_provider_authorisations",
    );
    assert.equal(providerAuth.rows[0]?.count, 0, "provider authorisations are never seeded");
    const providerPrivileges = await pg.query<{ role: string; permitted: boolean }>(
      `select role, has_table_privilege(role, 'public.sbg_operator_provider_authorisations',
        'SELECT, INSERT, UPDATE, DELETE') as permitted
        from (values ('aether_app'), ('aether_runtime')) as r(role)`,
    );
    assert.ok(providerPrivileges.rows.every(row => row.permitted === false),
      "runtime roles must not access operator/provider authorisations");
    const providerRls = await pg.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'public.sbg_operator_provider_authorisations'::regclass",
    );
    assert.equal(providerRls.rows[0]?.relrowsecurity, true, "provider authorisations require RLS");
    const rls = await pg.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'public.sbg_operator_property_grants'::regclass",
    );
    assert.equal(rls.rows[0]?.relrowsecurity, true);
  } finally {
    await pg.close();
  }
});

test("active grant allows only its operator; revocation removes access", async () => {
  const pg = await openCp272PaymentDb();
  try {
    for (const migration of [
      "0031_cp3005e2c_organisation_type.sql",
      "0032_cp3005e2c1_organisation_acceptance.sql",
      "0033_cp3005e2d2b_founding_organisation.sql",
      "0034_cp3005e2d2c_founding_classification_acceptance.sql",
      "0035_cp3005e2d2d_founding_property.sql",
      "0036_cp3005e2d2d_founding_integrity.sql",
      "0037_gate2_founding_property_eligibility.sql",
      "0038_gate2_approved_agreement_acceptance.sql",
      "0039_gate2_operator_property_grants.sql",
      "0040_gate2_operator_property_access_read.sql",
      "0041_gate2_operator_property_grant_management.sql",
      "0042_gate2_operator_booking_summaries.sql",
      "0043_gate2_operator_provider_authorisations.sql",
      "0044_gate2_operator_provider_authorisation_management.sql",
      "0045_gate2_operator_provider_access_read.sql",
      "0046_gate2_operator_provider_booking_summaries.sql",
    ]) await pg.exec(readFileSync(`migrations/${migration}`, "utf8"));
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    await insertAuthUser(pg, ZERO_USER);
    const ownerOrg = await pg.query<{ organisation_id: string }>(
      "select organisation_id::text as organisation_id from sbg_ensure_founding_organisation($1,$2)",
      [OWNER_USER.id, "Fixture Hotel Owner"],
    );
    await pg.query("select sbg_classify_founding_organisation($1,'hotel')", [OWNER_USER.id]);
    await pg.query(
      "insert into sbg_approved_property_agreement_versions(agreement_version,effective) values ('fixture-operator-access',true)",
    );
    await pg.query("select sbg_accept_approved_founding_agreement_for_user($1,$2)", [OWNER_USER.id, "fixture-operator-access"]);
    const hotel = await pg.query<{ hotel_id: string }>(
      "select hotel_id::text as hotel_id from sbg_create_founding_property_for_user($1,$2,$3,$4,$5,$6)",
      [OWNER_USER.id, "sbg-grant-test", "Grant Test Hotel", "Kos, Greece", "Europe/Athens", "EUR"],
    );
    const hotelId = hotel.rows[0]!.hotel_id;
    const operator = await pg.query<{ organisation_id: string }>(
      "select organisation_id::text as organisation_id from sbg_ensure_founding_organisation($1,$2)",
      [OTHER_USER.id, "Fixture Independent Operator"],
    );
    await pg.query("select sbg_classify_founding_organisation($1,'transfer_operator')", [OTHER_USER.id]);
    const operatorId = operator.rows[0]!.organisation_id;
    const check = async (userId: string) => {
      const result = await pg.query<{ allowed: boolean }>(
        "select sbg_operator_can_access_property_for_user($1,$2::uuid) as allowed", [userId, hotelId],
      );
      return result.rows[0]?.allowed;
    };
    // A second independently owned hotel is mandatory, never conditional.
    await pg.query(
      "select organisation_id from sbg_ensure_founding_organisation($1,$2)",
      [ZERO_USER.id, "Fixture Second Hotel Owner"],
    );
    await pg.query("select sbg_classify_founding_organisation($1,'hotel')", [ZERO_USER.id]);
    await pg.query("select sbg_accept_approved_founding_agreement_for_user($1,$2)", [ZERO_USER.id, "fixture-operator-access"]);
    const otherHotel = await pg.query<{ hotel_id: string }>(
      "select hotel_id::text as hotel_id from sbg_create_founding_property_for_user($1,$2,$3,$4,$5,$6)",
      [ZERO_USER.id, "sbg-other-grant-test", "Other Owner Hotel", "Rhodes, Greece", "Europe/Athens", "EUR"],
    );
    assert.equal(otherHotel.rows.length, 1, "a separate owner hotel must exist");
    const otherHotelId = otherHotel.rows[0]!.hotel_id;
    assert.notEqual(otherHotelId, hotelId);
    for (const enable of [true, false]) {
      await assert.rejects(
        pg.query(
          "select sbg_set_operator_property_grant_for_user($1,$2::uuid,$3::uuid,$4)",
          [OWNER_USER.id, otherHotelId, operatorId, enable],
        ),
        /operator grant not authorised/i,
        "a hotel owner cannot modify another hotel's operator grants",
      );
    }
    assert.equal(await check(OTHER_USER.id), false, "operator classification alone is not a grant");
    assert.equal(await check(OWNER_USER.id), false, "hotel owner is not an operator");
    await assert.rejects(
      pg.query("select sbg_set_operator_property_grant_for_user($1,$2::uuid,$3::uuid,true)", [OTHER_USER.id, hotelId, operatorId]),
      /operator grant not authorised/i,
    );
    await pg.query(
      "select sbg_set_operator_property_grant_for_user($1,$2::uuid,$3::uuid,true)",
      [OWNER_USER.id, hotelId, operatorId],
    );
    assert.equal(await check(OTHER_USER.id), true, "explicit active grant allows the operator");

    const providerForHotel = await pg.query<{ id: string }>(
      "select provider_id::text as id from hotel_provider_agreements where hotel_id = $1::uuid and active = true",
      [hotelId],
    );
    const providerForOtherHotel = await pg.query<{ id: string }>(
      "select provider_id::text as id from hotel_provider_agreements where hotel_id = $1::uuid and active = true",
      [otherHotelId],
    );
    const ownProvider = providerForHotel.rows[0]!.id;
    const otherProvider = providerForOtherHotel.rows[0]!.id;
    const setProvider = (userId: string, targetHotelId: string, targetProviderId: string, enabled: boolean) =>
      pg.query(
        "select sbg_set_operator_provider_authorisation_for_user($1,$2::uuid,$3::uuid,$4::uuid,$5)",
        [userId, targetHotelId, targetProviderId, operatorId, enabled],
      );
    await assert.rejects(setProvider(OTHER_USER.id, hotelId, ownProvider, true),
      /operator provider authorisation denied/i, "operator cannot self-authorise");
    await assert.rejects(setProvider(OWNER_USER.id, hotelId, otherProvider, true),
      /operator provider authorisation denied/i, "other hotel's provider is not eligible");
    await assert.rejects(setProvider(OWNER_USER.id, otherHotelId, otherProvider, true),
      /operator provider authorisation denied/i, "another hotel's owner must authorise");
    const canAccessProvider = async (userId: string, targetHotelId: string, targetProviderId: string) => {
      const result = await pg.query<{ allowed: boolean }>(
        "select sbg_operator_can_access_provider_for_user($1,$2::uuid,$3::uuid) as allowed",
        [userId, targetHotelId, targetProviderId],
      );
      return result.rows[0]?.allowed;
    };
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), false,
      "property grant does not imply provider access");
    await setProvider(OWNER_USER.id, hotelId, ownProvider, true);
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), true,
      "explicit provider authorisation allows only the matching provider");
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, otherProvider), false,
      "another hotel's provider remains inaccessible");
    assert.equal(await canAccessProvider(OWNER_USER.id, hotelId, ownProvider), false,
      "hotel owner cannot impersonate an operator");
    const authorised = await pg.query<{ count: number }>(
      "select count(*)::int as count from sbg_operator_provider_authorisations where hotel_id = $1::uuid and provider_id = $2::uuid and revoked_at is null",
      [hotelId, ownProvider],
    );
    assert.equal(authorised.rows[0]?.count, 1, "only specifically authorised provider is granted");
    // Provider-scoped projection is independent of the legacy hotel-only
    // draft, which must continue to return zero rows.
    const scopedQuery = (userId: string, targetHotelId: string, targetProviderId: string) =>
      pg.query<Record<string, unknown>>(
        "select * from sbg_list_operator_provider_booking_summaries_for_user($1,$2::uuid,$3::uuid,10)",
        [userId, targetHotelId, targetProviderId],
      );
    await assert.rejects(scopedQuery(OTHER_USER.id, hotelId, otherProvider),
      /operator provider booking access denied/i, "operator cannot query another provider");
    await assert.rejects(scopedQuery(OWNER_USER.id, hotelId, ownProvider),
      /operator provider booking access denied/i, "hotel owner cannot use operator projection");
    await setProvider(OWNER_USER.id, hotelId, ownProvider, false);
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), false,
      "revocation removes provider eligibility");
    const revoked = await pg.query<{ count: number }>(
      "select count(*)::int as count from sbg_operator_provider_authorisations where hotel_id = $1::uuid and provider_id = $2::uuid and revoked_at is null",
      [hotelId, ownProvider],
    );
    assert.equal(revoked.rows[0]?.count, 0, "provider-specific revocation takes effect");
    const canExecute = await pg.query<{ permitted: boolean }>(
      `select has_function_privilege('aether_app',
        'public.sbg_set_operator_provider_authorisation_for_user(text,uuid,uuid,uuid,boolean)', 'EXECUTE') as permitted`,
    );
    assert.equal(canExecute.rows[0]?.permitted, false, "application cannot issue provider grants");

    // Two real bookings make the result projection and hotel isolation observable.
    const insertBooking = async (targetHotelId: string, reference: string) => {
      const provider = await pg.query<{ id: string }>(
        "select provider_id::text as id from hotel_provider_agreements where hotel_id = $1::uuid and active = true order by provider_id limit 1", [targetHotelId],
      );
      assert.equal(provider.rows.length, 1, "founding hotel must have an executing provider");
      const result = await pg.query<{ id: string }>(
        `insert into bookings (
           hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
           guest_name, guest_phone, guest_email, passenger_count, luggage_count,
           pickup_text, destination_text, human_reference, confirmation_token
         ) values (
           $1::uuid, $4::uuid, date '2026-10-20', time '10:30', 90,
           'Private Guest', '+30000000000', 'private@sbg.test', 2, 1,
           'Hotel lobby', 'Airport', $2, $3
         ) returning id::text as id`,
        [targetHotelId, reference, `secret-${reference}`, provider.rows[0]!.id],
      );
      return result.rows[0]!.id;
    };
    await setProvider(OWNER_USER.id, hotelId, ownProvider, true);
    const providerSummaries = await scopedQuery(OTHER_USER.id, hotelId, ownProvider);
    assert.equal(providerSummaries.rows.length, 0, "no matching bookings exist yet");
    const ownBookingId = await insertBooking(hotelId, "PT-GRANT-OWN");
    await insertBooking(otherHotelId, "PT-GRANT-OTHER");

    const matching = await scopedQuery(OTHER_USER.id, hotelId, ownProvider);
    assert.equal(matching.rows.length, 1, "only executing-provider bookings are visible");
    assert.equal(matching.rows[0]?.bookingId, ownBookingId);
    assert.deepEqual(Object.keys(matching.rows[0]!).sort(), [
      "bookingId", "humanReference", "transferDate", "pickupTime",
      "passengerCount", "luggageCount", "pickupText", "destinationText", "cancelled",
    ].sort(), "provider summary excludes PII, tokens and payment data");
    const executable = await pg.query<{ permitted: boolean }>(
      `select has_function_privilege('aether_app',
        'public.sbg_list_operator_provider_booking_summaries_for_user(text,uuid,uuid,integer)', 'EXECUTE') as permitted`,
    );
    assert.equal(executable.rows[0]?.permitted, false, "app role cannot execute draft provider booking query");
    await setProvider(OWNER_USER.id, hotelId, ownProvider, false);
    await assert.rejects(scopedQuery(OTHER_USER.id, hotelId, ownProvider),
      /operator provider booking access denied/i, "revoked provider authorisation denies booking summaries");


    // The SQL query itself must deny ungranted identities and limit its
    // output to the approved projection; app role cannot execute it yet.
    await assert.rejects(
      pg.query("select * from sbg_list_operator_booking_summaries_for_user($1,$2::uuid,$3)", [OWNER_USER.id, hotelId, 10]),
      /operator booking access denied/i,
    );
    await assert.rejects(
      pg.query("select * from sbg_list_operator_booking_summaries_for_user($1,$2::uuid,$3)", [OTHER_USER.id, otherHotelId, 10]),
      /operator booking access denied/i,
    );
    const summaries = await pg.query<Record<string, unknown>>(
      "select * from sbg_list_operator_booking_summaries_for_user($1,$2::uuid,$3)",
      [OTHER_USER.id, hotelId, 10],
    );
    assert.equal(summaries.rows.length, 0, "hotel grant alone must not expose bookings without operator-to-provider assignment");
    assert.ok(ownBookingId, "fixture includes a real booking at the granted hotel");
    const execution = await pg.query<{ permitted: boolean }>(
      `select has_function_privilege('aether_app',
        'public.sbg_list_operator_booking_summaries_for_user(text,uuid,integer)', 'EXECUTE') as permitted`,
    );
    assert.equal(execution.rows[0]?.permitted, false, "application role must not execute unapproved booking query");

    assert.equal(await check(OWNER_USER.id), false, "grant does not transform hotel owner into operator");
    await pg.query(
      "select sbg_set_operator_property_grant_for_user($1,$2::uuid,$3::uuid,false)",
      [OWNER_USER.id, hotelId, operatorId],
    );
    assert.equal(await check(OTHER_USER.id), false, "revocation must immediately deny");
    // Reauthorisation is an explicit hotel-owner action, not automatic.
    await pg.query(
      "select sbg_set_operator_property_grant_for_user($1,$2::uuid,$3::uuid,true)",
      [OWNER_USER.id, hotelId, operatorId],
    );
    assert.equal(await check(OTHER_USER.id), true, "explicit regrant restores access");
    await pg.query(
      "update sbg_organisation_members set removed_at = now() where organisation_id = $1::uuid and user_id = $2",
      [operatorId, OTHER_USER.id],
    );
    assert.equal(await check(OTHER_USER.id), false, "removed operator membership must immediately deny");
    const activeGrant = await pg.query<{ count: number }>(
      "select count(*)::int as count from sbg_operator_property_grants where operator_organisation_id = $1::uuid and hotel_id = $2::uuid and revoked_at is null",
      [operatorId, hotelId],
    );
    assert.equal(activeGrant.rows[0]?.count, 1, "membership denial must not silently mutate grant records");
    assert.equal(ownerOrg.rows.length, 1);
  } finally {
    await pg.close();
  }
});
