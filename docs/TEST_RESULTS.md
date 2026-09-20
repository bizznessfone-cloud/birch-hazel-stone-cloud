# Test results

> **Living status:** `BUILD_STATE.md`. This file is a **historical test ledger**, not current Production proof.
> Current living roadmap: `docs/ROADMAP.md`. Next execution **CP26A**. CP25G.3 **CLOSED**.

Two sections. Never mix them.

## HISTORICAL — CP12B (2026-09-10)

Phase: **CP12B — Pre-Vercel production hardening**
Baseline: CP12A (`2283746187e7fc4a98987775ac54c28037e06948`). Occupancy SQL unchanged.

| Check | Engine | Result |
|---|---|---|
| `npm run test:aether` | PGLite | **120 passed / 0 failed** (119 + TZ) |
| `scripts/migrate-policy.test.mjs` | n/a | **6 passed** |
| `npm run build` | local | **PASS** (migrate skipped: no owner URL) |
| `npm run verify:neon` | Neon | **BLOCKED** — credentials unavailable (exit 2). Not skipped as a pass. |

**NEON PRODUCTION-ROLE SPLIT BLOCKED / UNVERIFIED** (`DATABASE_URL` unset).
A local build is not Vercel readiness.

## HISTORICAL — NEW CP11 (2026-09-06)

Phase: **NEW CP11 — Production Infrastructure**
Baseline: CP10. Previous abandoned CP11 unused.

These are tests actually run against the current tree.

| Check | Engine | Result |
|---|---|---|
| `npm run verify:neon` | Neon | **BLOCKED** — credentials unavailable (exit 2). Not skipped as a pass. |
| Neon privilege gate | Neon | **NOT RUN** (blocked before connect) |
| Neon concurrency | Neon | **NOT RUN** (blocked before connect) |
| Owner/runtime URL split | Neon | **NOT RUN** |
| `npm run typecheck` | local | **PASS** |
| `npm run test:aether` | PGLite | **101 passed / 0 failed** — **LOCAL only** |
| `npm run build` | local | **PASS** (`db:migrate` skipped: URLs unset) |

PGLite results must not be restated as Neon production verification.

---

## CURRENT REBUILD TEST RESULTS (CP10 / 10A historical)

Rebuild date: 2026-09-05

Phase under test: **10A — PERSISTENCE RESTORE** of Checkpoint 10

These are tests actually run against the current implementation after restore.

Current Aether total: **101 passed / 0 failed**.

`npm run typecheck`: **PASS** (re-run after restore)

`AETHER_RESTORE_TARGET=production` with credentials unset: **FAIL CLOSED** (CREDENTIAL FAILURE). Did not substitute PGLite.

Production `npm run build`: not re-run in 10A (product unchanged). Historical CP10 build was PASS.

### Restore re-run (this workspace, PGLite development substitute)

| Suite | Tests | Result |
|---|---|---|
| Foundation `foundation.test.ts` | 4 | PASS |
| Occupancy `occupancy.test.ts` | 17 | PASS |
| Ops-auth `ops-auth.test.ts` | 11 | PASS |
| Time `time.test.ts` | 15 | PASS |
| Process-TZ `time-process-tz.test.ts` (`TZ=Pacific/Auckland`) | 1 | PASS |
| Booking `booking.test.ts` | 9 | PASS |
| Inventory `inventory.test.ts` | 10 | PASS |
| Guest `guest.test.ts` | 4 | PASS |
| Ops-desk `ops-desk.test.ts` | 4 | PASS |
| Hotel `hotel.test.ts` | 8 | PASS |
| Matrix `matrix.test.ts` | 7 | PASS |
| Hardening `hardening.test.ts` | 11 | PASS |
| **Total** | **101** | **PASS** |

Engine: **PGLite**. This is **LOCAL / TEST ENVIRONMENT VERIFIED**, not production.

**NEON CONCURRENCY NOT VERIFIED.**

**NEON PRODUCTION-ROLE SPLIT BLOCKED / UNVERIFIED** (`DATABASE_URL` unset).

---

## Checkpoint 10 original results (immutable historical record)

Phase under test: **10 — PRODUCTION HARDENING** (checkpoint 10)

