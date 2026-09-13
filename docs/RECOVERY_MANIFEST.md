# Recovery manifest

This file must let a new developer or coding agent continue without the
original conversation. No secrets.

## Source of truth

GitHub is authoritative for application source.

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Known-good application source | `45e171a23037b7c94005018cd2126033a449d6f0` |
| Tag | `cp17-known-good` |

When `cp17-known-good` was created, `main` pointed at that commit. The tag is
immutable. Documentation-only commits on `main` do not change the CP16C/CP17
application baseline.

A workspace is never authoritative. Recovery ZIPs are secondary
disaster-recovery artifacts. The CP10 ZIP is historical and **MUST NOT** be
extracted over a newer Git tree without explicit human approval.

Source-code state and production database state must be reported separately.
Every future production-readiness audit must name the exact Git commit audited.
Do not claim Neon production readiness merely because this repository is current.

**CP19** currently refers to production Neon binding/verification. It is **not**
yet a completed production checkpoint and is **not** a source-code commit.

## Identity (current source)

| Field | Value |
|---|---|
| Product | Aether Transfer |
| Guest lockup | SCAN. BOOK. GO. |
| Current source checkpoint | **CP16C/CP17** (`45e171a` / `cp17-known-good`) |
| Trusted occupancy baseline | **CP10** (historical; not current source) |
| Previous abandoned original CP11 used | **NO** |
| Current phase | **source complete through CP17; CP19 Neon UNVERIFIED** |
| Phase status | **SOURCE CURRENT / DATABASE UNVERIFIED** |
| Completed source phases | 0–10 (PGLite), 12, 12A, 12B, 13A, 14.x, 15, 16C, 17 |
| Date | 2026-09-13 |

Do not claim production readiness. Source migrations exist through **0017**.
Vercel is **NOT CONNECTED**. Neon is **UNVERIFIED**.

## Current implementation state (source)

CP12/CP12A tenancy is in source. CP12B hardens production fail-closed behaviour.
CP13A adds SQL-created production LOGIN `aether_app`. CP14 adds hotel
configuration and timezone. CP15 hotel-scopes Ops identity. CP16C hardens
runtime privileges (0017). CP17 localizes Ops Today to the hotel IANA timezone.
Occupancy trigger, EXCLUDE, and `aether_athens_instant()` were not rewritten.
0011–0017 were not modified by this documentation alignment.

- Production without `DATABASE_URL` fails closed
- Production migrate: `AETHER_DATABASE_OWNER_URL` only
- `aether_runtime` remains the PGLite/preview SET ROLE identity (LOGIN after 0013)
- Production `DATABASE_URL` must authenticate as `aether_app` LOGIN
- Preview operator `desk` / `desk-pass` refused in production
- `DATABASE_URL` and `AETHER_DATABASE_OWNER_URL` unset here → `verify:neon` exits 2

## Database migration state

**Source files:** last schema migration file is
`migrations/0017_cp16_runtime_privilege_hardening.sql`. No `0018`.

**Production Neon:** application of 0012–0017 is **BLOCKED / UNVERIFIED**.
Do not infer Neon schema from GitHub source.

## Current test status

CP16C/CP17 source was locally verified on PGLite before tag `cp17-known-good`.
See living `BUILD_STATE.md`. Typecheck/lint/build are required before claiming
local completion of later work.

**NEON CONCURRENCY NOT VERIFIED.**
**NEON PRODUCTION-ROLE SPLIT BLOCKED / UNVERIFIED.**
**CP19 NOT COMPLETE.**

## Next exact development action

1. Do not extract the CP10 ZIP over this tree.
2. Do not treat CP19 as a source checkpoint or as complete.
3. Provide two distinct Neon URLs (owner vs SQL-created `aether_app` LOGIN).
4. Set the `aether_app` password out of band. Never commit it. Never create `aether_app` via Neon Console.
5. Re-run `npm run verify:neon` until it PASSes. Name the Git commit audited.
6. Do not connect Vercel until then.
7. Never call the platform app provisioner.

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

This section is **historical**. It is not the current project state. Do not
extract the CP10 ZIP over `45e171a` / `cp17-known-good`.

| Field | Value |
|---|---|
| Product | Aether Transfer |
| Guest lockup | SCAN. BOOK. GO. |
| Current build version / checkpoint | **10** (historical) |
| Current phase | **PHASE 10 — PRODUCTION HARDENING** (historical) |
| Phase status | **PASS** (Neon role split **BLOCKED / UNVERIFIED**) |
| Completed phases | 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 |
| Date | 2026-09-05 |
| Snapshot | `aether-transfer-checkpoint-10-phase-production-hardening-2026-09-05.zip` |
| Alias | `AETHER_TRANSFER_CP10_HARDENING_2026-09-05.zip` |
