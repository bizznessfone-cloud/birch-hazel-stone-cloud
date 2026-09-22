# RESTORE.md — reconstruct SCAN / BOOK / GO without this conversation

## Current accepted baseline (POST-CP26B CLOSED)

GitHub is authoritative for application source. Living status: **`BUILD_STATE.md`**.

| Field | Value |
|---|---|
| Repository | `https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | `19512c295830fbc6fd9712d688ce364d940f87c3` |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| **CP26B** | **CLOSED** |
| **Next execution checkpoint** | **CP26C — Stripe test-mode integration (design/preflight; not started)** |
| Forward roadmap | **`docs/ROADMAP.md`** |
| Fixture policy | **`docs/FIXTURE_POLICY.md`** |
| Production | Vercel `scan-book-go` / last observed `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` READY |
| Alias | `https://scan-book-go.vercel.app` |
| Migrations | `0001`–`0024` (applied on Production Neon)

`cp17-known-good` (`45e171a23037b7c94005018cd2126033a449d6f0`) is an **immutable historical tag**. It is **not** current `main`. Checking it out would roll the product backwards.

Recovery ZIPs are **secondary disaster-recovery artifacts**. The CP10 ZIP **MUST NOT** be extracted over a newer Git tree without explicit human approval.

A Grok workspace is disposable and is never authoritative.

### Source of truth order

1. GitHub repository + exact current `main` SHA
2. Living `BUILD_STATE.md`
3. Historical tag `cp17-known-good` (CP16C/CP17 only)
4. Recovery ZIP — secondary disaster-recovery artifact only
5. Grok workspace — disposable working environment
6. Chat — context, not source

## 1. What is SCAN / BOOK / GO?

Guest-first hotel transfer service (internal history name: Aether Transfer).

Primary guest journey:

```
HOTEL QR
      ↓
PUBLIC HOTEL PAGE  (/{hotelSlug} or legacy /book/{hotelCode})
      ↓
SELECT TRANSFER
      ↓
ENTER DETAILS
      ↓
BOOK
      ↓
CONFIRMATION  (/confirmed/{token})
      ↓
DONE
```

SaaS operators use `/app/*`. Reception / ops (`/ops`) is a separate internal desk.

Guest lockup: **SCAN. BOOK. GO.**

## 2. Architecture

- TanStack Start + React + TypeScript + Tailwind v4
- PostgreSQL is the system of record
- Preview/dev database: PGLite with `btree_gist` — development substitute only
- Production database: Neon PostgreSQL
- Occupancy: trigger-maintained `occupies` + `tstzrange [)` + vehicle/driver GiST EXCLUDE
- SaaS auth: Better Auth email/password (`/login`, `/api/auth/*`)
- Ops auth: scrypt + HttpOnly session `aether_ops_session` (separate domain)
- Roles:
  - `neondb_owner` — migration / schema owner
  - `aether_runtime` — PGLite/preview SET ROLE identity
  - `aether_app` — production LOGIN
- Migrations use a separate owner connection: `AETHER_DATABASE_OWNER_URL` (never on Vercel)
- `npm run build` does **not** run migrations

Authoritative living status: `BUILD_STATE.md`. Architecture notes: `docs/ARCHITECTURE.md`

## 3. Where is the source?

**GitHub**, not the workspace disk and not a ZIP.

```
git clone https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud.git
cd birch-hazel-stone-cloud
git checkout main
# last application SHA: 19512c295830fbc6fd9712d688ce364d940f87c3
```

Do **not** default to `git checkout cp17-known-good`.

Application code (once checked out):

- `src/lib/aether/` — domain
- `src/routes/app*.tsx` — SaaS operator surface
- `src/routes/$hotelSlug.tsx` — public hotel page
- `src/routes/book.$hotelCode.tsx` — legacy guest booking
- `src/routes/confirmed.$token.tsx` — confirmation
- `src/routes/ops*.tsx` — operations desk
- `src/lib/db.ts` — PGLite preview SET ROLE `aether_runtime` / Neon runtime (`aether_app` LOGIN; no production SET ROLE)

## 4. Where is the database schema?

SQL migrations in `migrations/`, applied in filename order. Better Auth schema is in the migration surface (`0001_auth.sql` and later privilege repair `0022`). Entitlement publication decoupling is `0023`. Ordered Domain A billing events are `0024`.

Source tree includes `0001` through `0024`. Production Neon has been migrated through **0024**.

## 5. What migrations must run?

`0001_auth.sql`, `0002`–`0017` (foundation through CP16C), then:

- `0018_cp22_saas_onboarding.sql`
- `0019_cp23_public_hotel_slug.sql`
- `0020_cp24_stripe_billing.sql`
- `0021_cp25_hotel_guest_payments.sql`
- `0022_cp25g3_better_auth_runtime_privileges.sql`
- `0023_cp26a2_entitlement_publication_decoupling.sql`
- `0024_cp26b2_ordered_billing_events.sql`

Preview: `src/lib/db.ts` applies these to PGLite at startup, then SET ROLE `aether_runtime`.

Production: `scripts/migrate.mjs` uses `AETHER_DATABASE_OWNER_URL` **only**. Missing owner URL fails. `DATABASE_URL` is never a migrate fallback. The generic production-migrate GitHub Action is retired and fail-closed. Permanent owner-plane control is read-only Gate B (`production-database.yml`). Future SQL needs a dedicated single-use controller and an explicit checkpoint. The deployed app must connect as `aether_app` LOGIN.

## 6. Required environment variable names (never commit values)

See `.env.example`.

| Name | Production application plane | Secret |
|---|---|---|
| `DATABASE_URL` | yes — runtime `aether_app` | yes |
| `AETHER_DATABASE_OWNER_URL` | **no** — owner plane only, never Vercel | yes |
| `BETTER_AUTH_SECRET` | yes (CP25G.3) | yes |
| `BETTER_AUTH_URL` | yes | no (URL only) |
| `SBG_SAAS_COMMERCE` | optional — unset = Domain A fail-closed | no |

## 7. Do not

- Do not extract the CP10 ZIP over current `main`.
- Do not reopen CP25G.3 or CP26A.
- Do not treat CP26 as go-live. Only CP31 activates commerce.
- Next execution is **CP26C**. See `docs/ROADMAP.md` and `docs/FIXTURE_POLICY.md`.
- Do not add `AETHER_DATABASE_OWNER_URL` to Vercel.
- Do not run migrations during `npm run build`.
- Do not dispatch retired 0022/0023/0024 production-migrate workflows.
- Do not mutate or delete the Production verification tenant (`sbg-verify-a5`) unless a later checkpoint explicitly authorises it.
- Do not set `SBG_SAAS_COMMERCE=test` on public Production until CP26C establishes an authorised isolation strategy.
