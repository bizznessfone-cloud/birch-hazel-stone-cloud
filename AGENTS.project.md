# SCAN / BOOK / GO — CURRENT PROJECT OVERRIDE

This file is the project-specific authority for the Grok workspace.

## Source of truth

Use this order:

1. GitHub `main` current HEAD — authoritative application source.
2. Current source code, migrations, and tests on that HEAD.
3. Current project state in `.grok/references/current-project-state.md`.
4. Current living recovery/build documentation.
5. Historical checkpoint documents — evidence only.
6. Grok workspace state — disposable cache, never authoritative.

Repository: `bizznessfone-cloud/birch-hazel-stone-cloud`.

CP15 frozen source checkpoint:
`96947e6c1840d5c04bc118c8abf93b2fa802469c`.

CP21B audit baseline:
`fa823186a548a2009bbb3dc1e7453c75cf94b919`.

CP22 implementation baseline: `390a471e7fcdac87ec9bd9e77ec89b2aea82a73f`.

## Mandatory current-state read

Before making any change, read:

`.grok/references/current-project-state.md`

Then inspect the actual repository state. Do not rely on old Grok snapshots.

## Product identity

The product is **SCAN / BOOK / GO**.

Do not confuse this project with xperience.one.

The internal code/history name **Aether Transfer** may remain in source and historical documents. It is the same application.

## Current phase

CP19 recovery/control-plane hardening is complete in source.

CP20 transactional confirmation-email architecture is implemented and tested; provider/domain activation is a later controlled step.

CP21 V1 Product Surface Audit is complete.

CP21B reconciliation is complete.

Current checkpoint: **CP24 — SBG Subscription + Stripe Connect**

## V1 product layer

The hardened base is now receiving the V1 product layer:

`account → hotel → first service → preview → QR → plan → Stripe activation → LIVE`

The V1 operator SaaS surface belongs under `/app/*`.

Existing `/ops/*` is the internal operations desk and must not be repurposed as SaaS onboarding.

Current public guest route is `/{hotelSlug}`. Legacy `/book/{hotelCode}` remains supported for compatibility. CP24 adds the operator billing/Stripe activation boundary.

## V1 scope

Onboarding, centralized transactional email, subscription activation, and Stripe Connect integration are now in V1 scope.

Stripe was intentionally outside the original frozen Blueprint v2 and is now being layered over the hardened base. Do not rewrite the historical Blueprint to pretend otherwise.

The exact Stripe account/payment boundary is a later controlled implementation step. SCAN / BOOK / GO is not intended to become the hotel's payment custodian or commission layer.

## Existing security architecture

Preserve:

- `neondb_owner` — migration/schema owner
- `aether_runtime` — PGLite/preview SET ROLE identity
- `aether_app` — SQL-created production LOGIN

Production must not use `aether_runtime`, SET ROLE, `neon_superuser`, or owner credentials.

Do not reopen CP15/CP16/CP19 security architecture while building CP24.

## Route boundaries

- `/` — current product surface; V1 marketing/onboarding work is pending.
- `/{hotelSlug}` — current human-readable public hotel booking.
- `/book/{hotelCode}` — legacy public guest booking compatibility route.
- `/confirmed/{token}` — secure public confirmation.
- `/ops/*` — internal authenticated operations.
- `/app/*` — V1 SaaS operator onboarding/application.

## Feature fence

Keep V2 features out of V1 unless a later checkpoint explicitly opens them:

- SMS
- WhatsApp
- chatbot
- custom domains
- hotel-local Ops Today enhancements
- new booking concepts
- marketplace features
- unrelated feature expansion

Do not add guest accounts, RLS, a new RBAC system, a tenants table, or new fleet/occupancy architecture.

## Historical material

Do not delete historical checkpoint files.

Do not rewrite historical records to make later work appear earlier.

Do not treat recovery ZIPs or Grok state as current source.

If an old living document conflicts with current GitHub source, classify the old statement as stale and use current source plus this project override.

## External-system discipline

Do not contact Neon, modify Vercel, change secrets, or deploy unless the active checkpoint explicitly authorizes it.

## Checkpoint discipline

Every checkpoint must identify the exact Git commit audited.

CP21B reconciles current Grok-facing state without deleting historical evidence.