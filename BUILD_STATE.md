# BUILD STATE — living record

This file describes **current reality**, not intended future state.

## CP26B — CLOSED

Domain A subscription lifecycle, ordered billing persistence, and Production
migration 0024 are accepted. Domain A commerce remains **OFF**. Only **CP31**
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
**CP26C-O4.1** added source migration `0027` only. It is not applied. Next is
**CP26C-O4.2**. Former **O3.4** is superseded. Do not
start it. Do not resume CP26C.3.
Production commerce remains **OFF**. Canonical amounts remain **UNDEFINED**.
Migration **0025** is **Production-applied**. First Production platform Owner is
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
| CP26C-O3R | **PASS** — model reconciled in [`docs/COMMERCIAL_MODEL.md`](docs/COMMERCIAL_MODEL.md); no implementation |
| Last application SHA | 19512c295830fbc6fd9712d688ce364d940f87c3 (CP26B.3R catalog identity; Production 0024 already applied) |
| Fixture policy | [`docs/FIXTURE_POLICY.md`](docs/FIXTURE_POLICY.md) |
| Local harness | `src/lib/aether/cp26a4-fixture.ts` (tests only; not a runtime import) |
| Domain A | remains dormant; only **CP31** may activate commerce |
| Accepted Production ledger | **0001–0026** (Gate B source pin **0001–0026**; `AUTHORISED_PENDING=[]`) |
| 0024 digest | `23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0` |
| 0025 digest | `575aabcb7322fc8ca63c8a3dd137d358f76375f1777ed59cf04c1d98d6c066fd` |
| 0026 file | `migrations/0026_cp26co3_commercial_catalogue.sql` |
| 0026 digest | `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446` (Production-applied once) |
| 0026 apply | GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457) job `108073574672` at `67d751014b6b5cbb5bd3c9ac4867fbad3da01b52` |
| 0025 controller | `.github/workflows/cp26co2a-0025-production-migrate.yml` + `scripts/cp26co2a-0025-production-migrate.mjs` |
| First-Owner controller | historical script `scripts/cp26co2c-first-owner-bootstrap.mjs`; workflow **RETIRED** |
| Active platform Owners | **1** — OPERATOR CONTROLLED / REDACTED (owns `sbg-verify-a5`) |
| Human `/owner` proof | **PASS** — Overview, Hotels, Plans & Pricing, Revenue, System |
| **Next control-plane** | **CP26C-O3R PASS** — commercial model reconciled; implementation not started |
| 0026 controller | historical script `scripts/cp26co32a-0026-production-migrate.mjs`; workflow **RETIRED**; npm alias **RETIRED** |
| Catalogue | schema installed; Owner UI reads `sbg_saas_*`; plans **basic / pro / premium** remain historical tier seeds; Production price versions **0**; Stripe mappings **0**; LIVE locks **false/false**; amounts **UNDEFINED** |
| **Next product** | **CP26C-O4.2** single-use 0027 controller (not started). **O4.1 SOURCE COMPLETE**, unapplied. **CP26C.3** not resumed |

Do not dispatch historical 0022/0023/0024 controllers or the retired 0026 workflow. Owner secret remains GitHub Actions `AETHER_DATABASE_OWNER_URL` only — never Vercel. Future migrations need a dedicated single-use controller and an explicit checkpoint. 0027+ stays fail-closed.

Push to `main` currently auto-deploys Vercel Production. That is a known control-plane characteristic, not a commercial activation. Ordered-webhook source is schema-capable on Production 0024. Domain A webhooks remain fail-closed while commerce is OFF (acknowledged without apply).

Password never enters git/chat/Grok/Vercel/`.env`. Do not delete the Production verification tenant.

`SBG_SAAS_COMMERCE=test` remains process-global and must **not** be enabled on the
public Production deployment. Former CP26C.4 is superseded; TEST activation is
**CP26C-O11** and is not authorised. CP26C.2 adds `SBG_SAAS_TEST_HOTEL_IDS`
(comma-separated hotel UUIDs). In test mode an empty/malformed allowlist fail-closes
every hotel. Live mode ignores this allowlist. Do not put a Production hotel UUID in git.

## Current accepted baseline (POST-CP26B CLOSED)

| Field | Value |
|---|---|
| Product | **SCAN / BOOK / GO** (internal history name: Aether Transfer) |
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | 19512c295830fbc6fd9712d688ce364d940f87c3 (CP26B.3R; Production 0024 applied) |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| **CP26B** | **CLOSED** |
| **Next control-plane** | none; CP26C-O2 **CLOSED** |
| **Next product checkpoint** | **CP26C-O4.2** single-use 0027 controller (not started). **O4.1 SOURCE COMPLETE**, unapplied. **CP26C.3** not resumed |
| Forward roadmap | **[docs/ROADMAP.md](docs/ROADMAP.md)** (CP26–CP31) |

