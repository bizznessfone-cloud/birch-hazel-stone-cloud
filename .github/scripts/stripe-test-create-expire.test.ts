import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AMOUNT_MINOR,
  CANCEL_URL,
  CONNECTED_ACCOUNT,
  CREATE_EXPIRE_EXECUTION_GATE,
  CURRENCY,
  REQUIRED_ENVIRONMENT,
  REQUIRED_REF,
  SUCCESS_URL,
  reportDrill,
  type DrillConfig,
} from "./stripe-test-create-expire.ts";

const SECRET = "rk_test_drillfixturekey0001";

function openConfig(overrides: Partial<DrillConfig> = {}): DrillConfig {
  return {
    gate: "open",
    ref: REQUIRED_REF,
    environment: REQUIRED_ENVIRONMENT,
    secret: SECRET,
    liveCheckoutFlag: "false",
    saasCommerce: "off",
    accountId: CONNECTED_ACCOUNT,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    idempotencyKey: "sbg-create-expire-fixture",
    fetchImpl: async () => {
      throw new Error("unexpected_fetch");
    },
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cs_test_fixture",
    livemode: false,
    mode: "payment",
    amount_total: 4500,
    currency: "eur",
    payment_status: "unpaid",
    status: "open",
    url: "https://checkout.stripe.com/c/pay/secret",
    metadata: {
      sbg_drill: "create_expire",
      sbg_connected_account: CONNECTED_ACCOUNT,
      sbg_synthetic: "true",
    },
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function settle(config: DrillConfig): Promise<string[]> {
  const lines: string[] = [];
  await reportDrill(config, lines);
  return lines;
}

test("execution gate is closed and blocks dispatch before Stripe", async () => {
  assert.equal(CREATE_EXPIRE_EXECUTION_GATE, "closed");
  let called = false;
  const lines = await settle(openConfig({
    gate: CREATE_EXPIRE_EXECUTION_GATE,
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, session());
    },
  }));
  assert.equal(called, false);
  assert.deepEqual(lines, ["create_expire_execution_closed"]);
});

test("paid harness gate remains closed", () => {
  const harness = readFileSync(new URL("./stripe-test-harness.ts", import.meta.url), "utf8");
  assert.match(harness, /const STRIPE_TEST_EXECUTION_GATE = "closed"/);
});

test("wrong branch or environment is rejected", async () => {
  assert.deepEqual(await settle(openConfig({ ref: "refs/heads/main" })), ["branch_rejected"]);
  assert.deepEqual(await settle(openConfig({ environment: "production" })), ["environment_rejected"]);
});

test("missing, malformed and live credentials are rejected", async () => {
  assert.deepEqual(await settle(openConfig({ secret: undefined })), ["credential_absent"]);
  assert.deepEqual(await settle(openConfig({ secret: "sk_test_not_restricted_key" })), ["credential_malformed"]);
  assert.deepEqual(await settle(openConfig({ secret: "rk_live_not_allowed_here" })), ["live_credential_rejected"]);
  assert.deepEqual(await settle(openConfig({ secret: "sk_live_not_allowed_here" })), ["live_credential_rejected"]);
  assert.deepEqual(await settle(openConfig({ liveCheckoutFlag: "true" })), ["live_payment_flag"]);
  assert.deepEqual(await settle(openConfig({ saasCommerce: "live" })), ["live_payment_flag"]);
});

test("incorrect account, amount or currency is rejected before Stripe", async () => {
  assert.deepEqual(await settle(openConfig({ accountId: "acct_other" })), ["account_rejected"]);
  assert.deepEqual(await settle(openConfig({ amountMinor: 100 })), ["amount_rejected"]);
  assert.deepEqual(await settle(openConfig({ currency: "usd" })), ["currency_rejected"]);
});

test("permission denial is sanitised and does not expire another session", async () => {
  const calls: string[] = [];
  const lines = await settle(openConfig({
    fetchImpl: async (_input, init) => {
      calls.push(String(init?.method));
      return jsonResponse(403, {
        error: {
          code: "more_permissions_required",
          message: `${SECRET} https://checkout.stripe.com/c/pay/secret`,
        },
      });
    },
  }));
  assert.deepEqual(calls, ["POST"]);
  assert.deepEqual(lines, ["create_permission_denied"]);
  assert.equal(lines.join("").includes(SECRET), false);
  assert.equal(lines.join("").includes("checkout.stripe.com"), false);
});

