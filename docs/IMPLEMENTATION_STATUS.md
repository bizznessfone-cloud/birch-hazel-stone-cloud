## CURRENT STATE (POST-CP25G.3)

Living status: **`BUILD_STATE.md`**.

- Product: **SCAN / BOOK / GO**
- Current source SHA: `4c20e9b9574309a0edbeb03f8675febdef38dede`
- CP25G.3: **CLOSED**
- Next numbered checkpoint: **UNDEFINED** — requires explicit architecture/product authorisation. **Do not invent CP26.**
- Vercel Production `scan-book-go` / `dpl_5XnaxYcqkrgWucD54TKgbmvHkfy1` READY, SHA matches source
- Neon Production migrated through **0022**
- `/app/*` exists (SaaS). `/ops/*` remains internal operations.
- V1 journey: `account → hotel → service → preview → QR → plan → Stripe → LIVE`
- Stripe/Resend Production configuration: **absent**
- First Production hotel through `/app`: **not proven**

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

Later completed (not in the original table): CP14–CP17, CP19 production binding, CP20 email architecture, CP21/CP21B, CP22 onboarding, CP23 public slug, CP24 Stripe Connect source, CP25 guest-payment source, CP25G.3 Production Better Auth configuration (CLOSED).

## Next

Next numbered checkpoint is **UNDEFINED**. Do not start CP22/CP24/CP26 from this file. Use `BUILD_STATE.md`.
