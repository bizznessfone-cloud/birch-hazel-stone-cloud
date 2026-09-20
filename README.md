## CURRENT ACCEPTED BASELINE (POST-CP25G.3)

Living source-of-truth. Historical README text below is evidence only.

| Field | Value |
|---|---|
| Product | **SCAN / BOOK / GO** (internal history name: Aether Transfer) |
| Repository | [`bizznessfone-cloud/birch-hazel-stone-cloud`](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud) |
| Branch | `main` |
| Current source SHA | `91ba2c15c6f3b5b11106ebc006e433515e1f0f86` |
| CP25G.3 | **CLOSED** |
| **Next execution checkpoint** | **CP26A — COMMERCIAL DORMANCY + SAAS TENANT FOUNDATION** |
| Forward roadmap | **[docs/ROADMAP.md](docs/ROADMAP.md)** |

CP26 builds/tests SBG SaaS subscriptions. **CP26 is not go-live.** Only **CP31** may activate real commerce.

### Production

| Field | Value |
|---|---|
| Vercel project | `scan-book-go` |
| Deployment | `dpl_5XnaxYcqkrgWucD54TKgbmvHkfy1` |
| State | READY |
| Alias | `https://scan-book-go.vercel.app` |
| Deployed SHA | same as source SHA above |

Environment (names/presence only; never secret values):

- `DATABASE_URL` — PRESENT (production runtime `aether_app`)
- `AETHER_DATABASE_OWNER_URL` — ABSENT from Vercel
- `BETTER_AUTH_SECRET` — PRESENT
- `BETTER_AUTH_URL` — PRESENT
- Stripe / Resend / Ops credentials — not present on the application plane unless separately proven

### Database

- Source and Production Neon migrations: **0001–0022**
- 0022 restored Better Auth runtime DML for `aether_app`
- `neondb_owner` = migration/schema owner; `aether_app` = production LOGIN; `aether_runtime` = PGLite/preview SET ROLE only
- `npm run build` does **not** run migrations. Production migration is a separate owner-plane control.

### Auth (do not reopen CP25G.3)

**Proven in Production:** email/password signup, session creation, secure cookies, authenticated `/app`, session persistence, sign-out, signed-out `/app` boundary.

**Implemented, not Production-proven:** returning email/password sign-in POST; authenticated tenant runtime.

**Backlog / deferred:** copied-cookie stale-session replay; password recovery; email verification.

### SaaS / guest / Ops

V1 journey: `account → hotel → service → preview → QR → plan → Stripe → LIVE`

- `/app/*` authenticated SaaS surface exists. First Production hotel **through `/app`** is not yet proven.
- Tenancy (`app_hotel_accounts`) exists structurally; authenticated Production tenant runtime is unproven.
- Stripe Connect / SBG subscription / hotel-owned guest payment **source** exists; Production Stripe configuration is absent.
- Resend confirmation-email **source** exists; Production Resend configuration is absent.
- Guest booking exists; `demo-kos` has Production evidence. Hotel-owned guest payment is not Production-proven.
- `/ops/*` remains isolated. Production Ops credentials are absent.

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
and check out **current `main`** (`4c20e9b9574309a0edbeb03f8675febdef38dede`
at the time of this alignment). Do not restore from a checkpoint ZIP unless Git
is unavailable and a human has approved that disaster-recovery path.

## Stack

TanStack Start, React, TypeScript, Tailwind v4, Outfit, Kysely, PostgreSQL /
PGLite, Neon in production.

## Historical Blueprint note

Blueprint v2 originally excluded payments. CP24/CP25 later layered Stripe
Connect and hotel-owned guest Checkout over the hardened base. Do not treat the
historical “do not add payments” line as current V1 scope. Do not add guest
accounts, RLS, hotel colour themes, Next.js, Prisma, or a standalone REST API.
