# SCAN / BOOK / GO — CURRENT PROJECT OVERRIDE

This file is the project-specific authority for the Grok workspace.

## Source of truth

Use this order:

1. GitHub `main` current HEAD — authoritative application source.
2. Current source code, migrations, and tests on that HEAD.
3. Living status in `BUILD_STATE.md` and `.grok/references/current-project-state.md`.
4. Current living recovery/build documentation.
5. Historical checkpoint documents — evidence only.
6. Grok workspace state — disposable cache, never authoritative.

Repository: `bizznessfone-cloud/birch-hazel-stone-cloud`.

## Current accepted baseline (POST-CP26B CLOSED)

| Field | Value |
|---|---|
| Last application SHA | 19512c295830fbc6fd9712d688ce364d940f87c3 (CP26B.3R catalog identity; Production 0024 already applied) |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| CP26B.1 | **PASS** |
| CP26B.2 | **SOURCE COMPLETE then APPLIED via CP26B.3** |
| CP26B.3 | **CLOSED** — Production 0024 applied + independently verified |
| CP26B.4 | **PASS** — Gate B 0001–0024; 0024 dispatch retired |
| **CP26B** | **CLOSED** |
| CP26C.1 | **PASS** — test-mode isolation architecture |
| CP26C.2 | **PASS** — hotel-UUID test allowlist in source |
| CP26C.3 | **PAUSED AFTER SAFE PREFLIGHT** |
| CP26C-O1 | **PASS** — Owner Control Plane architecture |
| CP26C-O2 | **CLOSED** — Owner dashboard Production-proven |
| CP26C-O2A | **PASS** — single-use 0025 controller |
| CP26C-O2B | **PASS** — Production 0025 applied (GHA 35758982641) |
| CP26C-O2C.1 | **PASS** — first-Owner bootstrap controller built |
| CP26C-O2C.2 | **PASS** — first Owner bootstrapped (GHA 36116463589) |
| CP26C-O2C.3 | **PASS** — bootstrap dispatch retired |
| CP26C-O3.1 | **PASS** — commercial catalogue contract (`docs/COMMERCIAL_CATALOGUE.md`) |
| CP26C-O3.2 | **PASS** — source `0026` verified, then Production-applied |
| CP26C-O3.2A | **PASS** — controller built; dispatch **RETIRED** |
| CP26C-O3.2B | **PASS** — Production 0026 applied (GHA 36135836457) |
| CP26C-O3.2C | **PASS** — Gate B **0001–0026**; 0026 workflow retired |
| CP26C-O3.3 | **PASS** — Owner commercial catalogue UI; amounts still **UNDEFINED** |
| CP26C-O3.3V | **PASS** — operator Production plans verification; no price created |
| CP26C-O3R | **PASS** — property-licence model reconciled; no implementation (`docs/COMMERCIAL_MODEL.md`) |
| **Next product checkpoint** | **Not CP27.4.** CP27.3c guest client-IP trust is in source. **CP26 COMPLETE**. **CP26C.3** not resumed |
| Forward roadmap | **`docs/ROADMAP.md`** |
| Commercial catalogue | **`docs/COMMERCIAL_CATALOGUE.md`** |
| Fixture policy | **`docs/FIXTURE_POLICY.md`** |

Historical SHAs (not current `main`):

- CP15 frozen: `96947e6c1840d5c04bc118c8abf93b2fa802469c`
- CP21B audit: `fa823186a548a2009bbb3dc1e7453c75cf94b919`
- CP17 tag `cp17-known-good`: `45e171a23037b7c94005018cd2126033a449d6f0`

## Product identity

The product is **SCAN / BOOK / GO**.

Do not confuse this project with xperience.one.

The internal code/history name **Aether Transfer** may remain in source and historical documents. It is the same application.

## Current phase

CP25G.3 Production Better Auth configuration is **CLOSED**.
CP26A is **CLOSED** (dormancy, 0023 decoupling, local tenant proofs, Production verification tenant `sbg-verify-a5` configured-not-live, returning sign-in proven).
**CP26B is CLOSED**. CP26C.1/C.2 isolation is in source. CP26C.3 is **paused**.
**CP26C-O2 is CLOSED**. Production commerce is **test**, not live.