### Production

| Field | Value |
|---|---|
| Vercel project | `scan-book-go` |
| Last observed deployment (CP26B.3V) | `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` |
| State | READY |
| Alias | `https://scan-book-go.vercel.app` |
| Deployed SHA (last observed) | `19512c295830fbc6fd9712d688ce364d940f87c3` |

A later push of this documentation/control-plane child may auto-deploy a new SHA. That must not activate commerce.

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
| Source migrations | `0001`–`0026` present |
| Production Neon | migrated through **0026** — pending **NONE** |
| 0026 | commercial catalogue schema installed; plan identities basic/pro/premium; zero price versions; zero Stripe mappings; locks false/false |
| 0024 | ordered Domain A billing events (`event.created` bigint, `cancel_at_period_end`, stale/ambiguous/duplicate); 10-argument `sbg_apply_billing_event`; 8-argument function **absent** |
| 0023 | entitlement publication decoupling (`sbg_sync_hotel_entitlement` no longer writes `hotels.status`) |
| Runtime | `DATABASE_URL` → `aether_app` |
| Owner / migration plane | `AETHER_DATABASE_OWNER_URL` → `neondb_owner` (not on Vercel) |
| Preview | PGLite; `aether_runtime` SET ROLE only |
| Application build | `npm run build` does **not** migrate |
| Permanent Gate B | `.github/workflows/production-database.yml` (read-only); accepted ledger **0001–0026**; `AUTHORISED_PENDING=[]` |

Roles: `neondb_owner` = schema/migration owner; `aether_app` = production LOGIN; `aether_runtime` = PGLite/preview only. Production must not use SET ROLE or owner credentials as runtime.

CP26B.3V invariants (do not re-query merely to reproduce): hotels 4; billing accounts 0; Stripe events 0; demo-kos live; sbg-verify-a5 configured/non-bookable.

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

Do not delete casually. Do not publish. Do not attach Stripe test billing to this tenant. Former CP26C.4/C.5 is superseded and is not an authorisation (isolation is in source; Production commerce remains OFF). Do not reuse CP25G.3 spent users or `demo-kos`.

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
- Domain A webhooks persist Stripe `event.created` (bigint Unix seconds) and `cancel_at_period_end`. Duplicate event IDs are idempotent; older events are stale no-ops; equal-timestamp different IDs are ambiguous fail-closed.
- SaaS entitlement (`active`/`trialing`/`past_due`) is independent of `hotels.status`.
- Production 0024 is **applied**. First Domain A event (none exist yet) becomes the ordering baseline for historical rows with null `last_stripe_event_created`.
- `SBG_SAAS_COMMERCE=test` is process-global. CP26C.2 isolates test commerce to `SBG_SAAS_TEST_HOTEL_IDS`. Do not set test mode on public Production. Former CP26C.4 is superseded.

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
- Do not treat CP26 as commercial go-live. Only CP31 activates commerce.
- Do not start CP26C test commerce on public Production. Former CP26C.4 is superseded; **CP26C-O11** is not authorised. Empty `SBG_SAAS_TEST_HOTEL_IDS` fail-closes every hotel.
- Do not invent CP26B.5.

Canonical forward path: **`docs/ROADMAP.md`**. Commercial model: **`docs/COMMERCIAL_MODEL.md`**. Commercial catalogue: **`docs/COMMERCIAL_CATALOGUE.md`**. Fixture policy: **`docs/FIXTURE_POLICY.md`**. Owner architecture: **`docs/OWNER_CONTROL_PLANE.md`**. **CP26C-O3R PASS** — organisation property-licence model reconciled; no implementation. Human O2D and O3.3V **PASS**. Former **O3.4** is superseded. **CP26C.3** is not resumed. **CP26C-O4.1 SOURCE COMPLETE** — `0027_cp26co41_organisation_property_licence.sql` is source only and unauthorised. Next is **CP26C-O4.2**. Canonical amounts remain **UNDEFINED**. Production price versions remain **0**. CP26C-O3.3 implemented the Owner catalogue UI. CP26C-O3.2C is **PASS**. CP26C-O3.2B is **PASS** (GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457)). The 0026 workflow is **RETIRED**. Active Production platform Owners: **1** (OPERATOR CONTROLLED / REDACTED). First-Owner bootstrap workflow **RETIRED** (historical run [36116463589](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36116463589)). Gate B accepted ledger is **0001–0026**. Price versions **0**. Stripe mappings **0**. LIVE locks **false/false**. No canonical pricing. Commerce **OFF**. Stripe untouched.

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
