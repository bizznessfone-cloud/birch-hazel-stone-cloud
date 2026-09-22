## CURRENT STATE (POST-CP26B CLOSED)

Living status: **`BUILD_STATE.md`**.

- Product: **SCAN / BOOK / GO**
- Last application SHA: `19512c295830fbc6fd9712d688ce364d940f87c3`
- CP25G.3 / **CP26A** / **CP26B**: **CLOSED**
- **Next execution checkpoint: CP26C — Stripe test-mode integration (design/preflight; not started)**
- Forward roadmap: **[ROADMAP.md](ROADMAP.md)** (CP26 build/test commerce → CP31 activate)
- Fixture policy: **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)**
- Vercel Production `scan-book-go` / last observed `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` READY
- Neon Production migrated through **0024**
- `/app/*` exists (SaaS). `/ops/*` remains internal operations.
- V1 journey: `account → hotel → service → preview → QR → plan → Stripe → LIVE`
- Stripe/Resend Production configuration: **absent**
- First Production hotel through `/app`: **configured, not live** (`sbg-verify-a5`)
- Returning Production sign-in: **proven CP26A.5**
- Domain A commerce: **OFF**. `SBG_SAAS_COMMERCE=test` is process-global (CP26C blast-radius).

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
