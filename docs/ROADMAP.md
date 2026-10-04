# SCAN / BOOK / GO — forward roadmap (CP26–CP31)

Canonical living roadmap. Other living documents should **point here**, not redefine these meanings.

| Field | Value |
|---|---|
| Formalised on parent | `91ba2c15c6f3b5b11106ebc006e433515e1f0f86` |
| Last application SHA | Verification baseline `30173015216ca638a7d63736205fe20be11d3880`. `19512c2` is the older CP26B.3R catalog identity, not current `main` |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| CP26B.1 | **PASS** — application lifecycle hardened (gate-before-write, one subscription, portal-first) |
| CP26B.2 | **SOURCE COMPLETE** then **APPLIED** via CP26B.3 |
| CP26B.3 | **CLOSED** — Production 0024 applied and independently verified |
| CP26B.4 | **PASS** — Gate B 0001–0024; 0024 dispatch retired |
| **CP26B** | **CLOSED** |
| CP26C.1 | **PASS** — test-mode isolation architecture (hotel-UUID dual-control allowlist) |
| CP26C.2 | **PASS** — fail-closed Domain A test-hotel isolation in source |
| CP26C.3 | **PAUSED AFTER SAFE PREFLIGHT** — no Stripe objects; no Vercel Stripe env; amounts not invented |
| CP26C-O1 | **PASS** — Owner Control Plane architecture |
| CP26C-O2 | **CLOSED** — Owner dashboard Production-proven |
| CP26C-O2A | **PASS** — single-use 0025 Production controller |
| CP26C-O2B | **PASS** — Production 0025 applied |
| CP26C-O2C.1 | **PASS** — first-Owner bootstrap controller built |
| CP26C-O2C.2 | **PASS** — first Owner bootstrapped (GHA 36116463589) |
| CP26C-O2C.3 | **PASS** — bootstrap workflow retired |
| CP26C-O3.1 | **PASS** — commercial catalogue contract ([`COMMERCIAL_CATALOGUE.md`](COMMERCIAL_CATALOGUE.md)); amounts UNDEFINED |
| CP26C-O3.2 | **PASS** — source `0026` verified, then Production-applied in O3.2B |
| CP26C-O3.2A | **PASS** — controller built; dispatch **RETIRED** in O3.2C |
| CP26C-O3.2B | **PASS** — Production 0026 applied once (GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457)) |
| CP26C-O3.2C | **PASS** — Gate B **0001–0026**; single-use 0026 workflow retired |
| CP26C-O3.3 | **PASS** — Owner commercial catalogue UI; amounts still UNDEFINED; Production prices **0** |
| CP26C-O2D | **PASS** — `/owner/login` isolated from hotel `/login`; no migration |
| CP26C-O3.3V | **PASS** — operator Production plans verification; no price created |
| CP26C-O3R | **PASS** — organisation property-licence model reconciled; no implementation ([`COMMERCIAL_MODEL.md`](COMMERCIAL_MODEL.md)) |
| CP26 FINALISATION | **PASS** — Production **0001–0028**; `property_licence` active; basic/pro/premium inactive; Domain A cut over to organisation quantity. Finalisation snapshot: commerce OFF. **CP26 was not yet complete** |
| CP26 STRIPE TEST | **PASS** — one TEST subscription, quantity 3, EUR 17900/month; allocation and duplicate webhook proven |
| CP26 EXIT GATE | **PASS** — **CP26 COMPLETE**. Commerce remains **test**. LIVE locks false |
| **CP27** | **CLOSED** — security hardening. CP27.3a/b/c in source. Read-only CP27.3 closure **PASS** on `b8b04e7`. No migration 0031 |
| CP28.2 | **VERIFIED** — local product regression, typecheck, build. Not a Neon proof |
| CP28.2B | **BLOCKED** — Production cleanup/privilege boundary. Not an occupancy defect |
| CP28.2C | **VERIFIED** — disposable Neon race only (`br-icy-shadow-b1fh96gk`, GHA [37031757779](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37031757779)). Production branch not used. Workflow retired |
| CP28.3 | **VERIFIED WITH COVERAGE LIMIT** — journeys on throwaway PGLite and unauthenticated browser shells. No Production login. No Stripe session |
| **CP28** | **CLOSED** |
| CP29.2 | **CLOSED** — disposable guest-create load, occupancy, limiter, and publication boundary. Not Production |
| CP29.3 | **PASS** — bottleneck and capacity measurement. Pool max 2 was not changed. Guest-create time is serial database round trips. See [`BUILD_STATE.md`](../BUILD_STATE.md) |
| CP29.4 | **Measurement completed** — function region `iad1`. Transport and SQL RTT were still open until CP29.4A |
| CP29.4A | **PASS** — Production URL is Neon **pooler**, region **eu-central-1**, warm in-function `SELECT 1` p50 93.429 ms. See [`BUILD_STATE.md`](../BUILD_STATE.md) |
| **CP29** | **CLOSED** |
| CP30.2A | **PASS** — observability boundary designed. Agent not built. Monitors not configured |
| CP30.2B | **PASS** — `GET /api/ready` only. See [`BUILD_STATE.md`](../BUILD_STATE.md) |
| **CP30** | **NOT CLOSED**. CP30.2C is not started. CP30.3 is not started |
| **Next** | **CP30.2C — DETERMINISTIC EXTERNAL MONITORING. NOT STARTED**. Not Production launch. Not public launch. Not LIVE commerce. The twelve-step O4–O11 chain is superseded and must not be executed. **CP26C.3** is not resumed. Only **CP31** activates LIVE commerce |

