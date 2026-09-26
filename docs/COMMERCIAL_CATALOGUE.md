# SCAN BOOK GO — commercial catalogue contract

**CP26C-O3.1.** Architecture and contract only. This document is the commercial
authority for the catalogue mechanism that was implemented. It is not a
migration, not a runtime change, and not permission to create Stripe objects
or invent prices.

**CP26C-O3R** supersedes the three-tier commercial target. Cardinality, the
organisation subscription, and property-licence quantity are decided in
[`COMMERCIAL_MODEL.md`](COMMERCIAL_MODEL.md). That document wins where this
file still describes BASIC / PRO / PREMIUM feature tiers, or one subscription
per hotel, as the future model. Historical sections below are not rewritten.

Where this document disagrees with [`OWNER_CONTROL_PLANE.md`](OWNER_CONTROL_PLANE.md)
§5.3, §6, §7, §8, or §19 on catalogue mechanism, **this document wins**. Figures previously used there
only to illustrate a price change are **not** canonical amounts. Canonical
BASIC / PRO / PREMIUM amounts are **UNDEFINED**. Do not price those tiers.

Living execution: [`ROADMAP.md`](ROADMAP.md). Owner surface:
[`OWNER_CONTROL_PLANE.md`](OWNER_CONTROL_PLANE.md). Fixture identity:
[`FIXTURE_POLICY.md`](FIXTURE_POLICY.md).

| Field | Value |
|---|---|
| Status | **CP26C-O3.1 PASS**. **CP26C-O3.2 PASS**. **CP26C-O3.2B PASS** — Production applied. **CP26C-O3.2C PASS** — controller retired. **CP26C-O3.3 PASS** — Owner catalogue UI. **CP26C-O3.3V PASS** (operator). **CP26C-O3R PASS** — model reconciled, not implemented |
| Next | **CP26C-O4.1** source-only organisation persistence (not started). Former **O3.4** superseded. **CP26C.3** not resumed |
| 0026 | `migrations/0026_cp26co3_commercial_catalogue.sql` — digest `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446` — **applied once** (GHA 36135836457) |
| Commerce | **OFF** (`SBG_SAAS_COMMERCE` absent) |
| CP26C.3 | **PAUSED** — do not resume; three-tier TEST Prices are superseded by O3R |
| CP31 | only checkpoint that may activate LIVE commerce |
| Gate B | accepted ledger **0001–0026**; `AUTHORISED_PENDING=[]` |
| Prices | versions **0**; Stripe mappings **0**; LIVE locks **false/false**; amounts **UNDEFINED** |

**CP26C-O3.3.** `/owner/plans` now reads `sbg_saas_plans`, `sbg_saas_price_versions`, `sbg_saas_stripe_mappings`, `sbg_saas_commerce_locks`, and catalogue rows in `sbg_owner_audit_events`. Mutations call only `sbg_catalogue_update_plan`, `sbg_catalogue_create_price_version`, `sbg_catalogue_activate_price_version`, and `sbg_catalogue_retire_price_version`. The UI does not call Stripe, does not call `sbg_catalogue_record_stripe_mapping`, and cannot set LIVE locks. With zero price versions the page shows “Price not configured”, not €0. The paragraph below that still says `getOwnerPlansFn` returns `pending_o3` is the **O3.1** baseline, not the current UI.

---

## 1. What exists today

Proven from source at the O3.1 baseline. Not inferred policy.

### Plan identity

Machine plan keys are exactly `basic`, `pro`, `premium`.

- `StripePlan` in `src/lib/aether/stripe.server.ts`
- `SBG_SAAS_PLAN_CODES` / `SBG_SAAS_PLAN_LABELS` in `src/lib/aether/owner-queries.ts` (labels Basic / Pro / Premium)
- `/app/billing` offers those three keys and no others (`src/routes/app.billing.tsx`)
- Domain A webhook allowlist is the three env keys only (`configuredDomainAPriceIds` in `src/lib/aether/saas-billing-webhook.ts`)

