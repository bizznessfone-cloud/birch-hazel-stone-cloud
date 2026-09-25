# SCAN / BOOK / GO — forward roadmap (CP26–CP31)

Canonical living roadmap. Other living documents should **point here**, not redefine these meanings.

| Field | Value |
|---|---|
| Formalised on parent | `91ba2c15c6f3b5b11106ebc006e433515e1f0f86` |
| Last application SHA | `19512c295830fbc6fd9712d688ce364d940f87c3` (CP26B.3R catalog identity) |
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
| **Next product checkpoint** | **CP26C-O3.3** — Owner Commercial Catalogue UI |

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
- Stripe TEST products/prices/webhook endpoint preparation (**CP26C.3**, paused until O3)
- Production Stripe configuration remains **absent** (must stay absent until CP26C.4)
- Do **not** set `SBG_SAAS_COMMERCE=test` on public Production until CP26C.4 explicitly authorises it **after** the CP26C.2 hotel allowlist is deployed. Empty `SBG_SAAS_TEST_HOTEL_IDS` fail-closes every hotel even if mode=test.

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

**CP26C-O3.2C PASS:** Gate B accepted ledger is **0001–0026**. `AUTHORISED_PENDING=[]`. Workflow `.github/workflows/cp26co32a-0026-production-migrate.yml` is **RETIRED**. npm alias `db:migrate:0026` is **RETIRED**. Historical script `scripts/cp26co32a-0026-production-migrate.mjs` remains. 0027+ stays fail-closed. Amounts remain **UNDEFINED**. Commerce **OFF**. Stripe untouched. CP26C.3 stays paused until O3.4. Checkout stays on transitional env Price IDs until **CP26C.4**.

**Next product: CP26C-O3.3** — Owner Commercial Catalogue UI. Do not start it inside O3.2C. Do not resume CP26C.3. Only **CP31** activates LIVE commerce.

Sequence:

```
CP26C.2 PASS → CP26C-O1 → CP26C-O2 → CP26C-O2A → CP26C-O2B (0025 applied) → CP26C-O2C (first Owner bootstrapped; workflow retired) → CP26C-O3.1 (contract) → CP26C-O3.2 (source 0026 verified) → CP26C-O3.2A (0026 controller) → CP26C-O3.2B (0026 applied) → CP26C-O3.2C (Gate B 0001–0026; workflow retired) → CP26C-O3.3 (Owner plans UI) → CP26C-O3.4 (human canonical prices) → resume CP26C.3 (TEST mappings only) → CP26C.4 (checkout cutover) → CP31 (LIVE)
```

**Do not enable test commerce on public Production until CP26C.4.** Empty allowlist = nobody authorised. Only **CP31** activates live commerce.

### CP26D — HOTEL-OWNED GUEST PAYMENT REGRESSION

Prove CP26 did not weaken Domain B: Connect context mandatory; no SBG application fee unless a future authorised business-model change; guest records separate from SaaS billing; entitlement must not confuse guest payment status with SaaS status.

---

## CP27 — FINAL SECURITY AUDIT / HARDENING

Security review and remediation of completed V1 **after** CP26 functional architecture is complete.

Includes: auth/session; tenancy/IDOR; privileges; Stripe webhook and metadata trust; entitlement bypass; secret exposure; Checkout manipulation; Connect state; public/private DTOs; CSRF/replay.

Does **not** commercially activate the platform.

## CP28 — FULL SYSTEM VERIFICATION

End-to-end, regression, failure-path, integration, concurrency; auth, tenancy, onboarding, booking, SaaS subscription, Domain B. No commercial activation.

## CP29 — LOAD / SCALABILITY TESTING

Controlled load: occupancy concurrency; pool behaviour; webhook bursts; API concurrency; Checkout/session fan-out where safely testable. No live customer load. No commercial activation.

## CP30 — PRODUCTION READINESS GATE

Final readiness **without** commercial activation. The system may be technically capable of going live but must remain commercially dormant.

Includes: production configuration review; runbooks; rollback; monitoring; domain; backup/recovery; closed security findings; regression/load gates; **commercial activation checklist prepared**. Live commerce remains **OFF**.

## CP31 — INTENTIONAL COMMERCIAL GO-LIVE

**Only CP31** may cross **READY → LIVE**. Requires explicit human authorisation and a checklist (live credentials/products/prices/webhook; kill-switch transition; public CTA; entitlement/live as designed; domain; monitoring; rollback; first-transaction controls).

CP30 success does **not** start CP31.
