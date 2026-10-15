# A3 — narrowly scoped activation change (PREPARATION ONLY)

Status: **NOT AUTHORISED FOR MERGE, WORKFLOW ACTIVATION OR PRODUCTION EXECUTION**.

## Source boundary

Do **not** merge draft PR #1 wholesale: it contains 34 changed paths and multiple unrelated rehearsal, archive, and documentation workflows.

Activation must be a separate, narrowly scoped change based on the then-current `main`, containing only:

1. `scripts/a3-0035-0036-production-admission.STAGED.mjs` — transactional executor.
2. `scripts/a3-0035-0036-production-admission-entry.STAGED.mjs` — explicit entrypoint.
3. `scripts/a3-0035-0036-production-admission.STAGED.test.mjs` — offline admission checks.
4. `.github/workflows/a3-0035-0036-production-admission.yml` — activated version of the inert template **only after separate user approval**.

Existing `main` dependencies to verify at activation: `scripts/production-db-preflight.mjs`, migrations 0035/0036 and their pinned SHA256 digests, `package.json`/`package-lock.json`, `pg` dependency. If any is absent or changed, STOP and reconcile explicitly; do not silently pull other PR #1 files.

## Owner-confirmed GitHub environment

`a3-production-0035-0036` exists; deployment branch restricted to `main`; Required reviewers OFF (sole-owner repository); Prevent self-review OFF. GitHub environment **does not provide an independent human approval gate**. Environment secret `A3_PRODUCTION_APPLY_OWNER_URL` is not yet configured.

## Fail-closed activation requirements

- Do not copy template into `.github/workflows/` until separately authorised.
- After the final activation workflow commit is on `main` and independently reviewed, record its full SHA in the restricted environment variable `A3_APPROVED_SOURCE_SHA`. Do not accept an expected SHA from workflow dispatch input.
- Require the dispatch commit SHA **and** checked-out SHA to equal `A3_APPROVED_SOURCE_SHA`. Missing or mismatched value fails closed. The variable must not be edited as part of dispatch.
- Require manual `workflow_dispatch`, exact confirmation, `main` restriction, GitHub environment and single-run concurrency.
- No scheduled/push/PR production-write triggers. No general-purpose `DATABASE_URL` fallback.
- Re-run offline tests on the exact activation commit; review all workflow permissions and credential exposure.
- Validate production backup availability and restore plan immediately before execution; previous backup expires 2026-10-21.
- Obtain **two separate explicit decisions**: (a) activate workflow and credentials; (b) dispatch production migrations 0035/0036. Neither has been granted.

## Immutable source pinning resolution (staged, unactivated)

The template now reads `A3_APPROVED_SOURCE_SHA` from the protected GitHub environment at run time. The approved SHA is set **after** the final workflow activation commit is created on `main`, resolving the circular dependency. The job rejects a missing or mismatched dispatch SHA before checkout and checks the checked-out SHA again. Since Required reviewers is disabled, environment variables are not independently protected against changes by the repository owner; this is a single-owner change-control measure, not independent authorisation.

## Production boundaries

No Neon writes, no migration application, no workflow activation, no PR merge, no Stripe LIVE and no CP31 under this preparation task.
