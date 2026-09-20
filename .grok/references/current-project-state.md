# SCAN / BOOK / GO — CURRENT PROJECT STATE

Living source-of-truth for Grok. GitHub `main` is authoritative. This file must
not trail the repository.

## Source

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Current source SHA | `4c20e9b9574309a0edbeb03f8675febdef38dede` |
| CP25G.3 | **CLOSED** |
| Next numbered checkpoint | **UNDEFINED** — requires explicit authorisation. **Do not invent CP26.** |

`cp17-known-good` (`45e171a…`) and CP15/CP21B SHAs below are **historical**.

- CP21B audit baseline (historical): `fa823186a548a2009bbb3dc1e7453c75cf94b919`
- CP15 frozen checkpoint (historical): `96947e6c1840d5c04bc118c8abf93b2fa802469c`

## Production

- Vercel project: `scan-book-go`
- Deployment: `dpl_5XnaxYcqkrgWucD54TKgbmvHkfy1` READY
- Alias: `https://scan-book-go.vercel.app`
- Deployed SHA matches current source SHA
- `DATABASE_URL` PRESENT (`aether_app`)
- `AETHER_DATABASE_OWNER_URL` ABSENT
- `BETTER_AUTH_SECRET` PRESENT
- `BETTER_AUTH_URL` PRESENT

## Database

Migrations **0001–0022** exist in source and are applied on Production Neon.
0022 restored Better Auth runtime DML for `aether_app`. Application build does
not migrate.

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
- Onboarding source exists. First Production hotel through `/app` is not proven.
- Stripe/Resend source exists. Production configuration is absent.
- `/ops/*` remains internal operations.
- Public guest: `/{hotelSlug}` plus legacy `/book/{hotelCode}`.
- Guest booking / `demo-kos` have Production evidence. Guest payment is not Production-proven.

## V2 fence

Keep SMS, WhatsApp, chatbot, custom domains, marketplace features, guest
accounts, RLS, and unrelated expansion out of V1 unless a later checkpoint
explicitly opens them.

## Next checkpoint

**UNDEFINED.** Do not treat CP22 or CP24 as next/current. Do not invent CP26.
