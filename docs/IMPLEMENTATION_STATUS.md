# Implementation status

Product: **SCAN / BOOK / GO** (internal code/history name: Aether Transfer)

## Current phase

**V1 product-surface construction**

| Area | State |
|---|---|
| Core booking engine | COMPLETE / hardened |
| Occupancy + concurrency architecture | COMPLETE in source; final Neon/load gates later |
| Hotel/provider tenancy foundation | COMPLETE |
| Production runtime role boundary | COMPLETE in source through 0017 |
| Hotel provisioning architecture | COMPLETE in source |
| CP15 hotel-scoped Ops identity | COMPLETE |
| CP19 recovery/control plane | COMPLETE in source |
| CP20 confirmation-email architecture | COMPLETE in source; provider activation later |
| CP21 V1 product-surface audit | COMPLETE |
| CP21B Grok reconciliation | COMPLETE |
| V1 operator onboarding | NEXT — CP22 |
| Public human-readable hotel slug | NEXT AFTER CP22 — CP23 |
| V1 end-to-end programme | PLANNED — CP24 |
| Resend/domain production activation | PLANNED — CP25 |
| Subscription / Stripe activation | PLANNED — CP26 |
| Final security audit | PLANNED — CP27 |
| Full V1 test matrix | PLANNED — CP28 |
| Load testing | PLANNED — CP29 |
| Production readiness | PLANNED — CP30 |
| Go-live | PLANNED — CP31 |

## Current route surface

- `/book/{hotelCode}` — public guest booking
- `/confirmed/{token}` — public token confirmation
- `/ops/*` — internal operations desk
- `/app/*` — V1 SaaS operator surface to be built in CP22

## Current V1 journey

`account → hotel → first service → preview → QR → plan → Stripe activation → LIVE`

## Current architecture boundaries

- `neondb_owner` remains migration/schema owner.
- `aether_runtime` remains PGLite/preview SET ROLE identity.
- `aether_app` is the production SQL-created LOGIN.
- Production must not use SET ROLE or owner credentials.
- Guest booking remains accountless and token-confirmed.
- `/ops/*` remains internal and is not the onboarding application.
- Hotel slug presentation is separate from database identity.
- Stripe is now V1 product-layer work; the original frozen Blueprint is not rewritten.
- SMS/WhatsApp/chatbot remain V2.

## Historical status

Older sections/checkpoint files are retained as historical evidence. They may describe an earlier current phase; do not use those claims to override current source or CP21B current-state instructions.

For the exact current source, inspect GitHub `main` and identify the HEAD SHA before every checkpoint.
