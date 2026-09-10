/**
 * Production privilege split. The application DML role must not own
 * occupancy objects. Migrations use AETHER_DATABASE_OWNER_URL only.
 * Production DATABASE_URL authenticates as aether_runtime LOGIN.
 * Application pools must not SET ROLE / options=-c role=.
 */
export {
  AETHER_RUNTIME_ROLE,
  AETHER_DATABASE_OWNER_URL_ENV,
} from "./runtime-config.ts";
