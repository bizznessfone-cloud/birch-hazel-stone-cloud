# Current checkpoint pointer

Living status: **`BUILD_STATE.md`** (repo root).

| Field | Value |
|---|---|
| Last application SHA | Verification baseline `30173015216ca638a7d63736205fe20be11d3880` (CP28.2C temporary workflow retired). This documentation commit does not change application source. `19512c2` is the last *observed* deployment identity in the Production row below, not current `main` |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| CP26B.1 | **PASS** |
| CP26B.2 | **SOURCE COMPLETE then APPLIED via CP26B.3** |
| CP26B.3 | **CLOSED** |
| CP26B.4 | **PASS** |
| **CP26B** | **CLOSED** |
| CP26C.1 | **PASS** |
| CP26C.2 | **PASS** |
| CP26C.3 | **PAUSED AFTER SAFE PREFLIGHT** |
| CP26C-O1 | **PASS** |
| CP26C-O2 | **CLOSED** — Production-proven |
| CP26C-O2A | **PASS** — single-use 0025 controller |
| CP26C-O2B | **PASS** — Production 0025 applied |
| CP26C-O2C.1 | **PASS** — first-Owner bootstrap controller built |
| CP26C-O2C.2 | **PASS** — first Owner bootstrapped (GHA 36116463589) |
| CP26C-O2C.3 | **PASS** — bootstrap workflow retired |
| CP26C-O3.1 | **PASS** — commercial catalogue contract |
| CP26C-O3.2 | **PASS** — source verified, then Production-applied in O3.2B |
| CP26C-O3.2A | **PASS** — controller built; dispatch **RETIRED** in O3.2C |
| CP26C-O3.2B | **PASS** — Production 0026 applied (GHA 36135836457) |
| CP26C-O3.2C | **PASS** — Gate B **0001–0026**; 0026 workflow retired |
| CP26C-O3.3 | **PASS** — Owner commercial catalogue UI; amounts still **UNDEFINED** |
| CP26C-O2D | **PASS** — `/owner/login` isolated from hotel `/login`; no migration |
| CP26C-O3.3V | **PASS** — operator Production `/owner/plans` verification; no price created |
| CP26C-O3R | **PASS** — property-licence model reconciled; no implementation ([`COMMERCIAL_MODEL.md`](COMMERCIAL_MODEL.md)) |
| CP26 FINALISATION | **PASS** — Production ledger **0001–0028**; dormant organisation property-licence cutover. Finalisation snapshot had commerce OFF. That is not the exit-gate state |
| CP26 STRIPE TEST | **PASS** |
| CP26 EXIT GATE | **PASS** — **CP26 COMPLETE** |
| **CP27** | **CLOSED** — security hardening. CP27.3a `7fb6817`, CP27.3b `9972964`, CP27.3c `b8b04e7`. Read-only CP27.3 closure **PASS** on `b8b04e7`. No migration 0031 |
| CP28.2 | **VERIFIED** — local `npm run test:aether`, typecheck, and build. Not a Neon proof |
| CP28.2B | **BLOCKED** — Production fixture/cleanup privilege boundary, not an occupancy defect. Not re-run on Production |
| CP28.2C | **VERIFIED** — disposable Neon only. Project `quiet-sound-53513710`, branch `cp28-2c-race-gate` / `br-icy-shadow-b1fh96gk`. Not Production `br-green-darkness-b1k7wkue`. GHA [37031757779](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37031757779) at `55b7e19`. Workflow retired by `3017301` |
| CP28.3 | **VERIFIED WITH COVERAGE LIMIT** — product tests 628/628 plus typecheck and build. Guest engine, idempotency, token privacy, Ops handoff, tenancy, assignment, overlap, cancel/reuse on throwaway PGLite. Browser shells only. See [`BUILD_STATE.md`](../BUILD_STATE.md) |
| **CP28** | **CLOSED** |
| CP29.2 | **CLOSED** — disposable load gate. GHA [37103649966](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37103649966). Not Production |
| CP29.3 | **PASS** — capacity measurement on the disposable branch. GHA [37105141618](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37105141618). No optimisation. No schema change |
| CP29.4 | **Measurement completed, then blocked** — function region `iad1`. Transport and in-function `SELECT 1` were not proven in CP29.4. CP29.4A later proved them |
| CP29.4A | **PASS** — Production transport **pooler**, Neon **eu-central-1**, branch `br-green-darkness-b1k7wkue`, warm `SELECT 1` p50 **93.429 ms**. Diagnostic removed. Not a booking SLA |
| **CP29** | **CLOSED**. CP30.2A and CP30.2B later passed. CP30 is not closed |
| CP30.2A | **PASS** — observability architecture only. Not an implementation |
| CP30.2B | **PASS** — `GET /api/ready` implemented. `200 {"ok":true}` or `503 {"ok":false}`. One `select 1`. No topology. External monitors **not configured**. Ops Agent **not built** |
| **Next product checkpoint** | **CP30.2C — NOT STARTED**. Not Production launch. Not LIVE commerce. Only **CP31** activates LIVE commerce |
| Forward roadmap | **[ROADMAP.md](ROADMAP.md)** (CP26–CP31) |
| Commercial catalogue | **[COMMERCIAL_CATALOGUE.md](COMMERCIAL_CATALOGUE.md)** |
| Owner architecture | **[OWNER_CONTROL_PLANE.md](OWNER_CONTROL_PLANE.md)** |
| Fixture policy | **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)** |
| Production | Vercel `scan-book-go` function region `iad1`. CP29.4A measurement deployment `dpl_HyanFe1gVVusyKvTsUe7zf6muNdN` at `f1d5bbe` was temporary and must not be promoted. Alias `https://scan-book-go.vercel.app`. `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` at `19512c2` is the older CP28 observation. This documentation commit auto-deploys. That is not an environment change and not a commerce-mode change |
| Migrations | Production and Gate B **0001–0030**; `AUTHORISED_PENDING=[]`; no 0031. 0030 digest `9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f` applied (GHA 36448160139); temporary apply workflow **RETIRED**. 0029 digest `e5897eda1a4f3c8c4025e16235b9d11a677b3cc7994934058142934d4dea7adc` applied (GHA 36404482927). Guest payment source exists (`sbg_prepare_booking_payment`, then hotel-owned Checkout). CP28 created no Stripe object and wrote no Production booking payment. Booking payments were **0** at the 0030 checkpoint and were not mutated by CP28. Documented Production `SBG_SAAS_COMMERCE` remains **test**, not live. `SBG_DOMAIN_B_LIVE_CHECKOUT` is not enabled |

This file’s remainder is a **historical Checkpoint 10** record only.

---

# HISTORICAL RECORD — Checkpoint 10 only

This section is **not** the current project state.

`cp17-known-good` (`45e171a23037b7c94005018cd2126033a449d6f0`) is an immutable
historical CP16C/CP17 tag. Current `main` is newer.

Do **not** extract the CP10 recovery ZIP over a newer Git tree without explicit
human approval. Recovery ZIPs are secondary disaster-recovery artifacts. A
workspace is never authoritative.

---

Aether Transfer
Checkpoint 10 (historical)
Phase production-hardening
Date 2026-09-05
Test status: PASS: 101 aether tests, typecheck, production build. NEON ROLE SPLIT BLOCKED. NEON CONCURRENCY NOT VERIFIED.
Complete restorable project snapshot from that date. Do not treat this card as current source.
Contains no secrets.
