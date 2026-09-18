# SCAN / BOOK / GO

Internal code/history name: **Aether Transfer**.

SCAN / BOOK / GO is a hotel QR-code transfer platform. The hardened booking, occupancy, tenancy, Ops and recovery foundations are now receiving the V1 SaaS product layer.

## Source of truth

GitHub `main` is authoritative.

Repository: `bizznessfone-cloud/birch-hazel-stone-cloud`

CP15 frozen checkpoint:
`96947e6c1840d5c04bc118c8abf93b2fa802469c`

CP21B audit baseline:
`fa823186a548a2009bbb3dc1e7453c75cf94b919`

Grok workspace state is disposable. Recovery ZIPs are secondary disaster-recovery artifacts. Historical checkpoint documents remain evidence and are not silently rewritten.

## Current V1 phase

**V1 product-surface construction**

The current operator journey is:

```
account
  ↓
hotel
  ↓
first service
  ↓
preview
  ↓
QR
  ↓
plan
  ↓
Stripe activation
  ↓
LIVE
```

The SaaS operator surface belongs under `/app/*`.

The existing `/ops/*` surface remains the internal authenticated operations desk.

## Current guest surface

- `/book/{hotelCode}` — current public hotel booking
- `/confirmed/{token}` — secure public confirmation
- human-readable hotel slug presentation is a later CP23 step

Guests do not need accounts. The confirmation token remains the public credential.

## Email

CP20 centralized transactional confirmation email is implemented in source.

Booking success is not invalidated by email transport failure.

Resend/domain/production activation is a later controlled step.

## Payments

Stripe is now part of the V1 product layer.

This does not rewrite the original frozen Blueprint v2, where Stripe was intentionally outside the original MVP contract. Stripe is being layered over the hardened foundation now.

## Hardened architecture

- PostgreSQL is authoritative for booking/inventory integrity.
- `neondb_owner` = migration/schema owner.
- `aether_runtime` = PGLite/preview SET ROLE identity.
- `aether_app` = SQL-created production LOGIN.
- Production must not use `aether_runtime`, SET ROLE, `neon_superuser`, or owner credentials.
- Occupancy trigger and GiST EXCLUDE protections remain authoritative.
- CP15 hotel-scoped Ops identity remains intact.

## Next checkpoint

**CP22 — V1 Operator Onboarding**

Build the operator account → hotel → service → preview → QR flow on the existing hardened base.

Do not restart the foundation and do not repurpose `/ops/*`.

## V2 fence

SMS, WhatsApp, chatbot, custom domains, hotel-local Ops Today enhancements, new booking concepts and unrelated feature expansion remain deferred.

For current Grok instructions, read `AGENTS.project.md` and `.grok/references/current-project-state.md`.
