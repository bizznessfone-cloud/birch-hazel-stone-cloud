# RESTORE.md — reconstruct SCAN / BOOK / GO without this conversation

## Current accepted baseline (POST-CP25G.3)

GitHub is authoritative for application source. Living status: **`BUILD_STATE.md`**.

| Field | Value |
|---|---|
| Repository | `https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Current source SHA | `4c20e9b9574309a0edbeb03f8675febdef38dede` |
| CP25G.3 | **CLOSED** |
| Next numbered checkpoint | **UNDEFINED** — **Do not invent CP26.** |
| Production | Vercel `scan-book-go` / `dpl_5XnaxYcqkrgWucD54TKgbmvHkfy1` READY |
| Alias | `https://scan-book-go.vercel.app` |
| Migrations | `0001`–`0022` (applied on Production Neon) |

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
# at this alignment: 4c20e9b9574309a0edbeb03f8675febdef38dede
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

SQL migrations in `migrations/`, applied in filename order. Better Auth schema is in the migration surface (`0001_auth.sql` and later privilege repair `0022`).

Source tree includes `0001` through `0022`. Production Neon has been migrated through **0022**.

## 5. What migrations must run?

`0001_auth.sql`, `0002`–`0017` (foundation through CP16C), then:

- `0018_cp22_saas_onboarding.sql`
- `0019_cp23_public_hotel_slug.sql`
- `0020_cp24_stripe_billing.sql`
- `0021_cp25_hotel_guest_payments.sql`
- `0022_cp25g3_better_auth_runtime_privileges.sql`

Preview: `src/lib/db.ts` applies these to PGLite at startup, then SET ROLE `aether_runtime`.

Production: `scripts/migrate.mjs` uses `AETHER_DATABASE_OWNER_URL` **only**. Missing owner URL fails. `DATABASE_URL` is never a migrate fallback. Dedicated GitHub Actions owner-plane workflows exist; they are not automatic on push. The deployed app must connect as `aether_app` LOGIN.

## 6. Required environment variable names (never commit values)

See `.env.example`.

| Name | Production application plane | Secret |
|---|---|---|
| `DATABASE_URL` | yes — runtime `aether_app` | yes |
| `AETHER_DATABASE_OWNER_URL` | **no** — owner plane only, never Vercel | yes |
| `BETTER_AUTH_SECRET` | yes (CP25G.3) | yes |
| `BETTER_AUTH_URL` | yes | no (URL only) |
| Stripe / Resend / Ops | not currently configured on Production | yes when present |

## 7. Do not

- Do not extract the CP10 ZIP over current `main`.
- Do not reopen CP25G.3.
- Do not invent CP26.
- Do not add `AETHER_DATABASE_OWNER_URL` to Vercel.
- Do not run migrations during `npm run build`.
