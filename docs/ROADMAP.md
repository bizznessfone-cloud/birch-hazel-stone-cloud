# SCAN / BOOK / GO — forward roadmap (CP26–CP31)

Canonical living roadmap. Other living documents should **point here**, not redefine these meanings.

| Field | Value |
|---|---|
| Formalised on parent | `91ba2c15c6f3b5b11106ebc006e433515e1f0f86` |
| Application baseline | `b35ef2fc8bdddef81fcc84aa59d358dba4346a30` |
| CP25G.3 | **CLOSED** |
| CP26A.1 / CP26A.2 | **CLOSED** |
| **Next execution checkpoint** | **CP26A remaining: operator-owned hotel lifecycle + fixture policy** |

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

Resolved in CP26A.1 / CP26A.2:

- Domain A kill-switch + Stripe test/live enforcement (`SBG_SAAS_COMMERCE`)
- live Stripe configuration alone cannot activate Domain A
- `sbg_sync_hotel_entitlement` no longer writes `hotels.status` (Production 0023)

Still open (later CP26 work):

- possible duplicate SaaS subscriptions
- incomplete failed-payment / past_due lifecycle
- Stripe integration has not been exercised in test mode
- Production Stripe configuration remains **absent** (must stay absent until an authorised child)

---

## CP26 — SUBSCRIPTIONS / STRIPE COMMERCIAL SYSTEM

**Objective:** Build, integrate, and **test** the SBG SaaS subscription/commercial billing system (Domain A).

**Entry:** CP25G.3 closed; living source-of-truth aligned; this roadmap formalised.

**Exit:** Domain A is complete and proven in **Stripe test mode**; Domain B regression holds; commerce remains dormant; no real customer subscription accepted.

**Exclusions:** No `sk_live`; no real charges; no CP31 activation; no Domain B rebuild unless a defect is found.

### CP26A — COMMERCIAL DORMANCY + SAAS TENANT FOUNDATION

Must complete **before** Stripe integration testing.

1. ~~Explicit commerce dormancy / kill-switch architecture.~~ **DONE (CP26A.1)**
2. ~~Explicit Stripe test/live mode enforcement.~~ **DONE (CP26A.1)**
3. ~~Prevent adding Stripe configuration alone from silently activating real commerce.~~ **DONE (CP26A.1)**
4. ~~Decouple or safely gate SaaS billing entitlement from automatic public hotel LIVE status.~~ **DONE (CP26A.2; Production 0023)**
5. Establish/prove the controlled operator-owned hotel lifecycle required for hotel-scoped billing.
6. Define safe Production/test fixture policy.
7. Preserve payment-domain separation.

**Mutation:** source (and tests) as required; no Production live Stripe keys; no real subscriptions.  
**Remaining CP26A execution:** items 5–6. Do not start CP26B until those complete.

### CP26B — SAAS SUBSCRIPTION LIFECYCLE COMPLETION

Complete Domain A lifecycle in source (exact design in CP26B preflight): creation; single-subscription / duplicate prevention; customer mapping; updates; upgrade/downgrade; cancellation; period end; incomplete/failed/past_due; invoice events where required; webhook idempotency; portal; entitlement state.

### CP26C — STRIPE TEST-MODE INTEGRATION

Exercise Domain A against Stripe **TEST MODE ONLY** (`sk_test`, test products/prices, test Checkout/cards/webhooks/portal/failures).  

**Hard prohibition:** no `sk_live`; no real customer charge; no real SaaS subscription.

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
