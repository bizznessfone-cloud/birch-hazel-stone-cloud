/**
 * Production privilege split. The application DML role must not own
 * occupancy objects. Migrations use a separate owner connection.
 */
export const AETHER_RUNTIME_ROLE = "aether_runtime";

/** Optional. migrate.mjs uses this when set; otherwise DATABASE_URL. */
export const AETHER_DATABASE_OWNER_URL_ENV = "AETHER_DATABASE_OWNER_URL";

export function pgRuntimeRoleOptions(): string {
  return `-c role=${AETHER_RUNTIME_ROLE}`;
}
