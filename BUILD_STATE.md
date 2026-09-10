# AETHER BUILD STATE

This file describes reality, not intended future state.

Current phase: **CP12B — Pre-Vercel production hardening**

Current checkpoint: **12b** (does not overwrite CP10, CP11, CP12, or CP12A)

Last known-good source checkpoint: **CP12A** (`2283746187e7fc4a98987775ac54c28037e06948`) before this work.

Current status: CP12 / CP12A source is in the tree. CP12B adds production fail-closed behaviour, owner-only migrations, `aether_runtime LOGIN`, public DTO/PII reduction, guest-create rate limiting, preview-credential refusal, and a capped shared `pg.Pool`.

Production status: **NOT PRODUCTION-READY** — Neon schema is **BLOCKED / UNVERIFIED** (credentials unavailable in this environment). Vercel is **NOT CONNECTED**.

Credential injection:

- `DATABASE_URL`: **MISSING**
- `AETHER_DATABASE_OWNER_URL`: **MISSING**
- No `.env` / secret mount / Neon connector with those names
- `npm run verify:neon` exits **2** (credentials unavailable) — not treated as a pass

Known blockers:

- Neon owner URL unavailable — 0012 / 0013 not applied or verified on Neon
- Neon `aether_runtime` LOGIN password must be set out of band (never in git)
- Vercel project not connected
- Neon concurrency: **NOT VERIFIED** on Neon (PGLite only)

Historical:

- CP10: occupancy + privilege split (PGLite)
- NEW CP11: Neon verifier (PASS historically with runner-only patch; this tree keeps the committed verifier, now without startup role options)
- CP12: multi-tenant hotel/provider foundation
- CP12A: resource ownership administration boundaries
- Previous abandoned original CP11: **not used**

Next safe action:

1. Inject two distinct Neon URLs (owner + `aether_runtime` LOGIN). Set the runtime role password out of band.
2. Apply pending migrations (0012, 0013) via owner URL only.
3. Re-run `npm run verify:neon`.
4. Do not connect Vercel until Neon verification PASSes.
5. Do not start CP13.

## What must not be claimed

PGLite results are **LOCAL VERIFIED** only. They are not Neon production verification. A local build is not Vercel readiness.
