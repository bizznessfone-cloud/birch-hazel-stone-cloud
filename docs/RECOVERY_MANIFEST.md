# Recovery manifest

This file must let a new developer or coding agent continue without the
original conversation. No secrets.

## Current accepted baseline (POST-CP25G.3)

GitHub is authoritative for application source. Living status: **`BUILD_STATE.md`**.

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Current source SHA | `4c20e9b9574309a0edbeb03f8675febdef38dede` |
| CP25G.3 | **CLOSED** |
| Next numbered checkpoint | **UNDEFINED** — **Do not invent CP26.** |
| Product | SCAN / BOOK / GO |
| Production | Vercel `scan-book-go` / `dpl_5XnaxYcqkrgWucD54TKgbmvHkfy1` READY |
| Alias | `https://scan-book-go.vercel.app` |
| Database | Production Neon migrated through **0022** |
| Runtime | `DATABASE_URL` → `aether_app`; owner URL **ABSENT** from Vercel |
| Auth | Better Auth Production configured; CP25G.3 closed |
| SaaS | `/app/*` exists; first `/app` hotel not Production-proven |
| Stripe / Resend | source present; Production configuration absent |

`cp17-known-good` (`45e171a23037b7c94005018cd2126033a449d6f0`) is an immutable **historical** CP16C/CP17 tag, not current `main`.

A workspace is never authoritative. Recovery ZIPs are secondary artifacts. The CP10 ZIP **MUST NOT** be extracted over a newer Git tree without explicit human approval.

## Identity

| Field | Value |
|---|---|
| Product | SCAN / BOOK / GO (history name: Aether Transfer) |
| Guest lockup | SCAN. BOOK. GO. |
| Current source checkpoint | POST-CP25G.3 at `4c20e9b` |
| Trusted occupancy baseline | CP10 (historical occupancy engine; not current source SHA) |
| Previous abandoned original CP11 used | **NO** |
| Current phase | CP25G.3 CLOSED; next numbered checkpoint UNDEFINED |
| Date of this alignment | 2026-09-20 |

## Database migration state

**Source files and Production Neon:** through `0022_cp25g3_better_auth_runtime_privileges.sql`.

Application build does not migrate. Owner-plane GitHub Actions exist and are manual.

## Auth (do not reopen CP25G.3)

Proven: signup, session, cookies, `/app`, persistence, sign-out, signed-out boundary.

Not Production-proven: returning sign-in POST; authenticated tenant runtime.

Deferred: copied-cookie stale replay; password recovery; email verification.
