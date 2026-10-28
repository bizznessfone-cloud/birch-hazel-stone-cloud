import assert from "node:assert/strict";
import { test } from "node:test";
import { OPERATOR_BOOKING_SAFE_FIELDS, toOperatorBookingSummary } from "./operator-booking-visibility.ts";

test("operator booking projection excludes private guest, payment and owner dispatch fields", () => {
  const row = {
    bookingId: "booking-1", humanReference: "PT-EXAMPLE",
    transferDate: "2026-10-20", pickupTime: "10:30",
    passengerCount: 2, luggageCount: 1, pickupText: "Hotel lobby",
    destinationText: "Airport", cancelled: false,
    guestName: "PRIVATE", guestEmail: "private@example.test", guestPhone: "PRIVATE",
    confirmationToken: "SECRET", stripePaymentIntentId: "SECRET",
    vehicleId: "OWNER", driverId: "OWNER", quotedAmountMinor: 9999,
  };
  const projected = toOperatorBookingSummary(row);
  assert.deepEqual(Object.keys(projected), [...OPERATOR_BOOKING_SAFE_FIELDS]);
  for (const key of ["guestName", "guestEmail", "guestPhone", "confirmationToken", "stripePaymentIntentId", "vehicleId", "driverId", "quotedAmountMinor"]) {
    assert.equal(Object.hasOwn(projected, key), false, key);
  }
});

test("operator booking projection rejects incomplete or malformed records", () => {
  assert.throws(() => toOperatorBookingSummary({}), /Invalid operator booking record/);
  assert.throws(() => toOperatorBookingSummary({
    bookingId: "booking-1", humanReference: "PT-EXAMPLE",
    transferDate: "2026-10-20", pickupTime: "10:30",
    passengerCount: -1, luggageCount: 0, pickupText: "Hotel",
    destinationText: "Airport", cancelled: false,
  }), /Invalid operator booking record/);
});
