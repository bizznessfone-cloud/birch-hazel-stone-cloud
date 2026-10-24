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
  createDrillRunId,
  type DrillConfig,
  type RecoveryRecord,
} from "./stripe-test-create-expire.ts";

const SECRET = "rk_test_drillfixturekey0001";
const RUN_ID = `sbgce_${"ab".repeat(16)}`;

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
    runId: RUN_ID,
    idempotencyKey: "sbg-create-expire-fixture",
    githubRunId: "40106029723",
    githubRunAttempt: "1",
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
      sbg_drill_run_id: RUN_ID,
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

function recoveryOf(lines: string[]): RecoveryRecord {
  return JSON.parse(lines[0] ?? "") as RecoveryRecord;
}

function assertNoSecrets(lines: string[]): void {
  const text = lines.join("");
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes("checkout.stripe.com"), false);
  assert.equal(text.includes("whsec_"), false);
  assert.equal(text.includes("sk_live"), false);
  assert.equal(text.includes("rk_live"), false);
}

test("execution gate is open and a closed gate still blocks before Stripe", async () => {
  assert.equal(CREATE_EXPIRE_EXECUTION_GATE, "open");
  let called = false;
  const lines = await settle(openConfig({
    gate: "closed",
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, session());
    },
  }));
  assert.equal(called, false);
  const recovery = recoveryOf(lines);
  assert.equal(recovery.state, "create_expire_execution_closed");
  assert.equal(recovery.runId, RUN_ID);
  assert.equal(recovery.sessionIdObtained, false);
  assert.equal(recovery.githubRunId, "40106029723");
  assert.equal(recovery.githubRunAttempt, "1");
});

test("paid harness gate remains closed", () => {
  const harness = readFileSync(new URL("./stripe-test-harness.ts", import.meta.url), "utf8");
  assert.match(harness, /const STRIPE_TEST_EXECUTION_GATE = "closed"/);
});

test("wrong branch or environment is rejected", async () => {
  assert.equal(recoveryOf(await settle(openConfig({ ref: "refs/heads/main" }))).state, "branch_rejected");
  assert.equal(recoveryOf(await settle(openConfig({ environment: "production" }))).state, "environment_rejected");
});

test("missing, malformed and live credentials are rejected", async () => {
  assert.equal(recoveryOf(await settle(openConfig({ secret: undefined }))).state, "credential_absent");
  assert.equal(recoveryOf(await settle(openConfig({ secret: "sk_test_not_restricted_key" }))).state, "credential_malformed");
  assert.equal(recoveryOf(await settle(openConfig({ secret: "rk_live_not_allowed_here" }))).state, "live_credential_rejected");
  assert.equal(recoveryOf(await settle(openConfig({ secret: "sk_live_not_allowed_here" }))).state, "live_credential_rejected");
  assert.equal(recoveryOf(await settle(openConfig({ liveCheckoutFlag: "true" }))).state, "live_payment_flag");
  assert.equal(recoveryOf(await settle(openConfig({ saasCommerce: "live" }))).state, "live_payment_flag");
});

