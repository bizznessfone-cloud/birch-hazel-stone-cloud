## CP21B CURRENT-STATE OVERRIDE

The historical status record below is preserved. Current state is:

- Product: **SCAN / BOOK / GO** (internal code/history name: Aether Transfer)
- CP21B reconciliation complete.
- Next checkpoint: **CP22 — V1 Operator Onboarding**
- V1 journey: `account → hotel → first service → preview → QR → plan → Stripe activation → LIVE`
- `/app/*` is the new SaaS operator surface; `/ops/*` remains internal operations.
- CP20 confirmation-email architecture is present and tested.
- Stripe/subscription work is now V1 product-layer work; the original frozen Blueprint is not rewritten.
- V2 remains fenced.

The historical checkpoint status below is retained as evidence and must not be used to override current source.

---

# Implementation status

Product: **Aether Transfer**

Build: **CP13A — SQL-created production application role (source only)**

Trusted occupancy baseline: **CP10**. CP12/CP12A tenancy is in the tree. Previous abandoned original CP11 was **not** used.

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
| 10 | Production hardening (PGLite privilege split) | **PASS** (PGLite) |
| 10A | Persistence / controlled restore | **PASS** (preview) |
| 11 | NEW CP11 Production Infrastructure | Historical — Neon verifier exists; live Neon **BLOCKED** here |
| 12 | Multi-tenant hotel/provider foundation | **PASS** (PGLite; Neon schema **UNVERIFIED**) |
| 12A | Resource ownership administration boundaries | **PASS** (PGLite) |
| 12B | Pre-Vercel production hardening | **LOCAL** — Neon **BLOCKED** |
| 13A | SQL-created production LOGIN `aether_app` | **LOCAL** — Neon **BLOCKED** |

## CP13A (current)

- [x] `aether_app` SQL-created LOGIN (0014); password out of band
- [x] `aether_runtime` retained for PGLite SET ROLE
- [x] 0011–0013 immutable
- [x] Production verifier requires `session_user` = `current_user` = `aether_app`
- [x] Verifier denies `neon_superuser` membership
- [ ] Neon 0012/0013/0014 applied and verified — **BLOCKED** (credentials unavailable)
- [ ] Vercel — **NOT CONNECTED**

## CP12B (historical, still in tree)

- [x] Production without DATABASE_URL fails closed (no silent PGLite)
- [x] Production migrate uses AETHER_DATABASE_OWNER_URL only
- [x] aether_runtime LOGIN (0013); app does not send a startup role option
- [x] Public confirmation JSON no longer exposes phone/email/token/notes
- [x] Guest-create rate limit (SQL, no Redis, fail-open)
- [x] Preview desk/desk-pass refused in production
- [x] Shared capped pg.Pool
- [ ] Neon 0012/0013 applied and verified — **BLOCKED** (credentials unavailable)
- [ ] Vercel — **NOT CONNECTED**

## Next

Do not start CP13B until this source checkpoint is accepted.
Supply Neon owner URL + SQL-created `aether_app` LOGIN URL, set the app password out of band (never Neon Console), then `npm run verify:neon`.
Do not connect Vercel until that gate PASSes.
Do not call the platform app provisioner.
