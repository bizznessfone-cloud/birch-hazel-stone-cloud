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
      "0047_gate2_property_revoke_cascades_provider_authorisations.sql",
      "0048_gate2_operator_property_list_read.sql",
      "0049_gate2_operator_provider_activation_read.sql",
      "0050_gate2_operator_identity_lookup.sql",
      "0051_gate2_provider_authorisation_app_execute.sql",
      "0052_gate2_approved_agreement_documents.sql",
      "0053_gate2_atomic_approved_agreement_acceptance.sql",
      "0054_gate2_commercial_onboarding_snapshot.sql",
      "0055_gate2_shared_approved_agreement_acceptance.sql",
      "0056_gate2_commercial_billing_evidence.sql",
      "0057_gate2_operator_property_licence_allocation.sql",
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
      "0047_gate2_property_revoke_cascades_provider_authorisations.sql",
      "0048_gate2_operator_property_list_read.sql",
      "0049_gate2_operator_provider_activation_read.sql",
      "0050_gate2_operator_identity_lookup.sql",
      "0051_gate2_provider_authorisation_app_execute.sql",
      "0052_gate2_approved_agreement_documents.sql",
      "0053_gate2_atomic_approved_agreement_acceptance.sql",
      "0054_gate2_commercial_onboarding_snapshot.sql",
      "0055_gate2_shared_approved_agreement_acceptance.sql",
      "0056_gate2_commercial_billing_evidence.sql",
      "0057_gate2_operator_property_licence_allocation.sql",
    ]) await pg.exec(readFileSync(`migrations/${migration}`, "utf8"));
    await insertAuthUser(pg, OWNER_USER);
    await insertAuthUser(pg, OTHER_USER);
    await insertAuthUser(pg, ZERO_USER);
    const ownerOrg = await pg.query<{ organisation_id: string }>(
      "select organisation_id::text as organisation_id from sbg_ensure_founding_organisation($1,$2)",
      [OWNER_USER.id, "Fixture Hotel Owner"],
    );
    await pg.query("select sbg_classify_founding_organisation($1,'hotel')", [OWNER_USER.id]);
    // Test-only approved document fixture: no production/legal publication.
    const fixtureText = "Offline agreement fixture; not legal terms";
    const fixtureHash = (await pg.query<{ digest: string }>(
      "select encode(sha256(convert_to($1,'UTF8')),'hex') as digest", [fixtureText],
    )).rows[0]!.digest;
    await pg.query(
      "insert into sbg_approved_property_agreement_versions(agreement_version,effective) values ('fixture-operator-access',false)",
    );
    await pg.query(
      "insert into sbg_approved_agreement_documents(agreement_version,document_text,document_sha256) values ($1,$2,$3)",
      ["fixture-operator-access", fixtureText, fixtureHash],
    );
    await pg.query(
      "update sbg_approved_property_agreement_versions set effective = true where agreement_version = 'fixture-operator-access'",
    );
    await pg.query(
      "select sbg_accept_approved_founding_agreement_for_user($1,$2,$3)",
      [OWNER_USER.id, "fixture-operator-access", fixtureHash],
    );
    // Document integrity and atomic acceptance: reject stale/tampered evidence.
    await assert.rejects(
      pg.query("select sbg_accept_approved_founding_agreement_for_user($1,$2,$3)",
        [OWNER_USER.id, "fixture-operator-access", "0".repeat(64)]),
      /approved agreement unavailable or changed/i,
    );
    await assert.rejects(
      pg.query("select sbg_accept_approved_founding_agreement_for_user($1,$2,$3)",
        [OWNER_USER.id, "terms-v1", fixtureHash]),
      /approved agreement unavailable or changed/i,
    );
    const currentDocument = await pg.query<{ agreement_version: string; document_sha256: string }>(
      "select agreement_version, document_sha256 from sbg_read_effective_founding_agreement()",
    );
    assert.deepEqual(currentDocument.rows.map(r => ({ agreement_version: r.agreement_version, document_sha256: r.document_sha256 })),
      [{ agreement_version: "fixture-operator-access", document_sha256: fixtureHash }]);
    await assert.rejects(
      pg.query("update sbg_approved_agreement_documents set document_text = 'tampered' where agreement_version = 'fixture-operator-access'"),
      /published agreement documents are immutable/i,
    );
    const noVersionOnlyPrivilege = await pg.query<{ allowed: boolean }>(
      "select has_function_privilege('aether_app','public.sbg_accept_approved_founding_agreement_for_user(text,text)','EXECUTE') as allowed",
    );
    assert.equal(noVersionOnlyPrivilege.rows[0]?.allowed, false, "version-only acceptance must be unavailable to app role");

    const hotel = await pg.query<{ hotel_id: string }>(
      "select hotel_id::text as hotel_id from sbg_create_founding_property_for_user($1,$2,$3,$4,$5,$6)",
      [OWNER_USER.id, "sbg-grant-test", "Grant Test Hotel", "Kos, Greece", "Europe/Athens", "EUR"],
    );
    const hotelId = hotel.rows[0]!.hotel_id;
    const hotelCommercial = await pg.query<{
      organisation_exists: boolean; organisation_type: string;
      approved_agreement_accepted: boolean; accessible_property_count: number;
    }>("select * from sbg_commercial_founding_snapshot_for_user($1)", [OWNER_USER.id]);
    assert.deepEqual(hotelCommercial.rows, [{
      organisation_exists: true, organisation_type: "hotel",
      approved_agreement_accepted: true, accessible_property_count: 1,
    }], "hotel founder sees its own one property and approved agreement");

    const operator = await pg.query<{ organisation_id: string }>(
      "select organisation_id::text as organisation_id from sbg_ensure_founding_organisation($1,$2)",
      [OTHER_USER.id, "Fixture Independent Operator"],
    );
    await pg.query("select sbg_classify_founding_organisation($1,'transfer_operator')", [OTHER_USER.id]);
    const operatorId = operator.rows[0]!.organisation_id;
    const resolveOperator = async (userId: string, targetHotelId: string, targetOperatorId: string) =>
      (await pg.query<{ operator_organisation_id: string; operator_name: string }>(
        "select operator_organisation_id::text, operator_name from sbg_resolve_operator_for_hotel_owner($1,$2::uuid,$3::uuid)",
        [userId, targetHotelId, targetOperatorId],
      )).rows;
    assert.deepEqual(await resolveOperator(OWNER_USER.id, hotelId, operatorId),
      [{ operator_organisation_id: operatorId, operator_name: "Fixture Independent Operator" }],
      "hotel billing authority may confirm an exact operator identity");
    assert.deepEqual(await resolveOperator(OTHER_USER.id, hotelId, operatorId), [],
      "operator cannot resolve its own identity as hotel owner");
    assert.deepEqual(await resolveOperator("nonexistent-user", hotelId, operatorId), [],
      "unknown user cannot enumerate operator identities");
    assert.deepEqual(await resolveOperator(OWNER_USER.id, hotelId, ownerOrg.rows[0]!.organisation_id), [],
      "hotel organisation must not resolve as an operator");
    const identityPrivilege = await pg.query<{ allowed: boolean }>(
      "select has_function_privilege('aether_app', 'public.sbg_resolve_operator_for_hotel_owner(text,uuid,uuid)', 'EXECUTE') as allowed",
    );
    assert.equal(identityPrivilege.rows[0]?.allowed, true, "app role can perform exact-ID confirmation");
    // Confirmation contract: wrong names or mismatched IDs cannot be treated as verified.
    const confirmable = async (userId: string, hotel: string, org: string, name: string) => {
      const resolved = await resolveOperator(userId, hotel, org);
      return resolved.length === 1 &&
        resolved[0]?.operator_organisation_id === org &&
        resolved[0]?.operator_name === name;
    };
    assert.equal(await confirmable(OWNER_USER.id, hotelId, operatorId, "Wrong Name"), false);
    assert.equal(await confirmable(OWNER_USER.id, hotelId, ownerOrg.rows[0]!.organisation_id, "Fixture Hotel Owner"), false);
    assert.equal(await confirmable(OTHER_USER.id, hotelId, operatorId, "Fixture Independent Operator"), false);
    assert.equal(await confirmable(OWNER_USER.id, hotelId, operatorId, "Fixture Independent Operator"), true);
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
    await pg.query("select sbg_accept_approved_founding_agreement_for_user($1,$2,$3)", [ZERO_USER.id, "fixture-operator-access", fixtureHash]);
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
    const operatorCommercial = await pg.query<{
      organisation_exists: boolean; organisation_type: string;
      approved_agreement_accepted: boolean; accessible_property_count: number;
    }>("select * from sbg_commercial_founding_snapshot_for_user($1)", [OTHER_USER.id]);
    assert.deepEqual(operatorCommercial.rows, [{
      organisation_exists: true, organisation_type: "transfer_operator",
      approved_agreement_accepted: false, accessible_property_count: 1,
    }], "operator grant is visible, but cannot imply legal acceptance or paid entitlement");
    await assert.rejects(
      pg.query("select sbg_accept_approved_founding_agreement_for_user($1,$2,$3)",
        [OTHER_USER.id, "fixture-operator-access", "0".repeat(64)]),
      /approved agreement unavailable or changed/i,
      "operator cannot accept an incorrect document hash",
    );
    const operatorAcceptance = await pg.query<{ agreement_version: string; already_accepted: boolean }>(
      "select * from sbg_accept_approved_founding_agreement_for_user($1,$2,$3)",
      [OTHER_USER.id, "fixture-operator-access", fixtureHash],
    );
    assert.deepEqual(operatorAcceptance.rows,
      [{ agreement_version: "fixture-operator-access", already_accepted: false }],
      "operator explicitly accepts the same approved document as a hotel founder");
    const operatorAfterAcceptance = await pg.query<{ approved_agreement_accepted: boolean; accessible_property_count: number }>(
      "select approved_agreement_accepted, accessible_property_count from sbg_commercial_founding_snapshot_for_user($1)",
      [OTHER_USER.id],
    );
    assert.deepEqual(operatorAfterAcceptance.rows,
      [{ approved_agreement_accepted: true, accessible_property_count: 1 }],
      "operator legal acceptance does not create additional property grants");



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
    const providerAppPrivilege = await pg.query<{ allowed: boolean }>(
      "select has_function_privilege('aether_app', 'public.sbg_set_operator_provider_authorisation_for_user(text,uuid,uuid,uuid,boolean)', 'EXECUTE') as allowed",
    );
    assert.equal(providerAppPrivilege.rows[0]?.allowed, true, "app role may invoke only the guarded provider setter");
    const providerRuntimePrivilege = await pg.query<{ allowed: boolean }>(
      "select has_function_privilege('aether_runtime', 'public.sbg_set_operator_provider_authorisation_for_user(text,uuid,uuid,uuid,boolean)', 'EXECUTE') as allowed",
    );
    assert.equal(providerRuntimePrivilege.rows[0]?.allowed, false, "runtime role must not invoke provider setter");
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
    // A grant alone cannot allocate an operator licence before provider authorisation.
    await pg.query(
      "insert into sbg_organisation_billing(organisation_id,status,licensed_quantity) values ($1::uuid,'inactive',1)",
      [operatorId],
    );
    const allocateOperator = () => pg.query(
      "insert into sbg_property_licence_allocations(organisation_id,hotel_id,allocated_by_user_id) values ($1::uuid,$2::uuid,$3)",
      [operatorId, hotelId, OTHER_USER.id],
    );
    await assert.rejects(allocateOperator(), /provider permission required/i,
      "property grant alone cannot create an operator licence allocation");
    await setProvider(OWNER_USER.id, hotelId, ownProvider, true);
    await allocateOperator();
    const billingEvidence = await pg.query<{
      billing_status: string; purchased_quantity: number; allocated_quantity: number;
      available_quantity: number; allocation_integrity_ok: boolean;
    }>("select * from sbg_commercial_billing_evidence_for_user($1)", [OTHER_USER.id]);
    assert.deepEqual(billingEvidence.rows, [{
      billing_status: "inactive", purchased_quantity: 1, allocated_quantity: 1,
      available_quantity: 0, allocation_integrity_ok: true,
    }], "operator allocation is commercially counted without implying active billing");
    await assert.rejects(allocateOperator(), /duplicate key|licence quantity exceeded/i,
      "one hotel cannot receive a second active allocation");
    // Purchased quantity is evidence, not an activation decision. Subscription
    // states must remain visible and must not silently alter allocations.
    for (const status of ["incomplete", "past_due", "unpaid", "canceled", "active"]) {
      await pg.query("update sbg_organisation_billing set status = $1 where organisation_id = $2::uuid",
        [status, operatorId]);
      const snapshot = await pg.query<{ billing_status: string; allocated_quantity: number }>(
        "select billing_status, allocated_quantity from sbg_commercial_billing_evidence_for_user($1)",
        [OTHER_USER.id],
      );
      assert.deepEqual(snapshot.rows, [{ billing_status: status, allocated_quantity: 1 }],
        "billing evidence must report subscription state without granting operations");
    }
    await pg.query("update sbg_organisation_billing set status = 'inactive' where organisation_id = $1::uuid",
      [operatorId]);
    const authorisedStatus = await pg.query<{ provider_authorised: boolean; provider_id: string }>(
      "select provider_authorised, provider_id::text from sbg_operator_provider_activation_for_user($1,$2::uuid)",
      [OTHER_USER.id, hotelId],
    );
    assert.deepEqual(authorisedStatus.rows, [{ provider_authorised: true, provider_id: ownProvider }],
      "active agreement and explicit authorisation produce provider status");
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), true,
      "explicit provider authorisation allows only the matching provider");

    // The provider agreement is a separate, revocable prerequisite.
    await pg.query(
      "update hotel_provider_agreements set active = false where hotel_id = $1::uuid and provider_id = $2::uuid",
      [hotelId, ownProvider],
    );
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), false,
      "inactive hotel/provider agreement must deny provider access");
    await pg.query(
      "update hotel_provider_agreements set active = true where hotel_id = $1::uuid and provider_id = $2::uuid",
      [hotelId, ownProvider],
    );
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), true,
      "restoring the agreement alone preserves the explicit grant under current policy");

    // The booking projection must independently honour provider-agreement
    // deactivation, not merely the eligibility predicate.
    const providerQuery = () => pg.query(
      "select * from sbg_list_operator_provider_booking_summaries_for_user($1,$2::uuid,$3::uuid,10)",
      [OTHER_USER.id, hotelId, ownProvider],
    );
    await pg.query(
      "update hotel_provider_agreements set active = false where hotel_id = $1::uuid and provider_id = $2::uuid",
      [hotelId, ownProvider],
    );
    await assert.rejects(providerQuery(), /operator provider booking access denied/i,
      "inactive agreement must block the booking projection itself");
    await pg.query(
      "update hotel_provider_agreements set active = true where hotel_id = $1::uuid and provider_id = $2::uuid",
      [hotelId, ownProvider],
    );


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
    const revokedEvidence = await pg.query<{ allocated_quantity: number; allocation_integrity_ok: boolean }>(
      "select allocated_quantity, allocation_integrity_ok from sbg_commercial_billing_evidence_for_user($1)",
      [OTHER_USER.id],
    );
    assert.deepEqual(revokedEvidence.rows, [{ allocated_quantity: 1, allocation_integrity_ok: false }],
      "revocation invalidates eligibility while preserving the allocation audit record");
    const preservedAllocation = await pg.query<{ count: number }>(
      "select count(*)::int as count from sbg_property_licence_allocations where organisation_id = $1::uuid and hotel_id = $2::uuid and released_at is null",
      [operatorId, hotelId],
    );
    assert.equal(preservedAllocation.rows[0]?.count, 1,
      "provider revocation must not silently release or delete paid licence history");
    // Fixture-only direct SQL models the future controlled release service.
    // A release preserves the immutable allocation row; it does not restore
    // provider permissions or grant an allocation on its own.
    await pg.query(
      "update sbg_property_licence_allocations set released_at = now(), released_by_user_id = $1 where organisation_id = $2::uuid and hotel_id = $3::uuid and released_at is null",
      [OTHER_USER.id, operatorId, hotelId],
    );
    const releasedEvidence = await pg.query<{ allocated_quantity: number; available_quantity: number }>(
      "select allocated_quantity, available_quantity from sbg_commercial_billing_evidence_for_user($1)",
      [OTHER_USER.id],
    );
    assert.deepEqual(releasedEvidence.rows, [{ allocated_quantity: 0, available_quantity: 1 }],
      "explicit release restores available quantity without deleting history");
    await assert.rejects(allocateOperator(), /provider permission required/i,
      "released licence cannot be reallocated after provider revocation");
    const allocationHistory = await pg.query<{ count: number }>(
      "select count(*)::int as count from sbg_property_licence_allocations where organisation_id = $1::uuid and hotel_id = $2::uuid and released_at is not null",
      [operatorId, hotelId],
    );
    assert.equal(allocationHistory.rows[0]?.count, 1,
      "released allocation remains auditable");
    const revoked = await pg.query<{ count: number }>(
      "select count(*)::int as count from sbg_operator_provider_authorisations where hotel_id = $1::uuid and provider_id = $2::uuid and revoked_at is null",
      [hotelId, ownProvider],
    );
    assert.equal(revoked.rows[0]?.count, 0, "provider-specific revocation takes effect");
    // Revoking the parent hotel grant must revoke subordinate provider grants.
    await setProvider(OWNER_USER.id, hotelId, ownProvider, true);
    await pg.query(
      "select sbg_set_operator_property_grant_for_user($1,$2::uuid,$3::uuid,false)",
      [OWNER_USER.id, hotelId, operatorId],
    );
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), false,
      "property revocation immediately denies provider eligibility before any regrant");
    await assert.rejects(scopedQuery(OTHER_USER.id, hotelId, ownProvider),
      /operator provider booking access denied/i,
      "property revocation immediately blocks provider booking summaries");
    await pg.query(
      "select sbg_set_operator_property_grant_for_user($1,$2::uuid,$3::uuid,true)",
      [OWNER_USER.id, hotelId, operatorId],
    );
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), false,
      "property regrant must not resurrect revoked provider authorisation");
    await assert.rejects(scopedQuery(OTHER_USER.id, hotelId, ownProvider),
      /operator provider booking access denied/i,
      "property regrant must not restore provider booking access after cascading revocation");

    const staleProviderGrants = await pg.query<{ count: number }>(
      "select count(*)::int as count from sbg_operator_provider_authorisations where hotel_id = $1::uuid and operator_organisation_id = $2::uuid and revoked_at is null",
      [hotelId, operatorId],
    );
    assert.equal(staleProviderGrants.rows[0]?.count, 0, "parent revocation cascades to provider grants");
    const canExecute = await pg.query<{ permitted: boolean }>(
      `select has_function_privilege('aether_app',
        'public.sbg_set_operator_provider_authorisation_for_user(text,uuid,uuid,uuid,boolean)', 'EXECUTE') as permitted`,
    );
    assert.equal(canExecute.rows[0]?.permitted, true, "application may call only the owner-guarded provider setter after 0051");

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


    // Membership removal must deny booking access even if both explicit
    // authorisation records remain active in storage.
    await pg.query(
      "update sbg_organisation_members set removed_at = now() where user_id = $1 and organisation_id = $2::uuid and removed_at is null",
      [OTHER_USER.id, operatorId],
    );
    await assert.rejects(scopedQuery(OTHER_USER.id, hotelId, ownProvider),
      /operator provider booking access denied/i,
      "removed operator member cannot read bookings despite retained grants");
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), false,
      "removed operator membership fails provider eligibility");
    await pg.query(
      "update sbg_organisation_members set removed_at = null where user_id = $1 and organisation_id = $2::uuid",
      [OTHER_USER.id, operatorId],
    );


    // Rejection of invalid pagination is a security boundary: never
    // permit unbounded provider booking exports via this function.
    for (const invalidLimit of [0, -1, 101]) {
      await assert.rejects(
        pg.query(
          "select * from sbg_list_operator_provider_booking_summaries_for_user($1,$2::uuid,$3::uuid,$4)",
          [OTHER_USER.id, hotelId, ownProvider, invalidLimit],
        ),
        /operator provider booking access denied/i,
        "invalid provider booking page size must fail closed",
      );
    }
    await assert.rejects(
      pg.query(
        "select * from sbg_list_operator_provider_booking_summaries_for_user($1,$2::uuid,$3::uuid,$4)",
        [OTHER_USER.id, hotelId, ownProvider, null],
      ),
      /operator provider booking access denied/i,
      "null page size must fail closed",
    );


    // Ambiguous active transfer-operator memberships must fail closed.
    // A second operator membership must not let a user choose the
    // favourable grant via a forged organisation selector.
    const secondOperatorCreator = {
      id: "fixture-second-operator-creator",
      email: "second-operator-creator@sbg.test",
      name: "Second Operator Creator",
    };
    await insertAuthUser(pg, secondOperatorCreator);
    const secondOperator = await pg.query<{ id: string }>(
      "select organisation_id::text as id from sbg_ensure_founding_organisation($1,$2)",
      [secondOperatorCreator.id, "Second Fixture Operator"],
    );
    await pg.query(
      "select sbg_classify_founding_organisation($1,'transfer_operator')",
      [secondOperatorCreator.id],
    );
    const secondOperatorId = secondOperator.rows[0]!.id;
    await pg.query(
      "insert into sbg_organisation_members (organisation_id, user_id, role, billing_authority) values ($1::uuid,$2,'operator',false)",
      [secondOperatorId, OTHER_USER.id],
    );
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), false,
      "multiple active operator memberships deny provider access");
    await assert.rejects(scopedQuery(OTHER_USER.id, hotelId, ownProvider),
      /operator provider booking access denied/i,
      "multiple active operator memberships deny booking summaries");
    await pg.query(
      "update sbg_organisation_members set removed_at = now() where organisation_id = $1::uuid and user_id = $2",
      [secondOperatorId, OTHER_USER.id],
    );
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), true,
      "access resumes when only the explicitly authorised operator membership remains");

    // A second, inactive provider at the SAME hotel must not inherit
    // the first provider's authorisation or appear in its booking results.
    const secondProvider = await pg.query<{ id: string }>(
      "insert into providers (code, name, kind) values ('gate2-second-provider', 'Fixture Second Provider', 'external') returning id::text as id",
    );
    const secondProviderId = secondProvider.rows[0]!.id;
    // V1 enforces one active provider agreement per hotel. A second
    // provider can exist only as an inactive historical agreement.
    await pg.query(
      "insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid,$2::uuid,false)",
      [hotelId, secondProviderId],
    );
    await assert.rejects(scopedQuery(OTHER_USER.id, hotelId, secondProviderId),
      /operator provider booking access denied/i,
      "inactive same-hotel provider without authorisation is inaccessible");
    const secondProviderBooking = await pg.query<{ id: string }>(
      `insert into bookings (
         hotel_id, executing_provider_id, transfer_date, pickup_time, duration_minutes,
         guest_name, guest_phone, guest_email, passenger_count, luggage_count,
         pickup_text, destination_text, human_reference, confirmation_token
       ) values (
         $1::uuid, $2::uuid, date '2026-10-20', time '11:30', 90,
         'Other Provider Guest', '+30000000001', 'other-provider@sbg.test', 1, 0,
         'Hotel lobby', 'Harbour', 'PT-GRANT-SECOND', 'secret-PT-GRANT-SECOND'
       ) returning id::text as id`,
      [hotelId, secondProviderId],
    );
    assert.equal(secondProviderBooking.rows.length, 1);
    await assert.rejects(setProvider(OWNER_USER.id, hotelId, secondProviderId, true),
      /operator provider authorisation denied/i,
      "inactive former provider cannot be authorised while another provider is active");
    assert.equal(await canAccessProvider(OTHER_USER.id, hotelId, ownProvider), true,
      "rejected former-provider authorisation leaves current provider access unchanged");
    const deniedFormerProviderGrant = await pg.query<{ count: number }>(
      "select count(*)::int as count from sbg_operator_provider_authorisations where hotel_id = $1::uuid and provider_id = $2::uuid and operator_organisation_id = $3::uuid and revoked_at is null",
      [hotelId, secondProviderId, operatorId],
    );
    assert.equal(deniedFormerProviderGrant.rows[0]?.count, 0,
      "rejected former-provider authorisation must not persist an active grant");
    const retainedCurrentProviderGrant = await pg.query<{ count: number }>(
      "select count(*)::int as count from sbg_operator_provider_authorisations where hotel_id = $1::uuid and provider_id = $2::uuid and operator_organisation_id = $3::uuid and revoked_at is null",
      [hotelId, ownProvider, operatorId],
    );
    assert.equal(retainedCurrentProviderGrant.rows[0]?.count, 1,
      "rejected former-provider authorisation must not revoke the active provider grant");
    await assert.rejects(scopedQuery(OTHER_USER.id, hotelId, secondProviderId),
      /operator provider booking access denied/i,
      "a real same-hotel booking does not unlock unauthorised provider access");

    const matching = await scopedQuery(OTHER_USER.id, hotelId, ownProvider);
    assert.equal(matching.rows.length, 1, "only executing-provider bookings are visible");
    assert.equal(matching.rows[0]?.bookingId, ownBookingId);
    assert.ok(matching.rows.every(row => row.bookingId !== secondProviderBooking.rows[0]!.id),
      "same-hotel second provider booking must never leak into first provider results");
    assert.ok(matching.rows.every(row => row.humanReference !== "PT-GRANT-SECOND"),
      "same-hotel second provider reference must not appear in first provider projection");
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

    const activation = async (userId: string, propertyId: string) =>
      (await pg.query<{ provider_authorised: boolean; provider_id: string }>(
        "select provider_authorised, provider_id::text from sbg_operator_provider_activation_for_user($1,$2::uuid)",
        [userId, propertyId],
      )).rows;
    assert.deepEqual(await activation(OWNER_USER.id, hotelId), [],
      "hotel owner cannot impersonate an operator activation");
    assert.deepEqual(await activation(OTHER_USER.id, otherHotelId), [],
      "operator cannot inspect an ungranted property");
    assert.deepEqual(await activation(OTHER_USER.id, hotelId), [],
      "revoked provider authorisation must not appear active");
    const activationPrivilege = await pg.query<{ allowed: boolean }>(
      "select has_function_privilege('aether_app', 'public.sbg_operator_provider_activation_for_user(text,uuid)', 'EXECUTE') as allowed",
    );
    assert.equal(activationPrivilege.rows[0]?.allowed, true, "app may read scoped status only");

    const listProperties = async (userId: string) => (await pg.query<{ hotel_id: string; hotel_name: string }>(
      "select hotel_id::text, hotel_name from sbg_operator_properties_for_user($1)", [userId],
    )).rows;
    assert.deepEqual(await listProperties(OWNER_USER.id), [], "hotel owner cannot discover operator properties");
    assert.deepEqual(await listProperties("nonexistent-user"), [], "unknown identity cannot discover properties");
    assert.deepEqual(await listProperties(OTHER_USER.id), [{ hotel_id: hotelId, hotel_name: "Grant Test Hotel" }],
      "only the explicitly granted hotel is listed, with no guest data");
    const listPrivilege = await pg.query<{ allowed: boolean }>(
      "select has_function_privilege('aether_app', 'public.sbg_operator_properties_for_user(text)', 'EXECUTE') as allowed",
    );
    assert.equal(listPrivilege.rows[0]?.allowed, true, "app role may call only the scoped list function");

    assert.equal(await check(OWNER_USER.id), false, "grant does not transform hotel owner into operator");
    await pg.query(
      "select sbg_set_operator_property_grant_for_user($1,$2::uuid,$3::uuid,false)",
      [OWNER_USER.id, hotelId, operatorId],
    );
    assert.equal(await check(OTHER_USER.id), false, "revocation must immediately deny");
    assert.deepEqual(await listProperties(OTHER_USER.id), [], "revoked grant disappears from property list");
    // Reauthorisation is an explicit hotel-owner action, not automatic.
    await pg.query(
      "select sbg_set_operator_property_grant_for_user($1,$2::uuid,$3::uuid,true)",
      [OWNER_USER.id, hotelId, operatorId],
    );
    assert.equal(await check(OTHER_USER.id), true, "explicit regrant restores access");
    assert.equal((await listProperties(OTHER_USER.id)).length, 1, "explicit regrant restores listing");
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
