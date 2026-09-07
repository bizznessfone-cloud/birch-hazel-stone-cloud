# Aether Transfer

SCAN. BOOK. GO.

Private hotel transfers. Reconstruction of the lost implementation from
**CANONICAL PRIVATE TRANSFER APP — BUILD BLUEPRINT v2**.

This is not a visual prototype. PostgreSQL is authoritative for booking and
inventory integrity.

## Current checkpoint

Read `docs/RECOVERY_MANIFEST.md` first.

Checkpoint **7** — Phase 7 operations UX is complete. Occupancy, auth, time,
booking, inventory, guest UX, and the ops desk are in this tree. Hotel
white-label, production hardening, and deployment are later phases.

## Restore

See `docs/RESTORE.md`.

## Stack

TanStack Start, React, TypeScript, Tailwind v4, Outfit, Kysely, PostgreSQL /
PGLite, Neon in production.

## Do not

Do not add payments, guest accounts, RLS, hotel colour themes, Next.js,
Prisma, or a standalone REST API. See `docs/BUILD_BLUEPRINT_V2.md`.
