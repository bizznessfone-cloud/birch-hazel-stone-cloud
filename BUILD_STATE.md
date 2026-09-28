# BUILD STATE — living record

This file describes **current reality**, not intended future state.

## CP26 — CLOSED

**CP26 FINALISATION — PASS. CP26 STRIPE TEST — PASS. CP26 EXIT GATE — PASS. CP26 — COMPLETE.**

Production ledger is **0001–0030** exactly once. Gate B accepts **0001–0030**. `AUTHORISED_PENDING=[]`. 0030 replaces only `public.sbg_prepare_booking_payment(text)` to remove PostgreSQL 42702. Digest `9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f`. It is **applied** (GHA [36448160139](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36448160139)). The first dispatch (GHA [36447682813](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36447682813)) rolled back and did not commit. Read-only verification is GHA [36448358172](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36448358172). The temporary 0030 apply workflow is **RETIRED**. Do not rerun `scripts/cp272-0030-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0029**. 0029 (`sbg_domain_a_checkout_claims`) remains **applied** (GHA [36404482927](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36404482927)). The claim table is empty. Checkout does not call it. Booking payments remain **0**. Production did not invoke the repaired function. M5, M6, M7, and M8 are not implemented. The generic Production migrator stays fail-closed and never applies SQL. `npm run build` does not migrate. Permanent read-only Gate B (`.github/workflows/production-database.yml`) remains. 0031+ stays fail-closed. Pre-existing `aether_runtime` EXECUTE and `neon_superuser` membership were observed and not remediated.

Commercial model: one product, `property_licence` (SCAN BOOK GO Property Licence). The published Production price version is `b13f9445-d27a-4e7d-8128-a2238906ce7c`, **EUR 17900**, month, interval_count 1. Self-service quantity is **1–49**. **50+** is Enterprise / contact sales, not a second product or an automatic discount. `basic` / `pro` / `premium` are inactive historical plans. Application source does not hard-code 17900.

Stripe TEST proof, sandbox only, livemode false: organisation `4208626a-ef20-4f5a-b28e-0d8b9c778205` → customer `cus_VKwWNaJ4nwUTfM` → subscription `sub_1UKGdCFHnHXHuPOwgswtqBhL` → one item `si_VKwWH8Gngk0GkW` on price `price_1UKGWjFHnHXHuPOwO50TJS93` (product `prod_VKwPfVeu1Q3S21`) → quantity **3**. One verified TEST mapping. No LIVE mapping. LIVE locks **false / false**. Commerce is **`SBG_SAAS_COMMERCE=test`**, not live. An empty `SBG_SAAS_TEST_ORGANISATION_IDS` fail-closes. Only **CP31** may activate LIVE commerce.

Organisation billing is active, licensed_quantity **3**, price version as above, last event `evt_1UKKPiFHnHXHuPOwM7L3ZmoM`. That event is one `sbg_stripe_events` row, outcome `applied`, `processed_at` and billing `updated_at` both `2026-09-27T15:54:55.965Z`. Same-id replay did not rewrite the row. Hotel billing accounts **0**. Booking payments **0**.

Licence balance: licensed **3**, active allocations **0**, available **3**. Released historical rows for `cp26-licence-a`, `cp26-licence-b`, `cp26-licence-c`, and `cp26-licence-d` remain. Those hotels stay **unconfigured**. Protected hotels were not repurposed.

**Next: resume CP27.2 application remediation only under a new explicit checkpoint.** Do not start M5, M6, M7, M8, CP27.3, or LIVE commerce from this reconciliation. Do not rerun the 0030 controller. Do not resume CP26C.3.

The section below is the historical path through CP26B and finalisation. Present-tense claims there that commerce is OFF, that prices are undefined, or that CP26 STRIPE TEST is next are the state **at that earlier checkpoint**.

## CP26B — CLOSED

Domain A subscription lifecycle, ordered billing persistence, and Production
migration 0024 are accepted. At CP26B, Domain A commerce was **OFF**. Only **CP31**
may activate real commerce. CP26C.1/C.2 isolation is in source. CP26C.3 is
**paused** (no Stripe objects; canonical amounts not invented). **CP26C-O3.1**
catalogue contract is accepted. **CP26C-O3.2** source migration 0026 was
verified, then **applied once** in Production (**CP26C-O3.2B PASS**).
**CP26C-O3.2C** reconciled Gate B to **0001–0026** and **retired** the
single-use 0026 dispatch surface. **CP26C-O3.3** implemented the Owner
commercial catalogue UI over that schema. Canonical amounts were not invented.
**CP26C-O2D** isolated Owner sign-in at `/owner/login`. Human verification of
that sign-in **passed**. **CP26C-O3.3V** passed: `/owner/plans` showed the
three active plans and no prices. **CP26C-O3R** reconciled the commercial
model to one organisation subscription and property-licence quantity.
**CP26 FINALISATION — PASS** applied 0027 and 0028 in Production, accepted them on Gate B, retired both dispatch workflows, and cut dormant Domain A from hotel tiers to organisation property-licence quantity. At the close of finalisation, commerce was still **OFF**, there was no price version, and there was no Stripe mapping. That snapshot is not the exit-gate state. **CP26 STRIPE TEST — PASS. CP26 EXIT GATE — PASS. CP26 — COMPLETE.** See the current section at the top of this file. The O4–O11 chain is superseded. Former **O3.4** is superseded. Do not resume CP26C.3.
Migration **0025** is **Production-applied**. Its dispatch workflow is **RETIRED** (controller script remains). First Production platform Owner is
**bootstrapped** (1 active grant). The first-Owner bootstrap workflow is **RETIRED**.

| Field | Value |
|---|---|
| CP26A.1 | **PASS** — Domain A commerce dormant (`SBG_SAAS_COMMERCE=off\|test\|live`; Production unset = fail-closed) |
| CP26A.2 | **PASS** — entitlement/publication decoupling; Production 0023 applied; dispatch retired |
| CP26A.3 | **PASS** — read-only design/preflight of operator-owned hotel lifecycle + fixture policy |
| CP26A.4 | **PASS** — local ownership → configured-not-live → billing UUID resolution; Domain A fail-closed; Domain B non-regression |
| CP26A.5 | **PASS** — one persistent Production verification identity + one owned hotel, **configured not live**, returning sign-in, billing GET |
| CP26A.6 | **PASS** — evidence reconciled; CP26A closed |
| CP26B.1 | **PASS** — Domain A application lifecycle: gate-before-write, one subscription, portal-first plan management |
| CP26B.2 | **SOURCE COMPLETE** — ordered Domain A webhook persistence |
| CP26B.3 | **CLOSED** — Production 0024 applied (GHA [35697938230](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35697938230)); already-applied verified (GHA [35699337916](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35699337916)) |
| CP26B.4 | **PASS** — Gate B accepted ledger **0001–0024**; 0024 `workflow_dispatch` retired; generic migrator remains fail-closed |
| **CP26B** | **CLOSED** |
| CP26C.1 | **PASS** — test-mode isolation architecture defined |
| CP26C.2 | **PASS** — Domain A test commerce isolated by hotel UUID allowlist (source) |
| CP26C.3 | **PAUSED AFTER SAFE PREFLIGHT** — no Stripe objects; no Vercel Stripe env |
| CP26C-O1 | **PASS** — Owner Control Plane architecture ([`docs/OWNER_CONTROL_PLANE.md`](docs/OWNER_CONTROL_PLANE.md)) |
| CP26C-O2 | **CLOSED** — Owner dashboard Production-proven |
| CP26C-O2A | **PASS** — single-use 0025 controller |
| CP26C-O2B | **PASS** — Production 0025 applied (GHA [35758982641](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35758982641)) |
| CP26C-O2C.1 | **PASS** — first-Owner bootstrap controller built |
| CP26C-O2C.2 | **PASS** — first Owner bootstrapped (GHA [36116463589](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36116463589)) |
| CP26C-O2C.3 | **PASS** — bootstrap dispatch retired; O2 closed |
| CP26C-O3.1 | **PASS** — commercial catalogue contract ([`docs/COMMERCIAL_CATALOGUE.md`](docs/COMMERCIAL_CATALOGUE.md)); amounts **UNDEFINED**; no migration |
| CP26C-O3.2 | **PASS** — source verified, then Production-applied in O3.2B |
| CP26C-O3.2A | **PASS** — single-use 0026 controller built; dispatch **RETIRED** in O3.2C |
| CP26C-O3.2B | **PASS** — Production 0026 applied once (GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457), job 108073574672) |
| CP26C-O3.2C | **PASS** — Gate B reconciled to **0001–0026**; 0026 dispatch retired |
| CP26C-O3.3 | **PASS** — Owner commercial catalogue UI; canonical amounts still **UNDEFINED**; no Production prices |
| CP26C-O2D | **PASS** — `/owner/login` sign-in only; hotel `/login` unchanged; no migration |
| CP26C-O3.3V | **PASS** — operator `/owner/plans` verification; no price created |
| CP26C-O3R | **PASS** — model reconciled in [`docs/COMMERCIAL_MODEL.md`](docs/COMMERCIAL_MODEL.md); no implementation at that checkpoint |
| CP26 FINALISATION | **PASS** — ledger **0001–0028**; dormant property-licence cutover. Finalisation snapshot: commerce still OFF and no price. Superseded by the Stripe TEST and exit gate |
| CP26 STRIPE TEST | **PASS** — one TEST organisation, customer, subscription, item, quantity 3, EUR 17900/month; webhook applied once; allocation proof then released |
| CP26 EXIT GATE | **PASS** — CP26 **COMPLETE**. Commerce remains **test**. LIVE locks false. Next is **CP27**, not started |
| Last application SHA | see current `main` after CP26 FINALISATION (19512c2 is the older CP26B.3R catalog identity, not current) |
| Fixture policy | [`docs/FIXTURE_POLICY.md`](docs/FIXTURE_POLICY.md) |
| Local harness | `src/lib/aether/cp26a4-fixture.ts` (tests only; not a runtime import) |
| Domain A | TEST commerce proven for one allowlisted organisation; not LIVE. Only **CP31** may activate LIVE commerce |
| Accepted Production ledger | **0001–0030** applied. `AUTHORISED_PENDING=[]`. 0030 digest `9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f` applied (GHA [36448160139](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36448160139)); workflow **RETIRED**. Claim table installed and empty. Checkout is not integrated. Booking payments **0** |
| 0024 digest | `23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0` |
| 0025 digest | `575aabcb7322fc8ca63c8a3dd137d358f76375f1777ed59cf04c1d98d6c066fd` |
| 0026 file | `migrations/0026_cp26co3_commercial_catalogue.sql` |
| 0026 digest | `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446` (Production-applied once) |
| 0026 apply | GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457) job `108073574672` at `67d751014b6b5cbb5bd3c9ac4867fbad3da01b52` |
| 0025 controller | historical script `scripts/cp26co2a-0025-production-migrate.mjs`; workflow **RETIRED**; npm `db:migrate:0025` remains and is not invoked by build |
| First-Owner controller | historical script `scripts/cp26co2c-first-owner-bootstrap.mjs`; workflow **RETIRED** |
| Active platform Owners | **1** — OPERATOR CONTROLLED / REDACTED (owns `sbg-verify-a5`) |
| Human `/owner` proof | **PASS** — Overview, Hotels, Plans & Pricing, Revenue, System |
| **Next control-plane** | none inside CP26. **CP26 COMPLETE**. Next is **CP27** |
| 0026 controller | historical script `scripts/cp26co32a-0026-production-migrate.mjs`; workflow **RETIRED**; npm alias **RETIRED** |
| Catalogue | `property_licence` **active**; `basic` / `pro` / `premium` **inactive** historical; one price version `b13f9445-d27a-4e7d-8128-a2238906ce7c` EUR **17900** month; one verified TEST mapping `price_1UKGWjFHnHXHuPOwO50TJS93`; no LIVE mapping; LIVE locks **false/false** |
| 0027 | applied once (GHA [36251190175](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36251190175)); digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef`; workflow **RETIRED**; script remains |
| 0028 | `migrations/0028_cp26fin_property_licence_catalogue.sql` applied once (GHA [36254890554](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36254890554)); digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d`; workflow **RETIRED**; controller `REQUIRED_LEDGER` frozen at **0001–0027** |
| **Next product** | **CP27.2 application remediation**, not started in this reconciliation. 0030 is applied. Do not start M5–M8, CP27.3, or LIVE commerce |

Do not dispatch historical 0022/0023/0024 controllers or the retired 0025, 0026, 0027, 0028, 0029, or 0030 workflows. Do not rerun `scripts/cp272-0030-production-migrate.mjs`. Do not recreate the retired one-shot CP26 read workflows. Owner secret remains GitHub Actions `AETHER_DATABASE_OWNER_URL` only — never Vercel. The generic migrator never applies SQL. 0030 is accepted. 0031+ stays fail-closed.

Push to `main` currently auto-deploys Vercel Production. That is a known control-plane characteristic, not a commercial activation and not a LIVE switch. Ordered-webhook source is schema-capable. Domain A TEST webhooks are signature-verified. Commerce is **test**, allowlisted, and fail-closed when `SBG_SAAS_TEST_ORGANISATION_IDS` is empty. Do not set commerce to **live**.

`SBG_SAAS_COMMERCE=test` is set on Production for the completed CP26 Stripe TEST. It is not LIVE commerce. Domain A checkout uses `SBG_SAAS_TEST_ORGANISATION_IDS`. Historical hotel-keyed tests still use `SBG_SAAS_TEST_HOTEL_IDS`. Empty allowlists fail-close. Do not put a Production UUID or a secret value in git.

## Current accepted baseline (CP26 CLOSED)

| Field | Value |
|---|---|
| Product | **SCAN / BOOK / GO** (internal history name: Aether Transfer) |
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | CP26B.3R historical `19512c295830fbc6fd9712d688ce364d940f87c3` is not current `main`. Current source is the CP26 exit-gate commit |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| **CP26B** | **CLOSED** |
| **CP26** | **COMPLETE** — finalisation, Stripe TEST, and exit gate **PASS** |
| **Next control-plane** | none; CP26C-O2 **CLOSED**; CP26C.3 not resumed |
| **Next product checkpoint** | **CP27 — SECURITY HARDENING**. Not started. Only **CP31** activates LIVE commerce |
| Forward roadmap | **[docs/ROADMAP.md](docs/ROADMAP.md)** (CP27–CP31) |

### Production

| Field | Value |
|---|---|
| Vercel project | `scan-book-go` |
| Last observed deployment (CP26B.3V) | `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` |
| State | READY |
| Alias | `https://scan-book-go.vercel.app` |
| Deployed SHA (last observed) | `19512c295830fbc6fd9712d688ce364d940f87c3` |

