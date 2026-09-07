# Recovery manifest

This file must let a new developer or coding agent continue without the
original conversation. No secrets.

## Identity

| Field | Value |
|---|---|
| Product | Aether Transfer |
| Guest lockup | SCAN. BOOK. GO. |
| Current build version / checkpoint | **11-BLOCKED** (NEW CP11 Production Infrastructure) |
| Trusted baseline | **CP10** |
| Previous abandoned CP11 used | **NO** |
| Current phase | **NEW CP11 — BLOCKED on Neon credentials** |
| Phase status | **BLOCKED** |
| Completed phases | 0–10 (PGLite). 11 incomplete. |
| Date | 2026-09-06 |
| Snapshot | `AETHER_CHECKPOINT_CP_11_BLOCKED_NEON_2026-09-06.zip` |

Do not claim production readiness. Schema phase remains **10**.

## Current implementation state

NEW CP11 added a fail-closed Neon verifier only. Occupancy trigger, EXCLUDE,
and `aether_athens_instant()` were not rewritten. Guest and ops UX were not
redesigned.

- `scripts/verify-neon-production.mjs` / `npm run verify:neon`
- `DATABASE_URL` and `AETHER_DATABASE_OWNER_URL` unset → verifier exits 2
- CP10 PGLite privilege proof is **not** Neon verification
- Preview operator: **desk** / **desk-pass** via startup.sh only

## Database migration state

Last schema migration: `migrations/0011_production_hardening.sql`.
`aether_meta.schema_phase = 10`. No 0012.

## Current test status

Aether tests (PGLite): **101 passed / 0 failed**. Typecheck PASS. Build PASS.
`npm run verify:neon`: **BLOCKED** (credentials).

**NEON CONCURRENCY NOT VERIFIED.**
**NEON PRODUCTION-ROLE SPLIT BLOCKED / UNVERIFIED.**

## Next exact development action

1. Provide two distinct Neon URLs (owner vs `aether_runtime` LOGIN).
2. Re-run `npm run verify:neon` until it PASSes.
3. Then — and only then — CP11A Guest Experience Layer.
4. Never call the platform app provisioner.

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
