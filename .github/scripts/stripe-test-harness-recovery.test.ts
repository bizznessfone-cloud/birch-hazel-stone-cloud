import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PAYMENT_AMOUNT_MINOR,
  PAYMENT_CONNECTED_ACCOUNT,
  STRIPE_TEST_EXECUTION_GATE,
  reconcilePaymentRecovery,
  type PaymentBookingEvidence,
  type PaymentRecoveryRecord,
} from "./stripe-test-harness.ts";
import { CREATE_EXPIRE_EXECUTION_GATE } from "./stripe-test-create-expire.ts";

const SECRET = "rk_test_harnessfixturekey01";
const SESSION = "cs_test_fixturepayment";
const BOOKING = "11111111-1111-4111-8111-111111111111";
const PAYMENT = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY = `${PAYMENT}:1`;

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION,
    object: "checkout.session",
    livemode: false,
    mode: "payment",
    amount_total: PAYMENT_AMOUNT_MINOR,
    currency: "eur",
    payment_status: "unpaid",
    status: "open",
    url: "https://checkout.stripe.com/c/pay/cs_test_secret",
    client_secret: SECRET,
    card: "4242424242424242",
    ...overrides,
  };
}

function confirmedBooking(overrides: Partial<PaymentBookingEvidence> = {}): PaymentBookingEvidence {
  return {
    lifecycleState: "confirmed_paid",
    paymentStatus: "paid",
    paidCount: 1,
    sessionId: SESSION,
    accountId: PAYMENT_CONNECTED_ACCOUNT,
    amountMinor: PAYMENT_AMOUNT_MINOR,
    currency: "EUR",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function timeoutError(): Error {
  const error = new Error("https://checkout.stripe.com/c/pay/timeout rk_test_secret whsec_secret 4242424242424242");
  error.name = "TimeoutError";
  return error;
}

async function reconcile(input: {
  sessionId?: string | null;
  creationAmbiguous?: boolean;
  operationFailure?: string | null;
  booking?: PaymentBookingEvidence | null;
  fetchImpl?: typeof fetch;
  blocked?: "identity_rejected" | null;
}): Promise<{ record: PaymentRecoveryRecord; expireCalls: number; calls: string[] }> {
  const calls: string[] = [];
  const inner = input.fetchImpl ?? (async () => jsonResponse(200, session()));
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return inner(url, init);
  };
  const record = await reconcilePaymentRecovery({
    secret: SECRET,
    sessionId: input.sessionId === undefined ? SESSION : input.sessionId,
    creationAmbiguous: input.creationAmbiguous === true,
    bookingId: BOOKING,
    paymentId: PAYMENT,
    idempotencyKey: IDEMPOTENCY,
    githubRunId: "40114158363",
    githubRunAttempt: "1",
    operationFailure: input.operationFailure ?? null,
    blocked: input.blocked ?? null,
    fetchImpl,
    readBooking: async () => input.booking === undefined ? null : input.booking,
  });
  return { record, expireCalls: calls.filter((call) => call.startsWith("POST ")).length, calls };
}

function assertRedacted(record: PaymentRecoveryRecord): void {
  const text = JSON.stringify(record);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes("4242424242424242"), false);
  assert.equal(text.includes("checkout.stripe.com"), false);
  assert.equal(text.includes("whsec_"), false);
  assert.equal(text.includes("sk_live_"), false);
  assert.equal(text.includes("rk_live_"), false);
}