A later push of this documentation/control-plane child may auto-deploy a new SHA. That must not switch commerce to **live**.

Environment (names/presence only):

| Variable | Production |
|---|---|
| `DATABASE_URL` | PRESENT (`aether_app` runtime LOGIN) |
| `AETHER_DATABASE_OWNER_URL` | ABSENT |
| `SBG_SAAS_COMMERCE` | PRESENT plain `test` (not live) |
| `BETTER_AUTH_SECRET` | PRESENT |
| `BETTER_AUTH_URL` | PRESENT |
| `STRIPE_SECRET_KEY` | PRESENT sensitive (value not recorded) |
| `STRIPE_WEBHOOK_SECRET` | PRESENT sensitive (value not recorded) |
| `SBG_SAAS_TEST_ORGANISATION_IDS` | PRESENT sensitive (value not recorded) |
| Resend / Ops credentials | not recorded as present |

### Database

| Layer | State |
|---|---|
| Source migrations | `0001`–`0030` present and applied |
| Production Neon | migrated through **0030** — pending **NONE** |
| 0028 | `property_licence` active; basic/pro/premium inactive; one price version EUR 17900 month; one verified TEST mapping; LIVE locks false/false |
| 0027 | organisation, member, organisation billing, allocation, and derived licence balance installed; one organisation billing row; four released allocation rows; active allocations 0 |
| 0026 | commercial catalogue schema installed; historical tier rows retained and now inactive |
| 0024 | ordered Domain A billing events (`event.created` bigint, `cancel_at_period_end`, stale/ambiguous/duplicate); 10-argument `sbg_apply_billing_event`; 8-argument function **absent** |
| 0023 | entitlement publication decoupling (`sbg_sync_hotel_entitlement` no longer writes `hotels.status`) |
| Runtime | `DATABASE_URL` → `aether_app` |
| Owner / migration plane | `AETHER_DATABASE_OWNER_URL` → `neondb_owner` (not on Vercel) |
| Preview | PGLite; `aether_runtime` SET ROLE only |
| Application build | `npm run build` does **not** migrate |
| Permanent Gate B | `.github/workflows/production-database.yml` (read-only); accepted ledger **0001–0030**; `AUTHORISED_PENDING=[]` |

