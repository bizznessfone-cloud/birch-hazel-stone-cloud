import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmOperatorPropertyGrant, revokeConfirmedOperatorPropertyGrant } from "./operator-property-grant-confirm.ts";

const hotelId = "11111111-1111-4111-8111-111111111111";
const operatorOrganisationId = "22222222-2222-4222-8222-222222222222";
function fakeDb(found: boolean, granted: boolean) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes("sbg_resolve_operator_for_hotel_owner")) return found
      ? [{ operator_organisation_id: operatorOrganisationId, operator_name: "Verified Operator" }] : [];
    if (sql.includes("sbg_set_operator_property_grant_for_user")) return [{ updated: granted }];
    throw new Error("Unexpected query");
  } };
  return { db: db as any, calls };
}
test("confirmation requires exact identity and uses session user", async () => {
  const { db, calls } = fakeDb(true, true);
  assert.deepEqual(await confirmOperatorPropertyGrant({
    db, sessionUserId: "hotel-owner", hotelId, operatorOrganisationId,
    confirmedOperatorName: "Verified Operator",
  }), { granted: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.params, ["hotel-owner", hotelId, operatorOrganisationId]);
  assert.deepEqual(calls[1]?.params, ["hotel-owner", hotelId, operatorOrganisationId, true]);
});
test("mismatched name, absent identity, and absent session never write", async () => {
  for (const [found, name, user] of [
    [true, "Impostor", "hotel-owner"], [false, "Verified Operator", "hotel-owner"],
    [true, "Verified Operator", ""],
  ] as const) {
    const { db, calls } = fakeDb(found, true);
    await assert.rejects(confirmOperatorPropertyGrant({
      db, sessionUserId: user, hotelId, operatorOrganisationId, confirmedOperatorName: name,
    }));
    assert.ok(calls.every(x => !x.sql.includes("sbg_set_operator_property_grant_for_user")));
  }
});
test("database denial fails closed for grant and revoke", async () => {
  for (const enable of [true, false]) {
    const { db, calls } = fakeDb(true, false);
    await assert.rejects(enable
      ? confirmOperatorPropertyGrant({ db, sessionUserId: "hotel-owner", hotelId, operatorOrganisationId, confirmedOperatorName: "Verified Operator" })
      : revokeConfirmedOperatorPropertyGrant({ db, sessionUserId: "hotel-owner", hotelId, operatorOrganisationId }));
    assert.equal(calls.at(-1)?.params.at(-1), enable);
  }
});
test("revocation invokes authority-checked database setter without lookup", async () => {
  const { db, calls } = fakeDb(false, true);
  assert.deepEqual(await revokeConfirmedOperatorPropertyGrant({
    db, sessionUserId: "hotel-owner", hotelId, operatorOrganisationId,
  }), { revoked: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.params, ["hotel-owner", hotelId, operatorOrganisationId, false]);
});