---

## Commercial architecture

```
CP26  BUILD + INTEGRATE + TEST COMMERCE
CP27  security audit / hardening
CP28  full system verification
CP29  load / scalability
CP30  production readiness (commercially dormant)
CP31  ACTIVATE COMMERCE  (READY → LIVE)
```

**CP26 is not go-live. Only CP31 may deliberately activate real commercial use.**

Passing CP30 must **not** automatically trigger CP31.

---

## Payment-domain contract

### Domain A — SBG SaaS subscriptions (primary CP26 concern)

Money: **Hotel/operator → SCAN BOOK GO**  
Purpose: SBG subscription and future add-on revenue.

### Domain B — Hotel-owned guest transfer payments

Money: **Guest → Hotel/operator**  
Purpose: hotel transfer revenue.

SCAN BOOK GO must **not** become merchant-of-record or take custody of Domain B funds under the current business model.

Domain B is **not** the primary CP26 implementation target. Existing CP25 Connect / guest Checkout must be **reused**, not rebuilt, unless a defect is found.

---

## Commercial dormancy invariant (until CP31)

Until CP31, with explicit human authorisation:

- no real SBG SaaS subscription payments
- no live SaaS Checkout offered to customers
- no intentional real subscription creation
- no accidental activation merely from environment configuration
- test mode must be distinguishable from live mode
- Production may contain **dormant** commerce code
- commercial activation requires explicit CP31 action
- no `sk_live` activation during CP26
- no public production signup journey may become a money-taking sales funnel

Stripe **test** mode, mocks, fixtures, and controlled non-money-taking verification are permitted when a CP26 child specifically authorises them.

---

## Current Stripe state (not remediated)

Reuse, do not rebuild:

- `sbg_billing_accounts`, SaaS subscription Checkout, billing portal
- Stripe Connect, shared webhook, event idempotency, `/app/billing`
- hotel-owned guest Checkout, `sbg_booking_payments`

Resolved in CP26A:

- Domain A kill-switch + Stripe test/live enforcement (`SBG_SAAS_COMMERCE`)
- live Stripe configuration alone cannot activate Domain A
- `sbg_sync_hotel_entitlement` no longer writes `hotels.status` (Production 0023)
- persistent Production verification tenant exists (`sbg-verify-a5`, **configured not live**)
- configured hotel is sufficient for Domain A billing GET; live and Connect are not required