Roles: `neondb_owner` = schema/migration owner; `aether_app` = production LOGIN; `aether_runtime` = PGLite/preview only. Production must not use SET ROLE or owner credentials as runtime.

CP26B.3V was a historical snapshot (hotels 4; billing accounts 0; Stripe events 0). It is not the current Production count. Exit-gate read [36336527434](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36336527434): ledger 28; one organisation; one applied Stripe event; hotel billing accounts 0; booking payments 0; active allocations 0; fixtures unconfigured.

### Auth (CP25G.3 CLOSED — do not reopen)

**Proven:** email/password signup; session creation; secure Production cookies (`__Host-`, HttpOnly, Secure, SameSite=Lax); authenticated `/app`; session persistence; sign-out; signed-out `/app` → `/login`.

**Production returning email/password authentication — PROVEN CP26A.5** (normal sign-out; unauthenticated `/app` protected; same identity and configured hotel recovered; no second user or hotel).

**Backlog / deferred:** copied-cookie stale-session replay; password recovery; email verification.

### Production verification tenant (RETAIN)

Classification: **PERSISTENT PRODUCTION VERIFICATION TENANT — RETAIN**.

| Field | Value |
|---|---|
| Identity | exactly one; operator-controlled email **REDACTED**; password in human password manager only |
| Hotel name | SBG Verification Hotel |
| Internal booking code | `sbg-verify-a5` |
| Public slug | `erification-otel` |
| Locality / TZ / currency | Verification Locality · Europe/Athens · EUR |
| Status | **configured** (not live, not guest-bookable) |
| Catalogue | Verification Transfer · Verification Airport · EUR 10.00 |
| Publication | `/erification-otel` and `/book/sbg-verify-a5` return `hotel_not_live` |
| Billing | authenticated GET `/app/billing` resolved this configured hotel; Connect/Checkout not invoked |
| Customer | **never** |

