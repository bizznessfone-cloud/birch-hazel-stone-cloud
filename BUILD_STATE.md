# BUILD STATE — living record

This file describes **current reality**, not intended future state.

## CP26A.4 — COMPLETE

Local/PGLite SaaS tenant foundation and fixture policy are proven in source.
No Production identity, hotel, Stripe, or database mutation.

| Field | Value |
|---|---|
| CP26A.1 | **PASS** — Domain A commerce dormant (`SBG_SAAS_COMMERCE=off\|test\|live`; Production unset = fail-closed) |
| CP26A.2 | **PASS** — entitlement/publication decoupling; Production 0023 applied; dispatch retired |
| CP26A.3 | **READY** — read-only preflight of operator-owned hotel lifecycle + fixture policy |
| CP26A.4 | **PASS** — local ownership → configured-not-live → billing UUID resolution; Domain A fail-closed; Domain B non-regression; `docs/FIXTURE_POLICY.md` |
| Last application SHA | `b35ef2fc8bdddef81fcc84aa59d358dba4346a30` (no runtime `src/` change in CP26A.2C or CP26A.4) |
| Fixture policy | [`docs/FIXTURE_POLICY.md`](docs/FIXTURE_POLICY.md) |
| Local harness | `src/lib/aether/cp26a4-fixture.ts` (tests only; not a runtime import) |
| Domain A | remains dormant; only **CP31** may activate commerce |
| Accepted Production ledger | **0001–0023** |
| **Next execution** | **CP26A.5** — operator-supervised creation of exactly one persistent Production verification identity + exactly one owned hotel, commerce **OFF** |

Do not dispatch historical 0022/0023 controllers. Owner secret remains GitHub Actions `AETHER_DATABASE_OWNER_URL` only — never Vercel. Future migrations need a dedicated single-use controller and an explicit checkpoint.

Push to `main` currently auto-deploys Vercel Production. That is a known control-plane characteristic, not a commercial activation. CP26A.4 source is tests/docs/harness only.

Do not start CP26B. Do not create the Production verification identity in an unsupervised child. Password never enters git/chat/Grok/Vercel/`.env`.

## Current accepted baseline (POST-CP26A.4)

| Field | Value |
|---|---|
| Product | **SCAN / BOOK / GO** (internal history name: Aether Transfer) |
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | `b35ef2fc8bdddef81fcc84aa59d358dba4346a30` (no runtime `src/` change in CP26A.4) |
| CP25G.3 | **CLOSED** |
| CP26A.1 / CP26A.2 | **CLOSED** |
| CP26A.4 | **CLOSED** (local tenant foundation + fixture policy) |
| **Next execution checkpoint** | **CP26A.5** — Production verification identity + one owned hotel, commerce OFF |
| Forward roadmap | **[docs/ROADMAP.md](docs/ROADMAP.md)** (CP26–CP31) |

### Production

| Field | Value |
|---|---|
| Vercel project | `scan-book-go` |
| Last observed deployment | `dpl_7mJ8kBkd1m679TpriPUnYeX8X4qY` |
| State | READY |
| Alias | `https://scan-book-go.vercel.app` |
| Deployed SHA (last observed) | `b35ef2fc8bdddef81fcc84aa59d358dba4346a30` |

Environment (names/presence only):

| Variable | Production |
|---|---|
| `DATABASE_URL` | PRESENT (`aether_app` runtime LOGIN) |
| `AETHER_DATABASE_OWNER_URL` | ABSENT |
| `SBG_SAAS_COMMERCE` | ABSENT (fail-closed Domain A) |
| `BETTER_AUTH_SECRET` | PRESENT |
| `BETTER_AUTH_URL` | PRESENT |
| Stripe / Resend / Ops credentials | ABSENT unless separately proven |

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

**Implemented, not Production-proven:** returning email/password sign-in POST; authenticated tenant runtime.