Resolved in CP26B (application + Production schema; commerce still OFF):

- one-subscription Checkout invariant (duplicate SaaS Checkout blocked)
- portal-first plan management (no custom upgrade/downgrade/cancel APIs)
- application classification of `past_due` / `unpaid` / `incomplete` / `paused`
- commerce gate before any Domain A billing write
- ordered Domain A webhook persistence (`event.created` bigint; duplicate / stale / ambiguous)
- `cancel_at_period_end` persisted without cancelling or publishing
- Production migration **0024** applied exactly once (GHA [35697938230](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35697938230)) and independently verified already-applied (GHA [35699337916](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35699337916)); digest `23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0`
- ordered 10-argument `sbg_apply_billing_event` installed; historical 8-argument last-write-wins function absent
- 0024 `workflow_dispatch` retired; generic Production migrator remains fail-closed

Still open (later CP26 work):

- Owner Control Plane catalogue (**CP26C-O3**) — architecture: [`OWNER_CONTROL_PLANE.md`](OWNER_CONTROL_PLANE.md); O2 foundation is in source
- Stripe TEST products/prices/webhook endpoint preparation (**CP26C.3 superseded; not resumed**; later **CP26C-O9**)
- Production Stripe configuration remains **absent** (must stay absent; former CP26C.4 is superseded)
- Do **not** set `SBG_SAAS_COMMERCE=test` on public Production until **CP26C-O11** explicitly authorises it. Empty `SBG_SAAS_TEST_HOTEL_IDS` fail-closes every hotel even if mode=test.

---

## CP26 — SUBSCRIPTIONS / STRIPE COMMERCIAL SYSTEM

**Objective:** Build, integrate, and **test** the SBG SaaS subscription/commercial billing system (Domain A).

**Entry:** CP25G.3 closed; living source-of-truth aligned; this roadmap formalised.

**Exit:** Domain A is complete and proven in **Stripe test mode**; Domain B regression holds; commerce remains dormant; no real customer subscription accepted.

**Exclusions:** No `sk_live`; no real charges; no CP31 activation; no Domain B rebuild unless a defect is found.

### CP26A — COMMERCIAL DORMANCY + SAAS TENANT FOUNDATION — CLOSED

Completed **before** Stripe integration testing.

1. ~~Explicit commerce dormancy / kill-switch architecture.~~ **DONE (CP26A.1)**
2. ~~Explicit Stripe test/live mode enforcement.~~ **DONE (CP26A.1)**
3. ~~Prevent adding Stripe configuration alone from silently activating real commerce.~~ **DONE (CP26A.1)**
4. ~~Decouple or safely gate SaaS billing entitlement from automatic public hotel LIVE status.~~ **DONE (CP26A.2; Production 0023)**
5. ~~Establish/prove the controlled operator-owned hotel lifecycle required for hotel-scoped billing.~~ **DONE (CP26A.4 local; CP26A.5 Production)**
6. ~~Define safe Production/test fixture policy.~~ **DONE (`docs/FIXTURE_POLICY.md`; Production tenant retained)**
7. Preserve payment-domain separation. (standing invariant; CP26A.4 Domain B non-regression holds)

**Mutation:** source (and tests) as required; no Production live Stripe keys; no real subscriptions.

### CP26B — SAAS SUBSCRIPTION LIFECYCLE COMPLETION — CLOSED

**BUILD / INTEGRATE / TEST ONLY.** Not real SaaS commerce, not live customer orders, not real subscription charging, not CP31 activation.

Completed Domain A lifecycle in source: creation; single-subscription / duplicate prevention; customer mapping; updates; upgrade/downgrade; cancellation; period end; incomplete/failed/past_due; invoice events where required; webhook idempotency; portal; entitlement state.

**CP26B.1 PASS:** application lifecycle — commerce gate before billing write; one-subscription Checkout invariant; portal-first plan management; SaaS entitlement classification independent of `hotels.status`.

