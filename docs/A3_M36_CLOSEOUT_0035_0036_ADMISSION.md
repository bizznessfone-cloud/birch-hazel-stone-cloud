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

## 2026-10-13 executor draft review — NOT CERTIFIED
- Draft: `scripts/a3-0035-0036-production-admission-executor.DRAFT.mjs` (review branch only). Its unconditional `executor-not-certified-or-authorised` failure is a deliberate hard stop; **do not remove it as part of ordinary testing**.
- **Approval is not yet sufficient:** a static environment string is not an independently verified, single-use human authorisation record. Require a distinct, auditable production approval and immutable source commit before any executable controller is considered.
- **Post-commit verification is incomplete:** existing draft checks ledger count and two indexes but does not comprehensively verify exact migration names, enabled triggers, effective agreement constraints, function privileges or `aether_app` write restrictions. Fail closed on any missing check.
- **Role/target validation requires further hardening:** URL hostname, project/branch/endpoint environment labels and session identity must be cross-checked with a direct non-pooled endpoint; no inherited owner/runtime credentials or implicit fallbacks.
- **Commit ambiguity is intentionally escalated:** never automatically rerun after a COMMIT error or failed fresh-session verification. Require independent read-only inspection.
- **Test execution is outstanding:** attempts to create a dedicated draft test file through the connected GitHub write tool were blocked; no new draft-specific CI run or isolated rehearsal has occurred. Existing disposable rehearsal evidence does not certify this production draft.
- **Next admission decision:** only after the above controls, unit tests and isolated dry run are independently reviewed. No migration apply, legal Terms seed, customer acceptance, PR merge, or CP31 activation is authorised.

## 2026-10-13 disposable PostgreSQL permission verification
- Target explicitly selected: Neon project `quiet-sound-53513710`, disposable branch `br-square-queen-b13qgjqq`, database `neondb`; **not** production branch `br-green-darkness-b1k7wkue`.
- Read-only SQL inspection returned: ledger_count=36, security_definer_count=3, app_executable_count=3, public_executable_count=0, app_agreement_write=false, disabled_relevant_triggers=0.
- The inspected SQL matches the privilege and trigger inspection now in the inert executor draft. The results validate the SQL against an isolated real PostgreSQL schema; they do **not** constitute execution of the draft controller or production approval.
- Offline GitHub Actions runs for commit `e3e43b2e1f2ee941ed1d5adfe87fa11bfaa588f9` all passed: `38440701651`, `38440693363`, `38440693404`.
- Production application remains unauthorised; executor hard-stop remains mandatory. Next: independent review of complete controller and isolated end-to-end rehearsal before separate approval.

## 2026-10-13 subsequent regression and disposable-state evidence
- Review commits `6f1b288`, `bd6ab8d`, and `2cde20c` added transaction/fresh-session checks of index uniqueness, validity and readiness, plus an offline successful-commit controller test. An intermediate CI failure identified and corrected a duplicate-index-identity validation defect.
- Final offline CI for `2cde20cb8189a0c3e9f87efe7a8978c1d6e91323`: **PASS** in all three workflows: disposable controller `38441913448`, admission tests `38441906765`, admission controller `38441906716`.
- Read-only SQL on disposable Neon branch `br-square-queen-b13qgjqq` confirmed both required indexes `indisunique=true`, `indisvalid=true`, `indisready=true`; approved-agreement `effective` column is nonnullable boolean default false.
- Separate disposable SQL returned migration ledger 36, both 0035/0036 ledger entries, zero approved versions, zero acceptances and zero duplicate founding creators.
- **Scope of evidence:** offline successful-path controller test uses simulated connections; real Neon observations inspect previously applied disposable state. Neither constitutes a fresh live end-to-end execution of the revised production executor. The unconditional executor hard stop is still present.
- **Remaining gate:** independent review and a fresh disposable-only full transaction rehearsal, then a consolidated readiness decision. Independent, single-use production authorisation remains absent. Do not merge, apply to production or activate CP31.
