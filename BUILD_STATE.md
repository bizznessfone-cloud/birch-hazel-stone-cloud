# BUILD STATE — living record

This file describes **current reality**, not intended future state.

## CP30.05E-2D-2D A2 — hotel subscription no longer creates an organisation

**A2 is in application source. No new migration. Production SQL was not run. The A1 Terms gate stays closed. First property creation stays blocked. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

`ensureHotelOrganisation` no longer calls `sbg_create_organisation_for_user`. An already-attached hotel returns its current organisation after hotel access and billing authority are checked. It is not moved, renamed, or classified. An unattached hotel attaches only to the caller's single founding organisation when that organisation is classified `hotel` and the caller still has billing authority. Attachment uses `sbg_attach_hotel_to_organisation`, which locks the hotel and rejects a different organisation. The client cannot choose the organisation id. Missing, ambiguous, unclassified, and `transfer_operator` states fail closed. No Terms acceptance is written.

An existing attached hotel keeps its billing path, including when the organisation is still unclassified. An unattached hotel is not given a new organisation. Recovery is one founding organisation classified as Hotel / Accommodation, then a retry. A2 does not create or classify that organisation, and it does not open the Terms screen. An ambiguous account is not repaired by creating another organisation.

The runtime SQL client cannot hold one transaction across the founding read and the attach. No installed function repeats the founding-uniqueness check inside the hotel lock. Concurrent retries of this function cannot move the hotel. A direct call to `sbg_create_organisation_for_user` can still insert another organisation; this path no longer does that.

## CP30.05E-2D-2D A1 — founding organisation journey in application source

**A1 is in application source. A2 is in application source; see the section above. No new migration. Production SQL was not run. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

Authenticated users with no hotel account enter `/app/founding`. They name the business through `sbg_ensure_founding_organisation`, then classify it as `hotel` or `transfer_operator` through `sbg_classify_founding_organisation`. Both types stop on a Terms-pending screen. That screen does not call `sbg_record_founding_terms_acceptance`. terms-v1 stays provisional and is not presented as accepted Terms.

A user who already has a hotel account stays on `/app/hotels/$hotelId`. Their organisation is not created, classified, or otherwise mutated by this gate. If the hotel list cannot be read, the journey does not write. Ambiguous founding state with no hotel account fails closed and does not classify. Users with no hotel account are redirected away from `/app/onboarding` and `/app/billing`. `createOnboardingHotel` refuses the first property until a hotel account already exists. `ensureHotelOrganisation` no longer creates an organisation from a hotel name; see the section above. The founding journey still does not call it. Homepage Get started is still `#start`. Commerce remains **test**.

## CP30.05E-2D-2C.1 — 0034 applied on Production; apply workflow retired

**0034 is applied and verified on Production.** Project `quiet-sound-53513710`, branch `br-green-darkness-b1k7wkue`, endpoint `ep-withered-haze-b1fd9hse`, database `neondb`, owner `neondb_owner`. GHA [37965989240](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37965989240) (job 113940347830, checkout `5a9c21fc0b7b2fc2ef8222eb5fe2268c92627738`) printed `GATE PASS — 0034 APPLIED AND VERIFIED`. Digest `3a80e2ec5ff9ab474c8dabf562fe8e3e37b8fcaa77ef7e8467bd0127afdc433c`. Organisation rows 1, classified 0, acceptance rows 0. Immutable and no-truncate triggers were present. `aether_app` has no SELECT, INSERT, UPDATE, or DELETE on `sbg_organisation_acceptances`. Stripe untouched. Commerce untouched. Live terms acceptance disabled. `GET /` was 200 and `GET /api/ready` was exactly `{"ok":true}` before and after. CP31 NOT STARTED. E-2D-2D A1 is in application source; see the section above. LIVE COMMERCE NOT ACTIVATED. terms-v1 stays provisional. Migration 0034 is not CP31.

GHA [37958312702](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37958312702) passed the identity gate at ledger 0001–0033 and recorded `GATE PASS — 0034 APPLIED AND VERIFIED`. Same-type classification held the organisation lock. The conflicting waiter then raised `organisation type is already set` (`42501`) from `sbg_classify_founding_organisation`. That rejection is the correct database result. Node 22 exited on it before the harness assertion, because the waiter promise was caught only after the holder commit. Cleanup did not run.

GHA [37961828006](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37961828006) verified the installed 0034 without reapplying it. Concurrency, conflicting classification, terms acceptance, and the acceptance-table privilege checks passed. `SET LOCAL ROLE aether_app` then failed with `permission denied to set role "aether_app"` (`42501`). That is the 0014 rule: the owner is not a member of `aether_app`. No grant was added. The verification workflow was not dispatched again from this correction.

GHA [37964615765](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37964615765) on `7509d881831ac23f5adcaff48366a3664936efcf` completed successfully. It proved the isolated ledger 0001–0034, the installed contract, three independent sessions, classification locking, conflicting-type rejection, idempotent retries, terms-v1 acceptance, unauthorised-member rejection, a read-only state check, no direct acceptance-table privileges, and that the owner cannot `SET ROLE aether_app`. Marker fixtures were removed and triggers stayed enabled. That run is the isolated evidence on branch `br-late-paper-b15gkfj3`. It is not the Production apply.

Gate B accepted ledger is **0001–0034**. `AUTHORISED_PENDING=[]`. The single-use workflow `.github/workflows/cp3005e2d2c1-0034-production-apply.yml` is **RETIRED**. Do not rerun `scripts/cp3005e2d2c1-0034-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0033**. The generic migrator does not apply SQL. Remaining workflows are read-only `.github/workflows/production-database.yml` and verification-only `.github/workflows/cp3005e2d2c1-0034-isolated-verify.yml`, which refuses the Production endpoint. Homepage Get started is still `#start`. `ensureHotelOrganisation` is unchanged. Commerce remains **test**. Better Auth stays 1.6.30. Cookie cache stays off.

## CP30.05E-2D-2C — classification and provisional terms acceptance authored, not applied

**E-2D-2B.1 is PASS. E-2D-2C is in source only. This section records the pre-apply checkpoint. Production 0034 is applied; see the section above. E-2D-2D NOT STARTED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

Organisation and property stay different. The organisation is the business. A property is a real hotel or accommodation that business serves. A transfer operator is not a hotel. Classification is `sbg_organisations.organisation_type`, not membership role. The founding membership stays `role = member`, `billing_authority = true`.

`sbg_classify_founding_organisation(text, text)` sets that type only for the caller’s unambiguous founding organisation: the one organisation they created, while they still have an active billing membership on it. NULL may become `hotel` or `transfer_operator`. The same value is idempotent. A different non-NULL value is rejected. The organisation row is locked with `FOR UPDATE` before the write. The client cannot name an organisation. A billing seat on someone else’s organisation is not classified.

`sbg_record_founding_terms_acceptance(text)` inserts one row into the existing `sbg_organisation_acceptances` table after the type is set. The agreement token is the server-owned provisional value `terms-v1`. No Terms document is published or approved by this checkpoint. Privacy is not a second row. The same organisation, user, and version does not insert twice. The row stores organisation, accepting user, version token, and `accepted_at`. It does not store an IP address, the Terms text, a checkbox, or a document hash. A read does not insert a row. Signup and founding do not call this function.

`sbg_read_founding_onboarding_state(text)` returns only that caller’s founding state: missing, ambiguous, or ready with type and whether `terms-v1` is accepted. Ambiguous and missing results do not reveal an organisation id. `aether_app` can execute the three caller functions and cannot execute the internal resolver. `aether_app` still has no SELECT, INSERT, UPDATE, or DELETE on `sbg_organisation_acceptances`.

Migration **0034** (`0034_cp3005e2d2c_founding_classification_acceptance.sql`, digest `3a80e2ec5ff9ab474c8dabf562fe8e3e37b8fcaa77ef7e8467bd0127afdc433c`) is source only. Gate B accepted ledger stays **0001–0033**. `AUTHORISED_PENDING=[]`. A directory scan of this commit reports the file as unexpected pending and does not apply it. Do not apply 0034 from this checkpoint. No acceptance row was written. The existing Production organisation was not classified.

`ensureHotelOrganisation` is unchanged. Homepage Get started is still `#start`. Commerce remains **test**. Better Auth stays 1.6.30. Cookie cache stays off.

## CP30.05E-2D-2B.1 — founding organisation primitive applied and Neon-verified

**E-2D-2A is ACCEPTED. E-2D-2B code is COMPLETE. 0033 is APPLIED and Neon-verified. E-2D-2C NOT STARTED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

Organisation and property are different things. The organisation is the business that operates SCAN BOOK GO. A property is an actual hotel or accommodation property that business serves. A transfer operator is not stored as a hotel. Example: organisation “Kos Transfers Limited”, properties “Portobello Royal”, “Atlantica Beach Resort”. A hotel organisation such as “Greco Blu Hotels” uses the same shape for its own hotels. One product, one organisation model, one property model.

