# Recovery manifest

> **Not the incident procedure.** Current Production incidents use **[V1_INCIDENT_RUNBOOK.md](V1_INCIDENT_RUNBOOK.md)** only. The baseline below is a historical manifest, including its “next checkpoint” and deployment id.

This file must let a new developer or coding agent continue without the
original conversation. No secrets. It is not the live incident identity.

## HISTORICAL SNAPSHOT — not current (label formerly “Current accepted baseline”, CP26 CLOSED)

GitHub is authoritative for application source. Living status: **`BUILD_STATE.md`**.

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | CP26B.3R `19512c295830fbc6fd9712d688ce364d940f87c3` is historical, not current `main` |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| **CP26B** | **CLOSED** |
| **CP26** | **COMPLETE** |
| **Next execution checkpoint** | **CP27 — SECURITY HARDENING**. Not started. **CP26 FINALISATION, STRIPE TEST, and EXIT GATE PASS** |
| Forward roadmap | **[ROADMAP.md](ROADMAP.md)** |
| Fixture policy | **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)** |
| Product | SCAN / BOOK / GO |
| Production | Vercel `scan-book-go` / last observed `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` READY |
| Alias | `https://scan-book-go.vercel.app` |
| Database | Production Neon migrated through **0031**; Gate B **0001–0031**; sole pending `0032_cp3005e2c1_organisation_acceptance.sql` (not applied); 0031 apply workflow **RETIRED** |
| Owners | **1** active platform Owner (OPERATOR CONTROLLED / REDACTED); bootstrap workflow **RETIRED** |
| Runtime | `DATABASE_URL` → `aether_app`; owner URL **ABSENT** from Vercel |
| Auth | Better Auth Production configured; returning sign-in **proven CP26A.5** |
| SaaS | `/app/*` exists; verification hotel `sbg-verify-a5` **configured not live**; CP26 licence fixtures unconfigured and unallocated |
| Stripe / Resend | Domain A TEST secrets present on Vercel (values not recorded). Commerce **test**. Domain B booking payments **0**. Resend not recorded as present |

`cp17-known-good` (`45e171a23037b7c94005018cd2126033a449d6f0`) is an immutable **historical** CP16C/CP17 tag, not current `main`.

A workspace is never authoritative. Recovery ZIPs are secondary artifacts. The CP10 ZIP **MUST NOT** be extracted over a newer Git tree without explicit human approval.

## Identity

| Field | Value |
|---|---|
| Product | SCAN / BOOK / GO (history name: Aether Transfer) |
| Guest lockup | SCAN. BOOK. GO. |
| Current source checkpoint | **CP26 COMPLETE** |
| Trusted occupancy baseline | CP10 (historical occupancy engine; not current source SHA) |
| Previous abandoned original CP11 used | **NO** |
| Current phase | **CP26 COMPLETE**; next **CP27 — SECURITY HARDENING**, not started |
| Date of this alignment | 2026-09-22 |

## Database migration state

**Source files and Production Neon:** through `0028_cp26fin_property_licence_catalogue.sql` (digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d`, apply run 36254890554). 0027 digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef`, apply run 36251190175. 0026 digest `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446`, apply run 36135836457, remains accepted history.

Application build does not migrate or bootstrap an Owner. Generic production-migrate GitHub Action is retired/fail-closed and never applies SQL. Permanent owner-plane control is read-only Gate B (accepted ledger **0001–0030**, `AUTHORISED_PENDING=[]`). 0030 digest `9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f` is applied (GHA 36448160139) and the temporary apply workflow is **RETIRED**. Do not rerun `scripts/cp272-0030-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0029**. 0029 is applied and its temporary apply workflow is **RETIRED**. Checkout calls the installed 0029 claim functions. Booking payments were 0 and were not mutated by this application remediation. M5, M6, M7, and M8 are implemented in application source. `SBG_DOMAIN_B_LIVE_CHECKOUT` is not enabled. Commerce **test**, not live. **CP26 COMPLETE.** Next is explicit CP27.3 authorisation, not started. Only **CP31** activates LIVE commerce.

## Auth (do not reopen CP25G.3)

Proven: signup, session, cookies, `/app`, persistence, sign-out, signed-out boundary, returning sign-in (CP26A.5).

Deferred: copied-cookie stale replay; password recovery; email verification.