**CP26 COMPLETE.** Finalisation, Stripe TEST, and the exit gate passed. Gate B accepted ledger is **0001–0033**. `AUTHORISED_PENDING=[]`. Source `0034_cp3005e2d2c_founding_classification_acceptance.sql` (digest `3a80e2ec5ff9ab474c8dabf562fe8e3e37b8fcaa77ef7e8467bd0127afdc433c`) is authored for founding classification and a provisional terms-v1 acceptance and is **not applied** and **not** authorised pending. The verification-only path is `.github/workflows/cp3005e2d2c1-0034-isolated-verify.yml` against the existing branch `br-late-paper-b15gkfj3`; it has no Production apply step. GHA [37958312702](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37958312702) installed 0034 on that branch only and the concurrency harness then exited on the expected conflicting-classification error before cleanup. GHA [37961828006](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37961828006) then verified that install and failed only on `SET ROLE aether_app`, which 0014 forbids for the owner. Production 0034 is not applied. Do not apply it from a generic migrator. Source **0033** (`0033_cp3005e2d2b_founding_organisation.sql`, digest `8880dbf93aa416e393af621957e3170da6390a6e3aef792d68fe97b709c22875`) is **applied** (GHA [37893184406](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37893184406)). Real Neon concurrency proof is GHA [37893386159](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37893386159): three direct backends, one organisation per founding user, no rename on a later name, disposable marker rows removed. The temporary 0033 workflow is **RETIRED**. Do not rerun `scripts/cp3005e2d2b1-0033-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0032**. Do not apply further SQL from the generic migrator. Source **0032** (`0032_cp3005e2c1_organisation_acceptance.sql`, digest `c3412d2b6efc05786ea3edf1146da25853b88ac0df69b1ce215240be0c72ab48`) is **applied** (GHA [37333642947](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37333642947)). The temporary 0032 workflow is **RETIRED**. Do not rerun `scripts/cp3005e2c1-0032-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0031**. No acceptance row was written. Source **0031** (`0031_cp3005e2c_organisation_type.sql`, digest `be0921b852dda7904863f34bc1160fab844b2aaf0821423f6863c91b71b592b6`) is **applied** (GHA [37279300118](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37279300118)). The temporary 0031 workflow is **RETIRED**. Do not rerun `scripts/cp3005e2c-0031-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0030**. The existing organisation was not classified. Source **0030** (`0030_cp272_fix_prepare_booking_payment.sql`, digest `9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f`) is **applied** (GHA [36448160139](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36448160139)). The first dispatch (GHA [36447682813](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36447682813)) rolled back. Read-only verification is GHA [36448358172](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36448358172). The temporary 0030 workflow is **RETIRED**. Do not rerun `scripts/cp272-0030-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0029**. Production functional invocation was not performed. Booking payments remain 0. Source **0029** (`0029_cp272_domain_a_checkout_claims.sql`, digest `e5897eda1a4f3c8c4025e16235b9d11a677b3cc7994934058142934d4dea7adc`) is **applied** (GHA [36404482927](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36404482927)). The temporary 0029 apply workflow is **RETIRED**. Checkout calls the installed 0029 claim functions. M5, M6, M7, and M8 are implemented in application source. 0031 is applied and does not classify the existing organisation. `SBG_DOMAIN_B_LIVE_CHECKOUT` is not enabled. Do not run `scripts/cp272-0029-production-migrate.mjs` again. 0027 digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef` applied (GHA [36251190175](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36251190175)); workflow **RETIRED**. 0028 digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d` applied (GHA [36254890554](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36254890554)); workflow **RETIRED**. The 0025 dispatch workflow is **RETIRED**. Controller scripts remain. `REQUIRED_LEDGER` inside the 0028 controller stays frozen at **0001–0027**. `property_licence` is active. basic/pro/premium are inactive. One price version `b13f9445-d27a-4e7d-8128-a2238906ce7c` EUR 17900 month. One verified TEST mapping `price_1UKGWjFHnHXHuPOwO50TJS93`. No LIVE mapping. LIVE locks false. One TEST organisation, one customer, one subscription, quantity 3. Licensed 3, active allocations 0, available 3. Application source does not hard-code 17900. Domain A checkout is organisation-scoped, server-authorised quantity 1–49, and fails closed without a verified mapping. The 0029 claim table is called by Domain A checkout. Domain B payment binding and `SBG_DOMAIN_B_LIVE_CHECKOUT` (default off, not enabled) are in application source. M5–M8 are implemented. The O4–O11 chain is superseded. Do not resume CP26C.3. Do **not** apply further migrations through the generic migrator. Historical **CP26C-O3.2B PASS** remains: 0026 digest `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446`, apply run [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457).
Exactly one platform Owner exists (OPERATOR CONTROLLED / REDACTED, hotel
`sbg-verify-a5`). The first-Owner bootstrap workflow is **RETIRED**. Do
**not** set `SBG_SAAS_COMMERCE=live`. Former CP26C.4 is
superseded. Only **CP31** activates LIVE commerce. See `docs/ROADMAP.md`,
`docs/OWNER_CONTROL_PLANE.md`, and `docs/FIXTURE_POLICY.md`.

