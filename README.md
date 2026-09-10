# Aether Transfer

SCAN. BOOK. GO.

Private hotel transfers. Reconstruction of the lost implementation from
**CANONICAL PRIVATE TRANSFER APP — BUILD BLUEPRINT v2**.

This is not a visual prototype. PostgreSQL is authoritative for booking and
inventory integrity.

## Current checkpoint

Read `docs/RECOVERY_MANIFEST.md` first.

Checkpoint **12b** — CP12B pre-Vercel production hardening. Occupancy, auth,
time, booking, inventory, guest UX, ops desk, hotel white-label, CP12 tenancy,
and CP12A ownership boundaries are in this tree. Neon verification and Vercel
connection are **not** part of this checkpoint.


## Restore

See `docs/RESTORE.md`.

## Stack

TanStack Start, React, TypeScript, Tailwind v4, Outfit, Kysely, PostgreSQL /
PGLite, Neon in production.

## Do not

Do not add payments, guest accounts, RLS, hotel colour themes, Next.js,
Prisma, or a standalone REST API. See `docs/BUILD_BLUEPRINT_V2.md`.