Do not delete casually. Do not publish. Do not attach the CP26 Stripe TEST subscription to `sbg-verify-a5`. Do not reuse CP25G.3 spent users or `demo-kos`.

### SaaS operator journey

```
account → hotel → service → preview → QR → plan → Stripe → LIVE
```

- `/app/*` exists and is authentication-gated.
- Onboarding through `/app` is **Production-proven** (CP26A.5) to **configured, not live**.
- Tenancy exists structurally (`app_hotel_accounts`). Schema remains many-to-many. Verification **policy** is one user / one hotel (not a new DB constraint).
- Billing ownership resolves by UUID then `ownedHotel`. Configured-not-live is valid for billing state. Live and Connect are not required.
- Stripe Connect and hotel-owned guest Checkout source exist. Domain B stays `mode=payment` on the hotel connected account, with no application fee. Production booking payments remain **0**.
- Domain A is organisation-scoped property-licence checkout. The browser does not choose Basic, Pro, or Premium, and does not choose a Stripe Price ID. Quantity is server-authorised (self-service 1–49). A missing `property_licence` price mapping fails closed. Commerce **test** may call Stripe only for an allowlisted organisation. Commerce **live** is not enabled.
- One organisation has at most one SBG subscription. A second Checkout is refused; management uses the portal.
- Domain A webhooks call `sbg_apply_organisation_billing_event`, retain quantity, and keep duplicate, stale, ambiguous, and conflicting-subscription protection. The 10-argument hotel function remains historical and is not the active path.
- Entitlement is an active/trialing/past_due organisation subscription plus an unreleased property allocation. Users are not licences. `hotels.status` is not SaaS publication.
- MRR/ARR is licensed quantity times the contracted price version. It is not `pending_catalogue`.
- `SBG_SAAS_COMMERCE=test` is set on Production. Do not change it to `live`. Domain A test mode uses `SBG_SAAS_TEST_ORGANISATION_IDS` and fail-closes when empty.