**CP26B.2 SOURCE COMPLETE:** ordered Domain A webhook persistence in source. Migration `0024_cp26b2_ordered_billing_events.sql` defined. Ordering: Stripe `event.created` (bigint Unix seconds). Duplicate event ID → idempotent no-op. Newer → apply. Older → stale no-op. Equal timestamp, different event IDs → ambiguous, no billing mutation. `cancel_at_period_end` is persisted and does not itself cancel or publish.

**CP26B.3 CLOSED:** controlled Production application of 0024. Apply run [35697938230](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35697938230) committed SQL (ledger 0001–0024). Aftermath then failed only catalog `function-identity` (unnamed vs named). Repair SHA `19512c2`. Verification run [35699337916](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35699337916) verdict `0024 ALREADY APPLIED — NO MUTATION`. Ordered 10-argument function installed; 8-argument function gone. Billing accounts 0; Stripe events 0. Commerce OFF.

**CP26B.4 PASS:** control-plane / documentation reconciliation. Gate B accepted ledger **0001–0024**. `AUTHORISED_PENDING` remains empty. Spent 0024 `workflow_dispatch` deleted. Generic migrator remains fail-closed. No CP26B.5.

**CP26B — CLOSED.** Next execution: **CP26C**. Do not start CP26C in this child.

### CP26C — STRIPE TEST-MODE INTEGRATION

Exercise Domain A against Stripe **TEST MODE ONLY** (`sk_test`, test products/prices, test Checkout/cards/webhooks/portal/failures).

**Hard prohibition:** no `sk_live`; no real customer charge; no real SaaS subscription.

**CP26C.1 PASS:** isolation architecture — Domain A test commerce requires dual control: `SBG_SAAS_COMMERCE=test` + Stripe test credentials + non-empty `SBG_SAAS_TEST_HOTEL_IDS` containing the hotel UUID. Live mode ignores the test allowlist. CP31 remains the only live activation.

**CP26C.2 PASS:** isolation implemented in source (Checkout, portal, Domain A webhook). Production commerce remains **OFF**. No Stripe Production configuration.

**CP26C.3 PAUSED AFTER SAFE PREFLIGHT:** source Stripe contract inspected; canonical BASIC / PRO / PREMIUM **amounts are not defined** and were not invented. No Stripe TEST objects created. No Vercel Stripe configuration installed. Commerce remains OFF. Allowlist remains absent.

**CP26C-O1 PASS:** Owner Control Plane architecture. Canonical document: [`OWNER_CONTROL_PLANE.md`](OWNER_CONTROL_PLANE.md). SBG database will own the commercial catalogue (plans + versioned prices + Stripe TEST/LIVE mappings). Vercel env Price IDs are transitional.

**CP26C-O2 CLOSED:** Owner dashboard foundation is Production-proven. Human `/owner` verification passed (Overview, Hotels, Plans & Pricing, Revenue, System). Active platform Owners = 1 (OPERATOR CONTROLLED / REDACTED). Migration `0025_cp26co2_platform_owners.sql` is Production-applied. Do not resume CP26C.3 until O3.

**CP26C-O2A then CP26C-O2B PASS:** dedicated single-use controller applied Production 0025 (GHA 35758982641). Digest `575aabcb7322fc8ca63c8a3dd137d358f76375f1777ed59cf04c1d98d6c066fd`.

**CP26C-O2C PASS:** first Owner bootstrapped once (GHA [36116463589](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36116463589), verdict `GATE PASS — FIRST OWNER BOOTSTRAPPED AND VERIFIED`). Target hotel code `sbg-verify-a5`. Pre active Owners 0; post 1; one `owner.granted` audit with `bootstrap = true`. Workflow `.github/workflows/cp26co2c-first-owner-bootstrap.yml` is **RETIRED**. Historical script remains. Gate B accepted ledger is **0001–0025**. `AUTHORISED_PENDING=[]`.

Non-blocking UI backlog: Owner header showed “SSBG Verification”. Deferred to UI polish. Not an authorization defect.