`sbg_ensure_founding_organisation(text, text)` is the V1 self-service founding primitive. It locks the caller’s `"user"` row, then either returns the one organisation that user created (when they still have an active billing membership on it) or creates that organisation and one membership in the same call. The membership is `role = member`, `billing_authority = true`. `organisation_type` stays NULL. A different name on retry does not rename. Two organisations already created by that user, or a billing seat on someone else’s organisation, fails closed. There is no `UNIQUE(user_id)`. A non-billing membership elsewhere does not become this user’s organisation.

No hotel is created or attached. No billing row, allocation, acceptance, or Stripe call. `ensureHotelOrganisation` is unchanged and still creates an organisation from a hotel name at checkout. That remains the E-2D-2E boundary.

Migration **0033** (`0033_cp3005e2d2b_founding_organisation.sql`, digest `8880dbf93aa416e393af621957e3170da6390a6e3aef792d68fe97b709c22875`) is accepted history. Gate B ledger is **0001–0033**. `AUTHORISED_PENDING=[]`. It was applied (GHA [37893184406](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37893184406), checkout `468cfd5`). Counts stayed organisation 1, member 1, classified 0, acceptance 0, licensed quantity 3, allocations 4. The function is `SECURITY DEFINER`, `search_path` `pg_catalog, public`, owner `neondb_owner`. `aether_app` can EXECUTE. `aether_runtime` and public cannot. `aether_app` still cannot INSERT, UPDATE, or DELETE `sbg_organisations` or `sbg_organisation_members`. Execute was proven with `has_function_privilege`, not `SET ROLE`. The temporary apply workflow is **RETIRED**. Do not rerun `scripts/cp3005e2d2b1-0033-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0032**. The generic migrator still does not apply SQL.

Real Neon concurrency is GHA [37893386159](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37893386159), checkout `8bd8870`. Three independent backends on the direct endpoint (not the pooler) had distinct pids 1117, 1116, and 1118. The same verification user and the same name produced one organisation and one membership (`role` member, `billing_authority` true, `organisation_type` NULL). The same user with two different names produced one organisation; the connection that already held `FOR UPDATE` stored its name, and the waiter did not rename it. A later call with a third name returned the same id and the same stored name. Two other verification users received two distinct organisations, both with `organisation_type` NULL. Lock waits were visible in `pg_stat_activity`. The first dispatch (same apply run 37893184406) saw one pooled backend three times and stopped before any insert. That is not the proof. PGLite `Promise.all` is not the concurrency evidence.

Ordinary DELETE is rejected by `sbg_organisation_reject_delete`. Cleanup disabled only `sbg_organisations_no_delete` and `sbg_organisation_members_no_delete` inside one owner transaction, deleted only marker rows (organisation name prefix `E2D2B1 `, user id prefix `e2d2b1-`), re-enabled both triggers before commit, and then proved `tgenabled` and that the pre-insert snapshot matched. Four organisations and four users were removed. No hotel, billing, acceptance, or Stripe write. Commerce stayed **test**. `GET /` was 200 and `GET /api/ready` was exactly `{"ok":true}` before and after.

Organisation and founding membership are one transactional unit in source: the function has no exception handler, so a membership failure rolls back the organisation insert. Destructive fault injection was not run on Production.

V1 acceptance, later, is one versioned Terms of Service record. Privacy may be linked and is not a second acceptance record in that decision. Nothing was written to `sbg_organisation_acceptances`.

Publication stays a later explicit customer action after entitlement and allocation. The Stripe webhook must not publish a hotel. That action is not built here.

V2+ IDEA ONLY, not built, no schema: a public place QR (for example Kardamena) could later mean a location rather than a hotel. The guest would choose a hotel, SBG would resolve that hotel’s serving organisation, and the transfer would run from that place to the hotel. V1 property remains a real hotel so that idea stays possible. Do not add entry points, change QR, or change guest booking for it.

Homepage Get started is still `#start`. Commerce remains **test**. Better Auth stays 1.6.30. Cookie cache stays off.

## CP30.05E-2D-1 — CLOSED / PASS

**Password recovery is closed. Better Auth stays 1.6.30. A controlled Production reset on `https://scanbookgo.com` was delivered and completed. E-2D-2 NOT STARTED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

E-2D-1B put native reset in the tree and left it fail-closed until Resend existed. E-2D-1D turned cookie cache off so `get-session` reads the database after `revokeSessionsOnPasswordReset`. This closeout records the human Production proof. It does not change code, schema, Stripe, or commerce.

Production was redeployed from `3d193cb9e2daba4f516700bf3aa2aaeaeda44650` after `scanbookgo.com` was attached and verified on Vercel, the Resend domain `scanbookgo.com` was verified (DKIM and SPF), and Production had `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `BETTER_AUTH_URL=https://scanbookgo.com`. The deployment reached READY and `scanbookgo.com` was aliased to it. `GET https://scanbookgo.com/api/ready` returned `{"ok":true}`. The Resend key is not recorded here.

On Production `/login`, Sign in showed **Forgot password?**. `/forgot-password` rendered. The existing human-controlled SBG Production verification account was submitted. The browser showed exactly: “If an account exists for that email, password reset instructions will be sent.” A real email arrived in that account’s Gmail inbox, not Spam. Subject: `Reset your SCAN BOOK GO password`. That is one controlled delivery, not a claim of universal deliverability.

The link returned the user to `scanbookgo.com`. The page said **Choose a new password**. No `vercel.app` hostname was visible in that flow. After the new password, the page said: “Your password has been updated. Sign in with the new password.” Sign-in with the new password reached the existing authenticated hotel workspace. That fixture was not changed. Opening the same link again showed: “This reset link is invalid or has expired.” The old password was rejected.

Two already-signed-in browsers were **not** set up before this reset. Dual-session revocation was not repeated as a live Production test. The evidence for that property remains the E-2D-1D memory-adapter test: two sessions, cache disabled, both cookies fail `get-session` after reset.

Migrations remain **0001–0032**. `AUTHORISED_PENDING=[]`. No 0033. `SBG_SAAS_COMMERCE` remains **test**. Homepage Get started is still `#start`. Ops still uses `aether_ops_session`.

## CP30.05E-2D-1D — cookie cache off, revocation is strict

**E-2D-1D is in this change. Better Auth stays 1.6.30. `session.cookieCache.enabled` is false. A real Resend send has not been proven. E-2D-1 is not complete. E-2D-2 NOT STARTED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

Password reset still deletes every Better Auth database session for that user when recovery is configured (`revokeSessionsOnPasswordReset`). `get-session` now reads that row. A previously issued `session_data` cookie is not issued and cannot keep the account authenticated. The extra session lookup is accepted for the controlled 1–5 hotel pilot. No pool change, no Redis, no second cache.

Ops still uses `aether_ops_session`. It is not this cookie and was not changed. Cookie names stay `__Host-`, `Secure`, `SameSite=Lax`. Homepage Get started is still `#start`. Migrations remain **0001–0032**. `AUTHORISED_PENDING=[]`. Commerce remains **test**.

## CP30.05E-2D-1B — password recovery implemented, delivery not proven

**Option B is accepted. Better Auth stays 1.6.30. Recovery code is in the tree and fail-closed. A real Resend send has not been proven. E-2D-1 is not complete. E-2D-2 NOT STARTED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

Native reset stays inside Better Auth: token, one-hour expiry, consume-once, and `revokeSessionsOnPasswordReset`. SBG registers `sendResetPassword` only when `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are both set. Until then the route stays disabled and no token is issued. When it is enabled, known addresses, unknown addresses, and sender failure share one browser acknowledgement. That acknowledgement is not a delivery receipt. Resend can reject or throw and the HTTP body stays the same. The server log is `sbg.password_reset.delivery` with `outcome` and `providerStatus` only. It does not store the token, the reset URL, the password, or the API key. An undelivered token can remain until it expires. That limit is accepted.

The reset link origin is `BETTER_AUTH_URL` in production. It is not `PUBLIC_APP_URL` and not the request Host. Successful reset deletes database sessions for that user. The signed `session_data` cookie can still satisfy `get-session` until its 300-second cache ends. Cookie cache stays on. A token-only cookie does not.

`/login` can offer Forgot password only when delivery is configured. `/forgot-password` and `/reset-password` are the only new public surfaces. Homepage Get started is still `#start`. No organisation, hotel, membership, acceptance, or Stripe change. Migrations remain **0001–0032**. `AUTHORISED_PENDING=[]`. Commerce remains **test**.

