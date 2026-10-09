## CURRENT ACCEPTED BASELINE (CP26 CLOSED)

Living source-of-truth. Historical README text below is evidence only.

| Field | Value |
|---|---|
| Product | **SCAN / BOOK / GO** (internal history name: Aether Transfer) |
| Repository | [`bizznessfone-cloud/birch-hazel-stone-cloud`](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud) |
| Branch | `main` |
| Last application SHA | CP26B.3R `19512c295830fbc6fd9712d688ce364d940f87c3` is historical, not current `main` |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| **CP26B** | **CLOSED** |
| **CP26** | **COMPLETE** — finalisation, Stripe TEST, and exit gate **PASS** |
| **Next execution checkpoint** | **Not CP27.4.** CP27.3c guest booking client-IP trust is in source. Commerce remains **test**, not live. Only **CP31** activates LIVE commerce |
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
- `SBG_SAAS_COMMERCE` — PRESENT, plain `test` (not live)
- `BETTER_AUTH_SECRET` — PRESENT
- `BETTER_AUTH_URL` — PRESENT
- `STRIPE_SECRET_KEY` — PRESENT sensitive (value not recorded)
- `STRIPE_WEBHOOK_SECRET` — PRESENT sensitive (value not recorded)
- `SBG_SAAS_TEST_ORGANISATION_IDS` — PRESENT sensitive (value not recorded)
- Resend / Ops credentials — not recorded as present

### Database

- Production Neon and Gate B accepted ledger are **0001–0033**. `AUTHORISED_PENDING=[]`. 0033 (`sbg_ensure_founding_organisation`, digest `8880dbf93aa416e393af621957e3170da6390a6e3aef792d68fe97b709c22875`) is applied (GHA 37893184406). Neon concurrency proof is GHA 37893386159 (three direct backends; disposable marker rows removed). The temporary apply workflow is **RETIRED**. Do not rerun `scripts/cp3005e2d2b1-0033-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0032**. 0032 (`sbg_organisation_acceptances`, digest `c3412d2b6efc05786ea3edf1146da25853b88ac0df69b1ce215240be0c72ab48`) is applied (GHA 37333642947). The temporary apply workflow is **RETIRED**. Do not rerun `scripts/cp3005e2c1-0032-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0031**. No acceptance row was written. 0031 (`sbg_organisations.organisation_type`, digest `be0921b852dda7904863f34bc1160fab844b2aaf0821423f6863c91b71b592b6`) remains applied (GHA 37279300118). Do not rerun `scripts/cp3005e2c-0031-production-migrate.mjs`. NULL means unclassified; the existing organisation was not backfilled. 0030 (`sbg_prepare_booking_payment(text)`, digest `9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f`) remains applied (GHA 36448160139). Do not rerun `scripts/cp272-0030-production-migrate.mjs`. 0029 claim table is installed. Checkout calls it. Booking payments were 0 and were not mutated by the M5–M8 application remediation. `SBG_DOMAIN_B_LIVE_CHECKOUT` is not enabled. Commerce **test**, not live. 0034+ stays fail-closed for Production apply.
- 0028 property-licence catalogue (`property_licence` active; basic/pro/premium inactive; one price version EUR 17900 month `b13f9445-d27a-4e7d-8128-a2238906ce7c`; one verified TEST mapping `price_1UKGWjFHnHXHuPOwO50TJS93`; no LIVE mapping; locks false/false; digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d`; apply run 36254890554; workflow retired)
- 0027 organisation property-licence persistence (digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef`; apply run 36251190175; workflow retired; one TEST organisation; licensed 3; active allocations 0)
- 0026 commercial catalogue (digest `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446`; apply run 36135836457; workflow retired)
- 0025 platform owners (`sbg_platform_owners`; digest `575aabcb7322fc8ca63c8a3dd137d358f76375f1777ed59cf04c1d98d6c066fd`); one Production Owner bootstrapped; 0025 dispatch workflow **RETIRED**; bootstrap workflow retired
- 0024 ordered Domain A billing events (`sbg_apply_billing_event` 10-argument; digest `23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0`)
- 0023 decoupled `sbg_sync_hotel_entitlement` from hotel publication
- `neondb_owner` = migration/schema owner; `aether_app` = production LOGIN; `aether_runtime` = PGLite/preview SET ROLE only
- `npm run build` does **not** run migrations. Production migration is a separate owner-plane control.
- Generic Production migrator is retired/fail-closed and never applies SQL. Spent 0022/0023/0024/0025/0026/0027/0028 dispatch workflows are retired. Permanent read-only Gate B remains.

### Auth (do not reopen CP25G.3)

**Proven in Production:** email/password signup, session creation, secure cookies, authenticated `/app`, session persistence, sign-out, signed-out `/app` boundary, **returning email/password sign-in (CP26A.5)**, **password recovery (CP30.05E-2D-1)** — one controlled `scanbookgo.com` reset was delivered to Gmail and completed. Dual already-open sessions were not repeated live; E-2D-1D’s automated two-session proof covers immediate revocation.

**Backlog / deferred:** email verification.

### SaaS / guest / Ops

V1 journey: `account → hotel → service → preview → QR → plan → Stripe → LIVE`

- `/app/*` authenticated SaaS surface exists. First Production hotel **through `/app`** is proven **configured, not live** (`sbg-verify-a5`).
- Tenancy (`app_hotel_accounts`) exists structurally. Current commercial canon is one organisation and many real hotel properties (`docs/COMMERCIAL_MODEL.md`). The older “one user / one hotel” sentence is historical verification policy, not a schema limit.
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
