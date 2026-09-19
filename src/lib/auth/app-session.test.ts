import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decideAppAccess } from "./app-session.ts";

const src = readFileSync(join(process.cwd(), "src/lib/auth/app-session.ts"), "utf8");

test("decideAppAccess allows the local dev user when auth is off and no database is configured", () => {
  assert.deepEqual(
    decideAppAccess({ authEnabled: false, databaseConfigured: false, hasSession: false }),
    { ok: true, mode: "dev" },
  );
});

test("decideAppAccess refuses the shared dev user when auth is off against a real database", () => {
  assert.deepEqual(
    decideAppAccess({ authEnabled: false, databaseConfigured: true, hasSession: false }),
    { ok: false, mode: "unauthenticated" },
  );
});

test("decideAppAccess requires a session when auth is on", () => {
  assert.deepEqual(
    decideAppAccess({ authEnabled: true, databaseConfigured: true, hasSession: false }),
    { ok: false, mode: "unauthenticated" },
  );
  assert.deepEqual(
    decideAppAccess({ authEnabled: true, databaseConfigured: true, hasSession: true }),
    { ok: true, mode: "session" },
  );
});

test("getAppSession probes without requireUserId and without a static server import", () => {
  assert.match(src, /createServerFn/);
  assert.match(src, /getSessionUser/);
  assert.match(src, /decideAppAccess/);
  assert.doesNotMatch(src, /requireUserId/);
  assert.doesNotMatch(src, /^import .*verify\.server/m);
  assert.doesNotMatch(src, /^import .*stripe\.server/m);
  assert.match(src, /await import\("\.\/verify\.server"\)/);
});