Human configuration still required before any delivery claim: set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` for a verified sender domain, keep `BETTER_AUTH_URL` as the production origin, restart so the callback registers, then send one controlled reset to a human-owned address. Do not paste secrets into chat.

## CP30.05E-2C.1 — versioned acceptance evidence applied

**E-2C organisation type remains PASS. E-2C.1 versioned legal-acceptance evidence is applied. No acceptance row was written. E-2D NOT STARTED. Get started is not connected. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

`sbg_organisation_acceptances` records organisation, accepting user, an explicit agreement-version token, and timestamp. It is not a boolean. The same organisation, user, and version cannot be stored twice. A later version is a new row and does not rewrite the earlier one. Acceptance is not per hotel and not per licence. `aether_app` received no new privilege. Production acceptance rows are **0**. The existing organisation was not given an acceptance. `organisation_type` stays nullable. Classified rows stayed **0**. Licence quantity stayed **3**. Allocations stayed **4**. Commerce remains **test**.

Migration **0032** (`0032_cp3005e2c1_organisation_acceptance.sql`, digest `c3412d2b6efc05786ea3edf1146da25853b88ac0df69b1ce215240be0c72ab48`) is accepted history. Gate B ledger is **0001–0032**. `AUTHORISED_PENDING=[]`. It is applied (GHA [37333642947](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37333642947)). The temporary apply workflow is **RETIRED**. Do not rerun `scripts/cp3005e2c1-0032-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0031**.

## CP30.05E-2C — organisation type applied

**CP30.05E-2A PASS. CP30.05E-2B PASS. CP30.05E-2C organisation type foundation is applied. E-2D NOT STARTED. Public onboarding is not built. Get started is not connected. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

`sbg_organisations.organisation_type` is `hotel` or `transfer_operator`, or NULL. NULL means unclassified. Production had **1** organisation row. It was not backfilled: classified rows stayed **0**. The create function is unchanged, so a new organisation stays NULL until a later checkpoint sets the type. Membership `role` is not the type. `hotels.organisation_id` is still not unique. One organisation can hold many hotels. Licence quantity stays on `sbg_organisation_billing.licensed_quantity`. The apply left licensed quantity **3** and allocations **4**.

Migration **0031** (`0031_cp3005e2c_organisation_type.sql`, digest `be0921b852dda7904863f34bc1160fab844b2aaf0821423f6863c91b71b592b6`) is accepted history. Gate B ledger is **0001–0031**. `AUTHORISED_PENDING=[]`. It is applied (GHA [37279300118](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37279300118)). The first dispatch (GHA [37279095087](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37279095087)) stopped in read-only preflight and did not mutate. The temporary apply workflow is **RETIRED**. Do not rerun `scripts/cp3005e2c-0031-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0030**. Commerce remains **test**.

## CP30.05E-2B — identity session. Onboarding not started

**CP30.05E-2A PASS. CP30.05E-2B identity/session foundation is in this change. E-2C NOT STARTED. Public onboarding does not exist. Homepage Get started is not connected. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

A new `/login` account is signed in with Better Auth email sign-in immediately after signup. The signup endpoint itself stays `autoSignIn: false`, so a new email and an existing email still share one sessionless 200 response. Signup does not create an organisation, a membership, a hotel, or an Owner/Ops grant.

Password recovery delivery is **BLOCKED ON EMAIL TRANSPORT**. Better Auth reset is not enabled, because its success body would claim an email was sent. Production Resend is still not configured. No reset token is issued by the application.

An authenticated user with no hotel still reaches the existing `/app/onboarding` wizard. That is temporary. E-2D must reconcile it. This checkpoint does not build onboarding.

Commerce remains **test**. Migrations remain **0001–0030**. `AUTHORISED_PENDING=[]`. No 0031.

## CP30 — CLOSED. CP31 — NOT STARTED

**CP30.2 CLOSED. CP30.3 CLOSED. CP30 CLOSED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

This close is an operations admission only. It does not authorise LIVE Stripe, CP31 execution, hotel onboarding, public launch, a custom domain, a database restore, or performance work.

Operating envelope: **CONTROLLED 1–5 HOTEL V1 PILOT**. Capacity posture: **AMBER**. Commerce remains **test**. `SBG_DOMAIN_B_LIVE_CHECKOUT` is not set. Production is healthy at `dpl_4hVF3RBDne7csNG54PigccBZqTXk`, SHA `e18c082b57a03235b9a322171b397cf5d1edbb59`, which is documentation on the CP30.2B application runtime `cf0d5a3`.

No checkpoint in this repository was named CP30.1. Topology used here is the accepted CP29.4A record: Vercel `iad1`, Neon pooler, `eu-central-1`, runtime `aether_app`. That work is not relabelled CP30.1.

UptimeRobot monitors **SBG Production — Application** and **SBG Production — Readiness** remain the detectors. Owner email received a test from each. A real DOWN/RECOVERY cycle was not induced. The Ops Agent is not required. The incident procedure remains `docs/V1_INCIDENT_RUNBOOK.md`. Neon history retention stays 6 hours and is not mature disaster recovery. Resend remains **NOT CONFIGURED**. The confirmation page says so. A missing email does not roll a booking back.

| Item | Result |
|---|---|
| CP30.2 | **CLOSED** |
| CP30.3 | **CLOSED** |
| CP30 | **CLOSED** — 1–5 hotel operating envelope accepted |
| CP31 | **NOT STARTED** |
| LIVE commerce | **NOT ACTIVATED** |
| Production commerce | **test** |

The CP30.3D section below was the state before this close. Its statement that CP30 was not closed was true then.

## CP30.3D — PASS. CP30.3C — PASS. CP30 — NOT CLOSED

**CP30.2A PASS. CP30.2B PASS. CP30.2C PASS. CP30.2 CLOSED. CP30.3A PASS. CP30.3B PASS. CP30.3C PASS. CP30.3D PASS. CP30 NOT CLOSED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

Incident procedure: `docs/V1_INCIDENT_RUNBOOK.md`. Neon project `quiet-sound-53513710` (Aether Transfer), subscription `free_v3`, AWS `eu-central-1`. Production branch `br-green-darkness-b1k7wkue` is ready, primary, default, and `protected=false`. History retention is `21600` seconds (6 hours, rolling). That window is a V1 limitation, not a mature backup strategy.

Historical recovery is snapshot restoration onto a new branch only. `create_branch` at HEAD is not historical recovery. Do not restore Production in place. Do not change `DATABASE_URL` for an investigation. `snap-autumn-band-b1nvf8cu` (2026-09-10, CP13A) must not be restored or deleted. CP28/CP29 disposable branches must not be deleted to free a slot. Branch limit is 10. No restore and no recovery branch were created.

UptimeRobot Application and Readiness monitors remain ACTIVE. Test notification was received. A real DOWN/RECOVERY cycle was not tested. Production Resend remains **NOT CONFIGURED**. Commerce remains **test**.

| Item | Result |
|---|---|
| CP30.2 | **CLOSED** |
| CP30.3A | **PASS** — reconnaissance |
| CP30.3B | **PASS** — incident runbook established |
| CP30.3C | **PASS** — Neon recovery capability verified. No restore |
| CP30.3D | **PASS** — runbook records that boundary. Documentation only |
| Accepted deployment pointer | `dpl_AdKc8WkBsw9a45kStuU9ZUenNGwK` at `b49adfb57e2c44943fd0d689fb16d978a3831187`. Documentation deploy relative to application runtime `cf0d5a3` |
| CP30 / CP31 | CP30 **NOT CLOSED**. CP31 **NOT STARTED** |
| LIVE commerce | **NOT ACTIVATED** |

The CP30.3B section below was true when the runbook was first added and Neon retention was still unproven. It is not the current pointer.

## CP30.3B — PASS. CP30.2 — CLOSED. CP30 — NOT CLOSED

**CP30.2A PASS. CP30.2B PASS. CP30.2C-1 PASS. CP30.2C-2 PASS. CP30.2 CLOSED. CP30.3A PASS. CP30.3B PASS. CP30 NOT CLOSED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

Incident procedure: `docs/V1_INCIDENT_RUNBOOK.md`. It supersedes operational instructions in the older restore and recovery files. Those files stay historical.

UptimeRobot monitors **SBG Production — Application** and **SBG Production — Readiness** are ACTIVE / HEALTHY. Owner email received a test notification from each. A real DOWN/RECOVERY cycle was not tested. The Ops Agent is not built and is not required for detection. Production Resend confirmation email is **NOT CONFIGURED**. Email failure does not roll back a committed booking.

| Item | Result |
|---|---|
| CP30.2A | **PASS** — observability boundary designed |
| CP30.2B | **PASS** — `GET /api/ready` implemented |
| CP30.2C-1 | **PASS** — monitoring audit. Better Stack was the design preference |
| CP30.2C-2 | **PASS** — UptimeRobot substituted after Better Stack onboarding blocked the workflow. No Better Stack credential was created |
| CP30.2 | **CLOSED** |
| CP30.3A | **PASS** — reconnaissance only. No remediation in that checkpoint |
| CP30.3B | **PASS** — this runbook. Documentation only |
| External monitors | **ACTIVE** via UptimeRobot. Test notification received. Real outage cycle **NOT TESTED** |
| Ops Agent | **NOT BUILT** |
| Production Resend | **NOT CONFIGURED** |
| CP30 / CP31 | CP30 **NOT CLOSED**. CP31 **NOT STARTED** |
| LIVE commerce | **NOT ACTIVATED** |

Deferred, not done here: Neon PITR proof, rollback drill, branch protection, `CP294A_DIAG_SECRET` deletion, second monitor vendor, status page, custom domain, password recovery, pool changes, performance work, LIVE commerce.

The CP30.2B section below was the state when `/api/ready` landed and monitors were not configured yet. That was true then. It is not the current pointer.

## CP30.2B — PASS. CP30.2A — PASS. CP30 — NOT CLOSED

**CP30.2A PASS. CP30.2B PASS. `GET /api/ready` IMPLEMENTED. External deterministic monitors NOT YET CONFIGURED. Ops Agent NOT BUILT. CP30.2C NOT STARTED. CP30.3 NOT STARTED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

`GET /api/ready` answers `200 {"ok":true}` or `503 {"ok":false}` after one `select 1` on the existing application pool. It is not linked from the UI. It does not write, set a cookie, or return driver or topology text. `Cache-Control: no-store`. No migration. No Stripe, Resend, Neon, DNS, or Vercel environment change.

| Item | Result |
|---|---|
| CP30.2A | **PASS** — observability boundary designed. Not built, except the readiness route authorised as CP30.2B |
| `/api/ready` | **IMPLEMENTED** |
| External monitors | **NOT YET CONFIGURED** |
| Ops Agent | **NOT BUILT** |
| CP30.2C / CP30.3 / CP31 | **NOT STARTED** |
| LIVE commerce | **NOT ACTIVATED** |

The CP29 section below is the close state of CP29. Its statement that CP30 had not started was true at that close.

## CP29 — CLOSED. CP29.4A — PASS. CP30 — NOT STARTED

**CP29.2 CLOSED. CP29.3 PASS. CP29.4 measurement completed. CP29.4A PASS. CP29 CLOSED. CP30 NOT STARTED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

CP29.4A measured the Production runtime and then removed the diagnostic. No booking, schema, grant, pool, index, Stripe, Resend, DNS, or commerce change. The 14-trip figure below is an estimate, not a booking SLA.

| Item | Result |
|---|---|
| Topology | Vercel function region **iad1**. Neon region **eu-central-1**. **Cross-region**. Transport **pooler** (`-pooler` host marker). Endpoint `ep-withered-haze-b1fd9hse`. Project `quiet-sound-53513710`. Branch `br-green-darkness-b1k7wkue`. Database `neondb`. `current_user` = `session_user` = `aether_app` |
| Measurement | Deployment `dpl_HyanFe1gVVusyKvTsUe7zf6muNdN` at `f1d5bbe`. One serial invocation. `SELECT 1` only, plus metadata reads. First sample **1747 ms** (pool was empty; connection setup is inside that sample). Warm n=16: min 93.016, p50 **93.429**, p95 93.718, p99 94.093 (low confidence), max 94.093, mean 93.408 ms. Pool object construction 0.616 ms. Pool total 0 → 1, idle 1, waiting 0. `max` stayed 2 |
| Estimate, not a booking | `14 × 93.429 ms = 1308 ms` network component. CP29.3 GitHub `centralus` was 14 × 118 ms = 1652 ms, measured create 1663 ms. About 0.34 s of that was the runner being farther away. The rest is this cross-region RTT times 14 serial trips. Not an SLA |
| Economics | Neon pooler absorbs per-isolate fan-out. Application `max=2` is still the per-isolate queue. Acceptable for a quiet pilot. Not changed |
| Capacity | 1–5 and 10–25: **AMBER**. 50 and 100: **NOT ENOUGH EVIDENCE**. Not a bookings-per-second promise |
| CP30 | **NOT STARTED**. Do not start it from this note |

The CP29.4 section below is the earlier blocked measurement. Its statement that transport was unproven was true at that close. CP29.4A superseded it.

## CP29.4 — BLOCKED. CP29 — NOT CLOSED

**CP29.2 CLOSED. CP29.3 PASS. CP29.4 did not close CP29. CP30 NOT STARTED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

No product code, schema, grant, pool setting, index, Stripe object, Resend send, Vercel env, or DNS change was made. No Production booking was created. No temporary workflow was added.

| Item | Result |
|---|---|
| Deployment | Production `scan-book-go` `dpl_v5TyFAPYjVQ12hZZLdtvF4SN6bqw` READY at `ff113933f9cd7ceb652330e932e31041b5e5250d`. Alias `https://scan-book-go.vercel.app`. Framework TanStack Start. Node 24.x. Deployment type `LAMBDAS`. Regions `["iad1"]`. A Fluid Compute flag was not in the deployment payload |
| Invocation region | Observed `x-vercel-id` `iad1::iad1::…` on the public alias. The function executed in `iad1`. The deployment-specific hostname is SSO-gated and was not used as the measurement path |
| Database reachability | Existing public homepage loader only. Payload `backend:"neon"`, `ok:true`, `kyselyOk:true`. That is two metadata reads, not a booking. `aether_meta` still reports `schemaPhase` 16 and `checkpoint` 23. That is old application metadata, not the Gate B ledger |
| `DATABASE_URL` transport | **NOT PROVEN**. The Production variable exists, type sensitive, and the API did not return a decrypted value. The string was not copied, printed, or changed. Pooler versus direct remains unknown |
| Deployed `SELECT 1` | **NOT SAFELY MEASURABLE IN CP29.4**. No existing timing diagnostic. A new public endpoint was not added. Preview was not given Production credentials |
| Warm public read | 12 homepage requests after a static warmup, reused TLS, all `x-vercel-cache: MISS`, all `backend:"neon"`. TTFB p50 215 ms, p95 228 ms, max 982 ms. The 982 ms sample was the first function hit. The other 11 were 209–228 ms. Static `/favicon.svg` on the same connection was p50 7 ms. This is request latency for two serial metadata reads plus render, not SQL RTT and not a booking |
| Region effect | Function region `iad1` plus ~200 ms of warm work for two serial reads is not a same-region shape. Impact **HIGH**. The Neon hostname region was not re-read from `DATABASE_URL`. The historical project is `eu-central-1`. Do not treat this as a measured booking SLA |
| Estimate only | If those two reads are dominated by serial round trips, implied per-query cost is about 100 ms. 14 × 100 ms ≈ 1.4 s. CP29.3 measured 14 × 118 ms = 1663 ms from `centralus`. The estimate is not an end-to-end booking measurement |
| Capacity | 1–5 and 10–25 remain **AMBER**. 50 and 100 remain **NOT ENOUGH EVIDENCE**. Assumption: a quiet pilot, not a burst. Not a bookings-per-second promise |
| Why CP29 stayed open at CP29.4 | Production pooler-versus-direct was still unproven, and in-function warm `SELECT 1` was not sampled. No correctness, grant, or commerce defect was found. CP29.4A later closed those two gaps. Do not start CP30 from this note |

