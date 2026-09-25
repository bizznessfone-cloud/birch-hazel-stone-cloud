## CURRENT STATE (CP26C-O2 CLOSED)

Living status: **`BUILD_STATE.md`**.

- Product: **SCAN / BOOK / GO**
- Last application SHA: `19512c295830fbc6fd9712d688ce364d940f87c3`
- CP25G.3 / **CP26A** / **CP26B** / **CP26C-O2**: **CLOSED**
- **Next execution checkpoint: CP26C-O3 — commercial catalogue**
- CP26C.3 remains **paused** until O3. CP26C remains **open**. Only **CP31** activates live commerce.
- Forward roadmap: **[ROADMAP.md](ROADMAP.md)**
- Fixture policy: **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)**
- Vercel Production `scan-book-go` / last observed `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` READY
- Neon Production migrated through **0025**. Gate B accepted ledger **0001–0025**.
- Active platform Owners: **1** (OPERATOR CONTROLLED / REDACTED). Bootstrap workflow **RETIRED**.
- `/app/*` exists (SaaS). `/owner/*` is Production-proven. `/ops/*` remains internal operations.
- First Production hotel through `/app`: **configured, not live** (`sbg-verify-a5`)
- Domain A commerce: **OFF**.

The historical status table below is preserved as evidence and must not override current source.

---

# Implementation status (historical CP13A-era record)

Product: **Aether Transfer** (now SCAN / BOOK / GO)

Build at the time of this table: **CP13A — SQL-created production application role (source only)**

Trusted occupancy baseline: **CP10**. CP12/CP12A tenancy is in the tree. Previous abandoned original CP11 was **not** used.

Never mark a phase PASS merely because the UI renders.

| Phase | Name | State at time of this table |
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
| 10 | Production hardening (PGLite privilege split) | **PASS** (PGLite) |
| 10A | Persistence / controlled restore | **PASS** (preview) |
| 11 | NEW CP11 Production Infrastructure | Historical |
| 12 | Multi-tenant hotel/provider foundation | **PASS** (later applied on Neon) |
| 12A | Resource ownership administration boundaries | **PASS** |
| 12B | Pre-Vercel production hardening | later completed on Neon/Vercel |
| 13A | SQL-created production LOGIN `aether_app` | later completed on Neon |

Later completed (not in the original table): CP14–CP17, CP19 production binding, CP20 email architecture, CP21/CP21B, CP22 onboarding, CP23 public slug, CP24 Stripe Connect source, CP25 guest-payment source, CP25G.3 Production Better Auth configuration (CLOSED), CP26A commercial dormancy + verification tenant (CLOSED), CP26B Domain A lifecycle + Production 0024 (CLOSED).

## Next

**CP26C.** Canonical definitions: **[ROADMAP.md](ROADMAP.md)**. CP26 is not go-live.
