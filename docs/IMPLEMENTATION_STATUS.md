## CURRENT STATE (CP26 CLOSED)

Living status: **`BUILD_STATE.md`**.

- Product: **SCAN / BOOK / GO**
- CP26B.3R SHA `19512c295830fbc6fd9712d688ce364d940f87c3` is historical, not current `main`
- CP25G.3 / **CP26A** / **CP26B** / **CP26C-O2**: **CLOSED**
- **CP26 FINALISATION — PASS. CP26 STRIPE TEST — PASS. CP26 EXIT GATE — PASS. CP26 — COMPLETE**
- **Next: CP27 — SECURITY HARDENING. Not started.** Former O3.4 superseded. CP26C.3 not resumed. The O4–O11 chain is superseded
- **CP26C-O3R PASS** — commercial model reconciled (`docs/COMMERCIAL_MODEL.md`). Later checkpoints implemented it
- **CP26C-O2D PASS** — Owner sign-in isolated at `/owner/login`. Human verification **PASS**. No migration
- **CP26C-O3.3 PASS** — Owner commercial catalogue UI. **O3.3V PASS**. Later a price version was created in CP26 STRIPE TEST
- CP26C.3 remains **not resumed**. Only **CP31** activates LIVE commerce
- Forward roadmap: **[ROADMAP.md](ROADMAP.md)**
- Fixture policy: **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)**
- Vercel Production `scan-book-go` / alias `https://scan-book-go.vercel.app`
- Neon Production migrated through **0028**. Gate B accepted ledger **0001–0028**. Source **0029** is reviewed pending and **not applied**. `AUTHORISED_PENDING=["0029_cp272_domain_a_checkout_claims.sql"]`. 0028 digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d` (run 36254890554). 0027 digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef` (run 36251190175). 0025, 0027, and 0028 workflows **RETIRED**. No 0029 apply workflow. `property_licence` active; basic/pro/premium inactive. One price version EUR 17900 month. One verified TEST mapping. Commerce **test**, not live
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