test("incorrect account, amount or currency is rejected before Stripe", async () => {
  assert.equal(recoveryOf(await settle(openConfig({ accountId: "acct_other" }))).state, "account_rejected");
  assert.equal(recoveryOf(await settle(openConfig({ amountMinor: 100 }))).state, "amount_rejected");
  assert.equal(recoveryOf(await settle(openConfig({ currency: "usd" }))).state, "currency_rejected");
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
  const recovery = recoveryOf(lines);
  assert.equal(recovery.state, "create_permission_denied");
  assert.equal(recovery.sessionIdObtained, false);
  assertNoSecrets(lines);
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
  assert.equal(params.get("metadata[sbg_drill_run_id]"), RUN_ID);
  assert.equal(params.get("metadata[sbg_github_run_id]"), "40106029723");
  assert.equal(params.get("metadata[sbg_github_run_attempt]"), "1");
  assert.equal(calls.some((call) => call.url.endsWith("/expire")), true);
  assert.deepEqual(recoveryOf(lines), {
    drill: "create_expire",
    runId: RUN_ID,
    connectedAccount: CONNECTED_ACCOUNT,
    githubRunId: "40106029723",
    githubRunAttempt: "1",
    state: "expired",
    operationFailure: null,
    cleanupFailure: null,
    sessionIdObtained: true,
    sessionId: "cs_test_fixture",
    livemode: false,
    amountMinor: 4500,
    currency: "eur",
    paymentStatus: "unpaid",
    finalStatus: "expired",
    paid: false,
  });
  assertNoSecrets(lines);
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
      return jsonResponse(200, expired ? session({ status: "expired" }) : session({ livemode: true }));
    },
  }));
  assert.equal(expired, true);
  assert.equal(recoveryOf(lines).state, "session_livemode_rejected");
  assert.equal(recoveryOf(lines).sessionId, "cs_test_fixture");
  assertNoSecrets(lines);
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
        return jsonResponse(200, session({ ...(gets === 1 ? field : {}), status: gets === 1 ? "open" : "expired" }));
      },
    }));
    assert.equal(recoveryOf(lines).state, "amount_total" in field ? "session_amount_rejected" : "session_currency_rejected");
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
  assert.equal(recoveryOf(lines).state, "retrieve_http_500");
  assert.equal(recoveryOf(lines).operationFailure, "retrieve_http_500");
  assert.equal(recoveryOf(lines).cleanupFailure, null);
  assert.equal(recoveryOf(lines).sessionId, "cs_test_fixture");
  assertNoSecrets(lines);
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
  const recovery = recoveryOf(lines);
  assert.equal(recovery.state, "expire_http_500");
  assert.equal(recovery.sessionIdObtained, true);
  assert.equal(recovery.sessionId, "cs_test_fixture");
  assert.equal(recovery.runId, RUN_ID);
  assertNoSecrets(lines);
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
  assert.equal(recoveryOf(lines).state, "expire_verification_failed");
  assert.equal(recoveryOf(lines).sessionId, "cs_test_fixture");
});

test("lost create response retries once with the same idempotency key", async () => {
  const keys: string[] = [];
  let creates = 0;
  let gets = 0;
  const bodies: string[] = [];
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (String(init?.method) === "POST" && url.endsWith("/expire")) return jsonResponse(200, session({ status: "expired" }));
      if (String(init?.method) === "POST") {
        creates += 1;
        keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        bodies.push(String(init?.body ?? ""));
        if (creates === 1) throw new DOMException("timed out", "TimeoutError");
        return jsonResponse(200, session());
      }
      gets += 1;
      return jsonResponse(200, session({ status: gets === 1 ? "open" : "expired" }));
    },
  }));
  assert.equal(creates, 2);
  assert.deepEqual(keys, ["sbg-create-expire-fixture", "sbg-create-expire-fixture"]);
  assert.equal(new URLSearchParams(bodies[0]).get("metadata[sbg_drill_run_id]"), RUN_ID);
  assert.equal(new URLSearchParams(bodies[1]).get("metadata[sbg_drill_run_id]"), RUN_ID);
  assert.equal(recoveryOf(lines).finalStatus, "expired");
  assert.equal(recoveryOf(lines).runId, RUN_ID);
});

test("a second lost create reports a possible orphan without a Checkout URL", async () => {
  const lines = await settle(openConfig({
    fetchImpl: async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  }));
  const recovery = recoveryOf(lines);
  assert.equal(recovery.state, "orphaned_session_possible");
  assert.equal(recovery.runId, RUN_ID);
  assert.equal(recovery.connectedAccount, CONNECTED_ACCOUNT);
  assert.equal(recovery.sessionIdObtained, false);
  assert.equal(recovery.sessionId, null);
  assert.equal(recovery.githubRunId, "40106029723");
  assert.equal(recovery.githubRunAttempt, "1");
  assertNoSecrets(lines);
});

test("run identifiers are unique and preserved", () => {
  const first = createDrillRunId();
  const second = createDrillRunId();
  assert.match(first, /^sbgce_[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

test("mismatched drill-run metadata is rejected", async () => {
  let gets = 0;
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (String(init?.method) === "POST" && url.endsWith("/expire")) return jsonResponse(200, session({ status: "expired" }));
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      gets += 1;
      if (gets === 1) {
        return jsonResponse(200, session({
          metadata: {
            sbg_drill: "create_expire",
            sbg_connected_account: CONNECTED_ACCOUNT,
            sbg_synthetic: "true",
            sbg_drill_run_id: `sbgce_${"cd".repeat(16)}`,
          },
        }));
      }
      return jsonResponse(200, session({ status: "expired" }));
    },
  }));
  assert.equal(recoveryOf(lines).state, "session_metadata_rejected");
  assert.equal(recoveryOf(lines).runId, RUN_ID);
});