**CP26C-O3.2B PASS:** Production `0026_cp26co3_commercial_catalogue.sql` applied once. GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457), job `108073574672`, SHA `67d751014b6b5cbb5bd3c9ac4867fbad3da01b52`. Digest `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446`. Verdict `GATE PASS — 0026 APPLIED AND VERIFIED`. Pre-ledger **0001–0025**. Post-ledger **0001–0026**. Plans basic/pro/premium. Price versions 0. Stripe mappings 0. Locks false/false. Active Owners 1. Hotels 4. demo-kos live. sbg-verify-a5 configured. Billing accounts 0. Stripe events 0. Three `catalogue.plan.created` migration audits.

**CP26C-O3.2C PASS:** Gate B accepted ledger is **0001–0026**. `AUTHORISED_PENDING=[]`. Workflow `.github/workflows/cp26co32a-0026-production-migrate.yml` is **RETIRED**. npm alias `db:migrate:0026` is **RETIRED**. Historical script `scripts/cp26co32a-0026-production-migrate.mjs` remains. 0027+ stays fail-closed. Amounts remain **UNDEFINED**. Commerce **OFF**. Stripe untouched. At the time, CP26C.3 was paused until O3.4 and checkout was to stay on env Price IDs until CP26C.4. **CP26C-O3R superseded those two conditions.**

**CP26C-O3.3 implemented.** `/owner/plans` reads the Production catalogue and mutates only through the 0026 functions `sbg_catalogue_update_plan`, `sbg_catalogue_create_price_version`, `sbg_catalogue_activate_price_version`, and `sbg_catalogue_retire_price_version`. It does not call Stripe, record mappings, change LIVE locks, publish hotels, or edit guest-transfer prices. Canonical amounts remain **UNDEFINED**. Production price versions remain **0**. Stripe mappings remain **0**. Commerce **OFF**.

**CP26C-O2D PASS:** `/owner/login` is the Owner sign-in surface (sign-in only). `/login` remains hotel/operator signup and sign-in, with no Owner link. Unauthenticated `/owner/*` redirects to `/owner/login`. An authenticated non-Owner is denied with “Owner access unavailable.” and is not sent to `/app`. Owner sign-out returns to `/owner/login`. The same Better Auth session is used. The first Platform Owner grant is unchanged. No migration. No Production DML. Commerce **OFF**.

**CP26C-O2D human verification PASS** (operator evidence). **CP26C-O3.3V PASS** (operator evidence): `/owner/plans` showed BASIC, PRO, and PREMIUM active, no canonical prices, “Price not configured”, TEST and LIVE not mapped, price controls present, and no price was created. The “SSBG Verification” header defect stays non-blocking backlog.

**CP26C-O3R PASS (snapshot at that checkpoint):** The locked commercial model is one organisation, one Stripe customer, one subscription, quantity = purchased property licences. At O3R there was no organisation table in source and billing was hotel-scoped. That sentence is not current. 0027 later created the tables and CP26 FINALISATION cut Domain A over to them. Decision: [`COMMERCIAL_MODEL.md`](COMMERCIAL_MODEL.md). O3R itself made no migration and no runtime change. Amounts remain **UNDEFINED**. Former **O3.4**, the previously scoped **CP26C.3** resume, and the previously scoped **CP26C.4** tier cutover are **superseded**. Do not start them. Only **CP31** activates LIVE commerce.

**CP26 FINALISATION COMPLETE (snapshot).** This paragraph records the state at the end of finalisation, before Stripe TEST. Production ledger is **0001–0028** exactly once each. Gate B accepted ledger is **0001–0028**. `AUTHORISED_PENDING=[]`. 0027 digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef` (apply GHA [36251190175](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36251190175)) is ordinary accepted history. Its workflow is **RETIRED**. 0028 `migrations/0028_cp26fin_property_licence_catalogue.sql` digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d` applied once (GHA [36254890554](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36254890554)). Its workflow is **RETIRED**. The historical controller script remains; its `REQUIRED_LEDGER` stays frozen at **0001–0027** and must not follow Gate B. At that snapshot: price versions 0, mappings 0, organisations 0, commerce OFF.