### Guest / Ops

- Guest booking exists. `demo-kos` is **live** on Production via **`/book/demo-kos`** and is **not** the SaaS verification tenant.
- `/demo-kos` slug route currently returns `hotel_not_found` (pre-existing; not caused by the verification fixture). Canonical demo remains `/book/demo-kos`.
- Hotel-owned guest payment source exists; not Production-proven. Domain B is outside the Domain A kill-switch.
- `/ops/*` remains isolated from SaaS `/app/*`. Production Ops credentials are absent.

### Known non-blocking findings (do not fix in CP26B.4)

- **Slug normalisation:** `sbg_slug_base` strips uppercase before `lower()`. `"SBG Verification Hotel"` → `erification-otel`. Do not rewrite the persisted verification slug without a later migration/redirect plan.
- **Auth UX:** `/login` defaults to account creation; returning users must choose Sign in. Security boundary passed.
- **Onboarding UX:** completed setup steps disappear from the flow (Step 2 vanished after the service persisted).
- **Demo slug/code:** `/book/demo-kos` works; `/demo-kos` does not resolve the live demo.

### What must not be claimed

- Do not claim CP17/CP19 is current.
- Do not claim CP22 is next or CP24 is current.
- Do not claim Neon is unproven or Vercel is disconnected.
- Do not claim migrations after 0017 are absent.
- Do not claim `/app/*` does not exist.
- Do not claim CP25G.3 remains open.
- Do not claim 0023 or 0024 is unapplied, or that a 0022/0023/0024 dispatch workflow remains.
- Do not claim returning Production sign-in is unproven.
- Do not claim the Production verification tenant does not exist.
- Do not treat CP26 as commercial go-live. Only CP31 activates LIVE commerce.
- Do not switch `SBG_SAAS_COMMERCE` to `live`. Do not resume CP26C.3. Former CP26C.4 and the O4–O11 chain stay superseded. Empty allowlists fail-close.
- Do not invent CP26B.5.
- Do not claim CP26 STRIPE TEST is still pending, or that CP26 is incomplete.

