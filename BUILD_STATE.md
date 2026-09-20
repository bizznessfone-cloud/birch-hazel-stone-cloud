# BUILD STATE — living record

This file describes **current reality**, not intended future state.

## Current accepted baseline (POST-CP25G.3)

| Field | Value |
|---|---|
| Product | **SCAN / BOOK / GO** (internal history name: Aether Transfer) |
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Current source SHA | `91ba2c15c6f3b5b11106ebc006e433515e1f0f86` (docs/roadmap on `main`; application baseline `4c20e9b…`) |
| CP25G.3 | **CLOSED** |
| **Next execution checkpoint** | **CP26A — COMMERCIAL DORMANCY + SAAS TENANT FOUNDATION** |
| Forward roadmap | **[docs/ROADMAP.md](docs/ROADMAP.md)** (CP26–CP31) |

### Production

| Field | Value |
|---|---|
| Vercel project | `scan-book-go` |
| Deployment | `dpl_5XnaxYcqkrgWucD54TKgbmvHkfy1` |
| State | READY |
| Alias | `https://scan-book-go.vercel.app` |
| Deployed SHA | `4c20e9b9574309a0edbeb03f8675febdef38dede` |

Environment (names/presence only):

| Variable | Production |
|---|---|
| `DATABASE_URL` | PRESENT (`aether_app` runtime LOGIN) |
| `AETHER_DATABASE_OWNER_URL` | ABSENT |
| `BETTER_AUTH_SECRET` | PRESENT |
| `BETTER_AUTH_URL` | PRESENT |
| Stripe / Resend / Ops credentials | ABSENT unless separately proven |

### Database

| Layer | State |
|---|---|
| Source migrations | `0001`–`0022` present |
| Production Neon | migrated through **0022** |
| 0022 | Better Auth runtime DML restored for `aether_app` |
| Runtime | `DATABASE_URL` → `aether_app` |
| Owner / migration plane | `AETHER_DATABASE_OWNER_URL` → `neondb_owner` (not on Vercel) |
| Preview | PGLite; `aether_runtime` SET ROLE only |
| Application build | `npm run build` does **not** migrate |

Roles: `neondb_owner` = schema/migration owner; `aether_app` = production LOGIN; `aether_runtime` = PGLite/preview only. Production must not use SET ROLE or owner credentials as runtime.

### Auth (CP25G.3 CLOSED — do not reopen)

**Proven:** email/password signup; session creation; secure Production cookies (`__Host-`, HttpOnly, Secure, SameSite=Lax); authenticated `/app`; session persistence; sign-out; signed-out `/app` → `/login`.

**Implemented, not Production-proven:** returning email/password sign-in POST; authenticated tenant runtime.

**Backlog / deferred:** copied-cookie stale-session replay; password recovery; email verification.

### SaaS operator journey

```
account → hotel → service → preview → QR → plan → Stripe → LIVE
```

- `/app/*` exists and is authentication-gated.
- Onboarding source exists. First Production hotel created **through `/app`** is **not** proven.
- Tenancy exists structurally (`app_hotel_accounts`). Authenticated Production tenant runtime remains unproven.
- Stripe Connect / SBG subscription / hotel-owned guest Checkout **source** exists. Production Stripe configuration is absent.
- Resend confirmation-email **source** exists. Production Resend is absent.

### Guest / Ops

- Guest booking exists. `demo-kos` has Production evidence.
- Hotel-owned guest payment source exists; not Production-proven.
- `/ops/*` remains isolated from SaaS `/app/*`. Production Ops credentials are absent.

### What must not be claimed

- Do not claim CP17/CP19 is current.
- Do not claim CP22 is next or CP24 is current.
- Do not claim Neon is unproven or Vercel is disconnected.
- Do not claim migrations after 0017 are absent.
- Do not claim `/app/*` does not exist.
- Do not claim CP25G.3 remains open.
- Do not treat CP26 as commercial go-live. Only CP31 activates commerce.
- Do not skip CP26A before Stripe test-mode integration.

Canonical forward path: **`docs/ROADMAP.md`**. Next execution: **CP26A**.

GitHub `main` at the current SHA is authoritative application source. A workspace is never authoritative. Recovery ZIPs are secondary disaster-recovery artifacts. The CP10 ZIP must not be extracted over a newer Git tree without explicit human approval.

---

## Historical (not current)

- `cp17-known-good` / `45e171a23037b7c94005018cd2126033a449d6f0` — immutable CP16C/CP17 source tag. Not current `main`.
- CP10 occupancy ZIP — historical disaster-recovery artifact only.
- CP19 originally meant Neon binding/verification. That work completed in later controlled production checkpoints; do not treat the old “CP19 unfinished” wording as living state.
- CP22–CP25 / CP25G.3 source and production work happened after CP17. See `docs/CP22_V1_OPERATOR_ONBOARDING.md`, `docs/CP23_PUBLIC_HOTEL_SLUG.md`, `docs/CP24_STRIPE_BILLING.md` as **completed checkpoint specifications**, not as the next task.