**CP26 STRIPE TEST — PASS. CP26 EXIT GATE — PASS. CP26 — COMPLETE.** One TEST organisation `4208626a-ef20-4f5a-b28e-0d8b9c778205`, customer `cus_VKwWNaJ4nwUTfM`, subscription `sub_1UKGdCFHnHXHuPOwgswtqBhL`, one item, quantity 3, price `price_1UKGWjFHnHXHuPOwO50TJS93`, catalogue version `b13f9445-d27a-4e7d-8128-a2238906ce7c` EUR 17900 month. Event `evt_1UKKPiFHnHXHuPOwM7L3ZmoM` applied once; same-id replay did not move `processed_at`. Allocation proof passed, then all four fixtures were released. Licensed 3, active 0, available 3. Domain B unchanged. LIVE locks false. Commerce **test**, not live. The 0025 dispatch workflow is **RETIRED**. **At CP26 close, next was CP27 — SECURITY HARDENING, not started.** That sentence is historical. CP27, CP28, and CP29 later closed. Current next is CP30.2C, not started. See the living table.

The O4.2 paragraph below is the historical controller-ready record. It is not the current state. 0027 was later applied and accepted. Do not dispatch a 0027 workflow; the file is gone.

**Historical CP26C-O4.2 record (controller ready at that checkpoint; later applied and retired):** Controller `scripts/cp26co42-0027-production-migrate.mjs`. The workflow file is **RETIRED**. Confirmation was `APPLY-0027`. Digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef`.

The sequences below are historical. Do not execute either tail. The O4–O11 chain is **superseded**. CP26 FINALISATION absorbed the dormant architecture those steps described (organisation persistence, catalogue identity, Owner product surface, quantity application) without a price, a Stripe mapping, or commerce.

Pre-O3R plan (historical):

```
CP26C.2 PASS → CP26C-O1 → CP26C-O2 → CP26C-O2A → CP26C-O2B (0025 applied) → CP26C-O2C (first Owner bootstrapped; workflow retired) → CP26C-O3.1 (contract) → CP26C-O3.2 (source 0026 verified) → CP26C-O3.2A (0026 controller) → CP26C-O3.2B (0026 applied) → CP26C-O3.2C (Gate B 0001–0026; workflow retired) → CP26C-O3.3 (Owner plans UI) → CP26C-O2D (Owner login surface) → human `/owner/login` verification → CP26C-O3.3V → CP26C-O3.4 (human canonical prices) → resume CP26C.3 (TEST mappings only) → CP26C.4 (checkout cutover) → CP31 (LIVE)
```

Post-O3R plan, superseded by CP26 FINALISATION (historical):

```
CP26C-O3R PASS → CP26C-O4.1 (organisation source) → O4.2 controller → O4.3 one apply → O4.4 retire → CP26C-O5 (property_licence catalogue identity, no amount) → CP26C-O6 (Owner UI) → CP26C-O7 (quantity application, commerce OFF) → CP26C-O8 (one human price version) → CP26C-O9 (Stripe TEST mapping) → CP26C-O10 (organisation TEST allowlist) → CP26C-O11 (TEST commerce) → CP31 (LIVE)
```

Remaining CP26 work, in order:

```
CP26 FINALISATION PASS → CP26 STRIPE TEST PASS → CP26 EXIT GATE PASS → CP26 COMPLETE → CP27 SECURITY HARDENING (not started)
```

The line above is the remaining-work list **at CP26 close**. It later completed: CP27 **CLOSED**, CP28 **CLOSED**, CP29 **CLOSED**. Current next is CP30.2C, not started. Do not restart CP27. Do not start CP30.2C from this note.

**Do not switch public Production commerce from test to live.** Empty organisation and hotel allowlists fail-close. Only **CP31** activates LIVE commerce.

### CP26D — HOTEL-OWNED GUEST PAYMENT REGRESSION

Prove CP26 did not weaken Domain B: Connect context mandatory; no SBG application fee unless a future authorised business-model change; guest records separate from SaaS billing; entitlement must not confuse guest payment status with SaaS status.

---

## CP27 — FINAL SECURITY AUDIT / HARDENING

Security review and remediation of completed V1 **after** CP26 functional architecture is complete.

Includes: auth/session; tenancy/IDOR; privileges; Stripe webhook and metadata trust; entitlement bypass; secret exposure; Checkout manipulation; Connect state; public/private DTOs; CSRF/replay.

Does **not** commercially activate the platform.

**Outcome: CLOSED.** Implemented in CP27.3a (Better Auth perimeter), CP27.3b (signup enumeration and billing reads), and CP27.3c (guest booking client IP). Read-only reconciliation **PASS** on `b8b04e7`. Residuals (memory auth rate limits, email verification off, last-billing and last-owner races, PGLite `aether_runtime` EXECUTE, Domain A orphan checkout session, raw quantity above the self-service cap, dev guest limiter fail-open, ops lockout) stay deferred. They were not immediate bypasses. No migration 0031.

## CP28 — FULL SYSTEM VERIFICATION

End-to-end, regression, failure-path, integration, concurrency; auth, tenancy, onboarding, booking, SaaS subscription, Domain B. No commercial activation.

**Outcome: CLOSED.** CP28.2 local regression **VERIFIED**. CP28.2B Production race **BLOCKED** on fixture cleanup privileges, not a product defect. CP28.2C disposable Neon race **VERIFIED** (project `quiet-sound-53513710`, branch `br-icy-shadow-b1fh96gk`, not Production). CP28.3 journeys **VERIFIED WITH COVERAGE LIMIT**: authenticated Production Ops, authenticated Owner, real Stripe TEST Checkout, and a live-preview guest wizard were not exercised. Booking status stays free-form by current V1 design. Guest payment integration exists in source; CP28 created no Stripe object. Commerce stays dormant. **CP29 is not started.**

## CP29 — LOAD / SCALABILITY TESTING

**Status: CLOSED.** CP29.2 is **CLOSED**. CP29.3 is **PASS**. CP29.4 measured the deployed region and left transport and SQL RTT open. CP29.4A **PASS** classified Production as Neon pooler in `eu-central-1` and measured warm in-function `SELECT 1` p50 93.429 ms. That does not start CP30, launch Production, or enable LIVE commerce. The CP28 outcome above still says CP29 was not started; that sentence is the state at the CP28 close.

Controlled load: occupancy concurrency; pool behaviour; webhook bursts; API concurrency; Checkout/session fan-out where safely testable. No live customer load. No commercial activation. CP29.2 and CP29.3 measured guest create, occupancy, idempotency, the existing pool, and Ops reads on the disposable branch only. They did not optimise, and they did not exercise webhook or Checkout fan-out.

## CP30 — PRODUCTION READINESS GATE

**Status: NOT CLOSED.** CP30.2A **PASS**. CP30.2B **PASS** (`GET /api/ready`). External deterministic monitors are **not configured**. The Ops Agent is **not built**. CP30.2C is **not started**. CP30.3 is **not started**.

Final readiness **without** commercial activation. The system may be technically capable of going live but must remain commercially dormant.

Includes: production configuration review; runbooks; rollback; monitoring; domain; backup/recovery; closed security findings; regression/load gates; **commercial activation checklist prepared**. Live commerce remains **OFF**.

## CP31 — INTENTIONAL COMMERCIAL GO-LIVE

**Only CP31** may cross **READY → LIVE**. Requires explicit human authorisation and a checklist (live credentials/products/prices/webhook; kill-switch transition; public CTA; entitlement/live as designed; domain; monitoring; rollback; first-transaction controls).

CP30 success does **not** start CP31.
