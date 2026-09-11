/**
 * Privilege split. Production DATABASE_URL authenticates as aether_app LOGIN.
 * PGLite/preview SET ROLE aether_runtime after owner migrations.
 * Application pools must not SET ROLE / options=-c role=.
 * Occupancy objects must not be owned by either application role.
 */
export {
  AETHER_RUNTIME_ROLE,
  AETHER_APP_ROLE,
  AETHER_DATABASE_OWNER_URL_ENV,
} from "./runtime-config.ts";
