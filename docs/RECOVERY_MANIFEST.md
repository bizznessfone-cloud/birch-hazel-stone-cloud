# Recovery manifest

This file must let a new developer or coding agent continue without the
original conversation. No secrets.

## Identity

| Field | Value |
|---|---|
| Product | Aether Transfer |
| Guest lockup | SCAN. BOOK. GO. |
| Current build version / checkpoint | **12b** (CP12B pre-Vercel production hardening) |
| Trusted occupancy baseline | **CP10** |
| Previous abandoned original CP11 used | **NO** |
| Current phase | **CP12B — local/repository hardening; Neon UNVERIFIED** |
| Phase status | **PARTIAL** — Neon credentials unavailable |
| Completed phases | 0–10 (PGLite), 12, 12A (PGLite). 12B local. Neon unverified. |
| Date | 2026-09-10 |

Do not claim production readiness. Schema phase is **12**. Checkpoint is **12b**.
Vercel is **NOT CONNECTED**.

## Current implementation state

CP12/CP12A tenancy is in source. CP12B hardens production fail-closed behaviour.
Occupancy trigger, EXCLUDE, and `aether_athens_instant()` were not rewritten.

- Production without `DATABASE_URL` fails closed
- Production migrate: `AETHER_DATABASE_OWNER_URL` only
- `aether_runtime` is LOGIN after 0013; production must not SET ROLE
- Preview operator `desk` / `desk-pass` refused in production
- `DATABASE_URL` and `AETHER_DATABASE_OWNER_URL` unset here → `verify:neon` exits 2

## Database migration state

Last schema migration: `migrations/0013_cp12b_runtime_login.sql`.
`aether_meta.schema_phase = 12`, `checkpoint = 12b`.
Neon application of 0012/0013: **BLOCKED / UNVERIFIED**.

## Current test status

See CP12B report after `npm run test:aether`. Typecheck/lint/build are required
before claiming local completion.

**NEON CONCURRENCY NOT VERIFIED.**
**NEON PRODUCTION-ROLE SPLIT BLOCKED / UNVERIFIED.**

## Next exact development action

1. Provide two distinct Neon URLs (owner vs `aether_runtime` LOGIN).
2. Set the runtime role password out of band. Never commit it.
3. Re-run `npm run verify:neon` until it PASSes.
4. Do not connect Vercel and do not start CP13 until then.
5. Never call the platform app provisioner.

## Required environment-variable names

| Name | When | Secret? |
|---|---|---|
| `DATABASE_URL` | production runtime (`aether_runtime` LOGIN) | yes |
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
