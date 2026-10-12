# A3-M36 closeout and 0035/0036 production admission review

Date: 2026-10-12. Status: **A3-M36 CERTIFIED; PRODUCTION APPLY NOT AUTHORISED**.

## Immutable test evidence
- Workflow: https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/38217959320
- Checked-out commit: `3e04c6ae6c8d8fc6ab98a937face1ea91cf6838e`.
- Final harness verdict: `GATE PASS — 0036 DISPOSABLE CONCURRENCY VERIFIED`.
- PostgreSQL concurrency, rollback/isolation, creator uniqueness, effective agreement enforcement, runtime `aether_app` privileges and immutable-trigger checks passed.
- Disposable branch: `br-shiny-paper-b1y32upe`; endpoint `ep-hidden-paper-b1360qvy`. Fixture residue deliberately retained. Do not reuse as a clean test environment or delete automatically.
- The certification is **isolated PostgreSQL evidence**, not production migration authorisation or CP31 approval.

## Read-only production baseline, 2026-10-12
- Neon project `quiet-sound-53513710`; production branch `br-green-darkness-b1k7wkue`; database `neondb`.
- `_migrations` latest: `0034_cp3005e2d2c_founding_classification_acceptance.sql`.
- `0035` and `0036` ledger entries: **zero**.
- Organisations: **1**; duplicate founding creator groups: **0**; organisation acceptance rows: **0**.
- These are point-in-time read-only observations, not a lock on production state.
- Do not touch other Neon projects, production data, or recovery/shared branches during review.

## Source contracts
- `0035_cp3005e2d2d_founding_property.sql`: founding-property atomic function; empty approved agreement catalogue; no Terms seed.
- `0036_cp3005e2d2d_founding_integrity.sql`: creator unique index, effective approved-version uniqueness and enforcement; rejects duplicates rather than repairing them.
- Migration order **0035 then 0036**. Apply within an explicitly controlled database transaction only after independent authorisation.
- `terms-v1` is provisional and prohibited. No approved effective agreement or customer acceptance may be invented or seeded by migration tooling.
- Existing accepted ledger `0001–0034` is immutable history; `AUTHORISED_PENDING=[]` until a separately approved change.

## Admission controller — required implementation and verification before execution
1. **Source pin:** refuse any checkout except an explicitly reviewed commit; independently pin and verify both SQL file SHA-256 digests and exact expected migration names. Do not derive an allowlist from the working directory.
2. **Target pin:** require explicit production project, branch and **direct** endpoint identity; reject pooler, unexpected host, wrong project, missing or reused confirmation, and any connection to an unapproved database. Never log secrets.
3. **No implicit execution:** build, deploy, startup and generic migration scripts must not apply either file. A dedicated, single-use, manually dispatched workflow must require a specific human confirmation and approved authorisation record.
4. **Read-only preflight:** verify owner role, database identity, ledger exactly `0001–0034`, no 0035/0036 rows, no duplicate creator groups, relevant schema/privileges and absence of incompatible objects. Fail closed on any drift.
5. **Atomic admission:** execute both immutable SQL files in order and record both migration entries in the **same transaction**, with bounded timeouts and a migration lock. Roll back completely on any error. Do not disable triggers, relax grants, or repair user data.
6. **Post-commit verification:** check ledger, indexes, effective-version count (zero unless separately approved), creator uniqueness, function privileges, trigger enablement and application-role restrictions. Record redacted structured PASS/BLOCKED output.
7. **Failure handling:** if post-commit verification fails, **STOP and escalate**. Do not auto-rollback by destructive SQL or blindly rerun an applied migration.
8. **Scope exclusion:** no legal Terms seeding, no acceptance writing, no hotel/property creation, no Stripe calls, no commerce mode change, no CP31.
9. **Workflow retirement:** retire the single-use apply workflow after an independently verified successful admission; preserve audit evidence and update `BUILD_STATE.md`.

## Decision
**CONDITIONAL ADMISSION — NOT READY TO APPLY.** The isolated concurrency test is certified and the read-only production preflight passes. A dedicated controller, code review, isolated dry run, legal-agreement decision, and explicit separate production execution authorisation remain outstanding. Production migrations **0035 and 0036 remain unapplied**.
