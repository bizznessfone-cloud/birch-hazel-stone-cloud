/**
 * CP26C-O2D — Owner authentication surface isolation.
 * Pure path decisions and source inspection. No Production, no Stripe, no migration.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  OWNER_ACCESS_UNAVAILABLE,
  OWNER_LOGIN_PATH,
  isOwnerLoginPath,
  ownerEntryDecision,
  safeOwnerReturnPath,
  safeSignOutPath,
  unauthenticatedOwnerRedirect,
} from "../auth/owner-login.ts";
import { isPlatformOwner } from "./owner-auth.ts";
import {
  OTHER_USER,
  OWNER_USER,
  PLATFORM_OWNER_USER,
  bootstrapPlatformOwner,
  insertAuthUser,
  openCp26cO2Db,
} from "./cp26a4-fixture.ts";
import type { Sql } from "@/lib/db";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const ALLOW_OWNER_MENTION = new Set([
  "src/routeTree.gen.ts",
  "src/routes/owner.tsx",
  "src/routes/owner.login.tsx",
  "src/routes/owner.index.tsx",
  "src/routes/owner.plans.tsx",
  "src/routes/owner.revenue.tsx",
  "src/routes/owner.system.tsx",
  "src/routes/owner.hotels.index.tsx",
  "src/routes/owner.hotels.$hotelId.tsx",
  "src/components/aether/owner-shell.tsx",
  "src/lib/auth/owner-login.ts",
  "src/lib/auth/owner-session.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

test("Owner return paths stay inside the control plane", () => {
  assert.equal(OWNER_LOGIN_PATH, "/owner/login");
  assert.equal(OWNER_ACCESS_UNAVAILABLE, "Owner access unavailable.");
  assert.equal(isOwnerLoginPath("/owner/login"), true);
  assert.equal(isOwnerLoginPath("/owner/login/"), true);
  assert.equal(isOwnerLoginPath("/owner/login/extra"), false);
  assert.equal(isOwnerLoginPath("/owner/plans"), false);

  for (const bad of [
    "https://evil.test/owner",
    "//evil.test",
    "/app",
    "/login",
    "/owner/login",
    "/owner/login/extra",
    "/%2f%2fevil.test",
    "/owner/../app",
    "/owner/./plans",
    "/\\owner",
    "/ownership",
    "/owner/plans?next=https://evil.test",
    "/owner/plans#hash",
    "",
    null,
    undefined,
  ]) {
    assert.equal(safeOwnerReturnPath(bad), "/owner", String(bad));
  }
  assert.equal(safeOwnerReturnPath("/owner"), "/owner");
  assert.equal(safeOwnerReturnPath("/owner/"), "/owner");
  assert.equal(safeOwnerReturnPath("/owner/plans"), "/owner/plans");
  assert.equal(safeOwnerReturnPath("/owner/revenue"), "/owner/revenue");
  assert.equal(safeOwnerReturnPath("/owner/system"), "/owner/system");
  assert.equal(safeOwnerReturnPath("/owner/hotels"), "/owner/hotels");
  assert.equal(
    safeOwnerReturnPath("/owner/hotels/11111111-1111-4111-8111-111111111111"),
    "/owner/hotels/11111111-1111-4111-8111-111111111111",
  );

  for (const path of ["/owner", "/owner/plans", "/owner/hotels", "/owner/revenue", "/owner/system"]) {
    const next = unauthenticatedOwnerRedirect(path);
    assert.equal(next?.to, "/owner/login");
    assert.equal(next?.search.redirect, path);
  }
  assert.equal(unauthenticatedOwnerRedirect("/owner/login"), null);
  assert.equal(unauthenticatedOwnerRedirect("/owner/login/extra")?.to, "/owner/login");
  assert.equal(unauthenticatedOwnerRedirect("/owner/login/extra")?.search.redirect, "/owner");
  assert.equal(unauthenticatedOwnerRedirect("/login"), null);
  assert.equal(unauthenticatedOwnerRedirect("/app"), null);
  assert.equal(unauthenticatedOwnerRedirect("/"), null);
});

test("Owner entry is server-gated and cannot be self-elevated", () => {
  assert.deepEqual(ownerEntryDecision({ ok: true }, "/owner/plans"), {
    action: "enter",
    path: "/owner/plans",
  });
  assert.deepEqual(ownerEntryDecision({ ok: true }, "https://evil.test"), {
    action: "enter",
    path: "/owner",
  });
  assert.deepEqual(ownerEntryDecision({ ok: false, reason: "forbidden" }, "/owner"), {
    action: "deny",
  });
  assert.deepEqual(ownerEntryDecision({ ok: false, reason: "unauthenticated" }, "/owner/plans"), {
    action: "signin",
  });

  assert.equal(safeSignOutPath("/owner/login"), "/owner/login");
  assert.equal(safeSignOutPath("/"), "/");
  assert.equal(safeSignOutPath("https://evil.test"), "/");
  assert.equal(safeSignOutPath("//evil.test"), "/");
  assert.equal(safeSignOutPath("/owner/login?next=https://evil.test"), "/");
  assert.equal(safeSignOutPath("javascript:alert(1)"), "/");

  const auth = read("src/lib/aether/owner-auth.ts");
  const session = read("src/lib/auth/owner-session.ts");
  const surface = read("src/lib/auth/owner-login.ts");
  assert.match(auth, /revoked_at is null/);
  assert.match(session, /isPlatformOwner/);
  assert.match(session, /getSessionUser/);
  assert.doesNotMatch(surface, /revoked_at|sbg_platform_owners|document\.cookie|localStorage/);
  assert.doesNotMatch(session, /searchParams|owner=true|document\.cookie/);
  assert.doesNotMatch(auth, /email\s*===|allowlist/);
  assert.match(read("src/lib/auth/client.ts"), /safeSignOutPath\(redirectTo\)/);
  const fns = read("src/lib/aether/owner-fns.ts");
  assert.equal((fns.match(/await requirePlatformOwner/g) ?? []).length, 10);
  assert.doesNotMatch(fns, /searchParams|owner=true/);
});

test("Owner login is sign-in only and operator login stays separate", () => {
  const ownerLogin = read("src/routes/owner.login.tsx");
  const operatorLogin = read("src/routes/login.tsx");
  const ownerRoute = read("src/routes/owner.tsx");
  const shell = read("src/components/aether/owner-shell.tsx");
  const home = read("src/routes/index.tsx");
  const app = read("src/routes/app.tsx");

  assert.match(ownerLogin, /Sign in/);
  assert.match(ownerLogin, /Internal platform access/);
  assert.match(ownerLogin, /getOwnerAccess/);
  assert.match(ownerLogin, /ownerEntryDecision/);
  assert.match(ownerLogin, /window\.location\.assign\(decision\.path\)/);
  assert.doesNotMatch(ownerLogin, /Create account|Create a new account|signUp|Get started|onboarding/i);
  assert.doesNotMatch(ownerLogin, /to:\s*"\/app"|to:\s*"\/login"|Hotel/);
  assert.match(ownerLogin, /OWNER_ACCESS_UNAVAILABLE/);
  assert.match(ownerLogin, /role="alert"/);
  assert.doesNotMatch(ownerLogin, /navigate\(\{\s*to:\s*"\/app"/);
  assert.match(read("src/lib/auth/owner-login.ts"), /Owner access unavailable\./);

  assert.match(operatorLogin, /Create account/);
  assert.match(operatorLogin, /signUp\.email/);
  assert.match(operatorLogin, /to:\s*"\/app"/);
  assert.doesNotMatch(operatorLogin, /\/owner/);

  assert.match(ownerRoute, /isOwnerLoginPath/);
  assert.match(ownerRoute, /unauthenticatedOwnerRedirect/);
  assert.match(ownerRoute, /PlatformOwnerForbiddenError/);
  assert.match(ownerRoute, /\/owner\/login/);
  assert.doesNotMatch(ownerRoute, /to:\s*"\/login"/);
  assert.doesNotMatch(ownerRoute, /to:\s*"\/app"/);

  assert.match(shell, /redirectTo=\{OWNER_LOGIN_PATH\}/);
  assert.match(shell, /signOut\(OWNER_LOGIN_PATH\)/);
  assert.match(shell, /Owner access unavailable/);
  assert.doesNotMatch(shell, /to:\s*"\/app"|to:\s*"\/login"/);

  assert.doesNotMatch(home, /\/owner/);
  assert.match(app, /to:\s*"\/login"/);
  assert.doesNotMatch(app, /\/owner/);

  for (const file of [
    "src/routes/owner.index.tsx",
    "src/routes/owner.plans.tsx",
    "src/routes/owner.revenue.tsx",
    "src/routes/owner.system.tsx",
    "src/routes/owner.hotels.index.tsx",
    "src/routes/owner.hotels.$hotelId.tsx",
  ]) {
    assert.match(read(file), /getOwner/);
  }
});

test("public and operator surfaces do not advertise the Owner control plane", () => {
  const hits: string[] = [];
  for (const abs of walk(join(root, "src"))) {
    const rel = abs.slice(root.length + 1);
    if (ALLOW_OWNER_MENTION.has(rel)) continue;
    const text = readFileSync(abs, "utf8");
    if (text.includes('"/owner') || text.includes("'/owner") || text.includes("`/owner")) hits.push(rel);
  }
  assert.deepEqual(hits, []);
  const migrations = readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql"));
  assert.equal(migrations.some((name) => name.startsWith("0027")), false);
});

function asSql(pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql {
  const sql = (async () => {
    throw new Error("tagged-template SQL is not used in CP26C-O2D tests");
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
    const result = await pg.query(text, params);
    return result.rows as T[];
  };
  return sql;
}

test("active Owner can enter; unauthenticated, non-Owner, and revoked Owner cannot", async () => {
  const pg = await openCp26cO2Db();
  const db = asSql(pg);
  await insertAuthUser(pg, PLATFORM_OWNER_USER);
  await insertAuthUser(pg, OWNER_USER);
  await insertAuthUser(pg, OTHER_USER);

  assert.equal(await isPlatformOwner(db, ""), false);
  assert.equal(await isPlatformOwner(db, OWNER_USER.id), false);
  assert.equal(await isPlatformOwner(db, OTHER_USER.id), false);
  assert.deepEqual(ownerEntryDecision({ ok: false, reason: "unauthenticated" }, "/owner/plans"), {
    action: "signin",
  });
  assert.deepEqual(ownerEntryDecision({ ok: false, reason: "forbidden" }, "/owner/revenue"), {
    action: "deny",
  });

  await bootstrapPlatformOwner(pg, PLATFORM_OWNER_USER.id, "o2d surface");
  assert.equal(await isPlatformOwner(db, PLATFORM_OWNER_USER.id), true);
  assert.equal(await isPlatformOwner(db, OWNER_USER.id), false);
  assert.deepEqual(ownerEntryDecision({ ok: true }, "/owner/plans"), {
    action: "enter",
    path: "/owner/plans",
  });

  await pg.query("update sbg_platform_owners set revoked_at = now() where user_id = $1", [
    PLATFORM_OWNER_USER.id,
  ]);
  assert.equal(await isPlatformOwner(db, PLATFORM_OWNER_USER.id), false);
  assert.deepEqual(ownerEntryDecision({ ok: false, reason: "forbidden" }, "/owner/system"), {
    action: "deny",
  });
});