test("payment statuses other than unpaid are rejected", async () => {
  const paidCalls: string[] = [];
  const paid = await settle(openConfig({
    fetchImpl: async (input, init) => {
      paidCalls.push(String(input).endsWith("/expire") ? "expire" : String(init?.method));
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      return jsonResponse(200, session({ payment_status: "paid" }));
    },
  }));
  assert.equal(paidCalls.includes("expire"), false);
  assert.equal(recoveryOf(paid).state, "session_payment_status_rejected");
  assert.equal(recoveryOf(paid).sessionId, "cs_test_fixture");

  let gets = 0;
  const other = await settle(openConfig({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (String(init?.method) === "POST" && url.endsWith("/expire")) return jsonResponse(200, session({ status: "expired" }));
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      gets += 1;
      return jsonResponse(200, session({
        payment_status: gets === 1 ? "no_payment_required" : "unpaid",
        status: gets === 1 ? "open" : "expired",
      }));
    },
  }));
  assert.equal(recoveryOf(other).state, "session_payment_status_rejected");
});

test("incorrect session identity is rejected", async () => {
  let gets = 0;
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (String(init?.method) === "POST" && url.endsWith("/expire")) return jsonResponse(200, session({ status: "expired" }));
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      gets += 1;
      return jsonResponse(200, session({ id: gets === 1 ? "cs_test_other" : "cs_test_fixture", status: gets === 1 ? "open" : "expired" }));
    },
  }));
  assert.equal(recoveryOf(lines).state, "session_id_rejected");
  assert.equal(recoveryOf(lines).sessionId, "cs_test_fixture");
});

test("final verification rejects mismatched identity, money, mode and status", async () => {
  const cases: Array<{ field: Record<string, unknown> }> = [
    { field: { id: "cs_test_other" } },
    { field: { livemode: true } },
    { field: { amount_total: 100 } },
    { field: { currency: "usd" } },
    { field: { mode: "subscription" } },
    { field: { status: "open" } },
    { field: { payment_status: "paid" } },
    { field: { metadata: { sbg_drill: "create_expire", sbg_connected_account: CONNECTED_ACCOUNT, sbg_synthetic: "true", sbg_drill_run_id: `sbgce_${"ef".repeat(16)}` } } },
  ];
  for (const item of cases) {
    let gets = 0;
    const lines = await settle(openConfig({
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (String(init?.method) === "POST" && url.endsWith("/expire")) return jsonResponse(200, session({ status: "expired" }));
        if (String(init?.method) === "POST") return jsonResponse(200, session());
        gets += 1;
        return jsonResponse(200, session({ status: gets === 1 ? "open" : "expired", ...(gets === 1 ? {} : item.field) }));
      },
    }));
    assert.equal(recoveryOf(lines).state, "expire_verification_failed", JSON.stringify(item.field));
    assert.equal(recoveryOf(lines).sessionId, "cs_test_fixture");
    assertNoSecrets(lines);
  }
});

test("unsafe GitHub identifiers are omitted", async () => {
  let body = "";
  const lines = await settle(openConfig({
    githubRunId: "https://checkout.stripe.com/secret",
    githubRunAttempt: "attempt-one",
    fetchImpl: async (input, init) => {
      if (String(init?.method) === "POST" && !String(input).endsWith("/expire")) body = String(init?.body ?? "");
      throw new DOMException("timed out", "TimeoutError");
    },
  }));
  const recovery = recoveryOf(lines);
  assert.equal(recovery.githubRunId, null);
  assert.equal(recovery.githubRunAttempt, null);
  assert.equal(body.includes("checkout.stripe.com"), false);
  assert.equal(body.includes("sbg_github_run_id"), false);
  assertNoSecrets(lines);
});

function expireCalls(calls: string[]): number {
  return calls.filter((call) => call === "expire").length;
}

