/**
 * Owner/runtime migration policy. Never log connection strings.
 *
 * Production migrations use AETHER_DATABASE_OWNER_URL only.
 * DATABASE_URL is never a migrate fallback. Missing owner URL in production
 * fails (exit 1). Preview without owner URL skips (exit 0) so PGLite can
 * apply the same files at startup.
 */

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function isProductionMigrateTarget(env) {
  if (env.AETHER_RESTORE_TARGET === "production") return true;
  if (env.VERCEL_ENV === "production") return true;
  const runtime = (env.DATABASE_URL || "").trim();
  return env.NODE_ENV === "production" && Boolean(runtime);
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {{ action: "migrate", ownerUrl: string } | { action: "skip", reason: string } | { action: "fail", reason: string }}
 */
export function resolveMigratePlan(env) {
  const owner = (env.AETHER_DATABASE_OWNER_URL || "").trim();
  const runtime = (env.DATABASE_URL || "").trim();
  const production = isProductionMigrateTarget(env);

  if (production) {
    if (!owner) {
      return {
        action: "fail",
        reason:
          "production migrations require AETHER_DATABASE_OWNER_URL only; DATABASE_URL is never used and skipping is not allowed",
      };
    }
    if (runtime && owner === runtime) {
      return {
        action: "fail",
        reason:
          "AETHER_DATABASE_OWNER_URL must differ from DATABASE_URL — the runtime login must not apply schema",
      };
    }
    return { action: "migrate", ownerUrl: owner };
  }

  if (!owner) {
    return {
      action: "skip",
      reason:
        "AETHER_DATABASE_OWNER_URL not set — skipping (PGLite applies migrations at preview startup). DATABASE_URL is never used for migrations.",
    };
  }
  return { action: "migrate", ownerUrl: owner };
}
