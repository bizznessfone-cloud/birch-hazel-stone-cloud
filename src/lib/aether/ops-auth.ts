/**
 * Operator authentication engine. Database is the session store.
 * The session credential is a random token stored only as a SHA-256 hash
 * and issued in an HttpOnly cookie — never returned to JavaScript.
 */
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import {
  ensureLegacyDispatcherMembership,
  type AccessClass,
} from "./tenancy.ts";
import {
  assertProductionOpsCredentials,
  isForbiddenPreviewOpsCredential,
  isProductionOpsGuard,
} from "./runtime-config.ts";

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export const SESSION_COOKIE = "aether_ops_session";
export const CSRF_COOKIE = "aether_ops_csrf";
export const CSRF_HEADER = "x-aether-csrf";

/** Decision: 12 hours. Historical TTL is UNKNOWN. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/** Decision: 5 failures in 15 minutes per normalized login. */
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const THROTTLE_MAX_FAILURES = 5;

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 32;
export const SCRYPT_SALT_BYTES = 16;

export type OpsDb = {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
};

export type CookieOpts = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
};

export type CookieJar = {
  get(name: string): string | undefined;
  set(name: string, value: string, options: CookieOpts): void;
  delete(name: string, options: Pick<CookieOpts, "path">): void;
};

export type AuthEnv = {
  db: OpsDb;
  cookies: CookieJar;
  headers?: { get(name: string): string | null | undefined };
  cookieSecure?: boolean;
  now?: Date;
  production?: boolean;
};

export type OpsContext = {
  operatorId: string;
  login: string;
  sessionId: string;
  membershipId: string;
  accessClass: "hotel_desk" | "provider_dispatcher";
  hotelId: string | null;
  providerId: string | null;
};

export type OpsAuthCode =
  | "unauthenticated"
  | "csrf"
  | "throttled"
  | "invalid_credentials"
  | "no_membership"
  | "ambiguous_membership"
  | "forbidden";

export class OpsAuthError extends Error {
  readonly status: number;
  readonly code: OpsAuthCode;
  constructor(code: OpsAuthCode, status: number, message: string) {
    super(message);
    this.name = "OpsAuthError";
    this.code = code;
    this.status = status;
  }
}

export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newSecretToken(): string {
  return randomBytes(32).toString("base64url");
}

export type ScryptParams = {
  N?: number;
  r?: number;
  p?: number;
  keylen?: number;
};

export async function hashPassword(
  password: string,
  params: ScryptParams = {},
): Promise<string> {
  const N = params.N ?? SCRYPT_N;
  const r = params.r ?? SCRYPT_R;
  const p = params.p ?? SCRYPT_P;
  const keylen = params.keylen ?? SCRYPT_KEYLEN;
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scrypt(password, salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

function parsePasswordHash(stored: string): {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
} | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null;
  }
  try {
    const salt = Buffer.from(parts[4]!, "hex");
    const key = Buffer.from(parts[5]!, "hex");
    if (salt.length === 0 || key.length === 0) return null;
    return { N, r, p, salt, key };
  } catch {
    return null;
  }
}

let dummyHashPromise: Promise<string> | undefined;
function dummyStoredHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("aether-dummy-not-a-password");
  return dummyHashPromise;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) {
    await verifyPassword(password, await dummyStoredHash());
    return false;
  }
  const actual = await scrypt(password, parsed.salt, parsed.key.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
  });
  if (actual.length !== parsed.key.length) return false;
  return timingSafeEqual(actual, parsed.key);
}

function nowOf(env: AuthEnv): Date {
  return env.now ?? new Date();
}

