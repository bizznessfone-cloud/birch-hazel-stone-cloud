# SCAN / BOOK / GO — BUILD STATE

This file describes the current project state. Historical checkpoint records remain in their original files.

## Source of truth

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| CP21B audit baseline | `fa823186a548a2009bbb3dc1e7453c75cf94b919` |
| CP15 frozen checkpoint | `96947e6c1840d5c04bc118c8abf93b2fa802469c` |

GitHub `main` is authoritative. The Grok workspace is disposable. Recovery ZIPs are secondary disaster-recovery artifacts.

## Current product phase

**V1 product-surface construction**

Completed hardened foundation:

- CP13A production `aether_app` role architecture
- CP14 hotel configuration, quote/destination and timezone protections
- CP15 hotel-scoped Ops identity
- CP16C/CP17 runtime privilege hardening and hotel-local Ops Today
- CP19 recovery/control-plane hardening
- CP20 transactional confirmation-email architecture
- CP21 V1 product-surface audit
- CP21B Grok workspace reconciliation

## Current route reality

- `/book/{hotelCode}` — current public guest booking
- `/confirmed/{token}` — secure public confirmation
- `/ops/*` — internal authenticated operations desk
- `/app/*` — reserved for the V1 SaaS operator surface; not yet implemented

The future public hotel presentation is a human-readable slug. That is CP23 and must not change database identity.

## V1 product layer

The current target journey is:

```
account → hotel → first service → preview → QR → plan → Stripe activation → LIVE
```

V1 now includes:

- operator onboarding
- hotel setup
- first-service setup
- preview/QR
- centralized transactional email architecture
- subscription/activation
- Stripe integration

Stripe was intentionally outside the original frozen Blueprint v2. It is now being layered over the hardened base; the historical Blueprint is not rewritten.

## Email

Confirmation email is post-commit and failure-isolated.

- central SCAN / BOOK / GO sender
- Resend integration architecture
- secure View My Booking URL
- no raw token display
- no hotel SMTP credentials

Production provider/domain activation remains a controlled later step.

## Security boundary

Production role architecture remains:

- `neondb_owner` — migration/schema owner
- `aether_runtime` — PGLite/preview SET ROLE identity
- `aether_app` — SQL-created production LOGIN

Do not use `aether_runtime`, SET ROLE, `neon_superuser`, or owner credentials for production.

## Next checkpoint

**CP22 — V1 Operator Onboarding**

Build:

1. account
2. hotel
3. first service
4. preview
5. QR
6. activation boundary

Do not repurpose `/ops/*`.

## V2 fence

SMS, WhatsApp, chatbot, custom domains, hotel-local Ops Today enhancements, new booking concepts and unrelated feature expansion remain deferred.

## Production/infrastructure status

Do not infer live production readiness from source alone. Production infrastructure verification, real email delivery, Stripe activation and final load/security gates are controlled later checkpoints.

No secret values belong in this file.

## Historical material

Earlier checkpoint documents are preserved as evidence. Their statements are not current-state authority when they conflict with current GitHub source or the CP21B project-state bridge.

`.grok/status` remains untracked.
