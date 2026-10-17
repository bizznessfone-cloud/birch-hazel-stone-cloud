import assert from "node:assert/strict";
import { test } from "node:test";
import { authoriseOperatorBookingAccess } from "./operator-booking-access.ts";

const hotelId = "11111111-1111-4111-8111-111111111111";

test("operator booking access rejects unauthenticated and ungranted users", async () => {
  const db = { query: async () => [{ allowed: false }] };
  assert.deepEqual(await authoriseOperatorBookingAccess({
    db: db as never, sessionUserId: null, hotelId,
  }), { allowed: false, reason: "unauthorized" });
  assert.deepEqual(await authoriseOperatorBookingAccess({
    db: db as never, sessionUserId: "operator-user", hotelId,
  }), { allowed: false, reason: "not_granted" });
});

test("a property grant never independently unlocks booking records", async () => {
  let calls = 0;
  const db = { query: async (sql: string) => {
    calls += 1;
    assert.match(sql, /sbg_operator_can_access_property_for_user/);
    return [{ allowed: true }];
  } };
  assert.deepEqual(await authoriseOperatorBookingAccess({
    db: db as never, sessionUserId: "operator-user", hotelId,
  }), { allowed: false, reason: "booking_scope_unavailable" });
  assert.equal(calls, 1, "must not execute a booking query or expose guest records");
});
