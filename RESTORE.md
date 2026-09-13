# RESTORE.md — reconstruct Aether without this conversation

## Source of truth

GitHub is authoritative for application source.

| Field | Value |
|---|---|
| Repository | `https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Known-good application source | `45e171a23037b7c94005018cd2126033a449d6f0` |
| Tag | `cp17-known-good` |

`cp17-known-good` is an immutable tag on that commit. When the tag was created,
`main` pointed at it. Later documentation-only commits on `main` do not change
the CP16C/CP17 application baseline.

Recovery ZIPs are **secondary disaster-recovery artifacts**. The CP10 ZIP in
`attachments/` is historical and **MUST NOT** be extracted over a newer Git
tree without explicit human approval.

A Grok workspace is disposable and is never authoritative.

Source-code state and production database state **must** be reported separately.
Every future production-readiness audit **must** name the exact Git commit
audited. Do **not** claim Neon production readiness merely because the source
repository is current.

**CP19** currently refers to production Neon binding/verification. It is **not**
yet a completed production checkpoint and is **not** a source-code commit.

### Source of truth order

1. GitHub repository + exact commit SHA (authoritative application source)
2. Checkpoint tag (`cp17-known-good` = known-good CP16C/CP17 source)
3. Recovery ZIP — secondary disaster-recovery artifact only
4. Grok workspace — disposable working environment
5. Chat — architectural / operational context, not source
6. Platform-generated/deployed state — **not** authoritative

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
- Time: `aether_athens_instant()` for Athens civil booking instants; hotel-local Ops Today uses `civilToday` / hotel IANA timezone
- Operator auth: scrypt + HttpOnly session `aether_ops_session` + CSRF cookie `aether_ops_csrf`
- Application DML roles:
  - `neondb_owner` — migration / schema owner
  - `aether_runtime` — PGLite/preview SET ROLE identity (must not own occupancy objects)
  - `aether_app` — SQL-created production LOGIN (must not own occupancy objects; must not be a Neon Console / `neon_superuser` role)
- Migrations use a separate owner connection: `AETHER_DATABASE_OWNER_URL`

Authoritative architecture notes: `docs/ARCHITECTURE.md`

## 3. Where is the source?

**GitHub**, not the workspace disk and not a ZIP.

```
git clone https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud.git
cd birch-hazel-stone-cloud
git checkout cp17-known-good
# equivalent: git checkout 45e171a23037b7c94005018cd2126033a449d6f0
```

Before modifying the application, identify: repository, branch, `HEAD` SHA, and
checkpoint tag. Confirm `HEAD` against `45e171a23037b7c94005018cd2126033a449d6f0`
or a later documented commit.

Application code (once checked out):

- `src/lib/aether/` — domain
- `src/routes/book.$hotelCode.tsx` — guest booking
- `src/routes/confirmed.$token.tsx` — confirmation
- `src/routes/ops*.tsx` — operations desk
- `src/lib/db.ts` — PGLite preview SET ROLE `aether_runtime` / Neon runtime (`aether_app` LOGIN; no production SET ROLE)

## 4. Where is the database schema?

SQL migrations in `migrations/`, applied in filename order. Platform `migrations/auth/` is unused (Better Auth is not the operator model).

Source tree includes `0002` through `0017`. That is **source** state. Production
Neon may lag until CP19 binding/verification completes.

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
| 14 | `0015_cp14_hotel_configuration.sql` | 14 |
| 15 | `0016_cp14_hotel_timezone.sql` | 14 |
| 16 | `0017_cp16_runtime_privilege_hardening.sql` | 16 |

Source files exist through **0017**. There is **no 0018**. Production Neon
application of 0012–0017 is **UNVERIFIED** until CP19.

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

No `.env` files are stored in git.

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

Last known-good **source**: CP16C/CP17 at `45e171a` / `cp17-known-good` (PGLite).
Neon remains unverified.

## 9. How is it deployed?

CP16C/CP17 is source-complete. Production deploy is blocked until Neon
owner/`aether_app` verification PASSes (CP19). Do not connect Vercel from this
source baseline. Do not treat a current GitHub clone as production readiness.

Do not call `init_or_update_app` / provision / reset / replace-app.

## 10. What must NEVER be done?

- Restore an older checkpoint ZIP over a newer Git tree without **explicit human approval**
- Treat the CP10 ZIP as current source
- Treat a Grok workspace as authoritative
- Call platform provisioner / `init_or_update_app` / reinitialise / reset app without **explicit human approval** (GATE A)
- Use the table-owner connection as the application runtime connection
- Claim Neon / production verification from PGLite results or from GitHub currency
- Substitute SQLite or mocks for PostgreSQL occupancy
- Rewrite git history (reset / revert / rebase / squash / force-push) as restore
- Commit secrets, `.env` values, or print credentials
- Redesign occupancy, booking, inventory, or auth as part of restore
- Reconstruct Aether as reception-only
- Continue building on an uncertain restore
- Create a CP19 tag, or claim CP19 complete, before Neon verification PASSes

## 11. Latest known-good checkpoint

**Source baseline: CP16C/CP17** — commit `45e171a23037b7c94005018cd2126033a449d6f0`,
tag `cp17-known-good`.

Historical trusted occupancy baseline remains **Checkpoint 10**. CP10
documentation and the CP10 ZIP are historical only.

Do not start production Vercel connection until Neon is verified (CP19).

## 12. How do you restore it?

Primary path (required):

1. Clone `https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud.git`.
2. Check out tag `cp17-known-good` (commit `45e171a23037b7c94005018cd2126033a449d6f0`),
   or a later documented commit on `main` after identifying SHA and checkpoint.
3. Record repository, branch, `HEAD` SHA, and checkpoint **before** modifying anything.
4. Read `BUILD_STATE.md`, `AETHER_RECOVERY_MANIFEST.json`, this file, then `docs/RECOVERY_MANIFEST.md`.
5. Run `sh scripts/restore_aether.sh` only as a sandbox helper after Git checkout — not as a ZIP overlay.
6. If the script fails, **stop**. Do not invent workarounds.
7. Start the app with `sh startup.sh` in this sandbox (serves the live preview).
8. Do not treat CP19 as complete. Do not connect Vercel until Neon verification PASSes.

Disaster-recovery path (ZIP) — **only** if GitHub is unavailable **and** a human
has explicitly approved overlaying that archive:

1. Do **not** extract `attachments/AETHER_TRANSFER_CP010_DATABASE_2026-09-05.zip`
   over a tree whose `HEAD` is newer than CP10.
2. Keep archives in `attachments/` — do not delete them.
3. Human review is required before any reconciliation with current GitHub.

## 13. What remains blocked?

- CP19: Neon production binding/verification (**not** a source commit)
- Neon application of 0012–0017 (credentials unavailable here)
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
That is a **database** blocker. It does not make GitHub source non-authoritative.
