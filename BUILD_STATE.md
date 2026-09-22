# BUILD STATE — living record

This file describes **current reality**, not intended future state.

## CP26A — CLOSED

Commercial dormancy, publication decoupling, fixture policy, and a persistent
Production verification tenant are accepted. Domain A commerce remains **OFF**.
Only **CP31** may activate real commerce.

| Field | Value |
|---|---|
| CP26A.1 | **PASS** — Domain A commerce dormant (`SBG_SAAS_COMMERCE=off\|test\|live`; Production unset = fail-closed) |
| CP26A.2 | **PASS** — entitlement/publication decoupling; Production 0023 applied; dispatch retired |
| CP26A.3 | **PASS** — read-only design/preflight of operator-owned hotel lifecycle + fixture policy |
| CP26A.4 | **PASS** — local ownership → configured-not-live → billing UUID resolution; Domain A fail-closed; Domain B non-regression |
| CP26A.5 | **PASS** — one persistent Production verification identity + one owned hotel, **configured not live**, returning sign-in, billing GET |
| CP26A.6 | **PASS** — evidence reconciled; CP26A closed |
| CP26B.1 | **PASS** — Domain A application lifecycle: gate-before-write, one subscription, portal-first plan management |
| Last application SHA | this CP26B.1 commit (runtime `src/` change; no migration) |
| Fixture policy | [`docs/FIXTURE_POLICY.md`](docs/FIXTURE_POLICY.md) |
| Local harness | `src/lib/aether/cp26a4-fixture.ts` (tests only; not a runtime import) |
| Domain A | remains dormant; only **CP31** may activate commerce |
| Accepted Production ledger | **0001–0023** |
| **Next execution** | **CP26B.2 — ordered billing persistence + migration 0024 source** |

Do not dispatch historical 0022/0023 controllers. Owner secret remains GitHub Actions `AETHER_DATABASE_OWNER_URL` only — never Vercel. Future migrations need a dedicated single-use controller and an explicit checkpoint.

Push to `main` currently auto-deploys Vercel Production. That is a known control-plane characteristic, not a commercial activation. CP26B.1 introduces no migration and does not enable commerce.

Password never enters git/chat/Grok/Vercel/`.env`. Do not delete the Production verification tenant.

## Current accepted baseline (POST-CP26B.1)

| Field | Value |
|---|---|
| Product | **SCAN / BOOK / GO** (internal history name: Aether Transfer) |
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | this CP26B.1 commit (runtime `src/` change; no migration) |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| CP26B.1 | **PASS** |
| **Next execution checkpoint** | **CP26B.2 — ordered billing persistence + migration 0024 source** |
| Forward roadmap | **[docs/ROADMAP.md](docs/ROADMAP.md)** (CP26–CP31) |

### Production

| Field | Value |
|---|---|
| Vercel project | `scan-book-go` |
| Last observed deployment (CP26A.5) | `dpl_7MFpVnCV4CbyoUjev1ZjcLVm2vtn` |
| State | READY |
| Alias | `https://scan-book-go.vercel.app` |
| Deployed SHA (last observed) | `d42f7940c698c8b80f9af65a6d43a30f3b3f3831` |

A later push of this documentation child may auto-deploy a docs-only SHA. That must not activate commerce.

Environment (names/presence only):

| Variable | Production |
|---|---|
| `DATABASE_URL` | PRESENT (`aether_app` runtime LOGIN) |
| `AETHER_DATABASE_OWNER_URL` | ABSENT |
| `SBG_SAAS_COMMERCE` | ABSENT (fail-closed Domain A) |
| `BETTER_AUTH_SECRET` | PRESENT |
| `BETTER_AUTH_URL` | PRESENT |
| Stripe / Resend / Ops credentials | ABSENT |

### Database

| Layer | State |
|---|---|
| Source migrations | `0001`–`0023` present |
| Production Neon | migrated through **0023** |
| 0023 | entitlement publication decoupling (`sbg_sync_hotel_entitlement` no longer writes `hotels.status`) |
| Runtime | `DATABASE_URL` → `aether_app` |
| Owner / migration plane | `AETHER_DATABASE_OWNER_URL` → `neondb_owner` (not on Vercel) |
| Preview | PGLite; `aether_runtime` SET ROLE only |
| Application build | `npm run build` does **not** migrate |
| Permanent Gate B | `.github/workflows/production-database.yml` (read-only) |

Roles: `neondb_owner` = schema/migration owner; `aether_app` = production LOGIN; `aether_runtime` = PGLite/preview only. Production must not use SET ROLE or owner credentials as runtime.

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

