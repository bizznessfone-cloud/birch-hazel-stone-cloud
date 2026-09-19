import assert from "node:assert/strict";
import test from "node:test";
import type { CreatedBooking } from "./booking";
import { sendConfirmationEmail } from "./confirmation-email.ts";

const booking: CreatedBooking = {
  humanReference: "PT-TEST123456",
  hotelCode: "demo-kos",
  hotelName: "Aether Demo Hotel",
  transferDate: "2026-09-30",
  pickupTime: "10:00",
  durationMinutes: 60,
  guestName: "Shaun Finn",
  passengerCount: 2,
  luggageCount: 1,
  pickupText: "Aether Demo Hotel",
  destinationText: "Kos Airport",
  destinationId: "00000000-0000-4000-8000-000000000001",
  cancelled: false,
  pricing: { priced: true, currency: "EUR", amountMinor: 3500 },
  confirmationToken: "test-confirmation-token",
};

const recipient = "shaun@example.com";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("confirmation email stays disabled until Resend configuration exists", async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.RESEND_FROM_EMAIL;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  try {
    const result = await sendConfirmationEmail(booking, recipient);
    assert.deepEqual(result, { status: "not_configured" });
  } finally {
    restoreEnv("RESEND_API_KEY", previousKey);
    restoreEnv("RESEND_FROM_EMAIL", previousFrom);
  }
});

test("confirmation email sends through Resend without exposing the token in the subject", async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.RESEND_FROM_EMAIL;
  const previousFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "test-key";
  process.env.RESEND_FROM_EMAIL = "confirmations@example.com";

  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ id: "email-test" }), { status: 200 });
  };

  try {
    const result = await sendConfirmationEmail(booking, recipient);
    assert.deepEqual(result, { status: "sent" });
    assert.ok(request);
    assert.equal(request!.url, "https://api.resend.com/emails");
    assert.equal(request!.headers.get("authorization"), "Bearer test-key");
    assert.equal(request!.headers.get("idempotency-key"), "booking-confirmation-PT-TEST123456");
    const body = JSON.parse(await request!.text()) as {
      to: string[];
      subject: string;
      html: string;
      text: string;
    };
    assert.deepEqual(body.to, [recipient]);
    assert.match(body.subject, /PT-TEST123456/);
    assert.doesNotMatch(body.subject, /test-confirmation-token/);
    assert.match(body.html, /View My Booking/);
    assert.match(body.html, /https:\/\/scan-book-go\.vercel\.app\/confirmed\/test-confirmation-token/);
    assert.match(body.html, /60 min/);
    assert.match(body.text, /PT-TEST123456/);
    assert.match(body.text, /Duration: 60 min/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("RESEND_API_KEY", previousKey);
    restoreEnv("RESEND_FROM_EMAIL", previousFrom);
  }
});

test("Resend HTTP failure is isolated and returns failed", async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.RESEND_FROM_EMAIL;
  const previousFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "test-key";
  process.env.RESEND_FROM_EMAIL = "confirmations@example.com";
  globalThis.fetch = async () => new Response("rejected", { status: 500 });

  try {
    const result = await sendConfirmationEmail(booking, recipient);
    assert.deepEqual(result, { status: "failed" });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("RESEND_API_KEY", previousKey);
    restoreEnv("RESEND_FROM_EMAIL", previousFrom);
  }
});

test("Resend transport exception is isolated and returns failed", async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.RESEND_FROM_EMAIL;
  const previousFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "test-key";
  process.env.RESEND_FROM_EMAIL = "confirmations@example.com";
  globalThis.fetch = async () => {
    throw new Error("network unavailable");
  };

  try {
    const result = await sendConfirmationEmail(booking, recipient);
    assert.deepEqual(result, { status: "failed" });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("RESEND_API_KEY", previousKey);
    restoreEnv("RESEND_FROM_EMAIL", previousFrom);
  }
});
