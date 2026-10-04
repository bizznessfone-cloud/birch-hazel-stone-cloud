import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readinessResponse, type ReadyDb } from "./ready.ts";

const CONNECTION = ["post", "gres://", "user", ":", "password@", "example"].join("");
const SECRETS = [
  CONNECTION,
  "br-secret-branch",
  "ep-secret-endpoint",
  "neondb_owner",
  "sk_live_FAKE",
  "re_test_FAKE",
  "Error: internal stack\n    at ready (/workspace/src/secret/path.ts:1:1)",
];

function poisoned(): Error {
  const err = new Error(SECRETS.join(" "));
  err.stack = SECRETS.join("\n");
  return err;
}

async function textOf(response: Response): Promise<{ body: string; headers: string }> {
  const body = await response.text();
  const headers = [...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join("\n");
  return { body, headers };
}

function assertBinary(body: string, ok: boolean) {
  assert.equal(body, ok ? '{"ok":true}' : '{"ok":false}');
  assert.deepEqual(JSON.parse(body), { ok });
  assert.deepEqual(Object.keys(JSON.parse(body)), ["ok"]);
}

function assertNoSecrets(body: string, headers: string) {
  const blob = `${body}\n${headers}`;
  for (const secret of SECRETS) {
    assert.equal(blob.includes(secret), false, secret);
  }
  assert.equal(/postgres:|password|stack|neondb|sk_live|br-|ep-/i.test(blob), false);
}

test("healthy readiness is HTTP 200 with only ok true", async () => {
  const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
  const db: ReadyDb = {
    async query(text, params) {
      calls.push({ text, params });
      return [{ "?column?": 1 }];
    },
  };
  const response = await readinessResponse(async () => db);
  const { body, headers } = await textOf(response);
  assert.equal(response.status, 200);
  assertBinary(body, true);
  assert.match(headers, /content-type: application\/json/i);
  assert.match(headers, /cache-control: no-store/i);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(calls, [{ text: "select 1", params: undefined }]);
  assertNoSecrets(body, headers);
});

test("database failure is HTTP 503 with only ok false", async () => {
  const response = await readinessResponse(async () => {
    throw poisoned();
  });
  const { body, headers } = await textOf(response);
  assert.equal(response.status, 503);
  assertBinary(body, false);
  assert.match(headers, /cache-control: no-store/i);
  assert.match(headers, /content-type: application\/json/i);
  assert.equal(response.headers.get("set-cookie"), null);
  assertNoSecrets(body, headers);
});

test("query failure does not leak driver text", async () => {
  const db: ReadyDb = {
    async query() {
      throw poisoned();
    },
  };
  const response = await readinessResponse(async () => db);
  const { body, headers } = await textOf(response);
  assert.equal(response.status, 503);
  assertBinary(body, false);
  assertNoSecrets(body, headers);
});

test("readiness route is GET, SELECT 1, and not linked", () => {
  const route = readFileSync(join(process.cwd(), "src/routes/api/ready.ts"), "utf8");
  const impl = readFileSync(join(process.cwd(), "src/lib/aether/ready.ts"), "utf8");
  assert.match(route, /GET:/);
  assert.doesNotMatch(route, /\b(POST|PUT|PATCH|DELETE):/);
  assert.match(route, /readinessResponse\(\(\) => getSql\(\)\)/);
  assert.match(impl, /db\.query\("select 1"\)/);
  assert.doesNotMatch(`${route}\n${impl}`, /stripe|resend|audit_events|insert |update |delete |set role|set-cookie|cookie|createBooking|sendConfirmation/i);

  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      if (path.endsWith("src/routes/api/ready.ts") || path.endsWith("src/routeTree.gen.ts") || path.endsWith("src/lib/aether/ready.test.ts")) {
        continue;
      }
      if (readFileSync(path, "utf8").includes("/api/ready")) hits.push(path);
    }
  };
  walk(join(process.cwd(), "src"));
  assert.deepEqual(hits, []);
});
