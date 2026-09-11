# AETHER BUILD STATE

This file describes reality, not intended future state.

Current phase: **CP13A — SQL-created production application role (source only)**

Current checkpoint: **13a** (does not overwrite CP10, CP11, CP12, CP12A, or CP12B)

Last known-good committed checkpoint: **CP12B** (`e3a7caf7ca32fe5326dbf9e89785215643ac7bd2`) before this work.

Current status: CP13A adds SQL-created production LOGIN `aether_app` (0014). `aether_runtime` remains the PGLite/preview SET ROLE identity. 0011–0013 are immutable. This is source-only: Neon has not been contacted.

Production status: **NOT PRODUCTION-READY** — Neon schema is **BLOCKED / UNVERIFIED** (credentials unavailable in this environment). Vercel is **NOT CONNECTED**.

Credential injection:

- `DATABASE_URL`: **MISSING** (must be `aether_app` LOGIN when present)
- `AETHER_DATABASE_OWNER_URL`: **MISSING** (must be `neondb_owner` / schema owner)
- No `.env` / secret mount / Neon connector with those names
- `npm run verify:neon` exits **2** (credentials unavailable) — not treated as a pass

Known blockers:

- Neon owner URL unavailable — 0012 / 0013 / 0014 not applied or verified on Neon
- Neon `aether_app` LOGIN password must be set out of band (never in git). Do not create `aether_app` via Neon Console (that grants `neon_superuser`).
- Existing Neon Console `aether_runtime` is unsuitable as the production login
- Vercel project not connected
- Neon concurrency: **NOT VERIFIED** on Neon (PGLite only)

Historical:

- CP10: occupancy + privilege split (PGLite)
- NEW CP11: Neon verifier (PASS historically with runner-only patch; this tree keeps the committed verifier, now without startup role options)
- CP12: multi-tenant hotel/provider foundation
- CP12A: resource ownership administration boundaries
- CP12B: pre-Vercel production hardening (`aether_runtime LOGIN` for the then-intended production identity)
- Previous abandoned original CP11: **not used**

Next safe action:

1. Do **not** start CP13B until this source checkpoint is accepted.
2. Inject two distinct Neon URLs (owner + SQL-created `aether_app` LOGIN). Set the `aether_app` password out of band. Never create `aether_app` in Neon Console.
3. Apply pending migrations (0012, 0013, 0014) via owner URL only.
4. Re-run `npm run verify:neon`.
5. Do not connect Vercel until Neon verification PASSes.

## What must not be claimed

PGLite results are **LOCAL VERIFIED** only. They are not Neon production verification. A local build is not Vercel readiness.
