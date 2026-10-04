# V1 incident runbook

This is the only current Production incident procedure for a 1–5 hotel pilot.

It supersedes operational instructions in `RESTORE.md`, `docs/RESTORE.md`, `docs/MASTER_RECOVERY_PROTOCOL.md`, `docs/RECOVERY_MANIFEST.md`, and `AETHER_RECOVERY_MANIFEST.json`. Those files remain historical. Do not follow their SHA, deployment, migration-ceiling, or “next checkpoint” lines during an incident.

Living status stays in `BUILD_STATE.md`. This page is the procedure.

Reconfirm identity at incident time. The snapshot below is what was proven when this runbook was written. A later documentation commit may redeploy the same application. Do not roll back just because a deployment id on this page is no longer the alias.

## A. Production identity at CP30.3B start

Proven before this documentation commit. No application source change in that proof.

| Item | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Accepted baseline SHA | `cf0d5a3d7a2cc88033a7419704b3c0f8985836e5` |
| Production deployment | `dpl_DuJ9YevC2cNXRaymD7VVBZR6hhnV` READY, region `iad1` |
| Application | `https://scan-book-go.vercel.app/` |
| Readiness | `https://scan-book-go.vercel.app/api/ready` |
| Migrations | `0001`–`0030` |
| `AUTHORISED_PENDING` | `[]` |
| `0031` | Does not exist. Do not invent it |

At incident time, read `origin/main` and the Vercel deployment actually aliased to `scan-book-go.vercel.app`. Compare that SHA with the table. If they differ, identify what changed before choosing a recovery action.

Known older rollback candidate at establishment: `dpl_6xyTG1UATyVP94mfz1g1NrQbT2Qa` at `fa8cf08fa202b5ae15930f4d4b501613c5ced454`. It predates `/api/ready`. It is not an approved routine rollback target for the current monitored topology.

## B. Monitoring

Provider: UptimeRobot. Owner email is the authoritative alert. The address is not stored in git.

| Monitor | Target | State when recorded |
|---|---|---|
| SBG Production — Application | `https://scan-book-go.vercel.app/` | ACTIVE / HEALTHY / GREEN |
| SBG Production — Readiness | `https://scan-book-go.vercel.app/api/ready` | ACTIVE / HEALTHY / GREEN |

Human evidence: a test notification from each monitor was received. A real DOWN/RECOVERY cycle was not tested. The Ops Agent is not required for detection and is not built.

## C. Application red

1. Confirm the Application monitor.
2. `GET /`. Expect HTTP 200.
3. `GET /api/ready`. Expect HTTP 200 and body exactly `{"ok":true}`.
4. Inspect the current Vercel production deployment. Do not change project settings.
5. Compare the deployed SHA with `origin/main`.
6. Decide whether the latest deployment is the likely fault.
7. Prefer a safe forward correction on `main`.
8. Do not roll back blindly.
9. Use a rollback candidate only after confirming it matches migrations `0001`–`0030` and the monitored routes. The candidate named in section A does not. Do not use it as a routine rollback.
10. After recovery, recheck `/` and `/api/ready`.
11. Do not edit commerce or database environment variables while recovering the application.

## D. Readiness red

1. Confirm `/`.
2. Confirm `/api/ready`.
3. If `/` is healthy and `/api/ready` is 503, treat it as application-plus-database readiness degradation. `503` with `{"ok":false}` means the readiness check failed. It does not name the fault.
4. Inspect the Vercel deployment and provider status.
5. Inspect the Neon project status manually.
6. Do not change `DATABASE_URL`.
7. Do not put owner credentials in the application.
8. Do not migrate.
9. Do not restore.
10. Any data operation needs a separately authorised recovery checkpoint.

## E. Migration failure

Production schema changes are not an application-deploy side effect.

- The only workflow is `.github/workflows/production-database.yml`.
- Gate B is read-only. It uses `AETHER_DATABASE_OWNER_URL` and does not migrate.
- Do not revive retired migration workflows.
- `scripts/migrate.mjs` applies one file per transaction: `BEGIN`, SQL, ledger insert, `COMMIT`. On error it `ROLLBACK`s and does not insert the ledger row unless that rollback itself fails because the connection died.
- There is no down migration.
- Do not invent `0031`.
- Future SQL requires `AUTHORISED_PENDING` to name that file and a separate checkpoint. Empty means nothing is authorised.
- `AETHER_DATABASE_OWNER_URL` stays off Vercel. The app connects as `aether_app` through `DATABASE_URL`.

Do not run a migration from this card.

## F. Commerce freeze

During any Production incident, do not:

- set `SBG_SAAS_COMMERCE=live`
- set `SBG_DOMAIN_B_LIVE_CHECKOUT=true`
- substitute a live Stripe key
- put `AETHER_DATABASE_OWNER_URL` on Vercel
- point `DATABASE_URL` at `neondb_owner`
- start CP31 as a recovery step

Current commerce is test, not LIVE. Domain A is on `SBG_SAAS_COMMERCE=test`. Domain B live checkout is off because `SBG_DOMAIN_B_LIVE_CHECKOUT` is not the exact string `true`. A Vercel rollback does not change these variables. A person editing them during an incident would.

## G. Database restore prohibition

Production Neon restore or PITR is not an authorised routine V1 incident action.

Do not restore until all of the following exist:

- a proven Neon retention / PITR window for this project
- a written restore target and procedure
- a separate recovery authorisation
- a stated impact on current Production data

Rebuilding schema from `migrations/` does not recover data. Do not restore from this card.

## H. Email and Stripe

Production Resend confirmation email is not configured. `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are absent from the Vercel production environment. Missing email is not evidence that booking creation failed. The booking transaction finishes before email. Email failure does not roll the booking back.

Stripe at this boundary is test / dormant. The enabled test webhook is not the outage detector. A test webhook failure does not get its own incident system.

Do not send mail, create Stripe objects, or change DNS from this card.

## I. Not this runbook

Neon PITR testing, a Production rollback drill, GitHub branch protection, deletion of retired `CP294A_DIAG_SECRET`, an Ops Agent, a second monitor vendor, a status page, a custom domain, password recovery, pool changes, performance work, and LIVE commerce are deferred. They are not incident actions.