**Backlog / deferred:** copied-cookie stale-session replay; password recovery; email verification.

### SaaS operator journey

```
account → hotel → service → preview → QR → plan → Stripe → LIVE
```

- `/app/*` exists and is authentication-gated.
- Onboarding source exists and is **locally proven** (CP26A.4): user → `app_hotel_accounts` → unconfigured hotel → service → destination → **configured, not live**.
- First Production hotel created **through `/app`** is **not** proven. That is **CP26A.5**.
- Tenancy exists structurally (`app_hotel_accounts`). Schema remains many-to-many. Verification **policy** is one user / one hotel (not a new DB constraint).
- Billing ownership resolves by UUID then `ownedHotel`. Configured-not-live is valid for billing state. Live and Connect are not required.
- Stripe Connect / SBG subscription / hotel-owned guest Checkout **source** exists. Production Stripe configuration is absent.
- Domain A Checkout/portal/webhook is fail-closed until `SBG_SAAS_COMMERCE=test|live` (live only at CP31).
- Resend confirmation-email **source** exists. Production Resend is absent.
- `SBG_SAAS_COMMERCE=test` is process-global (CP26C blast-radius risk; not solved here).

### Guest / Ops

- Guest booking exists. `demo-kos` is **live** on Production and is **not** the SaaS verification tenant.
- Hotel-owned guest payment source exists; not Production-proven. Domain B is outside the Domain A kill-switch.
- `/ops/*` remains isolated from SaaS `/app/*`. Production Ops credentials are absent.

### What must not be claimed

- Do not claim CP17/CP19 is current.
- Do not claim CP22 is next or CP24 is current.
- Do not claim Neon is unproven or Vercel is disconnected.
- Do not claim migrations after 0017 are absent.
- Do not claim `/app/*` does not exist.
- Do not claim CP25G.3 remains open.
- Do not claim 0023 is unapplied or that a 0023 dispatch workflow remains.
- Do not treat CP26 as commercial go-live. Only CP31 activates commerce.
- Do not skip **CP26A.5** (Production verification fixture) before Stripe test-mode integration (CP26C).
- Do not start CP26B until remaining CP26A Production fixture work is authorised.
- Do not reuse CP25G.3 spent Better Auth users, unknown unconfigured hotels, or `demo-kos` as the SaaS verification tenant.

Canonical forward path: **`docs/ROADMAP.md`**. Fixture policy: **`docs/FIXTURE_POLICY.md`**. Next execution: **CP26A.5**.

GitHub `main` at the current SHA is authoritative application source. A workspace is never authoritative. Recovery ZIPs are secondary disaster-recovery artifacts. The CP10 ZIP must not be extracted over a newer Git tree without explicit human approval.

---

## Historical (not current)

- CP26A.2 COMPLETE — Production 0023 via GHA run [35581165068](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35581165068); controller SHA `b35ef2f`; 0023 SHA-256 `469eeee3c8707beb40a2a268bea53c77620265efb969bfbff12c524e17585ba1`; demo-kos remained live; single-use 0022/0023 `workflow_dispatch` retired.
- `cp17-known-good` / `45e171a23037b7c94005018cd2126033a449d6f0` — immutable CP16C/CP17 source tag. Not current `main`.
- CP10 occupancy ZIP — historical disaster-recovery artifact only.
- CP19 originally meant Neon binding/verification. That work completed in later controlled production checkpoints; do not treat the old “CP19 unfinished” wording as living state.
- CP22–CP25 / CP25G.3 source and production work happened after CP17. See `docs/CP22_V1_OPERATOR_ONBOARDING.md`, `docs/CP23_PUBLIC_HOTEL_SLUG.md`, `docs/CP24_STRIPE_BILLING.md` as **completed checkpoint specifications**, not as the next task.
- Single-use 0022/0023 GitHub Actions workflows existed to apply those migrations once. They were retired after successful Production application. Scripts remain as historical/test evidence (already-applied = no-op).
