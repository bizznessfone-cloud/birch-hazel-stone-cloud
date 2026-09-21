# Recovery manifest

This file must let a new developer or coding agent continue without the
original conversation. No secrets.

## Current accepted baseline (POST-CP26A.2)

GitHub is authoritative for application source. Living status: **`BUILD_STATE.md`**.

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | `b35ef2fc8bdddef81fcc84aa59d358dba4346a30` |
| CP25G.3 | **CLOSED** |
| CP26A.1 / CP26A.2 | **CLOSED** |
| **Next execution checkpoint** | remaining **CP26A** items 5–6 |
| Forward roadmap | **[ROADMAP.md](ROADMAP.md)** |
| Product | SCAN / BOOK / GO |
| Production | Vercel `scan-book-go` / last observed `dpl_7mJ8kBkd1m679TpriPUnYeX8X4qY` READY |
| Alias | `https://scan-book-go.vercel.app` |
| Database | Production Neon migrated through **0023** |
| Runtime | `DATABASE_URL` → `aether_app`; owner URL **ABSENT** from Vercel |
| Auth | Better Auth Production configured; CP25G.3 closed |
| SaaS | `/app/*` exists; first `/app` hotel not Production-proven |
| Stripe / Resend | source present; Production configuration absent; Domain A fail-closed |

`cp17-known-good` (`45e171a23037b7c94005018cd2126033a449d6f0`) is an immutable **historical** CP16C/CP17 tag, not current `main`.

A workspace is never authoritative. Recovery ZIPs are secondary artifacts. The CP10 ZIP **MUST NOT** be extracted over a newer Git tree without explicit human approval.

## Identity

| Field | Value |
|---|---|
| Product | SCAN / BOOK / GO (history name: Aether Transfer) |
| Guest lockup | SCAN. BOOK. GO. |
| Current source checkpoint | POST-CP26A.2 at `b35ef2f` (0023 applied; dispatch retired) |
| Trusted occupancy baseline | CP10 (historical occupancy engine; not current source SHA) |
| Previous abandoned original CP11 used | **NO** |
| Current phase | CP26A.1/2 CLOSED; next remaining CP26A items 5–6; see ROADMAP.md |
| Date of this alignment | 2026-09-21 |

## Database migration state

**Source files and Production Neon:** through `0023_cp26a2_entitlement_publication_decoupling.sql`.

Application build does not migrate. Generic production-migrate GitHub Action is retired/fail-closed. Permanent owner-plane control is read-only Gate B.

## Auth (do not reopen CP25G.3)

Proven: signup, session, cookies, `/app`, persistence, sign-out, signed-out boundary.

Not Production-proven: returning sign-in POST; authenticated tenant runtime.

Deferred: copied-cookie stale replay; password recovery; email verification.
