import assert from "node:assert/strict";
import { test } from "node:test";
import { readOperatorPropertyAccess } from "./operator-property-grant-read.ts";

test("operator grant read fails closed without querying unapproved grant endpoints", async () => {
  const db = { query: async () => { throw new Error("unexpected query"); } };
  assert.deepEqual(await readOperatorPropertyAccess({ db: db as never, sessionUserId: null, hotelId: "hotel-a" }), {
    allowed: false, reason: "unauthorized",
  });
  assert.deepEqual(await readOperatorPropertyAccess({ db: db as never, sessionUserId: "operator-user", hotelId: "" }), {
    allowed: false, reason: "not_granted",
  });
  assert.deepEqual(await readOperatorPropertyAccess({ db: db as never, sessionUserId: "operator-user", hotelId: "hotel-a" }), {
    allowed: false, reason: "not_granted",
  });
});

test("database is the authority; only an explicit true grants access", async () => {
  const hotelId = "11111111-1111-4111-8111-111111111111";
  const calls: unknown[][] = [];
  const db = { query: async (_sql: string, params: unknown[]) => {
    calls.push(params);
    return [{ allowed: true }];
  } };
  assert.deepEqual(await readOperatorPropertyAccess({ db: db as never, sessionUserId: "operator-user", hotelId }), { allowed: true });
  assert.deepEqual(calls, [["operator-user", hotelId]]);
  for (const rows of [[], [{ allowed: false }], [{ allowed: true }, { allowed: true }]]) {
    const denied = { query: async () => rows };
    assert.deepEqual(await readOperatorPropertyAccess({ db: denied as never, sessionUserId: "operator-user", hotelId }), {
      allowed: false, reason: "not_granted",
    });
  }
  const failing = { query: async () => { throw Error("database unavailable"); } };
  assert.deepEqual(await readOperatorPropertyAccess({ db: failing as never, sessionUserId: "operator-user", hotelId }), {
    allowed: false, reason: "not_granted",
  });
});
