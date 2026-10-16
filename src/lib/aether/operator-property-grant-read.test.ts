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