The CP29.3 section below remains the disposable-branch measurement. It is not a Production SLA.

## CP29.3 — PASS. CP29.2 — CLOSED. CP29 — NOT CLOSED

**CP29.2 DISPOSABLE LOAD GATE — CLOSED. CP29.3 CAPACITY VERIFICATION — PASS. CP30 NOT STARTED. CP31 NOT STARTED. LIVE COMMERCE NOT ACTIVATED.**

No product code, schema, grant, pool setting, index, or Vercel environment change was made for CP29.3. The temporary measurement workflow is retired. Application source still matches the CP29.2A retirement tree except documentation.

| Item | Result |
|---|---|
| CP29.2 | **CLOSED** on disposable branch `br-mute-sky-b1tnej2d` only. GHA [37103649966](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37103649966). Four fixture hotels published live through `promoteHotelToLive` as `neondb_owner`, then the load ran as `aether_app`. Occupancy, idempotency, limiter overshoot 4, DTO, and privilege denials held. Production was not used |
| CP29.3 | **PASS**. GHA [37105141618](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37105141618) at `7fe5065`. An earlier harness run [37104933477](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37104933477) stopped on a missing public booking id and did not break invariants |
| Measured cause of ~1.9s | 14 serial database round trips. Warm `SELECT 1` p50 was 118 ms. 14 × 118 ms = 1652 ms. Fresh direct create was 1663 ms, with 3 ms unaccounted. Booking insert was 120 ms, the same as the other statements, so the occupancy trigger is not the delay. Email `not_configured` was 0.014 ms. No sleep. The GitHub-hosted runner is not the Vercel region; do not treat 1663 ms as a production SLA |
| Pool | `neonPoolSettings()` is max 2, idle 10 s, connect timeout 8 s, `allowExitOnIdle` true. One pool per isolate. Unchanged. At concurrency 16, pool total stayed 2, 14 creates succeeded, 2 hit `connection_timeout`, peak waiters 14, throughput stayed about 1.2/s. A second isolate held 2 more connections at the same time |
| Ops | Today board is date-scoped and not row-limited (Index Scan, 0 rows on the Athens today date, 360 ms). Bookings list has no `LIMIT` (Seq Scan, 51 rows, server time under 1 ms, 239 ms client). Detail is by id. Vehicles, drivers, and hotels are provider-scoped and not paginated. 100 concurrent reads queued 98 deep behind the same 2 connections; p95 11899 ms. No index was added |
| Capacity | Pilot and 10–25 hotels: **AMBER**. 50 and 100 hotels: **NOT ENOUGH EVIDENCE** for data volume. No envelope is a bookings-per-second promise. Limiter overshoot of 4 remains `acceptable_bounded_hardening_debt` and was not repaired |
| Bottlenecks, not repaired | (1) 14 serial round trips — **OPTIMISE BEFORE 25 HOTELS**. (2) Pool max 2 queue and `connection_timeout` — **OPTIMISE BEFORE 25 HOTELS**; acceptable for a quiet pilot; setting not changed. (3) Each isolate opens its own max-2 pool — Production use of the Neon pooler is **NOT PROVEN**. (4) Unbounded Ops bookings list — **OPTIMISE BEFORE 100 HOTELS**. (5) Limiter overshoot 4 — **HARDENING DEBT**. None is a **BLOCKER BEFORE CP30** |
| CP30 / CP31 / LIVE | **NOT STARTED / NOT STARTED / NOT ACTIVATED** |

