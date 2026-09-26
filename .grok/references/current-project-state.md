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
| CP26C-O2 | **CLOSED** — Owner dashboard Production-proven |
| CP26C-O2A | **PASS** — single-use 0025 controller |
| CP26C-O2B | **PASS** — Production 0025 applied |
| CP26C-O2C.1 | **PASS** — first-Owner bootstrap controller built |
| CP26C-O2C.2 | **PASS** — first Owner bootstrapped (GHA 36116463589) |
| CP26C-O2C.3 | **PASS** — bootstrap workflow retired |
| CP26C-O3.1 | **PASS** — commercial catalogue contract (`docs/COMMERCIAL_CATALOGUE.md`) |
| CP26C-O3.2 | **PASS** — source verified, then Production-applied in O3.2B |
| CP26C-O3.2A | **PASS** — controller built; dispatch **RETIRED** in O3.2C |
| CP26C-O3.2B | **PASS** — Production 0026 applied (GHA 36135836457) |
| CP26C-O3.2C | **PASS** — Gate B **0001–0026**; 0026 workflow retired |
| CP26C-O3.3 | **PASS** — Owner commercial catalogue UI; amounts still **UNDEFINED** |
| CP26C-O2D | **PASS** — `/owner/login` isolated from hotel `/login`; human verification **PASS** |
| CP26C-O3.3V | **PASS** — operator plans verification; no price created |
| CP26C-O3R | **PASS** — property-licence model reconciled (`docs/COMMERCIAL_MODEL.md`) |
| CP26 FINALISATION | **COMPLETE** — Production **0001–0028**; dormant organisation property-licence cutover; commerce **OFF**; CP26 **not** closed |
| **Next** | **CP26 STRIPE TEST**, then **CP26 EXIT GATE**. The O4–O11 chain is superseded |
| Forward roadmap | `docs/ROADMAP.md` (CP26–CP31) |
| Commercial model | `docs/COMMERCIAL_MODEL.md` |
| Commercial catalogue | `docs/COMMERCIAL_CATALOGUE.md` |
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

Migrations **0001–0028** exist in source and are applied on Production Neon.
Gate B accepted ledger is **0001–0028**. `AUTHORISED_PENDING=[]`.
0028 digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d` (GHA [36254890554](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36254890554)); workflow **RETIRED**.
0027 digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef` (GHA [36251190175](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36251190175)); workflow **RETIRED**.
`property_licence` is active. basic/pro/premium are inactive. Price versions **0**. Stripe mappings **0**. LIVE locks **false/false**.
Canonical amount remains **UNDEFINED**. Commerce **OFF**. CP26 is **not** closed. Next is **CP26 STRIPE TEST**.
The 0025 workflow remains historical and must not be re-dispatched.
0026 remains accepted history (GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457)).
Digest `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446`.
Active platform Owners: **1** (OPERATOR CONTROLLED / REDACTED). First-Owner bootstrap workflow is **RETIRED**. Historical run [36116463589](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36116463589).
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

**CP26C-O3.2A — 0026 Production controller built, not executed.** CP26C-O3.2 source migration is verified and unapplied. Digest `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446`. No Production connection. No Production mutation. No canonical pricing. Commerce OFF. Stripe untouched.

Canonical roadmap: `docs/ROADMAP.md`. Commercial catalogue: `docs/COMMERCIAL_CATALOGUE.md`. Owner architecture: `docs/OWNER_CONTROL_PLANE.md`. Fixture policy: `docs/FIXTURE_POLICY.md`.

CP26 = build/test Domain A SaaS subscriptions. **Not go-live.**
CP31 = activate commerce.
CP26C.3 remains paused until CP26C-O3.4 records canonical amounts. Checkout cutover is CP26C.4, not C.3. Do not enable `SBG_SAAS_COMMERCE=test` on public Production until CP26C.4.
Gate B accepted ledger remains **0001–0025**. `AUTHORISED_PENDING=[]`. Next is **CP26C-O3.2B** and it is not authorised by this record. Amounts are **UNDEFINED**.
