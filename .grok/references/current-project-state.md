# SCAN / BOOK / GO — CURRENT PROJECT STATE

Living source-of-truth for Grok. GitHub `main` is authoritative. This file must
not trail the repository.

## Source

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | `b35ef2fc8bdddef81fcc84aa59d358dba4346a30` |
| CP25G.3 | **CLOSED** |
| CP26A.1 / CP26A.2 | **CLOSED** |
| CP26A.4 | **CLOSED** (local tenant foundation + fixture policy) |
| **Next execution checkpoint** | **CP26A.5** — Production verification identity + one owned hotel, commerce OFF |
| Forward roadmap | `docs/ROADMAP.md` (CP26–CP31) |
| Fixture policy | `docs/FIXTURE_POLICY.md` |

`cp17-known-good` (`45e171a…`) and CP15/CP21B SHAs below are **historical**.

- CP21B audit baseline (historical): `fa823186a548a2009bbb3dc1e7453c75cf94b919`
- CP15 frozen checkpoint (historical): `96947e6c1840d5c04bc118c8abf93b2fa802469c`

## Production

- Vercel project: `scan-book-go`
- Last observed deployment: `dpl_7mJ8kBkd1m679TpriPUnYeX8X4qY` READY on `b35ef2f`
- Alias: `https://scan-book-go.vercel.app`
- Push to `main` auto-deploys Vercel Production
- `DATABASE_URL` PRESENT (`aether_app`)
- `AETHER_DATABASE_OWNER_URL` ABSENT
- `SBG_SAAS_COMMERCE` ABSENT (fail-closed Domain A)
- `BETTER_AUTH_SECRET` PRESENT
- `BETTER_AUTH_URL` PRESENT

## Database

Migrations **0001–0023** exist in source and are applied on Production Neon.
0023 decoupled `sbg_sync_hotel_entitlement` from hotel publication.
Single-use 0022/0023 mutation workflows are retired. Application build does
not migrate. Permanent Gate B is read-only.

## Auth (do not reopen CP25G.3)

Proven: signup, session, secure cookies, authenticated `/app`, persistence,
sign-out, signed-out `/app` boundary.

Not Production-proven: returning sign-in POST; authenticated tenant runtime.

Deferred: copied-cookie stale replay; password recovery; email verification.

## V1 operator journey

```
account → hotel → service → preview → QR → plan → Stripe → LIVE
```

- `/app/*` exists (authenticated SaaS).
- Onboarding source exists and is locally proven (CP26A.4): configured ≠ live.
- First Production hotel through `/app` is not proven (CP26A.5).
- Stripe/Resend source exists. Production configuration is absent.
- Domain A remains dormant until CP31.
- `/ops/*` remains internal operations.
- Public guest: `/{hotelSlug}` plus legacy `/book/{hotelCode}`.
- Guest booking / `demo-kos` (live) have Production evidence. Guest payment is not Production-proven.
- `demo-kos` is the operational demo, not the SaaS verification tenant.

## V2 fence

Keep SMS, WhatsApp, chatbot, custom domains, marketplace features, guest
accounts, RLS, and unrelated expansion out of V1 unless a later checkpoint
explicitly opens them.

## Next checkpoint

**CP26A.5 — operator-supervised Production verification identity + one owned hotel, commerce OFF**

Canonical roadmap: `docs/ROADMAP.md`. Fixture policy: `docs/FIXTURE_POLICY.md`.

CP26 = build/test Domain A SaaS subscriptions. **Not go-live.**
CP31 = activate commerce. Do not skip CP26A.5 before Stripe test-mode work.
Do not start CP26B yet.
