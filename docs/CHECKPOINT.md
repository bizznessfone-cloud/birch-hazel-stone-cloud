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
| CP26C-O3.2 | **PASS** — source verified, **not applied** |
| **Next product checkpoint** | **CP26C-O3.2A** — 0026 Production apply controller, **BUILD ONLY** |
| Forward roadmap | **[ROADMAP.md](ROADMAP.md)** (CP26–CP31) |
| Commercial catalogue | **[COMMERCIAL_CATALOGUE.md](COMMERCIAL_CATALOGUE.md)** |
| Owner architecture | **[OWNER_CONTROL_PLANE.md](OWNER_CONTROL_PLANE.md)** |
| Fixture policy | **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)** |
| Production | Vercel `scan-book-go` last observed `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` READY |
| Migrations | source **0001–0026**; Production **0001–0025**; 0026 **unapplied**; Gate B accepted **0001–0025**; first-Owner workflow **RETIRED** |

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
