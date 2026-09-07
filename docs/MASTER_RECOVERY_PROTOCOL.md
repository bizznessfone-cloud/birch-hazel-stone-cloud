# Aether Transfer — Master Recovery Protocol

This file is the permanent copy of the rebuild protocol used to reconstruct
Aether Transfer after the original implementation workspace was lost.

GitHub is not part of this rebuild. Persistence is the user's downloaded
recovery snapshots plus the documents in `docs/`.

## Absolute priorities

1. Preserve Blueprint v2 architecture.
2. Build a genuinely functional application, not a visual prototype.
3. PostgreSQL remains authoritative for booking and inventory integrity.
4. Security boundaries must be enforced server-side.
5. Database concurrency must be enforced by the database.
6. Timezone/DST behaviour must be explicitly tested.
7. Do not invent missing product requirements.
8. Do not expand MVP scope.
9. Maintain complete recovery documentation.
10. Produce complete downloadable recovery snapshots at defined checkpoints.
11. Never claim something is implemented, tested or verified unless it has been verified in the current rebuild.

## Snapshot rule

A snapshot must contain the entire restorable project: source, migrations,
tests, configuration examples (no secrets), and recovery documentation.

Ask at every checkpoint: could another coding agent restore this application
from this snapshot without access to the original conversation? If no, the
snapshot is not complete.

## Checkpoints

| Checkpoint | Gate |
|---|---|
| 0 | Foundation complete |
| 1 | Database + occupancy engine passes |
| 2 | Authentication passes |
| 3 | Time-domain tests pass |
| 4 | Booking engine passes |
| 5 | Inventory/concurrency passes |
| 6 | Guest UX passes |
| 7 | Operations UX passes |
| 8 | White-label/hotel attribution passes |
| 9 | Full test reconstruction passes |
| 10 | Production hardening passes |
| 11 | Production deployment passes |

Do not continue into the next major phase until the checkpoint is identified
and a complete snapshot exists.

## If the workspace disappears

Read, in order:

1. `docs/RECOVERY_MANIFEST.md`
2. `docs/IMPLEMENTATION_STATUS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/TEST_RESULTS.md`
5. `docs/RECOVERY_NOTES.md`
6. `docs/BUILD_BLUEPRINT_V2.md`
7. `docs/RESTORE.md`

Then inspect the source tree and migrations. Do not restart from scratch.
Continue from the recorded phase.

## Frozen stack

TanStack Start, React, TypeScript, Tailwind v4, CSS variables, Outfit, Kysely,
pg, PGLite, PostgreSQL, Neon intended for production. Use TanStack
`createServerFn`. Do not introduce Next.js, Prisma, or a standalone REST service.

## Out of MVP

Next.js, Prisma, standalone REST API, microservices, RLS, hotel colour themes,
hotel logo upload, marketplace, guest accounts, driver application, driver
authentication, WhatsApp, SMS, push notifications, Stripe, deposits, payment
processing, hotel billing, multi-operator SaaS, booking holds, surge pricing,
dynamic pricing, multi-stop journeys, taxi-meter functionality, guest vehicle
SKUs, custom service worker, offline booking, complex IAM, analytics/CMS,
passkeys, unnecessary frameworks.

## UNKNOWN rule

Blueprint v2 contains deliberate UNKNOWN fields. Do not convert UNKNOWN into
invented requirements. When a decision is unavoidable: choose the smallest safe
implementation, document it in `docs/RECOVERY_NOTES.md`, and mark it as an
implementation decision rather than recovered historical fact.

## Concurrency rule

Do not solve concurrency with SELECT availability → assume available →
INSERT/UPDATE. PostgreSQL EXCLUDE constraints are authoritative. Application
pre-checks are UX only.

## When something breaks

Do not weaken the architecture to make a test pass. Never remove EXCLUDE
constraints, disable the occupancy trigger, switch to naive timestamps, change
PostgreSQL timezone globally, move operator tokens into localStorage, remove
CSRF, expose reference-only booking lookup, or make frontend availability
authoritative.