No other SaaS plan key exists. These keys must stay stable. Display labels may
change later. Billing persistence and Checkout metadata already use the keys
(`startDomainACheckout` takes `plan: StripePlan`). A casual rename would orphan
webhook allowlisting and hotel plan selection.

### Price authority today (the defect)

There is **no** database catalogue.

Checkout resolves a plan key to a Stripe Price ID only through environment:

`stripePriceId(plan)` reads `STRIPE_${PLAN}_PRICE_ID`
(`STRIPE_BASIC_PRICE_ID`, `STRIPE_PRO_PRICE_ID`, `STRIPE_PREMIUM_PRICE_ID`).

`startDomainACheckout` (`src/lib/aether/saas-billing.server.ts`) then:

1. checks hotel ownership
2. `assertCheckoutAllowed` (one subscription; portal-first if one exists)
3. reads the env Price ID
4. `assertDomainACommerceAllowedForHotel` (commerce off / test allowlist / live)
5. writes that Price ID via `sbg_set_billing_price_for_user` **before** Checkout
6. opens Stripe Checkout with `line_items[0][price]`

The webhook accepts a Domain A price only if it is one of those three env
values (`assertDomainAWebhookPriceId`). Unknown prices fail closed. The plan
key is **not** stored on `sbg_billing_accounts`. Only `stripe_price_id` is.

Production does not have those env vars, `STRIPE_SECRET_KEY`,
`SBG_SAAS_COMMERCE`, or `SBG_SAAS_TEST_HOTEL_IDS`. Commerce is fail-closed off.
Test fixtures use non-production ids such as `price_sbg_test_basic`. Those are
**not** canonical prices and **not** amounts.

`/owner/plans` (`getOwnerPlansFn`) returns `catalogue: "pending_o3"` and
`amount: "pending_catalogue"`. It also hardcodes `interval: "month"` and
`currency: "EUR"`. Those two literals are **UI placeholders**, not accepted
commercial terms and not seeded prices.

### Billing persistence today

`sbg_billing_accounts` (0020, extended by 0024):