function cookieBase(env: AuthEnv, httpOnly: boolean): CookieOpts {
  return {
    httpOnly,
    secure: Boolean(env.cookieSecure),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

function equalSecrets(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function createOperator(
  db: OpsDb,
  login: string,
  password: string,
  params?: ScryptParams,
): Promise<{ id: string; login: string }> {
  const normalized = normalizeLogin(login);
  if (!normalized) {
    throw new OpsAuthError("invalid_credentials", 401, "Invalid credentials");
  }
  const password_hash = await hashPassword(password, params);
  const rows = await db.query<{ id: string; login: string }>(
    `insert into operators (login, password_hash)
     values ($1, $2)
     returning id, login`,
    [normalized, password_hash],
  );
  const row = rows[0];
  if (!row) throw new Error("operator insert failed");
  return row;
}

export async function ensureOperatorFromEnv(
  db: OpsDb,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<void> {
  const login = env.AETHER_OPS_LOGIN?.trim();
  const password = env.AETHER_OPS_PASSWORD;
  if (!login || !password) return;
  assertProductionOpsCredentials(login, password, env);
  const normalized = normalizeLogin(login);
  const password_hash = await hashPassword(password);
  const existing = await db.query<{ id: string }>(
    "select id from operators where login = $1",
    [normalized],
  );
  if (existing[0]) {
    await db.query("update operators set password_hash = $1 where id = $2", [
      password_hash,
      existing[0].id,
    ]);
    await ensureLegacyDispatcherMembership(db, existing[0].id);
    return;
  }
  const inserted = await db.query<{ id: string }>(
    "insert into operators (login, password_hash) values ($1, $2) returning id",
    [normalized, password_hash],
  );
  const id = inserted[0]?.id;
  if (!id) throw new Error("operator insert failed");
  await ensureLegacyDispatcherMembership(db, id);
}

async function failureCount(
  db: OpsDb,
  loginKey: string,
  since: Date,
): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n
     from login_attempts
     where login_key = $1
       and succeeded = false
       and attempted_at >= $2`,
    [loginKey, since.toISOString()],
  );
  return rows[0]?.n ?? 0;
}

async function recordAttempt(
  db: OpsDb,
  loginKey: string,
  succeeded: boolean,
  at: Date,
): Promise<void> {
  await db.query(
    `insert into login_attempts (login_key, succeeded, attempted_at)
     values ($1, $2, $3)`,
    [loginKey, succeeded, at.toISOString()],
  );
}

export async function loginOperator(
  env: AuthEnv,
  login: string,
  password: string,
): Promise<{ login: string; operatorId: string }> {
  const at = nowOf(env);
  const loginKey = normalizeLogin(login);
  if (!loginKey || !password) {
    throw new OpsAuthError("invalid_credentials", 401, "Invalid credentials");
  }

  const production =
    env.production === true ||
    (env.production !== false && isProductionOpsGuard());
  if (production && isForbiddenPreviewOpsCredential(login, password)) {
    const since = new Date(at.getTime() - THROTTLE_WINDOW_MS);
    const failures = await failureCount(env.db, loginKey, since);
    if (failures >= THROTTLE_MAX_FAILURES) {
      throw new OpsAuthError("throttled", 429, "Too many attempts");
    }
    await verifyPassword(password, await dummyStoredHash());
    await recordAttempt(env.db, loginKey, false, at);
    throw new OpsAuthError("invalid_credentials", 401, "Invalid credentials");
  }

  const since = new Date(at.getTime() - THROTTLE_WINDOW_MS);
  const failures = await failureCount(env.db, loginKey, since);
  if (failures >= THROTTLE_MAX_FAILURES) {
    throw new OpsAuthError("throttled", 429, "Too many attempts");
  }

  const operators = await env.db.query<{
    id: string;
    login: string;
    password_hash: string;
  }>("select id, login, password_hash from operators where login = $1", [
    loginKey,
  ]);
  const operator = operators[0];
  const stored = operator?.password_hash ?? (await dummyStoredHash());
  const ok = (await verifyPassword(password, stored)) && Boolean(operator);
  await recordAttempt(env.db, loginKey, ok, at);
  if (!ok || !operator) {
    throw new OpsAuthError("invalid_credentials", 401, "Invalid credentials");
  }

  const hats = await env.db.query<{ id: string }>(
    `select id from operator_memberships
      where operator_id = $1::uuid and active`,
    [operator.id],
  );
  if (hats.length === 0) {
    throw new OpsAuthError("no_membership", 403, "No organisational membership");
  }
  if (hats.length > 1) {
    throw new OpsAuthError(
      "ambiguous_membership",
      403,
      "Multiple memberships; sign-in cannot choose automatically",
    );
  }
  const membershipId = hats[0]!.id;

  const sessionToken = newSecretToken();
  const csrfToken = newSecretToken();
  const expires = new Date(at.getTime() + SESSION_TTL_MS);
  await env.db.query(
    `insert into sessions (operator_id, membership_id, token_hash, csrf_hash, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [operator.id, membershipId, hashToken(sessionToken), hashToken(csrfToken), expires.toISOString()],
  );

  env.cookies.set(SESSION_COOKIE, sessionToken, cookieBase(env, true));
  env.cookies.set(CSRF_COOKIE, csrfToken, cookieBase(env, false));

  return { login: operator.login, operatorId: operator.id };
}

export async function requireOps(
  env: AuthEnv,
  options: { csrf: boolean },
): Promise<OpsContext> {
  const sessionToken = env.cookies.get(SESSION_COOKIE);
  if (!sessionToken) {
    throw new OpsAuthError("unauthenticated", 401, "Unauthorized");
  }

  const at = nowOf(env);
  const rows = await env.db.query<{
    id: string;
    operator_id: string;
    login: string;
    csrf_hash: string;
    expires_at: string;
    revoked_at: string | null;
    membership_id: string;
    access_class: AccessClass | null;
    hotel_id: string | null;
    provider_id: string | null;
    membership_active: boolean | null;
  }>(
    `select s.id, s.operator_id, o.login, s.csrf_hash, s.expires_at, s.revoked_at,
            s.membership_id, m.access_class, m.hotel_id, m.provider_id, m.active as membership_active
       from sessions s
       join operators o on o.id = s.operator_id
       left join operator_memberships m on m.id = s.membership_id
      where s.token_hash = $1`,
    [hashToken(sessionToken)],
  );
  const session = rows[0];
  if (!session || session.revoked_at) {
    throw new OpsAuthError("unauthenticated", 401, "Unauthorized");
  }
  if (new Date(session.expires_at).getTime() <= at.getTime()) {
    throw new OpsAuthError("unauthenticated", 401, "Unauthorized");
  }
  if (
    !session.membership_id ||
    !session.membership_active ||
    !session.access_class ||
    (session.access_class === "hotel_desk" && !session.hotel_id) ||
    (session.access_class === "provider_dispatcher" && !session.provider_id)
  ) {
    throw new OpsAuthError("no_membership", 403, "No organisational membership");
  }

  if (options.csrf) {
    const csrfCookie = env.cookies.get(CSRF_COOKIE) ?? "";
    const csrfHeader = env.headers?.get(CSRF_HEADER) ?? "";
    if (
      !csrfCookie ||
      !csrfHeader ||
      !session.csrf_hash ||
      !equalSecrets(csrfCookie, csrfHeader) ||
      !equalSecrets(hashToken(csrfCookie), session.csrf_hash)
    ) {
      throw new OpsAuthError("csrf", 403, "Forbidden");
    }
  }

  return {
    operatorId: session.operator_id,
    login: session.login,
    sessionId: session.id,
    membershipId: session.membership_id,
    accessClass: session.access_class,
    hotelId: session.hotel_id,
    providerId: session.provider_id,
  };
}

export async function logoutOperator(env: AuthEnv): Promise<void> {
  const sessionToken = env.cookies.get(SESSION_COOKIE);
  if (sessionToken) {
    try {
      await requireOps(env, { csrf: true });
    } catch (err) {
      if (err instanceof OpsAuthError && err.code === "csrf") throw err;
      env.cookies.delete(SESSION_COOKIE, { path: "/" });
      env.cookies.delete(CSRF_COOKIE, { path: "/" });
      return;
    }
    await env.db.query(
      `update sessions
       set revoked_at = $1
       where token_hash = $2 and revoked_at is null`,
      [nowOf(env).toISOString(), hashToken(sessionToken)],
    );
  }
  env.cookies.delete(SESSION_COOKIE, { path: "/" });
  env.cookies.delete(CSRF_COOKIE, { path: "/" });
}
