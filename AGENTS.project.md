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

## Current accepted baseline (POST-CP25G.3)

| Field | Value |
|---|---|
| Current source SHA | `4c20e9b9574309a0edbeb03f8675febdef38dede` |
| CP25G.3 | **CLOSED** |
| Next numbered checkpoint | **UNDEFINED** — requires explicit architecture/product authorisation. **Do not invent CP26.** |

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

Source includes the hardened booking/occupancy/tenancy base plus CP20 email architecture, CP22 `/app` onboarding, CP23 public slug, CP24 Stripe Connect source, CP25 hotel-owned guest payment source, and CP25G.3 auth configuration.

Production Vercel `scan-book-go` (`dpl_5XnaxYcqkrgWucD54TKgbmvHkfy1`) is READY on the current SHA. Neon is migrated through **0022**. `DATABASE_URL` is the runtime credential; `AETHER_DATABASE_OWNER_URL` must never be added to Vercel.

## V1 product layer

```
account → hotel → first service → preview → QR → plan → Stripe activation → LIVE
```

`/app/*` is the SaaS operator surface. `/ops/*` is the internal operations desk.

Public guest route is `/{hotelSlug}`. Legacy `/book/{hotelCode}` remains supported.

First Production hotel through `/app` is **not** proven. Production Stripe and Resend configuration are **absent**.

## Existing security architecture

Preserve:

- `neondb_owner` — migration/schema owner
- `aether_runtime` — PGLite/preview SET ROLE identity
- `aether_app` — SQL-created production LOGIN

Production must not use `aether_runtime`, SET ROLE, `neon_superuser`, or owner credentials.

Do not reopen CP15/CP16/CP19 security architecture. Do not reopen CP25G.3.

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

Next numbered checkpoint is **UNDEFINED**. Do not invent CP26.
