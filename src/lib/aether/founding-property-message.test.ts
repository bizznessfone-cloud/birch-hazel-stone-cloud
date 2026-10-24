import assert from "node:assert/strict";
import test from "node:test";
import { foundingPropertyRegistrationMessage } from "./founding-property-message.ts";

test("shows recoverable customer guidance without raw database details", () => {
  assert.match(foundingPropertyRegistrationMessage(new Error("terms are not approved for property creation")), /agreement needs to be verified/);
  assert.match(foundingPropertyRegistrationMessage(new Error("duplicate key value violates unique constraint hotels_code_key")), /booking code is already in use/);
  assert.match(foundingPropertyRegistrationMessage(new Error("Invalid timezone")), /timezone and currency/);
  assert.match(foundingPropertyRegistrationMessage(new Error("Unauthorized")), /Sign in again/);
});
test("unknown errors never leak raw SQL or assert a failed write was rolled back", () => {
  const raw = "SQLSTATE 08006: connection lost after commit; private-record-123";
  const message = foundingPropertyRegistrationMessage(new Error(raw));
  assert.doesNotMatch(message, /SQLSTATE|private-record-123/);
  assert.match(message, /Check your workspace before trying again/);
});