Do not delete casually. Do not publish. Do not attach Stripe test billing to this tenant until CP26C blast-radius architecture is explicitly solved. Do not reuse CP25G.3 spent users or `demo-kos`.

### SaaS operator journey

```
account → hotel → service → preview → QR → plan → Stripe → LIVE
```

- `/app/*` exists and is authentication-gated.
- Onboarding through `/app` is **Production-proven** (CP26A.5) to **configured, not live**.
- Tenancy exists structurally (`app_hotel_accounts`). Schema remains many-to-many. Verification **policy** is one user / one hotel (not a new DB constraint).
- Billing ownership resolves by UUID then `ownedHotel`. Configured-not-live is valid for billing state. Live and Connect are not required.
- Stripe Connect / SBG subscription / hotel-owned guest Checkout **source** exists. Production Stripe configuration is absent.
- Domain A Checkout/portal/webhook is fail-closed until `SBG_SAAS_COMMERCE=test|live` (live only at CP31).
- Choose plan cannot mutate billing or call Stripe while commerce is OFF.
- Existing subscription states cannot start a second Checkout; plan changes go to Manage billing (portal-first).
- SaaS entitlement (`active`/`trialing`/`past_due`) is independent of `hotels.status`.
- Remaining for **CP26B.2 / 0024**: durable Stripe event ordering, event `created`, `cancel_at_period_end`, stale-event rejection.
- `SBG_SAAS_COMMERCE=test` is process-global (CP26C blast-radius risk; not solved here). CP26C still owns Stripe test-mode integration.

### Guest / Ops

- Guest booking exists. `demo-kos` is **live** on Production via **`/book/demo-kos`** and is **not** the SaaS verification tenant.
- `/demo-kos` slug route currently returns `hotel_not_found` (pre-existing; not caused by the verification fixture). Canonical demo remains `/book/demo-kos`.
- Hotel-owned guest payment source exists; not Production-proven. Domain B is outside the Domain A kill-switch.
- `/ops/*` remains isolated from SaaS `/app/*`. Production Ops credentials are absent.

### Known non-blocking findings (do not fix in CP26A.6)

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
- Do not claim 0023 is unapplied or that a 0023 dispatch workflow remains.
- Do not claim returning Production sign-in is unproven.
- Do not claim the Production verification tenant does not exist.
- Do not treat CP26 as commercial go-live. Only CP31 activates commerce.
- Do not start CP26C test commerce on public Production until blast-radius architecture is authorised.
- Do not reuse CP25G.3 spent Better Auth users, unknown unconfigured hotels, or `demo-kos` as the SaaS verification tenant.

Canonical forward path: **`docs/ROADMAP.md`**. Fixture policy: **`docs/FIXTURE_POLICY.md`**. Next execution: **CP26B.2**.

GitHub `main` at the current SHA is authoritative application source. A workspace is never authoritative. Recovery ZIPs are secondary disaster-recovery artifacts. The CP10 ZIP must not be extracted over a newer Git tree without explicit human approval.

---

## Historical (not current)

- CP26A.5 COMPLETE — one Production verification identity + hotel `sbg-verify-a5` configured-not-live; returning sign-in proven; billing GET only; no Stripe.
- CP26A.2 COMPLETE — Production 0023 via GHA run [35581165068](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35581165068); controller SHA `b35ef2f`; 0023 SHA-256 `469eeee3c8707beb40a2a268bea53c77620265efb969bfbff12c524e17585ba1`; demo-kos remained live; single-use 0022/0023 `workflow_dispatch` retired.
- `cp17-known-good` / `45e171a23037b7c94005018cd2126033a449d6f0` — immutable CP16C/CP17 source tag. Not current `main`.
- CP10 occupancy ZIP — historical disaster-recovery artifact only.
- CP19 originally meant Neon binding/verification. That work completed in later controlled production checkpoints; do not treat the old “CP19 unfinished” wording as living state.
- CP22–CP25 / CP25G.3 source and production work happened after CP17. See `docs/CP22_V1_OPERATOR_ONBOARDING.md`, `docs/CP23_PUBLIC_HOTEL_SLUG.md`, `docs/CP24_STRIPE_BILLING.md` as **completed checkpoint specifications**, not as the next task.
- Single-use 0022/0023 GitHub Actions workflows existed to apply those migrations once. They were retired after successful Production application. Scripts remain as historical/test evidence (already-applied = no-op).