The CP28 section below is the prior living record. Its statement that CP29 had not started is the state at the CP28 close.

## CP28 — CLOSED

**CP28 EXIT GATE — PASS. CP28 CLOSED.** Current status is the CP29 section above, not this sentence.

Verification baseline application SHA `30173015216ca638a7d63736205fe20be11d3880`. That commit only retires the temporary CP28.2C workflow. Application source matches `b8b04e7` (CP27.3c). This documentation commit does not change application source, schema, commerce flags, or Production data.

| Item | Class |
|---|---|
| CP26 | **IMPLEMENTED** and previously **COMPLETE**. Last documented Production commerce is `SBG_SAAS_COMMERCE=test`. CP28 did not create a new Stripe object and did not change that env |
| CP27 | **CLOSED**. CP27.3a `7fb6817`, CP27.3b `9972964`, CP27.3c `b8b04e7`. Read-only closure **PASS** on `b8b04e7`. No migration 0031 |
| CP28.2 | **VERIFIED** — local `npm run test:aether`, typecheck, build. Not a Neon connection |
| CP28.2B | **BLOCKED** — Production fixture/cleanup privilege boundary. `aether_app` cannot DELETE bookings, vehicles, or drivers and cannot build a removable isolated hotel/provider tree. Not an occupancy defect. Not re-run. Owner DML was not used |
| CP28.2C | **VERIFIED** — disposable Neon only |
| CP28.3 | **VERIFIED WITH COVERAGE LIMIT** |
| CP29 | **At CP28 close:** not started. Living status is the CP29 section at the top: CP29.4A pass, CP29 closed. Not Production launch. Not LIVE commerce |
| CP31 / LIVE | **NOT YET ACTIVATED**. Domain A `live` stays reserved. Domain B requires the exact env string `true` and was not set |

**CP28.2C (disposable, not Production).** Project `quiet-sound-53513710`. Branch display name `cp28-2c-race-gate`. Branch id `br-icy-shadow-b1fh96gk`. Endpoint identity was proven before writes. Production branch `br-green-darkness-b1k7wkue` was rejected and not used. Runtime `aether_app`. Two independent direct PostgreSQL sessions. GHA [37031757779](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37031757779) at `55b7e19b4760882aab3b836da6d41a766320df6b`. An earlier pooler attempt (GHA [37031501111](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/37031501111)) failed closed with no writes. Vehicle race: one commit / one `23P01`. Driver race: one commit / one `23P01`. Adjacency accepted. Cancellation released occupancy. Reuse accepted. Loser transaction integrity preserved. Runtime could not disable the occupancy trigger, drop either exclusion constraint, DELETE bookings, or `SET ROLE` owner (`42501`). The temporary workflow is **RETIRED** in `3017301`. The disposable branch was not deleted. Fixtures remain on that branch only.

**Exit-gate re-run on this baseline, before the documentation commit:** `npm run test:aether` 251 + 375 + 2 = **628 pass / 0 fail** (`TEST_EXIT` 0). `npm run typecheck` passed. `npm run build` passed. That re-run is the product suite, not a new Production or Stripe journey. Markdown edits are not imported by the product suite.

**CP28.3 coverage that is verified.** Throwaway PGLite exercised the real booking functions: idempotent create, confirmation-token privacy (public DTO omits email, phone, token, vehicle, driver, and occupies), reference lookup miss, nonexistent local time, vehicle and driver assignment, adjacency, overlap translated to safe `unavailable` without leaking `23P01`, foreign-provider refusal, cancel then vehicle reuse, non-live hotel refusal, guest rate-limit 429, production limiter storage failure 503 without SQL. Organisation membership and billing-authority checks stay in source. Domain A stays off unless `SBG_SAAS_COMMERCE` is exactly `test` or `live`; `live` rejects a test key; `test` rejects a live key. Domain B Checkout is hotel-owned (`Stripe-Account`). A live key without `SBG_DOMAIN_B_LIVE_CHECKOUT` exactly `true` throws. Owner gate denies a non-owner. Open redirect is collapsed to `/owner`. Unauthenticated browser shells: `/ops` → `/ops/login`; bad password stays on the login error; `/owner` → `/owner/login`. Mobile and desktop overflow was 0 on the local preview shell. No Production SQL. No Stripe network. Product tests on that tree were also 628/628, with typecheck and build passing.

**CP28.3 coverage limits (not PASS evidence).** Authenticated Production Ops board was not opened. Authenticated Owner control plane was not opened. Real Stripe TEST Checkout was not executed. The local preview hotel was not live, so the full click-through guest wizard was not exercised against a live preview hotel. Booking status remains free-form (trimmed length 1–40), not a rigid state machine: current V1 design, not a CP28 defect. Guest UI is English-only: current V1 design.

**Deferred, not CP28 blockers.** Memory auth rate limits, email verification off, last-billing and last-owner races, broad `aether_runtime` EXECUTE on PGLite, Domain A orphan checkout-session residual, raw `licensed_quantity` above 49 outside the self-service path, dev guest limiter fail-open, ops lockout. None was reclassified as an immediate bypass. CP28.2B remains a privilege/cleanup boundary for any future Production race, not a reason to grant DELETE.

**Commerce.** This checkpoint did not set `SBG_SAAS_COMMERCE` or `SBG_DOMAIN_B_LIVE_CHECKOUT`. It did not use `sk_live`. It created no Stripe customer, subscription, Checkout Session, PaymentIntent, or Connect object. Documented Production commerce stays **test**. Only **CP31** may activate LIVE commerce.

**Migrations.** Source and Gate B remain **0001–0030**. `AUTHORISED_PENDING=[]`. No 0031. No migration applied. No Production SQL.

**Next: CP30.2C — NOT STARTED.** CP30.2A and CP30.2B passed. `/api/ready` is implemented. External monitors are not configured. The Ops Agent is not built. Do not start CP30.2C, CP30.3, or CP31 from this note. Do not activate LIVE commerce.

The CP26 section below is the last Production commercial record. Sentences there that say the next checkpoint is CP27, or that the ledger stopped at 0028, are the state **at that earlier checkpoint** unless this CP28 section supersedes them.

## CP26 — CLOSED

**CP26 FINALISATION — PASS. CP26 STRIPE TEST — PASS. CP26 EXIT GATE — PASS. CP26 — COMPLETE.**

Production ledger is **0001–0030** exactly once. Gate B accepts **0001–0030**. `AUTHORISED_PENDING=[]`. 0030 replaces only `public.sbg_prepare_booking_payment(text)` to remove PostgreSQL 42702. Digest `9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f`. It is **applied** (GHA [36448160139](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36448160139)). The first dispatch (GHA [36447682813](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36447682813)) rolled back and did not commit. Read-only verification is GHA [36448358172](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36448358172). The temporary 0030 apply workflow is **RETIRED**. Do not rerun `scripts/cp272-0030-production-migrate.mjs`. Its `REQUIRED_LEDGER` stays frozen at **0001–0029**. 0029 (`sbg_domain_a_checkout_claims`) remains **applied** (GHA [36404482927](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36404482927)). Checkout now calls the installed 0029 claim, attach, and release functions. No migration 0031. Booking payments were **0** at the 0030 checkpoint and this application remediation did not write Production rows. M5, M6, M7, and M8 are implemented in application source. `SBG_DOMAIN_B_LIVE_CHECKOUT` is not enabled. The generic Production migrator stays fail-closed and never applies SQL. `npm run build` does not migrate. Permanent read-only Gate B (`.github/workflows/production-database.yml`) remains. 0031+ stays fail-closed. Pre-existing `aether_runtime` EXECUTE and `neon_superuser` membership were observed and not remediated.