Current Aether total: **101 passed / 0 failed**.

Breakdown: **90** Phase 0–9 file tests (re-run) + **11** Phase 10 tests in `hardening.test.ts`.

`npm run typecheck`: **PASS**

`npm run build` (production): **PASS** (migrate skipped: `DATABASE_URL` / `AETHER_DATABASE_OWNER_URL` unset)

Production built-output smoke vs preview baseline: **no divergence**, clean console.

### Phase 0–9 (re-run this phase, still passing)

| Suite | Tests | Result |
|---|---|---|
| Foundation `foundation.test.ts` | 4 | PASS |
| Occupancy `occupancy.test.ts` | 17 | PASS |
| Ops-auth `ops-auth.test.ts` | 11 | PASS |
| Time `time.test.ts` | 15 | PASS |
| Process-TZ `time-process-tz.test.ts` (`TZ=Pacific/Auckland`) | 1 | PASS |
| Booking `booking.test.ts` | 9 | PASS |
| Inventory `inventory.test.ts` | 10 | PASS |
| Guest `guest.test.ts` | 4 | PASS |
| Ops-desk `ops-desk.test.ts` | 4 | PASS |
| Hotel `hotel.test.ts` | 8 | PASS |
| Matrix `matrix.test.ts` (updated for 0011 / schema_phase 10) | 7 | PASS |
| **Subtotal** | **90** | **PASS** |

### Phase 10 newly added (`src/lib/aether/hardening.test.ts`)

| Test | Result |
|---|---|
| 0011 creates aether_runtime; occupancy objects remain owned by the migrator | PASS |
| runtime role cannot ALTER, DROP, or DISABLE the occupancy trigger | PASS (PGLite `42501`) |
| runtime role cannot DROP or ALTER occupancy EXCLUDE constraints | PASS (PGLite `42501`) |
| runtime role cannot DROP or replace aether_athens_instant | PASS (PGLite `42501`) |
| runtime role cannot CREATE or DROP required extensions | PASS (PGLite `42501` / `0A000`) |
| runtime role may DML; occupies trigger and 23P01 remain authority | PASS |
| runtime cancellation and unassignment still release occupancy | PASS |
| table owner can disable the occupancy trigger — production DATABASE_URL must not be that owner | PASS (documents remaining owner gap) |
| cookie, CSRF, throttle, revocation, and token entropy remain encoded | PASS |
| public DTO, guest isolation, secrets, and migration ownership stay hardened | PASS |
| Neon production-role split is BLOCKED when DATABASE_URL is unset | PASS (records BLOCKED, does not fake Neon) |
| **Subtotal** | **11 PASS** |

### Privilege gate (this phase)

| Check | Engine | Result |
|---|---|---|
| Runtime DISABLE `bookings_occupies_before` | PGLite `SET ROLE aether_runtime` | **DENIED** `42501` |
| Runtime DROP trigger | PGLite | **DENIED** `42501` |
| Runtime DROP vehicle EXCLUDE | PGLite | **DENIED** `42501` |
| Runtime DROP driver EXCLUDE | PGLite | **DENIED** `42501` |
| Runtime DROP / replace `aether_athens_instant` | PGLite | **DENIED** `42501` |
| Runtime DROP `btree_gist` | PGLite | **DENIED** `42501` |
| Runtime CREATE new extension | PGLite | does not succeed (`0A000` / `42501`) |
| Runtime required DML + occupies trigger | PGLite | **PASS** |
| Runtime overlap still `23P01` → unavailable | PGLite | **PASS** |
| Table owner DISABLE trigger | PGLite `postgres` | **ALLOWED** (why `DATABASE_URL` must not be owner) |
| Neon runtime role on a real database | Neon | **BLOCKED / UNVERIFIED** (`DATABASE_URL` unset) |
| Neon concurrency | Neon | **NOT VERIFIED** |

`SET ROLE` from an owner connection is defense in depth. `RESET ROLE` restores
the connecting owner. That remaining gap is not hidden.

### Live preview (this phase, not counted in the 101)

Home footer after 0011: Database **pglite**, Schema **phase 10**, Checkpoint **10**, Kysely **connected**.
