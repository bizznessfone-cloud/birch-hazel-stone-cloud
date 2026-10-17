import assert from "node:assert/strict";
import { test } from "node:test";
import { readEffectiveFoundingAgreement } from "./approved-founding-agreement.ts";
import { acceptEffectiveFoundingAgreement } from "./approved-founding-agreement-accept.ts";
const sha = "a".repeat(64);
const version = "approved-test-1";
function fakeDb(available: boolean, accepted = true) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = { query: async (sql: string, args: unknown[]) => {
    calls.push({ sql, args });
    if (sql.includes("sbg_read_effective_founding_agreement")) return available
      ? [{ agreement_version: version, document_text: "Fixture only, not legal text", document_sha256: sha }] : [];
    if (sql.includes("sbg_accept_approved_founding_agreement_for_user")) return accepted
      ? [{ agreement_version: version, already_accepted: false }] : [];
    throw new Error("Unexpected query");
  } };
  return { db: db as any, calls };
}
test("legal document read fails closed without an effective approved document", async () => {
  const { db } = fakeDb(false);
  assert.deepEqual(await readEffectiveFoundingAgreement({ db }), { available: false });
});
test("explicit acceptance passes only the session user and verified effective version", async () => {
  const { db, calls } = fakeDb(true);
  assert.deepEqual(await acceptEffectiveFoundingAgreement({
    db, sessionUserId: "hotel-owner", displayedVersion: version, displayedSha256: sha,
    explicitlyAccepted: true,
  }), { version, alreadyAccepted: false });
  assert.deepEqual(calls[1]?.args, ["hotel-owner", version, sha]);
});
test("no acceptance for missing document, changed hash/version, or missing consent", async () => {
  for (const input of [
    { available: false, displayedVersion: version, displayedSha256: sha, explicitlyAccepted: true, sessionUserId: "hotel-owner" },
    { available: true, displayedVersion: "outdated", displayedSha256: sha, explicitlyAccepted: true, sessionUserId: "hotel-owner" },
    { available: true, displayedVersion: version, displayedSha256: "b".repeat(64), explicitlyAccepted: true, sessionUserId: "hotel-owner" },
    { available: true, displayedVersion: version, displayedSha256: sha, explicitlyAccepted: false, sessionUserId: "hotel-owner" },
    { available: true, displayedVersion: version, displayedSha256: sha, explicitlyAccepted: true, sessionUserId: "" },
  ]) {
    const { db, calls } = fakeDb(input.available);
    await assert.rejects(acceptEffectiveFoundingAgreement({ db, ...input }));
    assert.equal(calls.filter(c => c.sql.includes("sbg_accept_approved_founding_agreement_for_user")).length, 0);
  }
});
test("database refusal cannot claim recorded acceptance", async () => {
  const { db } = fakeDb(true, false);
  await assert.rejects(acceptEffectiveFoundingAgreement({
    db, sessionUserId: "hotel-owner", displayedVersion: version, displayedSha256: sha,
    explicitlyAccepted: true,
  }));
});
