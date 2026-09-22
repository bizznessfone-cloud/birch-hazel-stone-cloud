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

## Current accepted baseline (POST-CP26A)

| Field | Value |
|---|---|
| Last application SHA | ff2581fddf658bc3fc09ca5f26ffb676c5c6926f (runtime `src/` + migration 0024 **source**; Production ledger still 0001–0023) |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| CP26B.1 | **PASS** |
| CP26B.2 | **SOURCE COMPLETE — 0024 DEFINED, NOT APPLIED** |
| **Next execution checkpoint** | **CP26B.3 — controlled Production application of migration 0024** |
| Forward roadmap | **`docs/ROADMAP.md`** |
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

Next execution is **CP26B.3** (controlled Production application of migration 0024; commerce OFF). CP26B is **not** closed. CP26 is **not** commercial go-live. Only **CP31** activates commerce. See `docs/ROADMAP.md` and `docs/FIXTURE_POLICY.md`.

Source includes the hardened booking/occupancy/tenancy base plus CP20 email architecture, CP22 `/app` onboarding, CP23 public slug, CP24 Stripe Connect source, CP25 hotel-owned guest payment source, CP25G.3 auth configuration, CP26A.1 commerce gate, CP26A.2 decoupled entitlement publication, CP26A.4 local tenant/fixture proofs, CP26A.5 Production verification tenant, CP26B.1 Domain A application lifecycle, and CP26B.2 ordered billing persistence **source** (migration 0024 present in git, **not** applied on Production).

Last observed Production Vercel `scan-book-go` (`dpl_7MFpVnCV4CbyoUjev1ZjcLVm2vtn`) is READY on SHA `d42f794`. A push to `main` auto-deploys Vercel Production (docs-only deploys must not activate commerce). Neon is migrated through **0023**. Source contains **0024** (unapplied). `DATABASE_URL` is the runtime credential; `AETHER_DATABASE_OWNER_URL` must never be added to Vercel. `SBG_SAAS_COMMERCE` is unset (fail-closed).

Do not reopen CP26A. Do not mutate the Production verification tenant unless a later checkpoint explicitly authorises it. Do not set `SBG_SAAS_COMMERCE=test` on public Production in CP26B. Do not dispatch the 0024 controller until CP26B.3.

## V1 product layer

```
account → hotel → first service → preview → QR → plan → Stripe activation → LIVE
```

`/app/*` is the SaaS operator surface. `/ops/*` is the internal operations desk.

Public guest route is `/{hotelSlug}`. Legacy `/book/{hotelCode}` remains supported.

First Production hotel through `/app` is **proven to configured, not live** (`sbg-verify-a5`). Production Stripe and Resend configuration are **absent**.

## Existing security architecture

Preserve:

- `neondb_owner` — migration/schema owner
- `aether_runtime` — PGLite/preview SET ROLE identity
- `aether_app` — SQL-created production LOGIN

Production must not use `aether_runtime`, SET ROLE, `neon_superuser`, or owner credentials.

Do not reopen CP15/CP16/CP19 security architecture. Do not reopen CP25G.3. Do not reopen CP26A.1/2/4/5.

## Route boundaries

- `/` — product surface
- `/{hotelSlug}` — human-readable public hotel booking
- `/book/{hotelCode}` — legacy public guest booking
- `/confirmed/{token}` — secure public confirmation
- `/login` — SaaS email/password
- `/ops/*` — internal authenticated operations
- `/app/*` — V1 SaaS operator application

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

Next execution checkpoint is **CP26B.3**. Canonical roadmap: `docs/ROADMAP.md`. Fixture policy: `docs/FIXTURE_POLICY.md`. CP26 is not go-live.
