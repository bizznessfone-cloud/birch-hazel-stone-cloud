import assert from "node:assert/strict";
import { test } from "node:test";
import { releasePropertyLicence } from "./property-licence-release";

const allocationId = "11111111-1111-4111-8111-111111111111";

test("licence release uses session identity and a validated allocation UUID", async () => {
  let calls = 0;
  const db = { query: async (sql: string, params: unknown[]) => {
    calls++;
    assert.match(sql, /sbg_release_property_licence_for_user/);
    assert.deepEqual(params, ["session-user", allocationId]);
    return [{ released: true }];
  } };
  assert.deepEqual(await releasePropertyLicence({ db: db as never, sessionUserId: "session-user", allocationId }), { released: true });
  assert.equal(calls, 1);
  assert.deepEqual(await releasePropertyLicence({ db: db as never, sessionUserId: "", allocationId }), { released: false });
  assert.deepEqual(await releasePropertyLicence({ db: db as never, sessionUserId: "session-user", allocationId: "not-a-uuid" }), { released: false });
  assert.equal(calls, 1);
});

test("licence release fails closed on denial, malformed response and database failure", async () => {
  for (const rows of [[], [{ released: false }], [{ released: "true" }], [{ released: true }, { released: true }]]) {
    const db = { query: async () => rows };
    assert.deepEqual(await releasePropertyLicence({ db: db as never, sessionUserId: "user", allocationId }), { released: false });
  }
  const db = { query: async () => { throw new Error("denied"); } };
  assert.deepEqual(await releasePropertyLicence({ db: db as never, sessionUserId: "user", allocationId }), { released: false });
});
