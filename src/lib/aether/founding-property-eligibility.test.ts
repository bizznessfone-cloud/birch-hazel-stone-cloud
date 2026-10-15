import assert from "node:assert/strict";
import test from "node:test";
import { readFoundingPropertyEligibility } from "./founding-property-eligibility.ts";

test("read-only eligibility denies missing session without querying", async () => {
  const db = { query: async () => { throw new Error("must not query"); } };
  assert.deepEqual(await readFoundingPropertyEligibility({ db: db as never, userId: null }), {
    eligible: false, reason: "unauthorized",
  });
});
test("read-only eligibility returns only approved known states", async () => {
  for (const [row, expected] of [
    [{ eligible: false, reason: "agreement_required" }, { eligible: false, reason: "agreement_required" }],
    [{ eligible: true, reason: "ready" }, { eligible: true, reason: "ready" }],
    [{ eligible: true, reason: "unknown" }, { eligible: false, reason: "unavailable" }],
    [{ eligible: false, reason: "unexpected" }, { eligible: false, reason: "unavailable" }],
  ] as const) {
    const db = { query: async (_sql: string, params: unknown[]) => {
      assert.deepEqual(params, ["session-user"]);
      return [row];
    } };
    assert.deepEqual(await readFoundingPropertyEligibility({ db: db as never, userId: "session-user" }), expected);
  }
});
test("missing eligibility row fails closed", async () => {
  const db = { query: async () => [] };
  assert.deepEqual(await readFoundingPropertyEligibility({ db: db as never, userId: "session-user" }), {
    eligible: false, reason: "unavailable",
  });
});
