# RESTORE.md — reconstruct Aether without this conversation

## 1. What is Aether?

Aether Transfer is a guest-first hotel transfer service.

Primary journey:

```
HOTEL QR CODE
      ↓
GUEST OPENS AETHER  (/book/{hotelCode})
      ↓
SELECT TRANSFER
      ↓
ENTER DETAILS
      ↓
BOOK
      ↓
CONFIRMATION  (/confirmed/{token})
      ↓
DONE
```

Reception / ops (`/ops`) is a fallback and management interface. Do not reconstruct Aether as a reception-only booking system.

Guest lockup: **SCAN. BOOK. GO.**

## 2. Architecture

- TanStack Start + React + TypeScript + Tailwind v4
- PostgreSQL is the system of record
- Preview/dev database: PGLite (embedded PostgreSQL) with `btree_gist` — **development substitute only**
- Production database: Neon PostgreSQL
- Occupancy: trigger-maintained `occupies` + `tstzrange [)` + vehicle/driver GiST EXCLUDE
- Time: `aether_athens_instant()` only (Europe/Athens civil time)
- Operator auth: scrypt + HttpOnly session `aether_ops_session` + CSRF cookie `aether_ops_csrf`
- Application DML roles:
  - `neondb_owner` — migration / schema owner
  - `aether_runtime` — PGLite/preview SET ROLE identity (must not own occupancy objects)
  - `aether_app` — SQL-created production LOGIN (must not own occupancy objects; must not be a Neon Console / `neon_superuser` role)
- Migrations use a separate owner connection: `AETHER_DATABASE_OWNER_URL`

Authoritative architecture notes: `docs/ARCHITECTURE.md`

## 3. Where is the source?

Workspace root. Application code:

- `src/lib/aether/` — domain
- `src/routes/book.$hotelCode.tsx` — guest booking
- `src/routes/confirmed.$token.tsx` — confirmation
- `src/routes/ops*.tsx` — operations desk
- `src/lib/db.ts` — PGLite preview SET ROLE `aether_runtime` / Neon runtime (`aether_app` LOGIN; no startup role option)

## 4. Where is the database schema?

SQL migrations in `migrations/`, applied in filename order. Platform `migrations/auth/` is unused (Better Auth is not the operator model).

## 5. What migrations must run?

| Order | File | Phase |
|---|---|---|
| 1 | `0002_foundation.sql` | 0 |
| 2 | `0003_occupancy.sql` | 1 |
| 3 | `0004_ops_auth.sql` | 2 |
| 4 | `0005_time_domain.sql` | 3 |
| 5 | `0006_booking_engine.sql` | 4 |
| 6 | `0007_inventory.sql` | 5 |
| 7 | `0008_guest_ux.sql` | 6 |
| 8 | `0009_ops_desk.sql` | 7 |
| 9 | `0010_hotel_white_label.sql` | 8 |
| 10 | `0011_production_hardening.sql` | 10 |
| 11 | `0012_cp12_tenancy.sql` | 12 |
| 12 | `0013_cp12b_runtime_login.sql` | 12b |
| 13 | `0014_cp13a_production_app_role.sql` | 13a |

`aether_meta.schema_phase = 13`, checkpoint = 13a after 0014.

Preview: `src/lib/db.ts` applies these to PGLite at startup, then SET ROLE `aether_runtime`.

Production: `scripts/migrate.mjs` uses `AETHER_DATABASE_OWNER_URL` **only**. Missing owner URL fails. `DATABASE_URL` is never a migrate fallback. The deployed app must connect as `aether_app` LOGIN, not as the owner, not as a Neon Console role, and must not SET ROLE. The `aether_app` password is supplied out of band; never in SQL.

## 6. Required environment variable names (never commit values)

See `.env.example`.