test("payment recovery gates stay closed", () => {
  assert.equal(STRIPE_TEST_EXECUTION_GATE, "closed");
  assert.equal(CREATE_EXPIRE_EXECUTION_GATE, "closed");
  const source = readFileSync(new URL("./stripe-test-harness.ts", import.meta.url), "utf8");
  assert.match(source, /reconcilePaymentRecovery\(/);
  assert.match(source, /const STRIPE_TEST_EXECUTION_GATE = "closed"/);
  assert.doesNotMatch(source, /STRIPE_TEST_EXECUTION_GATE = "open"/);
});

test("failure before Checkout creation reports no_session", async () => {
  let called = false;
  const { record } = await reconcile({
    sessionId: null,
    operationFailure: "webhook_secret_timeout",
    fetchImpl: async () => {
      called = true;
      throw new Error("unexpected");
    },
  });
  assert.equal(called, false);
  assert.equal(record.outcome, "no_session");
  assert.equal(record.creationAmbiguous, false);
  assert.equal(record.operationFailure, "webhook_secret_timeout");
  assertRedacted(record);
});

test("ambiguous creation without a Session ID stays unresolved", async () => {
  let called = false;
  const { record } = await reconcile({
    sessionId: null,
    creationAmbiguous: true,
    operationFailure: "stripe_test_harness_failed",
    fetchImpl: async () => {
      called = true;
      throw new Error("unexpected");
    },
  });
  assert.equal(called, false);
  assert.equal(record.outcome, "recovery_required");
  assert.notEqual(record.outcome, "no_session");
  assert.equal(record.creationAmbiguous, true);
  assert.equal(record.idempotencyKey, IDEMPOTENCY);
  assert.equal(record.githubRunId, "40114158363");
  assert.equal(record.recoveryFailure, "creation_ambiguous");
  assert.equal(record.operationFailure, "stripe_test_harness_failed");
  assertRedacted(record);
});

test("created unpaid Session is expired and independently verified", async () => {
  let gets = 0;
  const { record, expireCalls } = await reconcile({
    operationFailure: "checkout_browser_failed",
    fetchImpl: async (_url, init) => {
      if ((init?.method ?? "GET") === "POST") return jsonResponse(200, session({ status: "expired" }));
      gets += 1;
      return jsonResponse(200, session({ status: gets === 1 ? "open" : "expired" }));
    },
  });
  assert.equal(expireCalls, 1);
  assert.equal(gets, 2);
  assert.equal(record.outcome, "unpaid_expired");
  assert.equal(record.sessionId, SESSION);
  assert.equal(record.recoveryFailure, null);
  assertRedacted(record);
});

test("already expired unpaid Session is not expired again", async () => {
  const { record, expireCalls } = await reconcile({
    fetchImpl: async () => jsonResponse(200, session({ status: "expired", payment_status: "unpaid" })),
  });
  assert.equal(expireCalls, 0);
  assert.equal(record.outcome, "unpaid_expired");
  assertRedacted(record);
});

test("expiry failure still accepts an independently verified expired Session", async () => {
  let gets = 0;
  const { record, expireCalls } = await reconcile({
    fetchImpl: async (_url, init) => {
      if ((init?.method ?? "GET") === "POST") return jsonResponse(500, { error: { message: "secret https://checkout.stripe.com/c/pay/x" } });
      gets += 1;
      return jsonResponse(200, session({ status: gets === 1 ? "open" : "expired" }));
    },
  });
  assert.equal(expireCalls, 1);
  assert.equal(record.outcome, "unpaid_expired");
  assert.equal(record.recoveryFailure, "expire_failed");
  assertRedacted(record);
});

test("expiry failure without a final state stays unresolved", async () => {
  let gets = 0;
  const { record, expireCalls } = await reconcile({
    operationFailure: "checkout_browser_failed",
    fetchImpl: async (_url, init) => {
      if ((init?.method ?? "GET") === "POST") return jsonResponse(500, { url: "https://checkout.stripe.com/c/pay/x" });
      gets += 1;
      if (gets === 1) return jsonResponse(200, session());
      return jsonResponse(503, { error: { message: SECRET } });
    },
  });
  assert.equal(expireCalls, 1);
  assert.equal(record.outcome, "recovery_required");
  assert.equal(record.operationFailure, "checkout_browser_failed");
  assert.equal(record.recoveryFailure, "expire_failed");
  assert.equal(record.sessionId, SESSION);
  assertRedacted(record);
});

test("paid Session with a confirmed booking is not expired", async () => {
  const { record, expireCalls } = await reconcile({
    booking: confirmedBooking(),
    fetchImpl: async () => jsonResponse(200, session({ status: "complete", payment_status: "paid" })),
  });
  assert.equal(expireCalls, 0);
  assert.equal(record.outcome, "paid_confirmed");
  assert.equal(record.sessionId, SESSION);
  assert.equal(record.bookingId, BOOKING);
  assertRedacted(record);
});

test("paid Session without booking confirmation is preserved", async () => {
  const { record, expireCalls } = await reconcile({
    booking: confirmedBooking({ lifecycleState: "awaiting_payment", paymentStatus: "pending", paidCount: 0 }),
    fetchImpl: async () => jsonResponse(200, session({ status: "complete", payment_status: "paid" })),
  });
  assert.equal(expireCalls, 0);
  assert.equal(record.outcome, "paid_unconfirmed");
  assert.equal(record.sessionId, SESSION);
  assertRedacted(record);
});

test("browser timeout after payment stays paid_unconfirmed", async () => {
  const { record, expireCalls } = await reconcile({
    operationFailure: "checkout_browser_failed",
    booking: null,
    fetchImpl: async () => jsonResponse(200, session({ status: "complete", payment_status: "paid", url: "https://checkout.stripe.com/c/pay/paid" })),
  });
  assert.equal(expireCalls, 0);
  assert.equal(record.outcome, "paid_unconfirmed");
  assert.equal(record.operationFailure, "checkout_browser_failed");
  assertRedacted(record);
});

test("webhook listener failure after payment stays paid_unconfirmed", async () => {
  const { record, expireCalls } = await reconcile({
    operationFailure: "webhook_not_captured",
    booking: confirmedBooking({ lifecycleState: "payment_processing", paymentStatus: "pending", paidCount: 0 }),
    fetchImpl: async () => jsonResponse(200, session({ status: "complete", payment_status: "paid" })),
  });
  assert.equal(expireCalls, 0);
  assert.equal(record.outcome, "paid_unconfirmed");
  assert.equal(record.operationFailure, "webhook_not_captured");
  assertRedacted(record);
});

test("Session retrieval timeout stays unresolved", async () => {
  const { record, expireCalls } = await reconcile({
    fetchImpl: async () => {
      throw timeoutError();
    },
  });
  assert.equal(expireCalls, 0);
  assert.equal(record.outcome, "recovery_required");
  assert.equal(record.recoveryFailure, "request_timeout");
  assert.equal(record.sessionId, SESSION);
  assertRedacted(record);
});

test("unexpected account, amount, currency or LIVE mode is not expired", async () => {
  const cases = [
    session({ account: "acct_other" }),
    session({ amount_total: 4501 }),
    session({ currency: "usd" }),
    session({ livemode: true }),
  ];
  for (const body of cases) {
    const { record, expireCalls } = await reconcile({
      fetchImpl: async () => jsonResponse(200, body),
    });
    assert.equal(expireCalls, 0);
    assert.equal(record.outcome, "recovery_required");
    assert.equal(record.recoveryFailure, "identity_rejected");
    assertRedacted(record);
  }
  const live = await reconcile({ sessionId: "cs_live_notexpired" });
  assert.equal(live.expireCalls, 0);
  assert.equal(live.record.outcome, "recovery_required");
  assert.equal(live.record.sessionId, "cs_live_notexpired");
  assertRedacted(live.record);
});

test("operation and recovery failures stay separate", async () => {
  const { record } = await reconcile({
    operationFailure: "https://checkout.stripe.com/c/pay/raw rk_test_secret 4242424242424242",
    fetchImpl: async () => {
      throw timeoutError();
    },
  });
  assert.equal(record.outcome, "recovery_required");
  assert.equal(record.operationFailure, "stripe_test_harness_failed");
  assert.equal(record.recoveryFailure, "request_timeout");
  assert.notEqual(record.operationFailure, record.recoveryFailure);
  assertRedacted(record);
});

test("secrets, card data and Checkout URLs are redacted", async () => {
  const { record } = await reconcile({
    operationFailure: "checkout_browser_failed",
    fetchImpl: async () => jsonResponse(200, session({
      status: "expired",
      payment_status: "unpaid",
      last_payment_error: SECRET,
    })),
  });
  assert.equal(record.outcome, "unpaid_expired");
  assertRedacted(record);
});

test("repeated reconciliation does not expire a paid Session", async () => {
  let posts = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    if ((init?.method ?? "GET") === "POST") posts += 1;
    return jsonResponse(200, session({ status: "complete", payment_status: "paid" }));
  };
  const first = await reconcile({ booking: confirmedBooking(), fetchImpl });
  const second = await reconcile({ booking: confirmedBooking(), fetchImpl });
  assert.equal(first.record.outcome, "paid_confirmed");
  assert.equal(second.record.outcome, "paid_confirmed");
  assert.equal(posts, 0);
  assertRedacted(first.record);
  assertRedacted(second.record);
});