Source includes the hardened booking/occupancy/tenancy base plus CP20 email architecture, CP22 `/app` onboarding, CP23 public slug, CP24 Stripe Connect source, CP25 hotel-owned guest payment source, CP25G.3 auth configuration, CP26A.1 commerce gate, CP26A.2 decoupled entitlement publication, CP26A.4 local tenant/fixture proofs, CP26A.5 Production verification tenant, CP26B.1 Domain A application lifecycle, and CP26B.2/3 ordered billing persistence **applied on Production**.

A push to `main` auto-deploys Vercel Production. That deploy must not switch commerce to live. Neon is migrated through **0033**. `DATABASE_URL` is the runtime credential; `AETHER_DATABASE_OWNER_URL` must never be added to Vercel. `SBG_SAAS_COMMERCE` is `test`. The last pre-finalisation Vercel observation was `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` on `19512c2`; do not treat that SHA as current `main`.

Do not reopen CP26A or CP26B. Do not mutate the Production verification tenant unless a later checkpoint explicitly authorises it. Do **not** set `SBG_SAAS_COMMERCE=live`. Former CP26C.4 is superseded. Isolation (`SBG_SAAS_TEST_HOTEL_IDS` and `SBG_SAAS_TEST_ORGANISATION_IDS`) is in source; empty allowlists fail-close. Do not dispatch retired 0022/0023/0024/0025 controllers. Future SQL needs a new dedicated single-use controller.

## V1 product layer

```
account → hotel → first service → preview → QR → plan → Stripe activation → LIVE
```

`/app/*` is the SaaS operator surface. `/ops/*` is the internal operations desk.

Public guest route is `/{hotelSlug}`. Legacy `/book/{hotelCode}` remains supported.

First Production hotel through `/app` is **proven to configured, not live** (`sbg-verify-a5`). Domain A TEST Stripe configuration is present. Domain B guest payments are not Production-proven.

## Existing security architecture

Preserve:

- `neondb_owner` — migration/schema owner
- `aether_runtime` — PGLite/preview SET ROLE identity
- `aether_app` — SQL-created production LOGIN

Production must not use `aether_runtime`, SET ROLE, `neon_superuser`, or owner credentials.

Do not reopen CP15/CP16/CP19 security architecture. Do not reopen CP25G.3. Do not reopen CP26A.1/2/4/5. Do not reopen CP26B.

## Route boundaries

- `/` — product surface
- `/{hotelSlug}` — human-readable public hotel booking
- `/book/{hotelCode}` — legacy public guest booking
- `/confirmed/{token}` — secure public confirmation
- `/login` — SaaS email/password
- `/ops/*` — internal authenticated operations
- `/app/*` — V1 SaaS operator application
- `/owner/*` — platform Owner Control Plane (Better Auth **and** `sbg_platform_owners` grant)

## Feature fence

Keep V2 features out of V1 unless a later checkpoint explicitly opens them:

- SMS, WhatsApp, chatbot, custom domains
- marketplace features, unrelated feature expansion
- guest accounts, RLS, a new RBAC system, a tenants table, new fleet/occupancy architecture

Stripe was intentionally outside the original frozen Blueprint v2 and is now layered over the hardened base. SCAN / BOOK / GO is not the hotel’s payment custodian.

## Historical material

Do not delete historical checkpoint files.

Do not rewrite historical records to make later work appear earlier.

Do not treat recovery ZIPs or Grok state as current source.

If an old living document conflicts with current GitHub source, classify the old statement as stale and use current source plus this project override.

## External-system discipline

Do not contact Neon, modify Vercel, change secrets, or deploy unless the active checkpoint explicitly authorizes it.

## Checkpoint discipline

Every checkpoint must identify the exact Git commit audited.

Next is **not CP27.4**. CP27.3c guest booking client-IP trust is in source. Do not start CP27.4 from this file. Do not start former O3.4. Do not resume CP26C.3. Do not re-dispatch the retired 0025 workflow. Canonical roadmap: `docs/ROADMAP.md`. Commercial model: `docs/COMMERCIAL_MODEL.md`. CP26 is **COMPLETE**. CP26 is not go-live. Only CP31 activates LIVE commerce.
