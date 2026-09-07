# AETHER BUILD STATE

This file describes reality, not intended future state.

Current phase: **NEW CP11 — Production Infrastructure — BLOCKED**

Current checkpoint: **11-BLOCKED** (does not overwrite CP10 or CP10A)

Last known-good checkpoint: **10** (trusted production-hardening baseline). **10A** is the persistence restore of CP10.

Current status: CP10 baseline intact. NEW CP11 stopped at the Neon credential gate.

Production status: **NOT PRODUCTION-READY**

Credential injection attempt (2026-09-06, this session):

- `DATABASE_URL`: **MISSING**
- `AETHER_DATABASE_OWNER_URL`: **MISSING**
- No `.env` / secret mount / Neon connector with those names
- Platform provisioner **not** used to inject them
- `npm run verify:neon` exit **2** (credentials unavailable)

Known blockers:

- `DATABASE_URL` unset
- `AETHER_DATABASE_OWNER_URL` unset
- Neon runtime-role split: **BLOCKED / UNVERIFIED**
- Neon concurrency: **NOT VERIFIED**
- Platform app provisioner (`init_or_update_app`) can replace this filesystem — **not called**

Previous abandoned CP11 used as implementation source: **NO**

Next safe action:

1. Inject two distinct Neon URLs into the process environment (not source, not git, not the zip): owner (`AETHER_DATABASE_OWNER_URL`) and `aether_runtime` LOGIN (`DATABASE_URL`).
2. Re-run `npm run verify:neon`.
3. Do not start CP11A until that gate PASSes.
4. Do not call the platform app provisioner.

## NEW CP11 work that did land (no UX / occupancy rewrite)

- `scripts/verify-neon-production.mjs` — fail-closed real Neon privilege + concurrency gate
- `npm run verify:neon`
- Secrets audit: no `.env` files, no committed connection strings
- Preview `desk` / `desk-pass` in `startup.sh` remain preview-only

## What must not be claimed

PGLite privilege/concurrency results from CP10 are **LOCAL VERIFIED** only. They are not Neon production verification.