| Column | Role |
|---|---|
| `hotel_id` | PK, one SaaS billing row per hotel |
| `stripe_customer_id` | Stripe customer mirror |
| `stripe_subscription_id` | Stripe subscription mirror |
| `stripe_price_id` | Stripe Price mirror, not an SBG version |
| `status` | `inactive`, `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `paused`, `unpaid`, `canceled` |
| `current_period_end` | Stripe period end |
| `cancel_at_period_end` | 0024 |
| `last_stripe_event_created` | 0024 ordering, bigint Unix seconds |
| `last_stripe_event_id` | 0024 ordering pair |
| `updated_at` | last write |

Ordered apply is the 10-argument function from 0024:

`sbg_apply_billing_event(text, text, bigint, uuid, text, text, text, text, timestamptz, boolean) returns text`

Outcomes: `applied`, `duplicate`, `stale`, `ambiguous`, `rejected`.
Idempotency is `sbg_stripe_events.event_id`. Stale and same-second ambiguous
events must not change the account. This contract **must not** weaken that.

The row is **current state**, not price history. `stripe_price_id` is
overwritten (via `coalesce`) when a newer event applies. That cannot answer
“which SBG commercial version was purchased” once env Price IDs move or a
mapping is replaced.

`sbg_set_billing_price_for_user` may write a Price ID while status is still
`inactive`, before Checkout completes. That write is an intent mirror, **not**
proof of purchase. A catalogue version is bound only when an ordered billing
event **applies**.

### Entitlement and publication today

`isSaasEntitled` is binary: status ∈ `active`, `trialing`, `past_due`
(`src/lib/aether/saas-lifecycle.ts`). It does not differ by plan.

There is **no** plan-feature or machine entitlement engine. `hotel_services`
and `hotel_destinations` are hotel configuration (Domain B), not SaaS tiers.

0023 replaced `sbg_sync_hotel_entitlement` so it **returns** `hotels.status`
and does **not** write it. Publication stays an onboarding/provision concern.
Catalogue work must not undo that.

### Owner money today

Overview and Revenue loaders set `mrr`, `arr`, and `planDistribution` to the
literal `pending_catalogue`. Revenue counts subscription statuses for Domain A
hotels only. It does not read Stripe for prices and does not read Domain B
payment volume.

### Owner authority today

0025: `sbg_platform_owners` plus append-only `sbg_owner_audit_events`.
Runtime `aether_app` has SELECT only. Grant/revoke are SECURITY DEFINER and
require an already-active Owner. Bootstrap EXECUTE is not granted to
`aether_app`. The bootstrap workflow is retired. Active Production Owners: 1
(OPERATOR CONTROLLED / REDACTED).

Audit columns already fit commercial history: `at`, `actor_user_id`, `action`,
`target_type`, `target_id`, `metadata jsonb`. Insert-only. `actor_user_id`
on delete restrict. No action enum, so new action strings do not need a 0025
rewrite.

### Domain split today

Domain A Checkout is `mode=subscription` on the platform Stripe account.
Domain B guest transfer Checkout is `mode=payment` on the hotel connected
account, with `price_data.unit_amount` taken from `hotel_destinations`.
Verification Airport **EUR 10.00** is that Domain B fixture. It is not a SaaS
plan price.

---

## 2. Authority

SCAN BOOK GO owns the commercial catalogue.

Stripe is the payment processor and the external Price/Product mapping only.
Stripe must not decide what SBG sells, which amount is current, or what a
historical subscription was worth.

Vercel env Price IDs are **transitional**. They are the current runtime lookup
and must not remain the long-term source of truth. Production does not have
them today. Later cutover **does not** dual-read them (see §11).

`SBG_SAAS_COMMERCE` remains the runtime commerce switch (`off` | `test` |
`live`). Catalogue rows have **zero** authority to turn that switch on.
Absent env means off.

Secrets (`sk_`, `whsec_`, `DATABASE_URL`, owner URL) are never catalogue
columns.

---

## 3. Plan model

Table (0026, not created here): `sbg_saas_plans`.

| Column | Rule |
|---|---|
| `code` | `text` primary key. Check `code in ('basic','pro','premium')`. Immutable |
| `name` | display label. Seeded `Basic`, `Pro`, `Premium`. Owner may edit |
| `description` | `text not null default ''`. Display only. Seeded empty. Not a feature matrix |
| `sort_order` | integer. Seed `10`, `20`, `30` |
| `active` | boolean. Seed `true`. Inactive hides the plan from **new** Checkout only |
| `created_at` / `updated_at` | `timestamptz` |

A plan key survives every price change. The amount is **not** a column on the
plan.

V1 does not let the Owner insert a fourth plan. A new key is a later explicit
migration that extends the check. Deactivate rather than delete. No DELETE
function. A trigger rejects DELETE.

`active = true` means the identity may receive a price. It does **not** enable
commerce, Checkout, or hotel publication.

No entitlements table in 0026. Machine access stays the existing binary
subscription entitlement, identical for every plan, until a later checkpoint
defines real capabilities. Do not invent feature bullets (limits, channels,
support tiers). `description` is the only display differentiator.

---

## 4. Price version model

Table: `sbg_saas_price_versions`.

Commercial terms are environment-independent. TEST vs LIVE is **not** a column
here. Confirmed against current source: one plan key is sold; Stripe mode is
chosen by `SBG_SAAS_COMMERCE` and the secret key, not by a second commercial
amount. O1’s `stripe_test_price_id` / `stripe_live_price_id` columns on the
version are **rejected** — overwriting them destroys mapping history.

| Column | Rule |
|---|---|
| `id` | `uuid` PK |
| `plan_code` | FK → `sbg_saas_plans(code)` |
| `currency` | `text`. V1 check `= 'EUR'` |
| `amount_minor` | `integer`. Check `> 0`. Minor units. Never float |
| `billing_interval` | `text`. V1 check `= 'month'` |
| `interval_count` | `smallint`. V1 check `= 1` |
| `effective_from` | `timestamptz` null until first activation; then immutable |
| `retired_at` | `timestamptz` null until retire; then immutable |
| `purchasable` | `boolean not null default false` |
| `created_at` | `timestamptz` |
| `created_by_user_id` | FK → `"user"("id")` not null |

V1 shape **EUR / month / count 1** confirms the O1 contract and the current
placeholder on `/owner/plans`. It is **not** an amount. Annual and other
currencies wait for a later checkpoint that relaxes the checks and states the
MRR normalisation in §8. 0026 functions reject anything else.

No price rows are seeded. Amounts stay UNDEFINED until the authorised
price-version checkpoint (**CP26C-O8**). Former **O3.4** must not price the
three tiers. Nobody, including a migration, may invent them.

### Rules

1. Amount, currency, interval, interval count, plan code, id, created_at, and
   created_by are immutable as soon as the row exists. A BEFORE UPDATE trigger
   raises if they change. There is no edit-amount operation, including for
   unused drafts. A mistake is a new version.
2. A price change creates a new version. The old amount stays on the old row.
3. At most one `purchasable` row per `(plan_code, currency, billing_interval)`.
   Partial unique index. The activation function clears the previous
   `purchasable` flag in the same transaction, then sets the new one.
   Clearing `purchasable` does **not** set `retired_at`.
4. Historical versions stay queryable. No delete trigger allows removal,
   referenced or not.
5. Existing subscriptions are not moved when a new version becomes purchasable.
6. Moving existing subscribers requires a future explicit migration tool. The
   Owner UI must not do it.
7. Retire sets `retired_at` and `purchasable = false`. New Checkout cannot use
   it. History remains. Un-retire is forbidden.
8. Activation sets `effective_from` once, if still null.
9. A retired version cannot be activated.
10. An inactive plan cannot be given a new purchasable version. Existing
    subscribers on that plan are left untouched.

`purchasable` means “offered to new Checkout”. It does not mean “LIVE commerce
is on”.

---

## 5. Stripe mapping model

Table: `sbg_saas_stripe_mappings`.

| Column | Rule |
|---|---|
| `id` | `uuid` PK |
| `price_version_id` | FK → `sbg_saas_price_versions(id)` |
| `environment` | `text` check `in ('test','live')` |
| `stripe_product_id` | `text` check `^prod_[A-Za-z0-9_]+$` |
| `stripe_price_id` | `text` check `^price_[A-Za-z0-9_]+$` (same shape as `assertStripePriceId`) |
| `status` | `text` check `in ('verified','replaced')` |
| `created_at` / `mapped_at` | `timestamptz` |
| `actor_user_id` | nullable FK → `"user"("id")`. Null only for a controller that has no end-user session; the audit metadata must still name the checkpoint |

Unique:

- `unique (stripe_price_id)` globally, so one Price ID cannot satisfy both TEST and LIVE
- `unique (price_version_id, environment) where status = 'verified'`

A TEST Price never satisfies a LIVE lookup, and the reverse. Replacement
inserts a new row and marks the previous verified row `replaced`. Replaced
rows stay so historical subscriptions still resolve. No delete.

Mapping status before any row exists is **not mapped**. The Owner UI shows
that. It does not offer a text field for a Price ID.

Preferred Stripe shape, not created here:

- one Stripe Product per environment, name **SCAN BOOK GO**
- many immutable recurring Prices under that Product
- one SBG price version maps to one Stripe Price in each environment
- not one Product per plan (the plan key already lives in SBG; portal price
  switches stay inside one product)

Product IDs differ between Stripe test mode and live mode. They are separate
mapping rows, not one shared id.

### Locks

Singleton `sbg_saas_commerce_locks` (`id smallint` check `= 1`):

| Column | 0026 seed |
|---|---|
| `live_mapping_enabled` | `false` |
| `live_checkout_enabled` | `false` |

No function granted to `aether_app` can set either to true. Only a later
owner-plane migration at **CP31** may. 0026 inserts the false row.

`SBG_SAAS_COMMERCE` is still required for any Stripe call. The locks are an
extra fail-closed. Both must allow live. Neither is a second commerce switch
the Owner can flip.

---

## 6. Owner permission model

Only an **active** platform Owner (`sbg_platform_owners.revoked_at is null`)
may mutate the catalogue.

Hotel operators may, later, **read** the current purchasable display (name,
description, amount, currency, interval) and start Checkout for their own
hotel. They must not create plans, create or activate or retire versions,
write mappings, or edit history.

`/owner/plans` operations, and no others:

| Operation | Function | Granted to `aether_app` |
|---|---|---|
| View plans, versions, mapping state | SELECT | yes |
| Update plan display name, description, sort, active flag | `sbg_catalogue_update_plan` | yes |
| Create a draft price version | `sbg_catalogue_create_price_version` | yes |
| Make a version the single purchasable offer | `sbg_catalogue_activate_price_version` | yes |
| Retire future purchasing | `sbg_catalogue_retire_price_version` | yes |
| Record a Stripe mapping | `sbg_catalogue_record_stripe_mapping` | **no** — owner-plane only |

No DELETE operation. No “edit amount”. No button that enables LIVE checkout
or LIVE mapping. No browser call to Stripe.

Every mutation function:

1. locks the actor’s owner row `FOR SHARE`
2. re-checks `revoked_at is null` (concurrent revoke waits, then fails `42501`)
3. performs the change
4. inserts `sbg_owner_audit_events` in the **same** transaction
5. `search_path = public, pg_temp`

Direct table INSERT/UPDATE/DELETE is not granted to `aether_app`. Hotel-operator
server functions must not call the mutation functions. Knowing a version UUID
is not authorization.

---

## 7. Audit model

Reuse `sbg_owner_audit_events`. A second commercial audit table would split
“who did this” without adding history the jsonb payload cannot hold. Do not
reuse the booking `audit_events` table (`actor_id uuid`).

0026 adds a BEFORE UPDATE OR DELETE trigger on `sbg_owner_audit_events` that
always raises. That does not rewrite 0025 and does not block the existing
grant/revoke inserts.

| Action | Target type | Target id | Metadata (no secrets) |
|---|---|---|---|
| `catalogue.plan.created` | `commercial_plan` | plan code | seed source `migration:0026` when actor is null |
| `catalogue.plan.updated` | `commercial_plan` | plan code | `before` / `after` for name, description, sort_order, active |
| `catalogue.price.created` | `commercial_price_version` | version uuid | plan code, currency, amount_minor, interval, interval_count |
| `catalogue.price.activated` | `commercial_price_version` | version uuid | previous purchasable version id or null |
| `catalogue.price.retired` | `commercial_price_version` | version uuid | plan code |
| `catalogue.stripe_mapping.created` | `commercial_stripe_mapping` | mapping uuid | version id, environment, product id, price id, status |
| `catalogue.stripe_mapping.replaced` | `commercial_stripe_mapping` | previous mapping uuid | replacement mapping id, environment |

Price IDs in metadata are identifiers, not credentials. Never store secret keys,
webhook secrets, or email addresses.

---

## 8. MRR / ARR

Until **all** of the following are true, Overview and Revenue keep the literal
`pending_catalogue` for MRR, ARR, and plan distribution:

1. catalogue tables exist
2. every entitled billing row has a non-null catalogue price version
3. that version has an immutable `amount_minor`

No fallback to env Price IDs. No Stripe price retrieve. No invented amount.
If **any** entitled subscription lacks a version, the whole metric stays
`pending_catalogue` (no partial sum).

When the catalogue exists and entitled count is 0, MRR is `0` and ARR is `0`.
That state is distinguishable from “cannot price”.

Included statuses (same set as `isSaasEntitled`):

| Status | MRR |
|---|---|
| `active` | include the attached version’s monthly amount |
| `trialing` | include. This is contracted recurring price of entitled access, not cash collected |
| `past_due` | include. Still entitled. Not a collections metric |
| `canceled`, `incomplete`, `incomplete_expired`, `unpaid`, `paused`, `inactive` | exclude |

V1 versions are monthly, so:

- MRR = sum of included `amount_minor` (one currency: EUR)
- ARR = MRR × 12, a projection, not an accounting close

If a later checkpoint allows `year`, do not route annual through `MRR × 12`
after rounding. Annualise each subscription (month × 12, year × 1) and set
MRR from that annualised sum with integer half-up division by 12. Mixed
currencies fail closed back to `pending_catalogue`. No FX.

Plan distribution, when MRR is numeric, counts entitled rows by `plan_code`
of the **attached** version, not by the plan’s current purchasable version.

---

## 9. Checkout resolution (target, not implemented)

Current code stays on env Price IDs until **CP26C.4**. O3.1 does not change it.

Target, fail closed:

```
hotel
  → stable plan code the operator selected
  → the single purchasable, non-retired version for that plan (EUR / month)
  → verified Stripe mapping for the active commerce environment
  → Stripe Price ID
  → Checkout
