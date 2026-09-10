/**
 * Production vs preview runtime policy.
 * PGLite is a local preview substitute only. Production must fail closed.
 */

export const AETHER_RUNTIME_ROLE = "aether_runtime";
export const AETHER_DATABASE_OWNER_URL_ENV = "AETHER_DATABASE_OWNER_URL";

/** Known preview bootstrap pair from startup.sh. Forbidden in production. */
export const PREVIEW_OPS_LOGIN = "desk";
export const PREVIEW_OPS_PASSWORD = "desk-pass";

export type EnvMap = Record<string, string | undefined>;

export function readTrimmedEnv(name: string, env: EnvMap = process.env): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export function isNodeProduction(env: EnvMap = process.env): boolean {
  return env.NODE_ENV === "production";
}

/** Vite/Nitro `npm run build` evaluates server modules with NODE_ENV=production. */
export function isBundlingProcess(
  env: EnvMap = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  const event = env.npm_lifecycle_event || "";
  if (event === "build" || event === "build:dev") return true;
  const joined = argv.join(" ");
  return /\bvite\b/.test(joined) && /\bbuild\b/.test(joined);
}

/**
 * Serving production traffic (or a production restore), not a preview and not
 * the production *bundle* step which often has no DATABASE_URL yet.
 */
export function isProductionRuntime(
  env: EnvMap = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (env.AETHER_RESTORE_TARGET === "production") return true;
  if (env.VERCEL_ENV === "production") return true;
  if (isNodeProduction(env) && !isBundlingProcess(env, argv)) return true;
  return false;
}

export function productionDatabaseRequiredError(): Error {
  return new Error(
    "Aether production requires DATABASE_URL pointing at PostgreSQL. The embedded preview database is not used in production.",
  );
}

export function assertProductionDatabaseUrl(
  env: EnvMap = process.env,
  argv: readonly string[] = process.argv,
): void {
  if (!isProductionRuntime(env, argv)) return;
  if (readTrimmedEnv("DATABASE_URL", env)) return;
  throw productionDatabaseRequiredError();
}

export function neonPoolSettings(): {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  allowExitOnIdle: boolean;
} {
  // One shared Pool per isolate. Vercel/Neon: keep this tiny so bursts of
  // lambdas cannot open an oversized connection storm.
  return {
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    allowExitOnIdle: true,
  };
}

export function isForbiddenPreviewOpsCredential(login: string, password: string): boolean {
  return login.trim().toLowerCase() === PREVIEW_OPS_LOGIN && password === PREVIEW_OPS_PASSWORD;
}

export function isProductionOpsGuard(env: EnvMap = process.env): boolean {
  return (
    isNodeProduction(env) ||
    env.AETHER_RESTORE_TARGET === "production" ||
    env.VERCEL_ENV === "production"
  );
}

export function assertProductionOpsCredentials(
  login: string | undefined,
  password: string | undefined,
  env: EnvMap = process.env,
): void {
  if (!isProductionOpsGuard(env)) return;
  if (!login || password == null) return;
  if (isForbiddenPreviewOpsCredential(login, password)) {
    throw new Error("Preview operator credentials are not permitted in production.");
  }
}