| Name | Required in production | Secret |
|---|---|---|
| `DATABASE_URL` | yes — runtime role, not owner | yes |
| `AETHER_DATABASE_OWNER_URL` | yes — migrations only | yes |
| `AETHER_OPS_LOGIN` | no (preview bootstrap) | no |
| `AETHER_OPS_PASSWORD` | no (preview bootstrap) | yes |
| `AETHER_RESTORE_TARGET` | no (`preview` or `production`) | no |

No `.env` files are stored in checkpoints.

## 7. How is it built?

```
npm install
npm run typecheck
npm run build
```

`npm run build` runs `db:migrate`. If both database URLs are unset, migrate **skips** and PGLite migrates at process start. That skip is preview behaviour, not production verification.

## 8. How is it tested?

```
npm run test:aether
npm run typecheck
```

Last known-good: CP12B committed source + CP13A local role split (PGLite). Neon remains unverified.

## 9. How is it deployed?

CP13A is source-only production-role work. Production deploy is blocked until Neon
owner/`aether_app` verification PASSes. Do not connect Vercel from this checkpoint.

Do not call `init_or_update_app` / provision / reset / replace-app.

## 10. What must NEVER be done?

- Call platform provisioner / `init_or_update_app` / reinitialise / reset app without **explicit human approval** (GATE A)
- Use the table-owner connection as the application runtime connection
- Claim Neon / production verification from PGLite results
- Substitute SQLite or mocks for PostgreSQL occupancy
- Overwrite a completed checkpoint (create CP10A / CP11 instead)
- Commit secrets, `.env` values, or print credentials
- Redesign occupancy, booking, inventory, or auth as part of restore
- Reconstruct Aether as reception-only
- Continue building on an uncertain restore

## 11. Latest known-good checkpoint

**Checkpoint 13a** — CP13A SQL-created production LOGIN `aether_app`.

Historical trusted occupancy baseline remains **Checkpoint 10**. CP12/CP12A added tenancy. CP12B hardened fail-closed production. CP13A does not rewrite occupancy.

Do not start CP13B from restore. Do not connect Vercel until Neon is verified.

## 12. How do you restore it?

1. Start a fresh TanStack Start sandbox (or any Node 22 workspace).
2. Extract the checkpoint zip over the workspace, preserving `node_modules` if present.
3. Keep any user-uploaded archives in `attachments/` — do not delete them.
4. Read `BUILD_STATE.md`, `AETHER_RECOVERY_MANIFEST.json`, this file, then `docs/RECOVERY_MANIFEST.md`.
5. Run `sh scripts/restore_aether.sh`.
6. If the script fails, **stop**. Do not invent workarounds.
7. Start the app with `sh startup.sh` in this sandbox (serves the live preview).
8. Do not start CP13B. Do not connect Vercel until Neon verification PASSes.

Alternatively: `sh scripts/restore_aether.sh` after extract.

## 13. What remains blocked?

- Neon application of 0012 / 0013 / 0014 (credentials unavailable here)
- Neon `DATABASE_URL` proven as `aether_app` LOGIN (`session_user` = `current_user`)
- `aether_app` proven not a `neon_superuser` member
- Neon concurrency (overlapping vehicle and driver assignments)
- Production Secure cookie verification on a real HTTPS deployment
- Vercel project connection / env injection
- Out-of-band `aether_app` password on Neon (SQL-created role, never Console)

## 14. What credentials are still required?

Values are not stored here.

- Neon runtime `DATABASE_URL` (role `aether_app`, SQL-created LOGIN)
- Neon owner `AETHER_DATABASE_OWNER_URL` (`neondb_owner`)
- Production operator credentials if preview `desk` / `desk-pass` must not be used

If those are unavailable: **PRODUCTION VERIFICATION: BLOCKED. REASON: credentials unavailable.**

## Source of truth order

1. Database schema and migrations
2. Application source currently on disk
3. Checkpoint manifests / exported archives
4. Platform-generated/deployed state — **not authoritative**
