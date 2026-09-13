# AETHER BUILD STATE

This file describes reality, not intended future state.

## Source of truth

GitHub is authoritative for application source.

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Known-good application source | `45e171a23037b7c94005018cd2126033a449d6f0` |
| Tag | `cp17-known-good` |

`cp17-known-good` points at that commit and must not be moved. When the tag was
created, `main` pointed at it. Documentation-only commits may follow on `main`;
they do not change the application baseline.

A workspace is disposable and is never authoritative. Recovery ZIPs are
secondary disaster-recovery artifacts. The CP10 ZIP is historical and must not
be extracted over a newer Git tree without explicit human approval.

Source-code state and production database state are reported separately. Every
future production-readiness audit must name the exact Git commit audited. Do
not claim Neon production readiness merely because this repository is current.

## Current source baseline

Current source checkpoint: **CP16C/CP17** (`45e171a` / `cp17-known-good`)

Current phase: **source complete through CP17; CP19 Neon binding not completed**

Does not overwrite CP10, CP11, CP12, CP12A, CP12B, CP13A, or CP14–CP15.

Current status: source contains CP13A SQL-created production LOGIN `aether_app`
(0014), CP14 hotel configuration/timezone (0015–0016), CP15 hotel-scoped Ops
identity, CP16C privilege hardening (0017), and CP17 hotel-local Ops Today.
`aether_runtime` remains the PGLite/preview SET ROLE identity. 0011–0017 are
immutable. **This is source state, not Neon verification.**

Production status: **NOT PRODUCTION-READY** — Neon schema and `aether_app`
LOGIN on the production database are **BLOCKED / UNVERIFIED**. Vercel is
**NOT CONNECTED**.

**CP19** currently refers to production Neon binding/verification. It is **not**
yet a completed production checkpoint and is **not** a source-code commit.

## Source vs database

| Layer | State |
|---|---|
| Application source (GitHub) | CP16C/CP17 at `45e171a` / `cp17-known-good` |
| Migration files in git | `0002`–`0017` present; no `0018` |
| Preview (PGLite) | local development substitute |
| Production Neon | **UNVERIFIED** — not implied by source currency |
| Vercel | **NOT CONNECTED** |

Credential injection:

- `DATABASE_URL`: **MISSING** in this workspace (must be `aether_app` LOGIN when present)
- `AETHER_DATABASE_OWNER_URL`: **MISSING** (must be `neondb_owner` / schema owner)
- No `.env` / secret mount with those names
- `npm run verify:neon` exits **2** when credentials are unavailable — not a pass

Known blockers:

- Neon owner URL / runtime URL not bound in this workspace
- Neon application of 0012–0017 **UNVERIFIED**
- Neon `aether_app` LOGIN (`session_user` = `current_user`) **UNVERIFIED**
- Neon concurrency: **NOT VERIFIED** on Neon (PGLite only)
- Vercel project not connected

## Historical

- CP10: occupancy + privilege split (PGLite). Historical only. ZIP is not current source.
- NEW CP11: Neon verifier (historical runner evidence). Not current production proof.
- CP12: multi-tenant hotel/provider foundation
- CP12A: resource ownership administration boundaries
- CP12B: pre-Vercel production hardening
- CP13A: SQL-created production LOGIN `aether_app`
- CP14.x: hotel configuration, timezone, quote path, owner-only provisioning
- CP15: hotel-scoped Ops identity
- CP16C: runtime privilege hardening (0017)
- CP17: hotel-local Ops Today
- Previous abandoned original CP11: **not used**

## Next safe action

1. Do **not** extract the CP10 ZIP over this tree.
2. Do **not** treat CP19 as complete.
3. Bind production Neon (`DATABASE_URL` = `aether_app` LOGIN,
   `AETHER_DATABASE_OWNER_URL` = `neondb_owner`) as a separate infrastructure
   step. Never create `aether_app` in Neon Console.
4. Apply pending production migrations via owner URL only.
5. Re-run `npm run verify:neon`. A pass is the only Neon production evidence.
6. Do not connect Vercel until Neon verification PASSes.
7. Any production-readiness claim must name the exact Git commit audited.

## What must not be claimed

PGLite results are **LOCAL VERIFIED** only. They are not Neon production
verification. A current GitHub repository is not Neon readiness. A local build
is not Vercel readiness.