Canonical forward path: **`docs/ROADMAP.md`**. Commercial model: **`docs/COMMERCIAL_MODEL.md`**. Commercial catalogue: **`docs/COMMERCIAL_CATALOGUE.md`**. Fixture policy: **`docs/FIXTURE_POLICY.md`**. Owner architecture: **`docs/OWNER_CONTROL_PLANE.md`**. **CP26 COMPLETE.** Gate B accepted ledger is **0001–0028**. 0027 digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef` applied (GHA [36251190175](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36251190175)). 0028 digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d` applied (GHA [36254890554](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36254890554)). 0025, 0026, 0027, and 0028 dispatch workflows are **RETIRED**. `property_licence` is the only active plan. basic/pro/premium are inactive. One price version EUR 17900 month. One verified TEST mapping. No LIVE mapping. One TEST organisation, one subscription, quantity 3. Licensed 3, active allocations 0, available 3. Commerce **test**, not live. **Next is CP27 — SECURITY HARDENING. Not started.** Only **CP31** activates LIVE commerce. Historical O3.2B remains PASS (GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457)). Active Production platform Owners: **1**. First-Owner bootstrap workflow **RETIRED** (historical run [36116463589](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36116463589)). Password never enters git.

Non-blocking UI backlog: Owner header rendered “SSBG Verification” (presentation/spacing or avatar-initial concatenation). Deferred. Not an authorization defect.

GitHub `main` at the current SHA is authoritative application source. A workspace is never authoritative. Recovery ZIPs are secondary disaster-recovery artifacts. The CP10 ZIP must not be extracted over a newer Git tree without explicit human approval.

---

## Historical (not current)

- CP26B.3 CLOSED — Production 0024 via GHA [35697938230](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35697938230); already-applied verification GHA [35699337916](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35699337916); digest `23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0`; controller identity repair SHA `19512c2`; demo-kos remained live; billing 0; events 0.
- CP26B.2 SOURCE COMPLETE — ordered persistence source SHA `ff2581f`; docs SHA `2939948`; 0024 not applied in that child.
- CP26A.5 COMPLETE — one Production verification identity + hotel `sbg-verify-a5` configured-not-live; returning sign-in proven; billing GET only; no Stripe.
- CP26A.2 COMPLETE — Production 0023 via GHA run [35581165068](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35581165068); controller SHA `b35ef2f`; 0023 SHA-256 `469eeee3c8707beb40a2a268bea53c77620265efb969bfbff12c524e17585ba1`; demo-kos remained live; single-use 0022/0023 `workflow_dispatch` retired.
- `cp17-known-good` / `45e171a23037b7c94005018cd2126033a449d6f0` — immutable CP16C/CP17 source tag. Not current `main`.
- CP10 occupancy ZIP — historical disaster-recovery artifact only.
- CP19 originally meant Neon binding/verification. That work completed in later controlled production checkpoints; do not treat the old “CP19 unfinished” wording as living state.
- CP22–CP25 / CP25G.3 source and production work happened after CP17. See `docs/CP22_V1_OPERATOR_ONBOARDING.md`, `docs/CP23_PUBLIC_HOTEL_SLUG.md`, `docs/CP24_STRIPE_BILLING.md` as **completed checkpoint specifications**, not as the next task.
- Single-use 0022/0023/0024 GitHub Actions workflows existed to apply those migrations once. They were retired after successful Production application. Scripts remain as historical/test evidence (already-applied = no-op).