Commercial model: one product, `property_licence` (SCAN BOOK GO Property Licence). The published Production price version is `b13f9445-d27a-4e7d-8128-a2238906ce7c`, **EUR 17900**, month, interval_count 1. Self-service quantity is **1–49**. **50+** is Enterprise / contact sales, not a second product or an automatic discount. `basic` / `pro` / `premium` are inactive historical plans. Application source does not hard-code 17900.

Stripe TEST proof, sandbox only, livemode false: organisation `4208626a-ef20-4f5a-b28e-0d8b9c778205` → customer `cus_VKwWNaJ4nwUTfM` → subscription `sub_1UKGdCFHnHXHuPOwgswtqBhL` → one item `si_VKwWH8Gngk0GkW` on price `price_1UKGWjFHnHXHuPOwO50TJS93` (product `prod_VKwPfVeu1Q3S21`) → quantity **3**. One verified TEST mapping. No LIVE mapping. LIVE locks **false / false**. Commerce is **`SBG_SAAS_COMMERCE=test`**, not live. An empty `SBG_SAAS_TEST_ORGANISATION_IDS` fail-closes. Only **CP31** may activate LIVE commerce.

Organisation billing is active, licensed_quantity **3**, price version as above, last event `evt_1UKKPiFHnHXHuPOwM7L3ZmoM`. That event is one `sbg_stripe_events` row, outcome `applied`, `processed_at` and billing `updated_at` both `2026-09-27T15:54:55.965Z`. Same-id replay did not rewrite the row. Hotel billing accounts **0**. Booking payments **0**.

Licence balance: licensed **3**, active allocations **0**, available **3**. Released historical rows for `cp26-licence-a`, `cp26-licence-b`, `cp26-licence-c`, and `cp26-licence-d` remain. Those hotels stay **unconfigured**. Protected hotels were not repurposed.

The paragraph above is the last Production commercial record through 0030. **Current next is CP30.2C, not started.** CP30.2A and CP30.2B passed. See the CP30.2B section at the top. No migration 0031. Do not enable LIVE commerce. Do not rerun the 0030 controller. Do not resume CP26C.3. Do not start CP27.4. Do not start CP30.2C from this note.

The section below is the historical path through CP26B and finalisation. Present-tense claims there that commerce is OFF, that prices are undefined, or that CP26 STRIPE TEST is next are the state **at that earlier checkpoint**.

## CP26B — CLOSED

Domain A subscription lifecycle, ordered billing persistence, and Production
migration 0024 are accepted. At CP26B, Domain A commerce was **OFF**. Only **CP31**
may activate real commerce. CP26C.1/C.2 isolation is in source. CP26C.3 is
**paused** (no Stripe objects; canonical amounts not invented). **CP26C-O3.1**
catalogue contract is accepted. **CP26C-O3.2** source migration 0026 was
verified, then **applied once** in Production (**CP26C-O3.2B PASS**).
**CP26C-O3.2C** reconciled Gate B to **0001–0026** and **retired** the
single-use 0026 dispatch surface. **CP26C-O3.3** implemented the Owner
commercial catalogue UI over that schema. Canonical amounts were not invented.
**CP26C-O2D** isolated Owner sign-in at `/owner/login`. Human verification of
that sign-in **passed**. **CP26C-O3.3V** passed: `/owner/plans` showed the
three active plans and no prices. **CP26C-O3R** reconciled the commercial
model to one organisation subscription and property-licence quantity.
**CP26 FINALISATION — PASS** applied 0027 and 0028 in Production, accepted them on Gate B, retired both dispatch workflows, and cut dormant Domain A from hotel tiers to organisation property-licence quantity. At the close of finalisation, commerce was still **OFF**, there was no price version, and there was no Stripe mapping. That snapshot is not the exit-gate state. **CP26 STRIPE TEST — PASS. CP26 EXIT GATE — PASS. CP26 — COMPLETE.** See the current section at the top of this file. The O4–O11 chain is superseded. Former **O3.4** is superseded. Do not resume CP26C.3.
Migration **0025** is **Production-applied**. Its dispatch workflow is **RETIRED** (controller script remains). First Production platform Owner is
**bootstrapped** (1 active grant). The first-Owner bootstrap workflow is **RETIRED**.

| Field | Value |
|---|---|
| CP26A.1 | **PASS** — Domain A commerce dormant (`SBG_SAAS_COMMERCE=off\|test\|live`; Production unset = fail-closed) |
| CP26A.2 | **PASS** — entitlement/publication decoupling; Production 0023 applied; dispatch retired |
| CP26A.3 | **PASS** — read-only design/preflight of operator-owned hotel lifecycle + fixture policy |
| CP26A.4 | **PASS** — local ownership → configured-not-live → billing UUID resolution; Domain A fail-closed; Domain B non-regression |
| CP26A.5 | **PASS** — one persistent Production verification identity + one owned hotel, **configured not live**, returning sign-in, billing GET |
| CP26A.6 | **PASS** — evidence reconciled; CP26A closed |
| CP26B.1 | **PASS** — Domain A application lifecycle: gate-before-write, one subscription, portal-first plan management |
| CP26B.2 | **SOURCE COMPLETE** — ordered Domain A webhook persistence |
| CP26B.3 | **CLOSED** — Production 0024 applied (GHA [35697938230](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35697938230)); already-applied verified (GHA [35699337916](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35699337916)) |
| CP26B.4 | **PASS** — Gate B accepted ledger **0001–0024**; 0024 `workflow_dispatch` retired; generic migrator remains fail-closed |
| **CP26B** | **CLOSED** |
| CP26C.1 | **PASS** — test-mode isolation architecture defined |
| CP26C.2 | **PASS** — Domain A test commerce isolated by hotel UUID allowlist (source) |
| CP26C.3 | **PAUSED AFTER SAFE PREFLIGHT** — no Stripe objects; no Vercel Stripe env |
| CP26C-O1 | **PASS** — Owner Control Plane architecture ([`docs/OWNER_CONTROL_PLANE.md`](docs/OWNER_CONTROL_PLANE.md)) |
| CP26C-O2 | **CLOSED** — Owner dashboard Production-proven |
| CP26C-O2A | **PASS** — single-use 0025 controller |
| CP26C-O2B | **PASS** — Production 0025 applied (GHA [35758982641](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35758982641)) |
| CP26C-O2C.1 | **PASS** — first-Owner bootstrap controller built |
| CP26C-O2C.2 | **PASS** — first Owner bootstrapped (GHA [36116463589](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36116463589)) |
| CP26C-O2C.3 | **PASS** — bootstrap dispatch retired; O2 closed |
| CP26C-O3.1 | **PASS** — commercial catalogue contract ([`docs/COMMERCIAL_CATALOGUE.md`](docs/COMMERCIAL_CATALOGUE.md)); amounts **UNDEFINED**; no migration |
| CP26C-O3.2 | **PASS** — source verified, then Production-applied in O3.2B |
| CP26C-O3.2A | **PASS** — single-use 0026 controller built; dispatch **RETIRED** in O3.2C |
| CP26C-O3.2B | **PASS** — Production 0026 applied once (GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457), job 108073574672) |
| CP26C-O3.2C | **PASS** — Gate B reconciled to **0001–0026**; 0026 dispatch retired |
| CP26C-O3.3 | **PASS** — Owner commercial catalogue UI; canonical amounts still **UNDEFINED**; no Production prices |
| CP26C-O2D | **PASS** — `/owner/login` sign-in only; hotel `/login` unchanged; no migration |
| CP26C-O3.3V | **PASS** — operator `/owner/plans` verification; no price created |
| CP26C-O3R | **PASS** — model reconciled in [`docs/COMMERCIAL_MODEL.md`](docs/COMMERCIAL_MODEL.md); no implementation at that checkpoint |
| CP26 FINALISATION | **PASS** — ledger **0001–0028**; dormant property-licence cutover. Finalisation snapshot: commerce still OFF and no price. Superseded by the Stripe TEST and exit gate |
| CP26 STRIPE TEST | **PASS** — one TEST organisation, customer, subscription, item, quantity 3, EUR 17900/month; webhook applied once; allocation proof then released |
| CP26 EXIT GATE | **PASS** — CP26 **COMPLETE**. Commerce remains **test**. LIVE locks false. At CP26 close, next was **CP27**, not started. Superseded by the CP28 section |
| Last application SHA | see current `main` after CP26 FINALISATION (19512c2 is the older CP26B.3R catalog identity, not current) |
| Fixture policy | [`docs/FIXTURE_POLICY.md`](docs/FIXTURE_POLICY.md) |
| Local harness | `src/lib/aether/cp26a4-fixture.ts` (tests only; not a runtime import) |
| Domain A | TEST commerce proven for one allowlisted organisation; not LIVE. Only **CP31** may activate LIVE commerce |
| Accepted Production ledger | **0001–0030** applied. `AUTHORISED_PENDING=[]`. 0030 digest `9dec121ac28b8bcca5554576816eb8c764d50f56b6b97c9f0199e0b926e8643f` applied (GHA [36448160139](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36448160139)); workflow **RETIRED**. Claim table installed. Checkout calls 0029. `SBG_DOMAIN_B_LIVE_CHECKOUT` is unset. Booking payments were **0** and were not mutated here |
| 0024 digest | `23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0` |
| 0025 digest | `575aabcb7322fc8ca63c8a3dd137d358f76375f1777ed59cf04c1d98d6c066fd` |
| 0026 file | `migrations/0026_cp26co3_commercial_catalogue.sql` |
| 0026 digest | `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446` (Production-applied once) |
| 0026 apply | GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457) job `108073574672` at `67d751014b6b5cbb5bd3c9ac4867fbad3da01b52` |
| 0025 controller | historical script `scripts/cp26co2a-0025-production-migrate.mjs`; workflow **RETIRED**; npm `db:migrate:0025` remains and is not invoked by build |
| First-Owner controller | historical script `scripts/cp26co2c-first-owner-bootstrap.mjs`; workflow **RETIRED** |
| Active platform Owners | **1** — OPERATOR CONTROLLED / REDACTED (owns `sbg-verify-a5`) |
| Human `/owner` proof | **PASS** — Overview, Hotels, Plans & Pricing, Revenue, System |
| **Next control-plane** | none inside CP26. **CP26 COMPLETE**. At CP26 close, next was **CP27**. Current next is the CP28 section |
| 0026 controller | historical script `scripts/cp26co32a-0026-production-migrate.mjs`; workflow **RETIRED**; npm alias **RETIRED** |
| Catalogue | `property_licence` **active**; `basic` / `pro` / `premium` **inactive** historical; one price version `b13f9445-d27a-4e7d-8128-a2238906ce7c` EUR **17900** month; one verified TEST mapping `price_1UKGWjFHnHXHuPOwO50TJS93`; no LIVE mapping; LIVE locks **false/false** |
| 0027 | applied once (GHA [36251190175](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36251190175)); digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef`; workflow **RETIRED**; script remains |
| 0028 | `migrations/0028_cp26fin_property_licence_catalogue.sql` applied once (GHA [36254890554](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36254890554)); digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d`; workflow **RETIRED**; controller `REQUIRED_LEDGER` frozen at **0001–0027** |
| **Next product** | **CP30.2C — NOT STARTED.** CP30.2A and CP30.2B passed. See the CP30.2B section at the top. CP27 is **CLOSED**. No migration 0031. Do not enable LIVE commerce |

