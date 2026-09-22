# SCAN / BOOK / GO — forward roadmap (CP26–CP31)

Canonical living roadmap. Other living documents should **point here**, not redefine these meanings.

| Field | Value |
|---|---|
| Formalised on parent | `91ba2c15c6f3b5b11106ebc006e433515e1f0f86` |
| Application baseline | `b35ef2fc8bdddef81fcc84aa59d358dba4346a30` |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| CP26B.1 | **PASS** — application lifecycle hardened (gate-before-write, one subscription, portal-first) |
| CP26B.2 | **SOURCE COMPLETE** — ordered billing persistence; migration 0024 **defined, not applied** |
| **Next execution checkpoint** | **CP26B.3 — controlled Production application of migration 0024** |

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

Resolved in CP26B.1 (application layer only; commerce still OFF):

- one-subscription Checkout invariant (duplicate SaaS Checkout blocked)
- portal-first plan management (no custom upgrade/downgrade/cancel APIs)
- application classification of `past_due` / `unpaid` / `incomplete` / `paused`
- commerce gate before any Domain A billing write

Still open (later CP26 work):

- Production application of migration **0024** (**CP26B.3**)
- Stripe integration has not been exercised in test mode (**CP26C**)
- Production Stripe configuration remains **absent** (must stay absent until an authorised child)
- `SBG_SAAS_COMMERCE=test` is process-global (CP26C blast-radius; do not flip on public Production in CP26B)

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

### CP26B — SAAS SUBSCRIPTION LIFECYCLE COMPLETION

**BUILD / INTEGRATE / TEST ONLY.** Not real SaaS commerce, not live customer orders, not real subscription charging, not CP31 activation.

Complete Domain A lifecycle in source (exact design in CP26B preflight): creation; single-subscription / duplicate prevention; customer mapping; updates; upgrade/downgrade; cancellation; period end; incomplete/failed/past_due; invoice events where required; webhook idempotency; portal; entitlement state.

**CP26B.1 PASS:** application lifecycle — commerce gate before billing write; one-subscription Checkout invariant; portal-first plan management; SaaS entitlement classification independent of `hotels.status`.

**CP26B.2 SOURCE COMPLETE:** ordered Domain A webhook persistence in source. Migration `0024_cp26b2_ordered_billing_events.sql` is defined. Production accepted ledger remains **0001–0023**. Controller created, **not executed**.

Ordering: Stripe `event.created` (bigint Unix seconds). Duplicate event ID → idempotent no-op. Newer → apply. Older → stale no-op. Equal timestamp, different event IDs → ambiguous, no billing mutation. `cancel_at_period_end` is persisted and does not itself cancel or publish.

**Next: CP26B.3** controlled Production 0024 application. Commerce remains **OFF**. Do not dispatch the 0024 controller in this child. CP26C still owns real Stripe test-mode integration.

### CP26C — STRIPE TEST-MODE INTEGRATION

Exercise Domain A against Stripe **TEST MODE ONLY** (`sk_test`, test products/prices, test Checkout/cards/webhooks/portal/failures).

**Hard prohibition:** no `sk_live`; no real customer charge; no real SaaS subscription.

**Do not enable test commerce on public Production until blast-radius architecture is explicitly authorised.** `SBG_SAAS_COMMERCE=test` is process-global and would offer test Checkout to any `/login` signup.

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
