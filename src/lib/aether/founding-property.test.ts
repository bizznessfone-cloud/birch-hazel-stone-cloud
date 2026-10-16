import assert from "node:assert/strict";
import test from "node:test";
import { createFoundingProperty } from "./founding-property.ts";
const property = { name: "Aegean Bay", locality: "Kos, Greece", code: "aegean-bay", ianaTimezone: "Europe/Athens", currency: "EUR" };
test("passes only session user and six function arguments", async () => {
  let calls = 0;
  const db = { query: async (sql: string, params: unknown[]) => {
    calls++;
    assert.match(sql, /sbg_create_founding_property_for_user/);
    assert.deepEqual(params, ["session-user", "aegean-bay", "Aegean Bay", "Kos, Greece", "Europe/Athens", "EUR"]);
    return [{ hotel_id: "hotel-uuid", provider_id: "provider-uuid" }];
  }};
  assert.deepEqual(await createFoundingProperty({ db: db as never, userId: "session-user", property }), { hotelId: "hotel-uuid", providerId: "provider-uuid" });
  assert.equal(calls, 1);
});
test("rejects unauthorized and invalid data before any database call", async () => {
  const db = { query: async () => { throw Error("must not query"); } };
  await assert.rejects(createFoundingProperty({ db: db as never, userId: null, property }), /Unauthorized/);
  await assert.rejects(createFoundingProperty({ db: db as never, userId: "session-user", property: { ...property, code: "BAD CODE" } }), /Invalid property/);
  await assert.rejects(createFoundingProperty({ db: db as never, userId: "session-user", property: { ...property, currency: "eur" } }), /Invalid currency/);
});
test("propagates database agreement denial; never falls back to older creator", async () => {
  const db = { query: async () => { throw Error("terms are not approved for property creation"); } };
  await assert.rejects(createFoundingProperty({ db: db as never, userId: "session-user", property }), /terms are not approved/);
});

test('rejects missing database result', async () => {
  const db = { query: async () => [] };
  await assert.rejects(createFoundingProperty({ db: db as never, userId: 'session-user', property }), /not created/);
});

test("accepts real international IANA timezones and rejects invented zones", async () => {
  const db = { query: async (_sql: string, params: unknown[]) => {
    assert.equal(params[4], "Europe/London");
    return [{ hotel_id: "hotel-id", provider_id: "provider-id" }];
  } };
  assert.deepEqual(await createFoundingProperty({
    db: db as never, userId: "session-user", property: { ...property, ianaTimezone: "Europe/London", currency: "GBP" },
  }), { hotelId: "hotel-id", providerId: "provider-id" });
  await assert.rejects(createFoundingProperty({
    db: db as never, userId: "session-user", property: { ...property, ianaTimezone: "Europe/Imaginary" },
  }), /Invalid timezone/);
});

test("rejects unknown three-letter currency even when its shape is valid", async () => {
  const db = { query: async () => { throw Error("must not query"); } };
  await assert.rejects(createFoundingProperty({
    db: db as never, userId: "session-user", property: { ...property, currency: "ZZZ" },
  }), /Invalid currency/);
});
