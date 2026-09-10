#!/bin/sh
# Deterministic Aether restore. Fail closed. Never print secret values.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${AETHER_RESTORE_TARGET:-preview}"
FAIL=0
say() { printf '%s\n' "$*"; }
fail() { say "RESTORE FAILURE: $*"; FAIL=1; }

say "=== AETHER RESTORE ==="
say "target: $TARGET"
say "root: $ROOT"

# 1. required files
REQUIRED="
package.json
package-lock.json
startup.sh
src/lib/db.ts
src/lib/aether/constants.ts
src/lib/aether/runtime-role.ts
src/lib/aether/runtime-config.ts
scripts/migrate.mjs
scripts/migrate-policy.mjs
src/routes/book.\$hotelCode.tsx
src/routes/confirmed.\$token.tsx
src/routes/ops.login.tsx
migrations/0002_foundation.sql
migrations/0003_occupancy.sql
migrations/0004_ops_auth.sql
migrations/0005_time_domain.sql
migrations/0006_booking_engine.sql
migrations/0007_inventory.sql
migrations/0008_guest_ux.sql
migrations/0009_ops_desk.sql
migrations/0010_hotel_white_label.sql
migrations/0011_production_hardening.sql
migrations/0012_cp12_tenancy.sql
migrations/0013_cp12b_runtime_login.sql
"
for f in $REQUIRED; do
  if [ ! -e "$ROOT/$f" ]; then
    fail "missing required file: $f"
  fi
done
if [ "$FAIL" -ne 0 ]; then
  say "Failure: RESTORE FAILURE"
  say "Evidence: required source/migration files missing"
  say "Last known-good checkpoint: 12b"
  say "Safe recovery action: re-extract the CP12B source tree over the workspace"
  exit 1
fi

# 2. runtime
if ! command -v node >/dev/null 2>&1; then
  say "Failure: BUILD FAILURE"
  say "Evidence: node not on PATH"
  exit 1
fi
NODE_V="$(node -v)"
say "node: $NODE_V"

# 3. dependencies
if [ ! -d "$ROOT/node_modules" ]; then
  say "installing dependencies (node_modules missing)"
  npm install
fi
if [ ! -d "$ROOT/node_modules" ]; then
  say "Failure: BUILD FAILURE"
  say "Evidence: npm install did not produce node_modules"
  exit 1
fi

# 4. environment — names only, never print values
db_set=0
owner_set=0
[ -n "${DATABASE_URL:-}" ] && db_set=1
[ -n "${AETHER_DATABASE_OWNER_URL:-}" ] && owner_set=1
say "DATABASE_URL: $([ "$db_set" -eq 1 ] && echo SET || echo UNSET)"
say "AETHER_DATABASE_OWNER_URL: $([ "$owner_set" -eq 1 ] && echo SET || echo UNSET)"
say "AETHER_OPS_LOGIN: $([ -n "${AETHER_OPS_LOGIN:-}" ] && echo SET || echo UNSET)"
say "AETHER_OPS_PASSWORD: $([ -n "${AETHER_OPS_PASSWORD:-}" ] && echo SET || echo UNSET)"

if [ "$TARGET" = "production" ]; then
  if [ "$db_set" -eq 0 ] || [ "$owner_set" -eq 0 ]; then
    say "Failure: CREDENTIAL FAILURE"
    say "PRODUCTION VERIFICATION: BLOCKED"
    say "REASON: credentials unavailable"
    say "Evidence: production restore requires DATABASE_URL (runtime) AND AETHER_DATABASE_OWNER_URL (owner)"
    say "Likely cause: Neon credentials not injected into this environment"
    say "Affected component: production database"
    say "Last known-good checkpoint: 12b"
    say "Safe recovery action: supply both URLs, then re-run. Do not substitute PGLite."
    exit 1
  fi
  say "database path: Neon/PostgreSQL (production)"
else
  if [ "$db_set" -eq 0 ]; then
    say "DEVELOPMENT SUBSTITUTE: PGLite"
    say "This is NOT PostgreSQL production and MUST NOT be reported as production verification."
  else
    say "database path: DATABASE_URL is SET (treat as real PostgreSQL; still not 'production verified' unless target=production)"
  fi
fi

# 5. migrations
if [ "$owner_set" -eq 1 ]; then
  say "applying owner migrations via scripts/migrate.mjs
scripts/migrate-policy.mjs (AETHER_DATABASE_OWNER_URL only)"
  npm run db:migrate
else
  if [ "$TARGET" = "production" ]; then
    say "Failure: CREDENTIAL FAILURE"
    say "production migrate requires AETHER_DATABASE_OWNER_URL"
    exit 1
  fi
  say "preview migrations: skipped here; PGLite applies 0002-0013 at application startup (labelled substitute)"
fi

# 6. typecheck
say "typecheck"
npm run typecheck

# 7. automated tests
say "aether tests"
npm run test:aether

# 8. build (migrate skip is expected when URLs unset)
say "production build"
npm run build

say "=== RESTORE OK ==="
say "Application: source present"
say "Database: $([ "$TARGET" = "production" ] && echo production-path || echo "preview/PGLite substitute unless URL set")"
say "Tests: npm run test:aether completed"
say "Production: NOT claimed by this script unless target=production and Neon checks exist separately"
exit 0
