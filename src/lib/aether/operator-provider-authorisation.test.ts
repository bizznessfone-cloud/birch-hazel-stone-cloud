import assert from "node:assert/strict";
import { test } from "node:test";
import { setOperatorProviderAuthorisation } from "./operator-provider-authorisation.ts";

const hotelId = "11111111-1111-4111-8111-111111111111";
const providerId = "33333333-3333-4333-8333-333333333333";
const operatorOrganisationId = "22222222-2222-4222-8222-222222222222";
const valid = { sessionUserId: "hotel-owner", hotelId, providerId, operatorOrganisationId };
function fakeDb(approved: boolean) {
  const calls: unknown[][] = [];
  return {
    calls,
    db: { query: async (sql: string, args: unknown[]) => {
      assert.match(sql, /sbg_set_operator_provider_authorisation_for_user/);
      calls.push(args);
      return [{ updated: approved }];
    } } as any,
  };
}
test("authorise and revoke provider only through session-derived database call", async () => {
  for (const enable of [true, false]) {
    const { db, calls } = fakeDb(true);
    assert.deepEqual(await setOperatorProviderAuthorisation({ db, ...valid, enable }), { updated: true });
    assert.deepEqual(calls, [["hotel-owner", hotelId, providerId, operatorOrganisationId, enable]]);
  }
});
test("missing session, invalid UUID and invalid action cannot reach database", async () => {
  for (const input of [
    { ...valid, sessionUserId: "", enable: true },
    { ...valid, providerId: "bad", enable: true },
    { ...valid, enable: "true" as unknown as boolean },
  ]) {
    const { db, calls } = fakeDb(true);
    await assert.rejects(setOperatorProviderAuthorisation({ db, ...input }));
    assert.equal(calls.length, 0);
  }
});
test("database refusal cannot report success", async () => {
  for (const enable of [true, false]) {
    const { db } = fakeDb(false);
    await assert.rejects(setOperatorProviderAuthorisation({ db, ...valid, enable }), /denied/);
  }
});
