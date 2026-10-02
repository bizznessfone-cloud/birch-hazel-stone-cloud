## CURRENT STATE (CP26 CLOSED)

Living status: **`BUILD_STATE.md`**.

- Product: **SCAN / BOOK / GO**
- CP26B.3R SHA `19512c295830fbc6fd9712d688ce364d940f87c3` is historical, not current `main`
- CP25G.3 / **CP26A** / **CP26B** / **CP26C-O2**: **CLOSED**
- **CP26 FINALISATION — PASS. CP26 STRIPE TEST — PASS. CP26 EXIT GATE — PASS. CP26 — COMPLETE**
- **Next: not CP27.4** — CP27.3c guest booking client-IP trust is in source. Former O3.4 superseded. CP26C.3 not resumed. The O4–O11 chain is superseded
- **CP26C-O3R PASS** — commercial model reconciled (`docs/COMMERCIAL_MODEL.md`). Later checkpoints implemented it
- **CP26C-O2D PASS** — Owner sign-in isolated at `/owner/login`. Human verification **PASS**. No migration
- **CP26C-O3.3 PASS** — Owner commercial catalogue UI. **O3.3V PASS**. Later a price version was created in CP26 STRIPE TEST
- CP26C.3 remains **not resumed**. Only **CP31** activates LIVE commerce
- Forward roadmap: **[ROADMAP.md](ROADMAP.md)**
- Fixture policy: **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)**
- Vercel Production `scan-book-go` / alias `https://scan-book-go.vercel.app`
- Neon Production migrated through **0030**. Gate B accepted ledger **0001–0030**. `AUTHORISED_PENDING=[]`. 0030 digest `9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f` applied (GHA 36448160139). Temporary apply workflow **RETIRED**. Do not rerun `scripts/cp272-0030-production-migrate.mjs`. 0029 digest `e5897eda1a4f3c8c4025e16235b9d11a677b3cc7994934058142934d4dea7adc` applied (GHA 36404482927). Checkout calls the installed 0029 claim functions. Booking payments were 0 and were not mutated by M5–M8. M5, M6, M7, and M8 are implemented in application source. `SBG_DOMAIN_B_LIVE_CHECKOUT` is not enabled. Commerce **test**, not live. 0031+ fail-closed
- Active platform Owners: **1** (OPERATOR CONTROLLED / REDACTED). Bootstrap workflow **RETIRED**
- `/app/*` exists (SaaS). `/owner/*` is Production-proven. `/ops/*` remains internal operations
- First Production hotel through `/app`: **configured, not live** (`sbg-verify-a5`)
- Domain A commerce: **test**, allowlisted, not LIVE

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
