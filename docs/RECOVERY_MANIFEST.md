# Recovery manifest

This file must let a new developer or coding agent continue without the
original conversation. No secrets.

## Current accepted baseline (POST-CP26B CLOSED)

GitHub is authoritative for application source. Living status: **`BUILD_STATE.md`**.

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | `19512c295830fbc6fd9712d688ce364d940f87c3` |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| **CP26B** | **CLOSED** |
| **Next execution checkpoint** | **CP26C — Stripe test-mode integration (design/preflight; not started)** |
| Forward roadmap | **[ROADMAP.md](ROADMAP.md)** |
| Fixture policy | **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)** |
| Product | SCAN / BOOK / GO |
| Production | Vercel `scan-book-go` / last observed `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` READY |
| Alias | `https://scan-book-go.vercel.app` |
| Database | Production Neon migrated through **0024** |
| Runtime | `DATABASE_URL` → `aether_app`; owner URL **ABSENT** from Vercel |
| Auth | Better Auth Production configured; returning sign-in **proven CP26A.5** |
| SaaS | `/app/*` exists; verification hotel `sbg-verify-a5` **configured not live** |
| Stripe / Resend | source present; Production configuration absent; Domain A fail-closed |

`cp17-known-good` (`45e171a23037b7c94005018cd2126033a449d6f0`) is an immutable **historical** CP16C/CP17 tag, not current `main`.

A workspace is never authoritative. Recovery ZIPs are secondary artifacts. The CP10 ZIP **MUST NOT** be extracted over a newer Git tree without explicit human approval.

## Identity

| Field | Value |
|---|---|
| Product | SCAN / BOOK / GO (history name: Aether Transfer) |
| Guest lockup | SCAN. BOOK. GO. |
| Current source checkpoint | POST-CP26B CLOSED (verification tenant retained; Production 0024 applied; 0024 dispatch retired) |
| Trusted occupancy baseline | CP10 (historical occupancy engine; not current source SHA) |
| Previous abandoned original CP11 used | **NO** |
| Current phase | **CP26B CLOSED**; next **CP26C**; see ROADMAP.md and FIXTURE_POLICY.md |
| Date of this alignment | 2026-09-22 |

## Database migration state

**Source files and Production Neon:** through `0024_cp26b2_ordered_billing_events.sql`.

Application build does not migrate. Generic production-migrate GitHub Action is retired/fail-closed. Permanent owner-plane control is read-only Gate B. Spent 0022/0023/0024 single-use mutation workflows are retired.

## Auth (do not reopen CP25G.3)

Proven: signup, session, cookies, `/app`, persistence, sign-out, signed-out boundary, returning sign-in (CP26A.5).

Deferred: copied-cookie stale replay; password recovery; email verification.
