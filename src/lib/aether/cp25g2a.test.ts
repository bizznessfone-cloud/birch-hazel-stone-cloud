import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("CP25G.2A /app parent enforces authentication before child loaders", () => {
  const app = read("src/routes/app.tsx");
  assert.match(app, /beforeLoad:/);
  assert.match(app, /getAppSession/);
  assert.match(app, /throw redirect\(\{\s*to:\s*["']\/login["']/);
  assert.match(app, /RedirectToSignIn/);
  const beforeLoadAt = app.indexOf("beforeLoad");
  const componentAt = app.indexOf("component:");
  assert.ok(beforeLoadAt >= 0 && componentAt > beforeLoadAt);
});

test("CP25G.2A protected /app child routes still use server authorization", () => {
  const onboardingFns = read("src/lib/aether/onboarding-fns.ts");
  assert.match(onboardingFns, /authMiddleware/);
  assert.match(onboardingFns, /getOnboardingState/);
  assert.match(onboardingFns, /context\.userId/);

  const stripeFns = read("src/lib/aether/stripe-fns.ts");
  assert.match(stripeFns, /authMiddleware/);
  assert.match(stripeFns, /getBillingState/);

  for (const path of [
    "src/routes/app.index.tsx",
    "src/routes/app.onboarding.tsx",
    "src/routes/app.hotels.$hotelId.tsx",
    "src/routes/app.hotels.$hotelId.preview.tsx",
    "src/routes/app.hotels.$hotelId.qr.tsx",
  ]) {
    assert.match(read(path), /getOnboardingState/, path);
  }
});

test("CP25G.2A /app/billing inherits the parent boundary", () => {
  const billing = read("src/routes/app.billing.tsx");
  assert.match(billing, /createFileRoute\("\/app\/billing"\)/);
  assert.doesNotMatch(billing, /beforeLoad:/);
  const app = read("src/routes/app.tsx");
  assert.match(app, /createFileRoute\("\/app"\)/);
  assert.match(app, /beforeLoad:/);
});

test("CP25G.2A public and Ops routes stay outside the SaaS /app boundary", () => {
  for (const path of [
    "src/routes/book.$hotelCode.tsx",
    "src/routes/confirmed.$token.tsx",
    "src/routes/login.tsx",
    "src/routes/index.tsx",
    "src/routes/$hotelSlug.tsx",
    "src/routes/ops.tsx",
    "src/routes/ops.login.tsx",
  ]) {
    const src = read(path);
    assert.doesNotMatch(src, /getAppSession/, path);
    assert.doesNotMatch(src, /getOnboardingState/, path);
  }
  const ops = read("src/routes/ops.tsx");
  assert.match(ops, /opsWhoAmI/);
  assert.doesNotMatch(ops, /getAppSession/);
});
