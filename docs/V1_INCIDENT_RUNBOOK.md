# V1 incident runbook

This is the only current Production incident procedure for a 1–5 hotel pilot.

It supersedes operational instructions in `RESTORE.md`, `docs/RESTORE.md`, `docs/MASTER_RECOVERY_PROTOCOL.md`, `docs/RECOVERY_MANIFEST.md`, and `AETHER_RECOVERY_MANIFEST.json`. Those files remain historical. Do not follow their SHA, deployment, migration-ceiling, or “next checkpoint” lines during an incident.

Living status stays in `BUILD_STATE.md`. This page is the procedure.

Reconfirm identity at incident time. The snapshot below is what was proven when this runbook was written. A later documentation commit may redeploy the same application. Do not roll back just because a deployment id on this page is no longer the alias.

## A. Production identity

Reconfirm at incident time: read `origin/main` and the Vercel deployment aliased to `scan-book-go.vercel.app`. Do not roll back only because a deployment id on this page is no longer the alias.

### Current accepted pointer

Recorded when CP30.3D was written. This deployment is documentation relative to the CP30.2B application runtime. It did not change application source.

| Item | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| SHA | `b49adfb57e2c44943fd0d689fb16d978a3831187` |
| Production deployment | `dpl_AdKc8WkBsw9a45kStuU9ZUenNGwK` |
| Application runtime under that SHA | CP30.2B at `cf0d5a3d7a2cc88033a7419704b3c0f8985836e5` |
| Application | `https://scan-book-go.vercel.app/` |
| Readiness | `https://scan-book-go.vercel.app/api/ready` |
| Migrations | `0001`–`0030` |
| `AUTHORISED_PENDING` | `[]` |
| `0031` | Does not exist. Do not invent it |

### Identity when the runbook was first written

CP30.3B start, before the documentation deploy above: SHA `cf0d5a3d7a2cc88033a7419704b3c0f8985836e5`, deployment `dpl_DuJ9YevC2cNXRaymD7VVBZR6hhnV` READY, region `iad1`.

Known older rollback candidate: `dpl_6xyTG1UATyVP94mfz1g1NrQbT2Qa` at `fa8cf08fa202b5ae15930f4d4b501613c5ced454`. It predates `/api/ready`. It is not an approved routine rollback target. Do not roll back from this page.

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

## G. Neon recovery boundary

Proven by CP30.3C. No restore was performed. This is not a mature backup strategy. The rolling window is six hours.

| Item | Value |
|---|---|
| Project | `quiet-sound-53513710` |
| Project name | Aether Transfer |
| Platform / region | AWS / `eu-central-1` |
| Subscription | `free_v3` |
| History retention | `21600` seconds = 6 hours, rolling |
| Production branch | `br-green-darkness-b1k7wkue`, state `ready` |
| Branch flags | `primary=true`, `default=true`, `protected=false` |
| Branch limit | 10 |

`create_branch` copies the parent at HEAD. That is a copy of now. It is not historical recovery.

Historical recovery uses snapshot restoration onto a **new** branch. It can be a distinct branch. In-place replacement of Production is not required and is forbidden. Do not restore Production in place. Do not change Production `DATABASE_URL` while investigating recovery. Restoration itself needs a separate explicit authorisation. There is no automatic cutover and no automatic `DATABASE_URL` replacement.

Data older than the rolling six-hour window is outside the proven PITR retention. Schema replay from `migrations/` is not data recovery.

```
Production
br-green-darkness-b1k7wkue
        ↓
historical recovery inside the proven 6-hour window
NEW disposable recovery branch
        ↓
CP30.3C validation gate
+ Gate B where it applies
        ↓
human review
        ↓
separately authorised cutover
```

Before any cutover can be considered, a recovered branch must pass this gate:

- project is `quiet-sound-53513710`, not a CP28 or CP29 disposable branch
- recovered branch id is recorded and is not `br-green-darkness-b1k7wkue` until cutover is separately authorised
- database name is `neondb`
- the application role is `aether_app`; the owner role is not the runtime login
- ledger matches source `0001`–`0030`, `AUTHORISED_PENDING=[]`, no unexpected `0031`
- expected schema objects are present
- `bookings_vehicle_occupancy_excl` and `bookings_driver_occupancy_excl` are `EXCLUDE` constraints
- the occupancy trigger is present
- no duplicate confirmation tokens
- no vehicle overlaps
- no driver overlaps
- tenant isolation still holds
- critical hotel, provider, and user rows expected for the pilot are present
- the application SHA under test is the source intended for cutover
- `/api/ready` is checked against the recovery target only, without pointing Production `DATABASE_URL` at it
- `SBG_SAAS_COMMERCE` stays `test`; `SBG_DOMAIN_B_LIVE_CHECKOUT` is not the exact string `true`
- `AETHER_DATABASE_OWNER_URL` stays off Vercel

Gate B (`production-database.yml`, `BEGIN READ ONLY`) can check ledger, role, and occupancy. It does not read the retention window. Do not dispatch it from this card.

### Manual snapshot — do not use for current data

`snap-autumn-band-b1nvf8cu`, label “Aether Transfer CP13A pre-migration safety checkpoint”, source `br-green-darkness-b1k7wkue`, created `2026-09-10T16:36:11Z`.

This is historical CP13A evidence. It predates the current booking state and the current `0001`–`0030` ledger. Do not treat it as a current-data recovery point. Do not restore it. Do not delete it.

### Limits recorded, not fixed

- History retention is only 6 hours.
- The Production branch is `protected=false`. Do not change that flag from this card.
- The project branch limit is 10.
- Disposable children exist: `br-mute-sky-b1tnej2d` (`cp29-load-gate`) and `br-icy-shadow-b1fh96gk` (`cp28-2c-race-gate`). Do not delete them to free a slot.
- A full branch census was not taken. Check the count before any future create.
- Restore-picker granularity inside the 6 hours was not itemised.
- Whether a restored branch creates a compute or endpoint by itself was not itemised.

Do not infer behaviour beyond this list.

## H. Email and Stripe

Production Resend confirmation email is not configured. `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are absent from the Vercel production environment. Missing email is not evidence that booking creation failed. The booking transaction finishes before email. Email failure does not roll the booking back.

Stripe at this boundary is test / dormant. The enabled test webhook is not the outage detector. A test webhook failure does not get its own incident system.

Do not send mail, create Stripe objects, or change DNS from this card.

## I. Not this runbook

A Neon restore drill, a Production rollback drill, changing Neon protection or retention, GitHub branch protection, deletion of retired `CP294A_DIAG_SECRET`, an Ops Agent, a second monitor vendor, a status page, a custom domain, password recovery, pool changes, performance work, and LIVE commerce are deferred. They are not incident actions.