test("successful create, retrieve and expire lifecycle", async () => {
  const calls: Array<{ method: string; url: string; idempotency: string; account: string; body: string }> = [];
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({
        method: String(init?.method),
        url,
        idempotency: headers.get("Idempotency-Key") ?? "",
        account: headers.get("Stripe-Account") ?? "",
        body: String(init?.body ?? ""),
      });
      if (init?.method === "POST" && url.endsWith("/expire")) return jsonResponse(200, session({ status: "expired" }));
      if (init?.method === "POST") return jsonResponse(200, session());
      if (calls.filter((call) => call.method === "GET").length === 1) return jsonResponse(200, session());
      return jsonResponse(200, session({ status: "expired", url: undefined }));
    },
  }));
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.account, CONNECTED_ACCOUNT);
  assert.equal(calls[0]?.idempotency, "sbg-create-expire-fixture");
  const params = new URLSearchParams(calls[0]?.body);
  assert.equal(params.get("line_items[0][price_data][unit_amount]"), "4500");
  assert.equal(params.get("line_items[0][price_data][currency]"), "eur");
  assert.equal(params.get("mode"), "payment");
  assert.equal(params.get("success_url"), SUCCESS_URL);
  assert.equal(params.get("cancel_url"), CANCEL_URL);
  assert.equal(params.has("application_fee_amount"), false);
  assert.equal([...params.keys()].some((key) => key.includes("transfer_data") || key.includes("application_fee")), false);
  assert.equal(calls.some((call) => call.url.endsWith("/expire")), true);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    drill: "create_expire",
    livemode: false,
    amountMinor: 4500,
    currency: "eur",
    paymentStatus: "unpaid",
    finalStatus: "expired",
    paid: false,
  });
  assert.equal(lines.join("").includes("cs_test_fixture"), false);
  assert.equal(lines.join("").includes("checkout.stripe.com"), false);
});

test("livemode true fails after cleanup", async () => {
  let expired = false;
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (String(init?.method) === "POST" && url.endsWith("/expire")) {
        expired = true;
        return jsonResponse(200, session({ livemode: true, status: "expired" }));
      }
      if (String(init?.method) === "POST") return jsonResponse(200, session({ livemode: true }));
      return jsonResponse(200, expired ? session({ livemode: true, status: "expired" }) : session({ livemode: true }));
    },
  }));
  assert.equal(expired, true);
  assert.deepEqual(lines, ["session_livemode_rejected"]);
});

test("retrieved amount or currency mismatch fails after cleanup", async () => {
  for (const field of [{ amount_total: 100 }, { currency: "usd" }] as const) {
    let gets = 0;
    const lines = await settle(openConfig({
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (String(init?.method) === "POST" && url.endsWith("/expire")) return jsonResponse(200, session({ ...field, status: "expired" }));
        if (String(init?.method) === "POST") return jsonResponse(200, session(field));
        gets += 1;
        return jsonResponse(200, session({ ...field, status: gets === 1 ? "open" : "expired" }));
      },
    }));
    assert.equal(lines[0], "amount_total" in field ? "session_amount_rejected" : "session_currency_rejected");
  }
});

test("retrieval failure still attempts expiration", async () => {
  const calls: string[] = [];
  let gets = 0;
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      const method = String(init?.method);
      const expire = String(input).endsWith("/expire");
      calls.push(expire ? "expire" : method);
      if (expire) return jsonResponse(200, session({ status: "expired" }));
      if (method === "POST") return jsonResponse(200, session());
      gets += 1;
      if (gets === 1) return jsonResponse(500, { error: { message: SECRET } });
      return jsonResponse(200, session({ status: "expired" }));
    },
  }));
  assert.equal(calls.includes("expire"), true);
  assert.equal(lines[0], "retrieve_http_500");
  assert.equal(lines.join("").includes(SECRET), false);
});

test("expiration failure is reported", async () => {
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      if (String(init?.method) === "POST" && String(input).endsWith("/expire")) {
        return jsonResponse(500, { error: { message: "whsec_secret" } });
      }
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      return jsonResponse(200, session());
    },
  }));
  assert.equal(lines[0], "expire_http_500");
  assert.equal(lines.join("").includes("whsec_secret"), false);
});

test("expiration verification failure is reported", async () => {
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (String(init?.method) === "POST" && url.endsWith("/expire")) return jsonResponse(200, session({ status: "open" }));
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      return jsonResponse(200, session({ status: "open" }));
    },
  }));
  assert.deepEqual(lines, ["expire_verification_failed"]);
});

test("lost create response retries once with the same idempotency key", async () => {
  const keys: string[] = [];
  let creates = 0;
  let gets = 0;
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (String(init?.method) === "POST" && url.endsWith("/expire")) return jsonResponse(200, session({ status: "expired" }));
      if (String(init?.method) === "POST") {
        creates += 1;
        keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        if (creates === 1) throw new DOMException("timed out", "TimeoutError");
        return jsonResponse(200, session());
      }
      gets += 1;
      return jsonResponse(200, session({ status: gets === 1 ? "open" : "expired" }));
    },
  }));
  assert.equal(creates, 2);
  assert.deepEqual(keys, ["sbg-create-expire-fixture", "sbg-create-expire-fixture"]);
  assert.equal(JSON.parse(lines[0] ?? "").finalStatus, "expired");
});

test("a second lost create reports a possible orphan without a Checkout URL", async () => {
  const lines = await settle(openConfig({
    fetchImpl: async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  }));
  assert.deepEqual(lines, ["orphaned_session_possible"]);
});
