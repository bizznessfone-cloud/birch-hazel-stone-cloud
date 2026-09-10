# Implementation status

Product: **Aether Transfer**

Build: **CP12B — Pre-Vercel production hardening**

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

## CP12B (current)

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

Supply Neon owner URL + `aether_runtime` LOGIN URL, set the runtime password out of band, then `npm run verify:neon`.
Do not start CP13. Do not connect Vercel until that gate PASSes.
Do not call the platform app provisioner.
