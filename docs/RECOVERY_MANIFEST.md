# Recovery manifest

This file must let a new developer or coding agent continue without the
original conversation. No secrets.

## Identity

| Field | Value |
|---|---|
| Product | Aether Transfer |
| Guest lockup | SCAN. BOOK. GO. |
| Current build version / checkpoint | **13a** (CP13A SQL-created production LOGIN `aether_app`) |
| Trusted occupancy baseline | **CP10** |
| Previous abandoned original CP11 used | **NO** |
| Current phase | **CP13A — source-only role split; Neon UNVERIFIED** |
| Phase status | **PARTIAL** — Neon credentials unavailable |
| Completed phases | 0–10 (PGLite), 12, 12A (PGLite), 12B local. 13A local. Neon unverified. |
| Date | 2026-09-10 |

Do not claim production readiness. Schema phase is **13**. Checkpoint is **13a**.
Vercel is **NOT CONNECTED**.

## Current implementation state

CP12/CP12A tenancy is in source. CP12B hardens production fail-closed behaviour.
CP13A adds SQL-created production LOGIN `aether_app`. Occupancy trigger, EXCLUDE,
and `aether_athens_instant()` were not rewritten. 0011–0013 were not modified.

- Production without `DATABASE_URL` fails closed
- Production migrate: `AETHER_DATABASE_OWNER_URL` only
- `aether_runtime` remains the PGLite/preview SET ROLE identity (LOGIN after 0013)
- Production `DATABASE_URL` must authenticate as `aether_app` LOGIN
- Preview operator `desk` / `desk-pass` refused in production
- `DATABASE_URL` and `AETHER_DATABASE_OWNER_URL` unset here → `verify:neon` exits 2

## Database migration state

Last schema migration: `migrations/0014_cp13a_production_app_role.sql`.
`aether_meta.schema_phase = 13`, `checkpoint = 13a`.
Neon application of 0012/0013/0014: **BLOCKED / UNVERIFIED**.

## Current test status

See CP12B report after `npm run test:aether`. Typecheck/lint/build are required
before claiming local completion.

**NEON CONCURRENCY NOT VERIFIED.**
**NEON PRODUCTION-ROLE SPLIT BLOCKED / UNVERIFIED.**

## Next exact development action

1. Do not start CP13B until this source checkpoint is accepted.
2. Provide two distinct Neon URLs (owner vs SQL-created `aether_app` LOGIN).
3. Set the `aether_app` password out of band. Never commit it. Never create `aether_app` via Neon Console.
4. Re-run `npm run verify:neon` until it PASSes.
5. Do not connect Vercel until then.
6. Never call the platform app provisioner.

## Required environment-variable names

| Name | When | Secret? |
|---|---|---|
| `DATABASE_URL` | production runtime (`aether_app` LOGIN) | yes |
| `AETHER_DATABASE_OWNER_URL` | migrations / schema owner | yes |
| `AETHER_OPS_LOGIN` | optional preview operator bootstrap | no |
| `AETHER_OPS_PASSWORD` | optional preview operator bootstrap | yes |

No `.env` files.

---

## CP10 identity (immutable historical record)

| Field | Value |
|---|---|
| Product | Aether Transfer |
| Guest lockup | SCAN. BOOK. GO. |
| Current build version / checkpoint | **10** |
| Current phase | **PHASE 10 — PRODUCTION HARDENING** |
| Phase status | **PASS** (Neon role split **BLOCKED / UNVERIFIED**) |
| Completed phases | 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 |
| Date | 2026-09-05 |
| Snapshot | `aether-transfer-checkpoint-10-phase-production-hardening-2026-09-05.zip` |
| Alias | `AETHER_TRANSFER_CP10_HARDENING_2026-09-05.zip` |
