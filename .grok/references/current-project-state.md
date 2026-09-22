# SCAN / BOOK / GO — CURRENT PROJECT STATE

Living source-of-truth for Grok. GitHub `main` is authoritative. This file must
not trail the repository.

## Source

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | 19512c295830fbc6fd9712d688ce364d940f87c3 (CP26B.3R; Production 0024 applied) |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| CP26B.1 | **PASS** |
| CP26B.2 | **SOURCE COMPLETE then APPLIED via CP26B.3** |
| CP26B.3 | **CLOSED** |
| CP26B.4 | **PASS** — Gate B 0001–0024; 0024 dispatch retired |
| **CP26B** | **CLOSED** |
| CP26C.1 | **PASS** |
| CP26C.2 | **PASS** — test hotel UUID allowlist in source |
| CP26C.3 | **PAUSED AFTER SAFE PREFLIGHT** |
| CP26C-O1 | **PASS** — Owner Control Plane architecture |
| CP26C-O2 | **PASS** — Owner dashboard foundation; 0025 SOURCE ONLY |
| CP26C-O2A | **READY — NOT EXECUTED** — single-use 0025 controller |
| **Next control-plane action** | authorised 0025 dispatch (`APPLY-0025`) |
| **Next product checkpoint** | **CP26C-O3 — commercial catalogue persistence** |
| Forward roadmap | `docs/ROADMAP.md` (CP26–CP31) |
| Owner architecture | `docs/OWNER_CONTROL_PLANE.md` |
| Fixture policy | `docs/FIXTURE_POLICY.md` |

`cp17-known-good` (`45e171a…`) and CP15/CP21B SHAs below are **historical**.

- CP21B audit baseline (historical): `fa823186a548a2009bbb3dc1e7453c75cf94b919`
- CP15 frozen checkpoint (historical): `96947e6c1840d5c04bc118c8abf93b2fa802469c`

## Production

- Vercel project: `scan-book-go`
- Last observed deployment (CP26B.3V): `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` READY on `19512c2`
- Alias: `https://scan-book-go.vercel.app`
- Push to `main` auto-deploys Vercel Production (docs/control-plane deploys must not activate commerce)
- `DATABASE_URL` PRESENT (`aether_app`)
- `AETHER_DATABASE_OWNER_URL` ABSENT
- `SBG_SAAS_COMMERCE` ABSENT (fail-closed Domain A)
- `BETTER_AUTH_SECRET` PRESENT
- `BETTER_AUTH_URL` PRESENT

## Database

Migrations **0001–0025** exist in source. Production Neon is applied through **0024**.
**0025 is SOURCE ONLY — not Production-applied.** CP26C-O2A controller is READY
and **not executed**. Gate B accepted ledger remains **0001–0024**.
`AUTHORISED_PENDING=[]`. Generic migrator remains fail-closed.
0025 digest `575aabcb7322fc8ca63c8a3dd137d358f76375f1777ed59cf04c1d98d6c066fd`.
Generic migrator remains fail-closed. Spent 0024 `workflow_dispatch` is retired.
0024 digest `23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0`.
Apply run [35697938230](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35697938230).
Verification run [35699337916](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35699337916) (`0024 ALREADY APPLIED — NO MUTATION`).

## Auth (do not reopen CP25G.3)

Proven: signup, session, secure cookies, authenticated `/app`, persistence,
sign-out, signed-out `/app` boundary.

**Production returning email/password authentication — PROVEN CP26A.5.**

Deferred: copied-cookie stale replay; password recovery; email verification.

## Production verification tenant (RETAIN)

- Code `sbg-verify-a5`, slug `erification-otel`, **configured not live**
- Operator-controlled email REDACTED; password in human password manager only
- Billing GET resolved; no Stripe/Connect/Checkout
- Do not publish, delete, or attach test commerce until CP26C.4/C.5 explicitly authorise it (hotel allowlist is in source; Production commerce remains OFF)

## V1 operator journey

```
account → hotel → service → preview → QR → plan → Stripe → LIVE
```

- `/app/*` exists (authenticated SaaS).
- First Production hotel through `/app` is proven to **configured, not live**.
- Stripe/Resend source exists. Production configuration is absent.
- Domain A remains dormant until CP31.
- CP26B.1 hardened Domain A application lifecycle (gate-before-write, one subscription, portal-first).
- CP26B.2/3 ordered billing persistence is **applied** (`event.created` bigint, `cancel_at_period_end`, stale/ambiguous/duplicate).
- CP26C.2 isolates Domain A test commerce to `SBG_SAAS_TEST_HOTEL_IDS`. Do not set `SBG_SAAS_COMMERCE=test` on public Production until CP26C.4.
- `/ops/*` remains internal operations.
- Public guest: `/{hotelSlug}` plus legacy `/book/{hotelCode}`.
- Canonical live demo: `/book/demo-kos`. `/demo-kos` slug currently hotel_not_found (pre-existing).
- Guest payment is not Production-proven.
- `demo-kos` is the operational demo, not the SaaS verification tenant.

## V2 fence

Keep SMS, WhatsApp, chatbot, custom domains, marketplace features, guest
accounts, RLS, and unrelated expansion out of V1 unless a later checkpoint
explicitly opens them.

## Next checkpoint

**CP26C-O2 — Owner dashboard foundation (not started)**

Canonical roadmap: `docs/ROADMAP.md`. Owner architecture: `docs/OWNER_CONTROL_PLANE.md`. Fixture policy: `docs/FIXTURE_POLICY.md`.

CP26 = build/test Domain A SaaS subscriptions. **Not go-live.**
CP31 = activate commerce.
CP26C.3 remains paused until CP26C-O3. Do not enable `SBG_SAAS_COMMERCE=test` on public Production until CP26C.4.
