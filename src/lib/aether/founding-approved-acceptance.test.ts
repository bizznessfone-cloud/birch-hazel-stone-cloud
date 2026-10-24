import assert from "node:assert/strict";
import test from "node:test";
import { acceptApprovedFoundingAgreement } from "./founding-approved-acceptance.ts";

test("records only the authenticated identity and exact selected version", async () => {
  let calls = 0;
  const db = { query: async (sql: string, params: unknown[]) => {
    calls++;
    assert.match(sql, /sbg_accept_approved_founding_agreement_for_user/);
    assert.deepEqual(params, ["session-user", "approved-v2"]);
    return [{ agreement_version: "approved-v2", already_accepted: false }];
  } };
  assert.deepEqual(await acceptApprovedFoundingAgreement({
    db: db as never, userId: "session-user", agreementVersion: "approved-v2",
  }), { agreementVersion: "approved-v2", alreadyAccepted: false });
  assert.equal(calls, 1);
});

test("rejects missing identity and provisional terms before database access", async () => {
  const db = { query: async () => { throw Error("unexpected database access"); } };
  await assert.rejects(acceptApprovedFoundingAgreement({
    db: db as never, userId: null, agreementVersion: "approved-v2",
  }), /Unauthorized/);
  await assert.rejects(acceptApprovedFoundingAgreement({
    db: db as never, userId: "session-user", agreementVersion: "terms-v1",
  }), /Approved agreement version required/);
  await assert.rejects(acceptApprovedFoundingAgreement({
    db: db as never, userId: "session-user", agreementVersion: " ",
  }), /Approved agreement version required/);
});

test("propagates effective-approval and authority denials without fallback", async () => {
  const db = { query: async () => { throw Error("approved agreement unavailable"); } };
  await assert.rejects(acceptApprovedFoundingAgreement({
    db: db as never, userId: "session-user", agreementVersion: "approved-v2",
  }), /approved agreement unavailable/);
});

test("rejects absent, mismatched or malformed acceptance evidence", async () => {
  for (const rows of [[], [{ agreement_version: "other", already_accepted: false }], [{ agreement_version: "approved-v2" }]]) {
    const db = { query: async () => rows };
    await assert.rejects(acceptApprovedFoundingAgreement({
      db: db as never, userId: "session-user", agreementVersion: "approved-v2",
    }), /Agreement acceptance was not recorded/);
  }
});

test("reports idempotent repeat acceptance", async () => {
  const db = { query: async () => [{ agreement_version: "approved-v2", already_accepted: true }] };
  assert.deepEqual(await acceptApprovedFoundingAgreement({
    db: db as never, userId: "session-user", agreementVersion: "approved-v2",
  }), { agreementVersion: "approved-v2", alreadyAccepted: true });
});
