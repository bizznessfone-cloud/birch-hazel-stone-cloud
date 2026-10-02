# Current checkpoint pointer

Living status: **`BUILD_STATE.md`** (repo root).

| Field | Value |
|---|---|
| Last application SHA | 19512c295830fbc6fd9712d688ce364d940f87c3 (CP26B.3R; Production 0024 applied) |
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
| **Next product checkpoint** | **CP27.3c** — guest booking XFF limiter only. CP27.3b is in source. Checkout calls 0029. `SBG_DOMAIN_B_LIVE_CHECKOUT` is not enabled. Only **CP31** activates LIVE commerce |
| Forward roadmap | **[ROADMAP.md](ROADMAP.md)** (CP26–CP31) |
| Commercial catalogue | **[COMMERCIAL_CATALOGUE.md](COMMERCIAL_CATALOGUE.md)** |
| Owner architecture | **[OWNER_CONTROL_PLANE.md](OWNER_CONTROL_PLANE.md)** |
| Fixture policy | **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)** |
| Production | Vercel `scan-book-go` last observed `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` READY |
| Migrations | Production and Gate B **0001–0030**; `AUTHORISED_PENDING=[]`; 0030 digest `9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f` applied (GHA 36448160139); temporary apply workflow **RETIRED**; 0029 digest `e5897eda1a4f3c8c4025e16235b9d11a677b3cc7994934058142934d4dea7adc` applied (GHA 36404482927); claim table empty; checkout not integrated; booking payments 0; commerce **test** |

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