```

Fail closed when:

- commerce mode is off
- test mode and the hotel is not on the explicit allowlist
- live mode or live mapping while `live_checkout_enabled` is false
- plan inactive or unknown
- no purchasable version
- version retired
- no verified mapping for **this** environment
- more than one verified mapping
- currency or interval is not the V1 contract
- returned Stripe `livemode` disagrees with `SBG_SAAS_COMMERCE`

The browser never sends a Stripe Price ID. Server resolution only.

Read function (created in 0026, **not called** by runtime until C.4):

`sbg_resolve_domain_a_checkout_price(p_plan_code text, p_environment text) returns text`

EXECUTE granted to `aether_app`. It raises if the locks or uniqueness rules fail.
It does not consult env vars.

Checkout metadata should then include `plan_code` and `price_version_id` in
addition to the existing `hotel_id` and `user_id`. Metadata is a hint. The
mapping row is the authority.

---

## 10. Subscription persistence (target, not in 0026)

0026 **does not** alter `sbg_billing_accounts` and **does not** replace
`sbg_apply_billing_event`.

**CP26C.4** adds nullable:

`sbg_billing_accounts.catalogue_price_version_id uuid null references sbg_saas_price_versions(id)`

No backfill that guesses a version. Existing rows stay null. Null on an
entitled row keeps MRR at `pending_catalogue`.

Binding rules:

- Set the column only when ordered apply returns `applied`, in the **same**
  database transaction.
- Resolve the event’s Stripe Price ID through `sbg_saas_stripe_mappings`
  (`verified` **or** `replaced`, environment = this event’s livemode).
- Unknown Price ID: do not invent a version. Webhook stays fail-closed **before**
  apply, as today, so a bad price never becomes `applied`.
- Do not retarget the account to the plan’s current purchasable version.
  The mapping of the Price on the event is the version.
- A newer applied event with a different mapped price may update the column
  (portal or scheduled plan change). Stale, duplicate, ambiguous, and rejected
  outcomes must not.
- Null price on an event must not clear a previously bound version (same
  `coalesce` idea as `stripe_price_id`).
- The pre-Checkout `sbg_set_billing_price_for_user` write does not set
  `catalogue_price_version_id`.

Implementation shape: a new wrapper function that calls the existing 10-arg
apply and then, only on `applied`, sets the version. Do not drop or replace
the 0024 function. Do not change event ordering or idempotency.

---



| Checkpoint | Does | Does not |
|---|---|---|
| **O3.1** (this) | This contract | Migration, SQL apply, Stripe, prices, runtime |
| **O3.2** | Source file `0026` as specified in §12. Tests for that SQL. Gate B still **rejects** 0026 as unaccepted until a dedicated controller | Production apply, generic migrator change that applies SQL, Stripe, amounts, Checkout change |
| **O3.2 apply** | Single-use Production controller, explicit later authorisation, same discipline as 0025. Not implied by writing the file | Commerce on, Stripe objects, price invention |
| **O3.3** | `/owner/plans` UI in §13 | Stripe API from the browser, LIVE controls, Checkout cutover |
| **O3.4** | Human Owner records canonical amounts on Production through that UI, then verifies rows | Seeded amounts, Stripe objects, allowlisting `sbg-verify-a5` |
| **CP26C.3** | After O3.4 only. Create Stripe **TEST** Product + Prices for accepted purchasable versions. Owner-plane mapping insert, status `verified`, environment `test` | LIVE keys, LIVE products, LIVE prices, charges, subscriptions, Vercel Stripe env, Checkout cutover, `SBG_SAAS_COMMERCE`, allowlist |
| **CP26C.4** | Switch Checkout and Domain A webhook off env Price IDs onto catalogue resolution. Add `catalogue_price_version_id`. No env fallback | LIVE commerce. Public Production test commerce still needs the explicit allowlist |
| **CP31** | The only checkpoint that may set live locks, create LIVE mappings, and set `SBG_SAAS_COMMERCE=live` | Started from this contract |

**No dual-read.** O1’s “catalogue then env” fallback is superseded. A stale env
Price ID must not override or fill in for the catalogue. Before C.4, runtime
keeps today’s env lookup; Production env IDs are absent, so Checkout stays
fail-closed. After C.4, unknown and env-only prices fail closed.

C.3 does **not** copy Price IDs into Vercel. That compatibility copy is
rejected.

Public Production test commerce stays forbidden. Former CP26C.4 is superseded.
Empty allowlist fail-closes every hotel. Live mode ignores the allowlist.
Only CP31 may turn live on. Continuation is [`COMMERCIAL_MODEL.md`](COMMERCIAL_MODEL.md).

0026 did not extend Gate B by itself. `AUTHORISED_PENDING` stays empty.
O3.2C, after the accepted O3.2B apply, moved the pin to **0001–0026**.
0027+ remains fail-closed until its own checkpoint.

---

## 12. Proposed 0026 schema

**Do not create this file in O3.1.**

Additive only. Do not edit `0001`–`0025`. Do not `UPDATE` or `DELETE`
`sbg_billing_accounts`, `sbg_stripe_events`, hotels, or Stripe. No commerce
flag. No hotel id on catalogue tables (seed is not a hotel attachment).

### Tables

As specified in §3–§5, plus:

- FKs named above
- `revoke all` from `public` on every new table and function
- `grant select` on the three catalogue tables and the locks table to `aether_app`
- no INSERT/UPDATE/DELETE grant to `aether_app`

### Indexes

- `sbg_saas_plans` PK `code`
- `sbg_saas_price_versions` PK `id`
- partial unique `(plan_code, currency, billing_interval) where purchasable`
- index `(plan_code, created_at desc)` for history
- `sbg_saas_stripe_mappings` PK `id`
- unique `(stripe_price_id)`
- partial unique `(price_version_id, environment) where status = 'verified'`
- locks PK `id`

### Triggers (invariants a unique index cannot express alone)

| Trigger | Why a check is not enough |
|---|---|
| Price version BEFORE UPDATE | Blocks mutation of commercial terms even by the table owner. Allows only `purchasable`, `retired_at`, `effective_from` transitions stated in §4 |
| BEFORE DELETE on plans, versions, mappings | Delete is never a normal operation |
| BEFORE UPDATE OR DELETE on `sbg_owner_audit_events` | Audit cannot be rewritten |
| Activation unique index | One purchasable offer. The function must drop the old flag before setting the new one, same transaction, plan row locked |

The single-purchasable transition is transaction-safe only inside
`sbg_catalogue_activate_price_version` (lock plan, clear previous, set new,
audit). The index is the backstop, not the workflow.

Live rejection is **not** a static check: `sbg_catalogue_record_stripe_mapping`
reads `live_mapping_enabled` and raises if the environment is `live` while the
flag is false. Checkout resolution reads `live_checkout_enabled` the same way.

### Seed (identities only)

```text
basic   Basic    description ''   sort 10   active true
pro     Pro      description ''   sort 20   active true
premium Premium  description ''   sort 30   active true
```

Plus one locks row, both flags false. Plus three `catalogue.plan.created`
audit rows, `actor_user_id` null, metadata `{"source":"migration:0026"}`.

No `sbg_saas_price_versions` rows. No mappings. No amounts.

### Privileges

| Object | `aether_app` |
|---|---|
| Catalogue and locks tables | SELECT |
| `sbg_catalogue_update_plan` | EXECUTE |
| `sbg_catalogue_create_price_version` | EXECUTE |
| `sbg_catalogue_activate_price_version` | EXECUTE |
| `sbg_catalogue_retire_price_version` | EXECUTE |
| `sbg_resolve_domain_a_checkout_price` | EXECUTE (unused until C.4) |
| `sbg_catalogue_record_stripe_mapping` | **not granted** |
| Any function that sets live locks | does not exist |

Owner-plane record-mapping is the same privilege pattern as
`sbg_bootstrap_platform_owner`: the function exists, runtime cannot execute it.

---

## 13. `/owner/plans` UX (O3.3)

Minimum page. Not an ERP.

```text
Plans & Pricing