Do not dispatch historical 0022/0023/0024 controllers or the retired 0025, 0026, 0027, 0028, 0029, or 0030 workflows. Do not rerun `scripts/cp272-0030-production-migrate.mjs`. Do not recreate the retired one-shot CP26 read workflows. Owner secret remains GitHub Actions `AETHER_DATABASE_OWNER_URL` only — never Vercel. The generic migrator never applies SQL. 0030 is accepted. 0031+ stays fail-closed.

Push to `main` currently auto-deploys Vercel Production. That is a known control-plane characteristic, not a commercial activation and not a LIVE switch. Ordered-webhook source is schema-capable. Domain A TEST webhooks are signature-verified. Commerce is **test**, allowlisted, and fail-closed when `SBG_SAAS_TEST_ORGANISATION_IDS` is empty. Do not set commerce to **live**.

`SBG_SAAS_COMMERCE=test` is set on Production for the completed CP26 Stripe TEST. It is not LIVE commerce. Domain A checkout uses `SBG_SAAS_TEST_ORGANISATION_IDS`. Historical hotel-keyed tests still use `SBG_SAAS_TEST_HOTEL_IDS`. Empty allowlists fail-close. Do not put a Production UUID or a secret value in git.

## Accepted baseline (commerce record at CP26; living pointer is the CP29.3 section)

| Field | Value |
|---|---|
| Product | **SCAN / BOOK / GO** (internal history name: Aether Transfer) |
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | Verification baseline `30173015216ca638a7d63736205fe20be11d3880`. `19512c295830fbc6fd9712d688ce364d940f87c3` is the older CP26B.3R catalog identity and the last *observed* deployment SHA, not current `main` |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| **CP26B** | **CLOSED** |
| **CP26** | **COMPLETE** — finalisation, Stripe TEST, and exit gate **PASS** |
| **CP27** | **CLOSED** |
| **CP28** | **CLOSED** — see the CP28 section |
| **CP29.2** | **CLOSED** — disposable load only. Not Production |
| **CP29.3** | **PASS** — measurement only. No optimisation |
| **CP29.4A** | **PASS** — Production pooler, `eu-central-1`, warm `SELECT 1` p50 93.429 ms. Diagnostic removed |
| **CP29** | **CLOSED** |
| **Next control-plane** | none; CP26C-O2 **CLOSED**; CP26C.3 not resumed |
| **Next product checkpoint** | **CP30 — NOT STARTED.** Only **CP31** activates LIVE commerce |
| Forward roadmap | **[docs/ROADMAP.md](docs/ROADMAP.md)** (CP27–CP31) |

### Production

| Field | Value |
|---|---|
| Vercel project | `scan-book-go` |
| Last observed deployment (CP26B.3V) | `dpl_FmUosqz2wy7aCT51rNjdanJnuviZ` |
| State | READY |
| Alias | `https://scan-book-go.vercel.app` |
| Deployed SHA (last observed) | `19512c295830fbc6fd9712d688ce364d940f87c3` |

A later push of this documentation/control-plane child may auto-deploy a new SHA. That must not switch commerce to **live**.

Environment (names/presence only):

| Variable | Production |
|---|---|
| `DATABASE_URL` | PRESENT (`aether_app` runtime LOGIN) |
| `AETHER_DATABASE_OWNER_URL` | ABSENT |
| `SBG_SAAS_COMMERCE` | PRESENT plain `test` (not live) |
| `BETTER_AUTH_SECRET` | PRESENT |
| `BETTER_AUTH_URL` | PRESENT |
| `STRIPE_SECRET_KEY` | PRESENT sensitive (value not recorded) |
| `STRIPE_WEBHOOK_SECRET` | PRESENT sensitive (value not recorded) |
| `SBG_SAAS_TEST_ORGANISATION_IDS` | PRESENT sensitive (value not recorded) |
| Resend / Ops credentials | not recorded as present |

### Database

| Layer | State |
|---|---|
| Source migrations | `0001`–`0030` present and applied |
| Production Neon | migrated through **0030** — pending **NONE** |
| 0028 | `property_licence` active; basic/pro/premium inactive; one price version EUR 17900 month; one verified TEST mapping; LIVE locks false/false |
| 0027 | organisation, member, organisation billing, allocation, and derived licence balance installed; one organisation billing row; four released allocation rows; active allocations 0 |
| 0026 | commercial catalogue schema installed; historical tier rows retained and now inactive |
| 0024 | ordered Domain A billing events (`event.created` bigint, `cancel_at_period_end`, stale/ambiguous/duplicate); 10-argument `sbg_apply_billing_event`; 8-argument function **absent** |
| 0023 | entitlement publication decoupling (`sbg_sync_hotel_entitlement` no longer writes `hotels.status`) |
| Runtime | `DATABASE_URL` → `aether_app` |
| Owner / migration plane | `AETHER_DATABASE_OWNER_URL` → `neondb_owner` (not on Vercel) |
| Preview | PGLite; `aether_runtime` SET ROLE only |
| Application build | `npm run build` does **not** migrate |
| Permanent Gate B | `.github/workflows/production-database.yml` (read-only); accepted ledger **0001–0030**; `AUTHORISED_PENDING=[]` |

Roles: `neondb_owner` = schema/migration owner; `aether_app` = production LOGIN; `aether_runtime` = PGLite/preview only. Production must not use SET ROLE or owner credentials as runtime.

CP26B.3V was a historical snapshot (hotels 4; billing accounts 0; Stripe events 0). It is not the current Production count. Exit-gate read [36336527434](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36336527434): ledger 28; one organisation; one applied Stripe event; hotel billing accounts 0; booking payments 0; active allocations 0; fixtures unconfigured.

### Auth (CP25G.3 CLOSED — do not reopen)

**Proven:** email/password signup; session creation; secure Production cookies (`__Host-`, HttpOnly, Secure, SameSite=Lax); authenticated `/app`; session persistence; sign-out; signed-out `/app` → `/login`.

**Production returning email/password authentication — PROVEN CP26A.5** (normal sign-out; unauthenticated `/app` protected; same identity and configured hotel recovered; no second user or hotel).

