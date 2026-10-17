import assert from "node:assert/strict";
import { test } from "node:test";
import { setOperatorPropertyGrant } from "./operator-property-grant-write.ts";

const hotelId = "11111111-1111-4111-8111-111111111111";
const operatorOrganisationId = "22222222-2222-4222-8222-222222222222";

test("grant write passes server user and property to database authority", async () => {
  const calls: unknown[][] = [];
  const db = { query: async (_sql: string, params: unknown[]) => {
    calls.push(params);
    return [{ updated: true }];
  } };
  assert.deepEqual(await setOperatorPropertyGrant({
    db: db as never, sessionUserId: "hotel-owner", hotelId, operatorOrganisationId, enable: false,
  }), { updated: true });
  assert.deepEqual(calls, [["hotel-owner", hotelId, operatorOrganisationId, false]]);
});

test("grant write rejects unauthenticated, malformed and unsuccessful requests", async () => {
  const db = { query: async () => { throw Error("should not be called"); } };
  await assert.rejects(setOperatorPropertyGrant({
    db: db as never, sessionUserId: null, hotelId, operatorOrganisationId, enable: true,
  }), /Unauthorized/);
  await assert.rejects(setOperatorPropertyGrant({
    db: db as never, sessionUserId: "owner", hotelId: "bad", operatorOrganisationId, enable: true,
  }), /Invalid/);
  const denied = { query: async () => [{ updated: false }] };
  await assert.rejects(setOperatorPropertyGrant({
    db: denied as never, sessionUserId: "owner", hotelId, operatorOrganisationId, enable: true,
  }), /not updated/);
});