test("a non-retryable expiration response is attempted once", async () => {
  const calls: string[] = [];
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      const expire = String(input).endsWith("/expire");
      calls.push(expire ? "expire" : String(init?.method));
      if (expire) return jsonResponse(400, { error: { code: "resource_missing", message: `${SECRET} https://checkout.stripe.com/c/pay/secret` } });
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      return jsonResponse(200, session());
    },
  }));
  assert.equal(expireCalls(calls), 1);
  const recovery = recoveryOf(lines);
  assert.equal(recovery.state, "expire_http_400");
  assert.equal(recovery.cleanupFailure, "expire_http_400");
  assert.equal(recovery.operationFailure, null);
  assert.equal(recovery.runId, RUN_ID);
  assert.equal(recovery.sessionId, "cs_test_fixture");
  assert.equal(recovery.connectedAccount, CONNECTED_ACCOUNT);
  assertNoSecrets(lines);
});

test("a retryable expiration failure stops after two attempts", async () => {
  const keys: string[] = [];
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/expire")) {
        keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        return jsonResponse(503, { error: { message: "whsec_secret https://checkout.stripe.com/c/pay/secret" } });
      }
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      return jsonResponse(200, session());
    },
  }));
  assert.deepEqual(keys, ["sbg-create-expire-fixture:expire", "sbg-create-expire-fixture:expire"]);
  assert.equal(recoveryOf(lines).state, "expire_http_503");
  assert.equal(recoveryOf(lines).cleanupFailure, "expire_http_503");
  assertNoSecrets(lines);
});

test("an expiration timeout can be retried once and then verified", async () => {
  let expires = 0;
  let gets = 0;
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/expire")) {
        expires += 1;
        if (expires === 1) throw new DOMException("timed out", "TimeoutError");
        return jsonResponse(200, session({ status: "expired" }));
      }
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      gets += 1;
      return jsonResponse(200, session({ status: gets === 1 ? "open" : "expired" }));
    },
  }));
  assert.equal(expires, 2);
  assert.equal(recoveryOf(lines).state, "expired");
  assert.equal(recoveryOf(lines).cleanupFailure, null);
});

test("an already-expired response is verified independently", async () => {
  let expires = 0;
  let gets = 0;
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/expire")) {
        expires += 1;
        return jsonResponse(400, {
          error: { code: "checkout_session_expired", message: `${SECRET} https://checkout.stripe.com/c/pay/secret` },
        });
      }
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      gets += 1;
      return jsonResponse(200, session({ status: gets === 1 ? "open" : "expired" }));
    },
  }));
  assert.equal(expires, 1);
  assert.equal(recoveryOf(lines).state, "expired");
  assert.equal(recoveryOf(lines).finalStatus, "expired");
  assertNoSecrets(lines);

  let rejectedExpires = 0;
  const rejected = await settle(openConfig({
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/expire")) {
        rejectedExpires += 1;
        return jsonResponse(400, { error: { code: "checkout_session_expired" } });
      }
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      return jsonResponse(200, session({ status: "open" }));
    },
  }));
  assert.equal(rejectedExpires, 1);
  assert.equal(recoveryOf(rejected).state, "expire_verification_failed");
});

test("retrieval failure followed by cleanup failure keeps both classifications", async () => {
  let expires = 0;
  const lines = await settle(openConfig({
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/expire")) {
        expires += 1;
        return jsonResponse(400, { error: { message: "https://checkout.stripe.com/c/pay/secret" } });
      }
      if (String(init?.method) === "POST") return jsonResponse(200, session());
      return jsonResponse(500, { error: { message: SECRET } });
    },
  }));
  assert.equal(expires, 1);
  const recovery = recoveryOf(lines);
  assert.equal(recovery.state, "expire_http_400");
  assert.equal(recovery.operationFailure, "retrieve_http_500");
  assert.equal(recovery.cleanupFailure, "expire_http_400");
  assert.equal(recovery.runId, RUN_ID);
  assert.equal(recovery.sessionId, "cs_test_fixture");
  assert.equal(recovery.connectedAccount, CONNECTED_ACCOUNT);
  assert.equal(recovery.githubRunId, "40106029723");
  assert.equal(recovery.githubRunAttempt, "1");
  assert.notEqual(recovery.state, "expired");
  assertNoSecrets(lines);
});


