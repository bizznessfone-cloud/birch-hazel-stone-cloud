## CP21B CURRENT PROJECT STATE

The original README content below is retained. This section supersedes only its current-state claims.

- Product: **SCAN / BOOK / GO**; internal code/history name: Aether Transfer.
- CP21B reconciliation is complete.
- Current V1 phase: product-surface construction.
- Next: **CP22 — V1 Operator Onboarding**.
- V1 journey: `account → hotel → first service → preview → QR → plan → Stripe activation → LIVE`.
- `/ops/*` remains internal operations; `/app/*` is the new SaaS surface.
- CP20 transactional email architecture is implemented/tested.
- Stripe is now V1 product-layer work, intentionally layered after the frozen MVP foundation.
- Do not delete or rewrite historical checkpoint material.

---

# Aether Transfer

SCAN. BOOK. GO.

Private hotel transfers. Reconstruction of the lost implementation from
**CANONICAL PRIVATE TRANSFER APP — BUILD BLUEPRINT v2**.

This is not a visual prototype. PostgreSQL is authoritative for booking and
inventory integrity.

## Source of truth

GitHub is authoritative for application source.

| Field | Value |
|---|---|
| Repository | [`bizznessfone-cloud/birch-hazel-stone-cloud`](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud) |
| Branch | `main` |
| Known-good application source | `45e171a23037b7c94005018cd2126033a449d6f0` |
| Tag | `cp17-known-good` |

`cp17-known-good` is an immutable tag on that commit. When the tag was created,
`main` pointed at it. Later documentation-only commits on `main` do not change
the CP16C/CP17 application baseline.

A Grok workspace is disposable and is never authoritative. Recovery ZIPs are
secondary disaster-recovery artifacts. The CP10 ZIP in `attachments/` is
historical and **must not** be extracted over a newer Git tree without explicit
human approval.

Source-code state and production database state are reported separately. Do not
claim Neon production readiness merely because this repository is current.

## Current checkpoint

Read `docs/RECOVERY_MANIFEST.md` first.

**Source baseline: CP16C/CP17** at `45e171a` / `cp17-known-good`. Occupancy,
auth, time, booking, inventory, guest UX, ops desk, hotel white-label, CP12
tenancy, CP13A `aether_app` LOGIN, CP14 hotel configuration/timezone, CP15
hotel-scoped Ops identity, CP16C privilege hardening, and CP17 hotel-local Ops
Today are in this tree.

**CP19** is production Neon binding/verification. It is **not** a completed
production checkpoint and is **not** a source-code commit. Neon verification
and Vercel connection are **not** part of this baseline.

Every future production-readiness audit **must** name the exact Git commit
audited.

## Restore

See `RESTORE.md` (repo root) and `docs/RESTORE.md`. Clone the GitHub repository
and check out `cp17-known-good` or commit `45e171a23037b7c94005018cd2126033a449d6f0`.
Do not restore from a checkpoint ZIP unless Git is unavailable and a human has
approved that disaster-recovery path.

## Stack

TanStack Start, React, TypeScript, Tailwind v4, Outfit, Kysely, PostgreSQL /
PGLite, Neon in production.

## Do not

Do not add payments, guest accounts, RLS, hotel colour themes, Next.js,
Prisma, or a standalone REST API. See `docs/BUILD_BLUEPRINT_V2.md`.