BASIC
  current price: Not configured
  Stripe TEST: Not mapped
  Stripe LIVE: Not mapped
  status: Active

PRO
  …

PREMIUM
  …
```

Opening a plan shows description, current price, price history, and mapping
state. The Owner may edit description and display name, create a new price,
activate it, and retire future purchasing.

Activating or creating a price shows:

> Existing subscriptions remain on their current price.

Empty amount stays “Not configured”. Do not render the placeholder EUR/month
from today’s loader as if it were a price. Once a real version exists, show
that version’s currency, minor-unit amount formatted for display, and interval.

Do not show secret keys. Do not show a Stripe ID input. Do not show a LIVE
enable control. Mapping lines are read-only status.

---

## 14. Security

| Threat | Control |
|---|---|
| Hotel operator mutates catalogue | Mutation functions require an active Owner. Operator routes never call them |
| IDOR on plan/price ids | Catalogue is global. Authorization is the Owner check, not object tenancy |
| Direct `select function(...)` | SECURITY DEFINER re-checks Owner under a row lock. Mapping function not granted to runtime |
| Price tampering | No amount update. Trigger plus absent UPDATE grant |
| Zero, negative, non-integer | `integer` and `amount_minor > 0`. Function rejects null |
| Currency or interval manipulation | V1 checks EUR and month only |
| Two purchasable versions | Partial unique index + locked activation transaction |
| Historical rewrite | Trigger. No un-retire. No delete |
| TEST/LIVE mix-up | `environment` column, global unique Price ID, resolver filters environment, live flags default false |
| Fake Stripe Price ID | Format check. UI cannot submit one. Only the owner-plane recorder writes mappings, after Stripe returns the id (C.3 / CP31) |
| Catalogue publishes a hotel | Functions and tables do not reference `hotels` writes. 0023 stays authoritative |
| Audit delete or edit | Trigger. No grants |
| Owner revoked mid-operation | `FOR SHARE` on the actor row; re-check; otherwise `42501` and rollback including the audit insert |
| Last Owner | Unchanged 0025 rule. Catalogue functions do not revoke Owners |
| Commerce escalation | Locks false. No env writes. Resolver unused until C.4. `SBG_SAAS_COMMERCE` absent stays off |

---

## 15. Publication, tenants, domains

No catalogue statement may assign `hotels.status`. Configured, subscription
entitlement, Stripe Connect, and live publication stay separate. 0023 stands.

`sbg-verify-a5` is not attached to test commerce by seeding or by Owner plan
edits. The allowlist stays explicit and is **absent**. `demo-kos` is not a
SaaS billing fixture and must not gain a billing row from catalogue work.

Domain A is hotel/operator → SBG. Domain B is guest → hotel. Guest destination
amounts, including Verification Airport EUR 10.00, never enter this catalogue
and never enter MRR.

---

## 16. What O3.1 deliberately does not decide

- The numeric BASIC, PRO, and PREMIUM amounts.
- Whether a future annual price is offered (column reserved only as a later
  check relaxation).
- Per-plan machine entitlements.
- Portal configuration that would let a customer switch to an unmapped Price.
  Until that is designed, an unmapped portal price fail-closes at the webhook.
- Deleting env Price ID variables (they are already absent on Production).
  C.4 simply stops reading them.