**Backlog / deferred:** copied-cookie stale-session replay; password recovery; email verification.

### Production verification tenant (RETAIN)

Classification: **PERSISTENT PRODUCTION VERIFICATION TENANT — RETAIN**.

| Field | Value |
|---|---|
| Identity | exactly one; operator-controlled email **REDACTED**; password in human password manager only |
| Hotel name | SBG Verification Hotel |
| Internal booking code | `sbg-verify-a5` |
| Public slug | `erification-otel` |
| Locality / TZ / currency | Verification Locality · Europe/Athens · EUR |
| Status | **configured** (not live, not guest-bookable) |
| Catalogue | Verification Transfer · Verification Airport · EUR 10.00 |
| Publication | `/erification-otel` and `/book/sbg-verify-a5` return `hotel_not_live` |
| Billing | authenticated GET `/app/billing` resolved this configured hotel; Connect/Checkout not invoked |
| Customer | **never** |

Do not delete casually. Do not publish. Do not attach the CP26 Stripe TEST subscription to `sbg-verify-a5`. Do not reuse CP25G.3 spent users or `demo-kos`.

### SaaS operator journey

```
account → hotel → service → preview → QR → plan → Stripe → LIVE
```

- `/app/*` exists and is authentication-gated.
- Onboarding through `/app` is **Production-proven** (CP26A.5) to **configured, not live**.
- Tenancy exists structurally (`app_hotel_accounts`). Schema remains many-to-many. Verification **policy** is one user / one hotel (not a new DB constraint).
- Billing ownership resolves by UUID then `ownedHotel`. Configured-not-live is valid for billing state. Live and Connect are not required.
- Stripe Connect and hotel-owned guest Checkout source exist. Domain B stays `mode=payment` on the hotel connected account, with no application fee. Production booking payments remain **0**.
- Domain A is organisation-scoped property-licence checkout. The browser does not choose Basic, Pro, or Premium, and does not choose a Stripe Price ID. Quantity is server-authorised (self-service 1–49). A missing `property_licence` price mapping fails closed. Commerce **test** may call Stripe only for an allowlisted organisation. Commerce **live** is not enabled.
- One organisation has at most one SBG subscription. A second Checkout is refused; management uses the portal.
- Domain A webhooks call `sbg_apply_organisation_billing_event`, retain quantity, and keep duplicate, stale, ambiguous, and conflicting-subscription protection. The 10-argument hotel function remains historical and is not the active path.
- Entitlement is an active/trialing/past_due organisation subscription plus an unreleased property allocation. Users are not licences. `hotels.status` is not SaaS publication.
- MRR/ARR is licensed quantity times the contracted price version. It is not `pending_catalogue`.
- `SBG_SAAS_COMMERCE=test` is set on Production. Do not change it to `live`. Domain A test mode uses `SBG_SAAS_TEST_ORGANISATION_IDS` and fail-closes when empty.

### Guest / Ops

- Guest booking exists. `demo-kos` is **live** on Production via **`/book/demo-kos`** and is **not** the SaaS verification tenant.
- `/demo-kos` slug route currently returns `hotel_not_found` (pre-existing; not caused by the verification fixture). Canonical demo remains `/book/demo-kos`.
- Hotel-owned guest payment source exists (`sbg_prepare_booking_payment`, then hotel Checkout on the hotel Stripe account). It is **not** Production-proven. CP28 created no Stripe object. Domain B is outside the Domain A kill-switch and stays locked unless `SBG_DOMAIN_B_LIVE_CHECKOUT` is exactly `true`.
- `/ops/*` remains isolated from SaaS `/app/*`. Production Ops credentials are absent.

### Known non-blocking findings (do not fix in CP26B.4)

- **Slug normalisation:** `sbg_slug_base` strips uppercase before `lower()`. `"SBG Verification Hotel"` → `erification-otel`. Do not rewrite the persisted verification slug without a later migration/redirect plan.
- **Auth UX:** `/login` defaults to account creation; returning users must choose Sign in. Security boundary passed.
- **Onboarding UX:** completed setup steps disappear from the flow (Step 2 vanished after the service persisted).
- **Demo slug/code:** `/book/demo-kos` works; `/demo-kos` does not resolve the live demo.

### What must not be claimed

- Do not claim CP17/CP19 is current.
- Do not claim CP22 is next or CP24 is current.
- Do not claim Neon is unproven or Vercel is disconnected.
- Do not claim migrations after 0017 are absent.
- Do not claim `/app/*` does not exist.
- Do not claim CP25G.3 remains open.
- Do not claim 0023 or 0024 is unapplied, or that a 0022/0023/0024 dispatch workflow remains.
- Do not claim returning Production sign-in is unproven.
- Do not claim the Production verification tenant does not exist.
- Do not treat CP26 as commercial go-live. Only CP31 activates LIVE commerce.
- Do not switch `SBG_SAAS_COMMERCE` to `live`. Do not resume CP26C.3. Former CP26C.4 and the O4–O11 chain stay superseded. Empty allowlists fail-close.
- Do not invent CP26B.5.
- Do not claim CP26 STRIPE TEST is still pending, or that CP26 is incomplete.

Canonical forward path: **`docs/ROADMAP.md`**. Commercial model: **`docs/COMMERCIAL_MODEL.md`**. Commercial catalogue: **`docs/COMMERCIAL_CATALOGUE.md`**. Fixture policy: **`docs/FIXTURE_POLICY.md`**. Owner architecture: **`docs/OWNER_CONTROL_PLANE.md`**. **CP26 COMPLETE. CP27 CLOSED. CP28 CLOSED.** Gate B accepted ledger is **0001–0030**. `AUTHORISED_PENDING=[]`. 0027 digest `1710fa05f3ab05d77a86ef061df43a9239220fa9d955f03628fdca39a9c08eef` applied (GHA [36251190175](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36251190175)). 0028 digest `35626cb2d3b21a076f4a2cb982b9d0983610620fb21dbf7f3e94eb4c0576a02d` applied (GHA [36254890554](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36254890554)). 0029 and 0030 are applied; see the CP28 section. 0025–0030 dispatch workflows are **RETIRED**. `property_licence` is the only active plan. basic/pro/premium are inactive. One price version EUR 17900 month. One verified TEST mapping. No LIVE mapping. One TEST organisation, one subscription, quantity 3. Licensed 3, active allocations 0, available 3. Commerce **test**, not live. **Next is CP30 — NOT STARTED.** CP29 is **CLOSED**. Only **CP31** activates LIVE commerce. Historical O3.2B remains PASS (GHA [36135836457](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36135836457)). Active Production platform Owners: **1**. First-Owner bootstrap workflow **RETIRED** (historical run [36116463589](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/36116463589)). Password never enters git.

Non-blocking UI backlog: Owner header rendered “SSBG Verification” (presentation/spacing or avatar-initial concatenation). Deferred. Not an authorization defect.

GitHub `main` at the current SHA is authoritative application source. A workspace is never authoritative. Recovery ZIPs are secondary disaster-recovery artifacts. The CP10 ZIP must not be extracted over a newer Git tree without explicit human approval.

---

## Historical (not current)

- CP26B.3 CLOSED — Production 0024 via GHA [35697938230](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35697938230); already-applied verification GHA [35699337916](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35699337916); digest `23cdc44037e0e886444477fdb693536a95c32b6080984de4076cc7a5f71d13c0`; controller identity repair SHA `19512c2`; demo-kos remained live; billing 0; events 0.
- CP26B.2 SOURCE COMPLETE — ordered persistence source SHA `ff2581f`; docs SHA `2939948`; 0024 not applied in that child.
- CP26A.5 COMPLETE — one Production verification identity + hotel `sbg-verify-a5` configured-not-live; returning sign-in proven; billing GET only; no Stripe.
- CP26A.2 COMPLETE — Production 0023 via GHA run [35581165068](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/35581165068); controller SHA `b35ef2f`; 0023 SHA-256 `469eeee3c8707beb40a2a268bea53c77620265efb969bfbff12c524e17585ba1`; demo-kos remained live; single-use 0022/0023 `workflow_dispatch` retired.
- `cp17-known-good` / `45e171a23037b7c94005018cd2126033a449d6f0` — immutable CP16C/CP17 source tag. Not current `main`.
- CP10 occupancy ZIP — historical disaster-recovery artifact only.
- CP19 originally meant Neon binding/verification. That work completed in later controlled production checkpoints; do not treat the old “CP19 unfinished” wording as living state.
- CP22–CP25 / CP25G.3 source and production work happened after CP17. See `docs/CP22_V1_OPERATOR_ONBOARDING.md`, `docs/CP23_PUBLIC_HOTEL_SLUG.md`, `docs/CP24_STRIPE_BILLING.md` as **completed checkpoint specifications**, not as the next task.
- Single-use 0022/0023/0024 GitHub Actions workflows existed to apply those migrations once. They were retired after successful Production application. Scripts remain as historical/test evidence (already-applied = no-op).
