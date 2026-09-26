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
| **Next execution checkpoint** | **CP26 STRIPE TEST**, then **CP26 EXIT GATE**. **CP26 FINALISATION COMPLETE**. CP26 is **not** closed |
| Forward roadmap | **[ROADMAP.md](ROADMAP.md)** |
| Fixture policy | **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)** |
| Product | SCAN / BOOK / GO |
| Production | Vercel `scan-book-go` / last observed `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` READY |
| Alias | `https://scan-book-go.vercel.app` |
| Database | Production Neon migrated through **0028**; Gate B **0001–0028**; 0027 and 0028 workflows **RETIRED**; 0025 workflow must not be re-dispatched |
| Owners | **1** active platform Owner (OPERATOR CONTROLLED / REDACTED); bootstrap workflow **RETIRED** |
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

**Source files and Production Neon:** through `0028_cp26fin_property_licence_catalogue.sql` (digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d`, apply run 36254890554). 0027 digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef`, apply run 36251190175. 0026 digest `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446`, apply run 36135836457, remains accepted history.

Application build does not migrate or bootstrap an Owner. Generic production-migrate GitHub Action is retired/fail-closed and never applies SQL. Permanent owner-plane control is read-only Gate B (accepted ledger **0001–0028**, `AUTHORISED_PENDING=[]`). Spent 0022/0023/0024/0026/0027/0028 single-use mutation workflows are retired. The first-Owner bootstrap workflow is **RETIRED**. The 0025 apply workflow remains historical evidence and must not be re-dispatched. Catalogue: `property_licence` active; basic/pro/premium inactive. Price versions **0**. Stripe mappings **0**. Organisations, members, organisation billing, and allocations **0**. Canonical amounts remain **UNDEFINED**. Commerce **OFF**. Stripe untouched. Domain A is organisation-scoped and dormant. Domain B is unchanged. **CP26 FINALISATION COMPLETE.** CP26 is **not** closed. Next is **CP26 STRIPE TEST**, then **CP26 EXIT GATE**. Former **O3.4** is superseded. Do not resume CP26C.3.

## Auth (do not reopen CP25G.3)

Proven: signup, session, cookies, `/app`, persistence, sign-out, signed-out boundary, returning sign-in (CP26A.5).

Deferred: copied-cookie stale replay; password recovery; email verification.
