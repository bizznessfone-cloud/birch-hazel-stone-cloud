import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMigratePlan } from "./migrate-policy.mjs";

test("preview without owner URL skips and does not use DATABASE_URL", () => {
  const plan = resolveMigratePlan({
    NODE_ENV: "development",
    DATABASE_URL: "postgres://runtime:secret@localhost/db",
  });
  assert.equal(plan.action, "skip");
  assert.match(plan.reason, /AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(JSON.stringify(plan), /secret/);
});

test("preview with owner URL migrates as owner only", () => {
  const plan = resolveMigratePlan({
    NODE_ENV: "development",
    AETHER_DATABASE_OWNER_URL: "postgres://owner@localhost/db",
    DATABASE_URL: "postgres://runtime@localhost/db",
  });
  assert.equal(plan.action, "migrate");
  assert.equal(plan.ownerUrl, "postgres://owner@localhost/db");
});

test("production without owner URL fails closed even when DATABASE_URL is set", () => {
  const plan = resolveMigratePlan({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://runtime@localhost/db",
  });
  assert.equal(plan.action, "fail");
  assert.match(plan.reason, /AETHER_DATABASE_OWNER_URL/);
  assert.match(plan.reason, /never/);
});

test("production restore target without owner URL fails even without DATABASE_URL", () => {
  const plan = resolveMigratePlan({
    AETHER_RESTORE_TARGET: "production",
  });
  assert.equal(plan.action, "fail");
});

test("production with owner URL migrates; equal URLs fail", () => {
  const ok = resolveMigratePlan({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://runtime@localhost/db",
    AETHER_DATABASE_OWNER_URL: "postgres://owner@localhost/db",
  });
  assert.equal(ok.action, "migrate");
  assert.equal(ok.ownerUrl, "postgres://owner@localhost/db");

  const same = resolveMigratePlan({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://same@localhost/db",
    AETHER_DATABASE_OWNER_URL: "postgres://same@localhost/db",
  });
  assert.equal(same.action, "fail");
  assert.match(same.reason, /differ/);
});

test("local production build without DATABASE_URL still skips (preview bundle)", () => {
  const plan = resolveMigratePlan({
    NODE_ENV: "production",
    npm_lifecycle_event: "build",
  });
  assert.equal(plan.action, "skip");
});
