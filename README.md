## CURRENT ACCEPTED BASELINE (POST-CP26B CLOSED)

Living source-of-truth. Historical README text below is evidence only.

| Field | Value |
|---|---|
| Product | **SCAN / BOOK / GO** (internal history name: Aether Transfer) |
| Repository | [`bizznessfone-cloud/birch-hazel-stone-cloud`](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud) |
| Branch | `main` |
| Last application SHA | `19512c295830fbc6fd9712d688ce364d940f87c3` |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| **CP26B** | **CLOSED** |
| **Next execution checkpoint** | **CP26C — Stripe test-mode integration (design/preflight; not started)** |
| Forward roadmap | **[docs/ROADMAP.md](docs/ROADMAP.md)** |
| Fixture policy | **[docs/FIXTURE_POLICY.md](docs/FIXTURE_POLICY.md)** |

CP26 builds/tests SBG SaaS subscriptions. **CP26 is not go-live.** Only **CP31** may activate real commerce.

### Production

| Field | Value |
|---|---|
| Vercel project | `scan-book-go` |
| Deployment | last observed `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` |
| State | READY |
| Alias | `https://scan-book-go.vercel.app` |
| Deployed SHA (last observed) | `19512c295830fbc6fd9712d688ce364d940f87c3` |

Environment (names/presence only; never secret values):

- `DATABASE_URL` — PRESENT (production runtime `aether_app`)
- `AETHER_DATABASE_OWNER_URL` — ABSENT from Vercel
- `SBG_SAAS_COMMERCE` — ABSENT (fail-closed Domain A)
- `BETTER_AUTH_SECRET` — PRESENT
- `BETTER_AUTH_URL` — PRESENT
- Stripe / Resend / Ops credentials — not present on the application plane unless separately proven

### Database

- Source and Production Neon migrations: **0001–0026**
- 0026 commercial catalogue (`sbg_saas_plans` basic/pro/premium; zero price versions; zero Stripe mappings; locks false/false; digest `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446`; apply run 36135836457; workflow retired)
- 0025 platform owners (`sbg_platform_owners`; digest `575aabcb7322fc8ca63c8a3dd137d358f76375f1777ed59cf04c1d98d6c066fd`); one Production Owner bootstrapped; bootstrap workflow retired
- 0024 ordered Domain A billing events (`sbg_apply_billing_event` 10-argument; digest `23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0`)
- 0023 decoupled `sbg_sync_hotel_entitlement` from hotel publication
- `neondb_owner` = migration/schema owner; `aether_app` = production LOGIN; `aether_runtime` = PGLite/preview SET ROLE only
- `npm run build` does **not** run migrations. Production migration is a separate owner-plane control.
- Generic Production migrator is retired/fail-closed. Spent 0022/0023/0024 dispatch workflows are retired.

### Auth (do not reopen CP25G.3)

**Proven in Production:** email/password signup, session creation, secure cookies, authenticated `/app`, session persistence, sign-out, signed-out `/app` boundary, **returning email/password sign-in (CP26A.5)**.

**Backlog / deferred:** copied-cookie stale-session replay; password recovery; email verification.

### SaaS / guest / Ops

V1 journey: `account → hotel → service → preview → QR → plan → Stripe → LIVE`

- `/app/*` authenticated SaaS surface exists. First Production hotel **through `/app`** is proven **configured, not live** (`sbg-verify-a5`).
- Tenancy (`app_hotel_accounts`) exists structurally; verification policy is one user / one hotel.
- Stripe Connect / SBG subscription / hotel-owned guest payment **source** exists; Production Stripe configuration is absent.
- Resend confirmation-email **source** exists; Production Resend configuration is absent.
- Guest booking exists; canonical live demo is `/book/demo-kos`. Hotel-owned guest payment is not Production-proven.
- `/ops/*` remains isolated. Production Ops credentials are absent.
- `SBG_SAAS_COMMERCE=test` is process-global (CP26C blast-radius). Do not enable it on public Production until an authorised isolation strategy exists.

Read `BUILD_STATE.md` for the living status record. Restore from GitHub `main` at the current SHA, not from `cp17-known-good` (that tag is a historical CP16C/CP17 marker).

---

# Aether Transfer (historical README retained)

SCAN. BOOK. GO.

Private hotel transfers. Reconstruction of the lost implementation from
**CANONICAL PRIVATE TRANSFER APP — BUILD BLUEPRINT v2**.

This is not a visual prototype. PostgreSQL is authoritative for booking and
inventory integrity.

## Source of truth (historical CP17 wording — superseded above)

GitHub is authoritative for application source.

`cp17-known-good` (`45e171a23037b7c94005018cd2126033a449d6f0`) is an **immutable historical tag** for the CP16C/CP17 application baseline. It is **not** current `main`.

A Grok workspace is disposable and is never authoritative. Recovery ZIPs are
secondary disaster-recovery artifacts. The CP10 ZIP in `attachments/` is
historical and **must not** be extracted over a newer Git tree without explicit
human approval.

## Restore

See `RESTORE.md` (repo root) and `docs/RESTORE.md`. Clone the GitHub repository
and check out **current `main`**. Do not restore from a checkpoint ZIP unless Git
is unavailable and a human has approved that disaster-recovery path.

## Stack

TanStack Start, React, TypeScript, Tailwind v4, Outfit, Kysely, PostgreSQL /
PGLite, Neon in production.

## Historical Blueprint note

Blueprint v2 originally excluded payments. CP24/CP25 later layered Stripe
Connect and hotel-owned guest Checkout over the hardened base. Do not treat the
historical “do not add payments” line as current V1 scope. Do not add guest
accounts, RLS, hotel colour themes, Next.js, Prisma, or a standalone REST API.
