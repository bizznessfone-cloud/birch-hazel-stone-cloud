# Aether Transfer — Master Recovery Protocol

This file is the permanent copy of the rebuild protocol used to reconstruct
Aether Transfer after the original implementation workspace was lost.

## Source of truth

GitHub is the authoritative source for application source code.

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Known-good application source | `45e171a23037b7c94005018cd2126033a449d6f0` |
| Tag | `cp17-known-good` |

When `cp17-known-good` was created, `main` pointed at that commit. The tag is
immutable. Documentation-only commits may follow on `main` without changing the
CP16C/CP17 application baseline.

Recovery ZIPs are secondary disaster-recovery artifacts. The CP10 ZIP is
historical and must not be extracted over a newer Git tree without explicit
human approval. A workspace is disposable and is never authoritative.

Every engineering checkpoint must identify an exact Git commit SHA. Every
future production-readiness audit must name the exact Git commit audited.
Source-code state and production database state must be reported separately.
A historical checkpoint must never be mistaken for the current project state.

Do not claim Neon production readiness merely because the source repository is
current. **CP19** currently refers to production Neon binding/verification and
is **not** yet a completed production checkpoint.

Agents must never restore an older checkpoint over a newer repository state
without explicit human approval. Before modifying the application, identify
repository, branch, `HEAD` SHA, and checkpoint. Before starting a new
checkpoint, the previous known-good commit must remain recoverable.

### Source of truth order

1. GitHub repository + exact commit SHA
2. Checkpoint tag (`cp17-known-good`)
3. Recovery ZIP (disaster recovery only)
4. Grok workspace (disposable)
5. Chat (context only)
6. Platform-generated/deployed state — **not** authoritative

## Absolute priorities

1. Preserve Blueprint v2 architecture.
2. Build a genuinely functional application, not a visual prototype.
3. PostgreSQL remains authoritative for booking and inventory integrity.
4. Security boundaries must be enforced server-side.
5. Database concurrency must be enforced by the database.
6. Timezone/DST behaviour must be explicitly tested.
7. Do not invent missing product requirements.
8. Do not expand MVP scope.
9. Maintain complete recovery documentation keyed to GitHub SHAs.
10. Recovery snapshots (ZIPs) are backups of a Git commit, not replacements for GitHub.
11. Never claim something is implemented, tested or verified unless it has been verified in the current rebuild, and never claim production from source currency alone.

## Snapshot rule

A snapshot must contain the entire restorable project: source, migrations,
tests, configuration examples (no secrets), and recovery documentation. It is a
backup of a named Git commit.

Ask at every checkpoint: could another coding agent restore this application
from GitHub at the named SHA without access to the original conversation? If
no, the checkpoint documentation is not complete.

## Checkpoints

Historical rebuild gates (0–11) remain the original protocol. They are **not**
the current source baseline.

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
| 10 | Production hardening passes (historical occupancy baseline) |
| 11 | Production deployment passes (**not achieved**) |
| 12 / 12A / 12B | Tenancy and pre-Vercel hardening (source) |
| 13A | SQL-created production LOGIN `aether_app` (source) |
| 14.x | Hotel configuration, timezone, quote, provisioning (source) |
| 15 | Hotel-scoped Ops identity (source) |
| 16C | Runtime privilege hardening (source, migration 0017) |
| 17 | Hotel-local Ops Today (source) — **current known-good**, tag `cp17-known-good` |
| 19 | Production Neon binding/verification — **not a source commit; not complete** |

Current source baseline is CP16C/CP17 at
`45e171a23037b7c94005018cd2126033a449d6f0`. Checkpoint 10 documentation is
historical only.

Do not continue into the next major phase until the checkpoint is identified
by Git SHA (and tag when present) and remains recoverable.

## If the workspace disappears

Restore from GitHub:

```
git clone https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud.git
git checkout cp17-known-good
```

Then read, in order:

1. `docs/RECOVERY_MANIFEST.md`
2. `BUILD_STATE.md`
3. `RESTORE.md`
4. `docs/IMPLEMENTATION_STATUS.md`
5. `docs/ARCHITECTURE.md`
6. `docs/TEST_RESULTS.md`
7. `docs/RECOVERY_NOTES.md`
8. `docs/BUILD_BLUEPRINT_V2.md`
9. `docs/RESTORE.md`

Then inspect the source tree and migrations. Do not restart from scratch.
Continue from the recorded source phase. Do not extract a historical ZIP over
the clone.

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
