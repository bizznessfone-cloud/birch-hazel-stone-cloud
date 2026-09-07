# Implementation status

Product: **Aether Transfer**

Build: **NEW CP11 — Production Infrastructure — BLOCKED**

Trusted baseline: **CP10**. Previous abandoned CP11 was **not** used.

Never mark a phase PASS merely because the UI renders.

| Phase | Name | State |
|---|---|---|
| 0 | Foundation | **PASS** |
| 1 | Database | **PASS** |
| 2 | Authentication | **PASS** |
| 3 | Time domain | **PASS** |
| 4 | Booking engine | **PASS** |
| 5 | Inventory assignment | **PASS** |
| 6 | Guest UX | **PASS** |
| 7 | Operations UX | **PASS** |
| 8 | Hotel white label | **PASS** |
| 9 | Full test reconstruction | **PASS** |
| 10 | Production hardening | **PASS** (PGLite; Neon **BLOCKED**) |
| 10A | Persistence / controlled restore | **PASS** (preview) |
| 11 | NEW CP11 Production Infrastructure | **BLOCKED** — Neon credentials unavailable |
| 11A | Guest Experience Layer | NOT STARTED |
| 11B | Guest/Ops Integration | NOT STARTED |

## NEW CP11 (2026-09-06)

Inspected CP10 source and docs. Occupancy trigger, `aether_athens_instant()`, GiST EXCLUDE, `requireOps()`, HttpOnly session, guest `/book/{hotelCode}`, ops `/ops` unchanged.

Added fail-closed `scripts/verify-neon-production.mjs`. Did **not** call the platform provisioner. Did **not** substitute PGLite as Neon evidence.

- [x] CP10 baseline inspected
- [x] Previous abandoned CP11 unused
- [x] Destructive reset avoided
- [x] Secrets audit (no `.env`, no committed URLs)
- [ ] Neon owner/runtime separation — **BLOCKED** (`DATABASE_URL` and `AETHER_DATABASE_OWNER_URL` unset)
- [ ] Neon privilege gate — **BLOCKED**
- [ ] Neon concurrency — **BLOCKED**
- [ ] Production deployment — **BLOCKED**

## Phase 10 gate (unchanged; PGLite only)

See CP10 record. Neon boxes remain unchecked.

## Next

Supply Neon owner URL + `aether_runtime` LOGIN URL, then `npm run verify:neon`.
Do not start CP11A until NEW CP11 Neon gates PASS.
Do not call the platform app provisioner.
