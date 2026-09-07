/**
 * HTTP adapter for operator auth. Server-only: reads TanStack cookies/headers.
 * Do not import from client modules.
 */
import {
  deleteCookie,
  getCookie,
  getRequest,
  setCookie,
} from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  type AuthEnv,
  type CookieJar,
  type OpsContext,
  type OpsDb,
  ensureOperatorFromEnv,
  loginOperator,
  logoutOperator,
  requireOps as requireOpsEngine,
  OpsAuthError,
} from "./ops-auth";

function sqlDb(sql: {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
}): OpsDb {
  return {
    query: (text, params) => sql.query(text, params),
  };
}

function header(name: string): string | undefined {
  return getRequest()?.headers.get(name) ?? undefined;
}

function cookieSecure(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  if (process.env.DATABASE_URL?.trim()) return true;
  const proto = header("x-forwarded-proto");
  if (proto?.split(",")[0]?.trim() === "https") return true;
  try {
    const url = getRequest()?.url;
    if (url && new URL(url).protocol === "https:") return true;
  } catch {
    /* ignore */
  }
  return false;
}

function requestJar(): CookieJar {
  return {
    get: (name) => getCookie(name),
    set: (name, value, options) => {
      setCookie(name, value, options);
    },
    delete: (name, options) => {
      deleteCookie(name, options);
    },
  };
}

function requestEnv(): AuthEnv {
  return {
    db: sqlDb({
      query: async () => {
        throw new Error("db not bound");
      },
    }),
    cookies: requestJar(),
    headers: {
      get: (name) => header(name) ?? null,
    },
    cookieSecure: cookieSecure(),
  };
}

async function boundEnv(): Promise<AuthEnv> {
  const sql = await getSql();
  const env = requestEnv();
  env.db = sqlDb(sql);
  return env;
}

/**
 * Reject scripted cross-site/sibling requests. Complements the CSRF token:
 * SameSite=Lax cookies are sent to sibling grok.me apps.
 */
export function assertOpsRequestOrigin(): void {
  const request = getRequest();
  if (!request) return;
  const site = request.headers.get("sec-fetch-site");
  if (!site || site === "same-origin" || site === "none") return;
  throw new OpsAuthError("csrf", 403, "Forbidden");
}

export async function requireOps(
  options: { csrf?: boolean } = {},
): Promise<OpsContext> {
  assertOpsRequestOrigin();
  const env = await boundEnv();
  return requireOpsEngine(env, { csrf: options.csrf ?? true });
}

export async function loginOperatorFromRequest(
  login: string,
  password: string,
): Promise<{ login: string; operatorId: string }> {
  assertOpsRequestOrigin();
  const env = await boundEnv();
  await ensureOperatorFromEnv(env.db);
  return loginOperator(env, login, password);
}

export async function logoutOperatorFromRequest(): Promise<void> {
  assertOpsRequestOrigin();
  const env = await boundEnv();
  await logoutOperator(env);
}

export { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, OpsAuthError };
