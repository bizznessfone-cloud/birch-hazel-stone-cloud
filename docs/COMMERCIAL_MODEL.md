# CP26C-O3R — organisation property-licence commercial model

**Decision only.** This checkpoint inspected source and living docs. It did not
add a migration, change runtime, call Stripe, create a price version, or enable
commerce.

This document is the commercial-cardinality authority after CP26C-O3R. It
supersedes the BASIC / PRO / PREMIUM **feature-tier** assumption and the
**one hotel = one Stripe subscription** assumption where those appear as the
intended future model in [`COMMERCIAL_CATALOGUE.md`](COMMERCIAL_CATALOGUE.md)
and [`OWNER_CONTROL_PLANE.md`](OWNER_CONTROL_PLANE.md).

Those documents stay historical evidence of what was contracted and built.
Their older sections are not rewritten to pretend this model was always
explicit. Where an older sentence still describes three paid tiers, or one
subscription per hotel, as the target, **this document wins**.

Catalogue amounts remain **UNDEFINED** in the database. The operator-locked
standard unit amount is **not copied into this repository**. A later authorised
price-version checkpoint must take that amount from the human authorisation
brief and persist it only as an immutable catalogue price version. Application
logic, analytics, seeds, and tests must not hard-code it.

| Field | Value |
|---|---|
| Status | **CP26C-O3R PASS** — reconciled; no implementation |
| Baseline | `d50a641ca60d6b469d37fd2fd712696740c169e5` = `origin/main` |
| Human O2D | **PASS** (operator evidence: `/owner/login` isolated) |
| Human O3.3V | **PASS** (operator evidence: three active plans, no prices, not mapped) |
| Former O3.4 | **SUPERSEDED** — do not start; it would price the obsolete tiers |
| CP26C.3 | **NOT RESUMED** — its three-tier TEST Price plan is superseded |
| CP26C.4 | **SUPERSEDED as previously scoped** — do not cut Checkout over to three tier Prices |
| Next | **CP26C-O4.2** single-use 0027 controller (not started). **O4.1 SOURCE COMPLETE**, unapplied |
| Commerce | **OFF** |
| Ledger | Gate B **0001–0026**; `AUTHORISED_PENDING=[]`; 0027+ fail-closed |
| 0026 digest | `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446` unchanged |
| Production prices | operator-attested **0** versions, **0** mappings, **0** real SaaS subscriptions; not re-queried |
| LIVE locks | source default **false / false** |

**CP26C-O4.1 source.** `migrations/0027_cp26co41_organisation_property_licence.sql` now exists. It is not in Gate B, not authorised, and not applied. The sentences below that say the tables were "not created here" are the O3R decision, which this migration follows. Membership does **not** use a closed `billing_owner` | `operator` check: `role` is an extensible token and `billing_authority` is the only billing capability. That avoids freezing a two-role taxonomy in this persistence step.

---

## 1. Classification

The implemented architecture is **hotel-scoped billing**. It is not an
organisation aggregate, and it is not yet a property-licence quantity model.

Proven from source:

- There is no organisation, company, or customer table.
- `app_hotel_accounts` (`migrations/0018_cp22_saas_onboarding.sql`) is a
  membership of `(user_id, hotel_id)`. The primary key allows many hotels per
  user and many users per hotel. It does not own a Stripe customer or a
  licence quantity.
- `sbg_create_hotel_for_user` inserts one hotel, one in-house provider, one
  active agreement, and one membership row. A second call creates a second
  hotel. Nothing groups those hotels into one commercial customer.
- `sbg_billing_accounts` (`migrations/0020_cp24_stripe_billing.sql`, extended
  by `0024`) has primary key `hotel_id`. Partial unique indexes force one
  Stripe customer id and one Stripe subscription id across hotels. There is
  no quantity column.
- `sbg_apply_billing_event` (10 arguments, `0024`) rejects a second distinct
  subscription id while the hotel row is in a non-terminal status. Ordering
  uses Stripe `event.created`. Duplicate `event_id` returns `duplicate`.
- Checkout (`createSubscriptionCheckout` in `src/lib/aether/stripe.server.ts`)
  sends `line_items[0][quantity]` as the literal `"1"` and metadata
  `hotel_id` + `user_id`. The webhook requires `metadata.hotel_id` and reads
  only the first subscription item's price. It does not read quantity.
- Plan identity is exactly `basic` | `pro` | `premium` (`StripePlan`,
  `SBG_SAAS_PLAN_CODES`, `sbg_saas_plans_code_check`). Checkout resolves
  `STRIPE_${PLAN}_PRICE_ID`. The catalogue resolver
  `sbg_resolve_domain_a_checkout_price(plan_code, environment)` is not used
  by Checkout.
- `isSaasEntitled` is billing status `active` | `trialing` | `past_due`.
  There is no feature matrix by plan. Owner MRR is the literal
  `pending_catalogue`, not an amount.
- `sbg_sync_hotel_entitlement` after `0023` returns `hotels.status` and does
  not write it. Publication is not billing.

`app_hotel_accounts` is **not** sufficient to be the organisation.

---

## 2. Locked target

One product. One standard. No Basic / Pro / Premium feature tiers. Engineering
flags may still exist for rollout. They are not commercial entitlements.

Commercial unit: **property licence**. Not a user, booking, transfer, vehicle,
driver, staff member, guest, feature, or destination. No SBG commission on
guest transfers.

Hierarchy:

```
organisation
  → one Stripe customer
  → one Stripe subscription
  → one recurring property-licence Price
  → subscription item quantity = purchased property licences
  → properties (hotels), each consuming at most one active allocation
  → users (access only; never quantity)
```

Example shape, not a seed: seven purchased licences and five configured
properties means two available licences. Those seven licences are **one**
subscription, not seven subscriptions.

`available_licences = licensed_property_quantity - active_allocation_count`

Spare licence: add property, allocate, no Stripe quantity change.

No spare licence: increase Stripe quantity, Stripe computes proration, then
allocate. The application must not implement a shadow proration engine.

Self-service quantity is 1 through 49 property licences. 50 or more is
Enterprise / contact sales. Enterprise is the same product, not another tier.
No enterprise rate, discount, contract, or Stripe object is defined here.
The model must not make a later negotiated agreement impossible: an
organisation may later point at a non-purchasable contracted price version
without that version becoming the public purchasable price.

Users are not licences. Inviting a user must not change quantity.

One property has at most one active allocation. Upgrades do not exist as tier
changes. A price change replaces the contracted price version on the same
subscription; it does not create a second licence. Cancellation belongs to the
organisation subscription. Historical property, booking, audit, and billing
rows are not deleted because a licence is released or quantity falls.

The Platform Owner manages the catalogue. The Platform Owner does not become
the customer and does not manage that customer's Stripe subscription.

MRR, when a price version exists, is the persisted contracted unit amount of
that subscription's price version times its paid quantity. It is not "current
purchasable price times every hotel". Enterprise contracted versions must not
be forced through the standard purchasable price. Until a price version
exists, MRR stays unresolved. Do not hard-code the operator-locked amount.

---

## 3. What 0026 keeps

Do not delete or rewrite `migrations/0026_cp26co3_commercial_catalogue.sql`.
Digest stays `4ca1796a3cab62ff060ce12957c066ecf01cde2dfdf4ae320f0e40d881c8b446`.

Keep, and reuse for the single property-licence product:

- immutable price versions (EUR, month, interval count 1, `amount_minor > 0`)
- create as not purchasable; one purchasable version per product identity
- retire without delete
- TEST and LIVE Stripe mappings, separate verified rows
- LIVE mapping lock and LIVE checkout lock, both still false
- append-only `sbg_owner_audit_events`
- Platform Owner gate on catalogue writes
- no-delete triggers on plans, price versions, mappings, and audit

Do not keep, as the **target** model:

- three codes meaning feature tiers
- Checkout and webhook allowlists of three env Price IDs
- plan-keyed entitlement

`sbg_catalogue_create_price_version` does **not** require the plan to be
active. `sbg_catalogue_activate_price_version` does. Deactivating a tier
therefore does not by itself stop an immutable price from being created on
that tier. The later catalogue migration must reject price creation on an
inactive plan. Until that migration, do not use `/owner/plans` to price
`basic`, `pro`, or `premium`.

---

## 4. Treatment of the three plan rows

Production has the three plan identities, zero price versions, zero Stripe
mappings, and zero real SaaS subscriptions (operator evidence; this checkpoint
did not connect to Production). Nothing commercial is attached to those codes.

| Strategy | Verdict |
|---|---|
| Delete the rows | **Reject.** Delete triggers forbid it, and the migration audit targets those codes. |
| Rename `basic` into the new product | **Reject.** `code` is immutable. The permanent key would still be `basic`. |
| Put the standard amount on one of the three | **Reject.** That freezes a tier code into immutable price history. |
| Leave them active and unused | **Reject as the end state.** The Owner UI can still create a price on them. |
| Keep the rows, deactivate them, add one new code | **Accept.** |

Later catalogue migration, not this checkpoint:

1. Widen `sbg_saas_plans_code_check` to allow `property_licence` **and** the
   historical three codes.
2. Insert `property_licence` with no price version.
3. Set `basic`, `pro`, and `premium` `active = false` (rows remain).
4. Change `sbg_catalogue_create_price_version` so an inactive plan cannot
   receive a price version.
5. Do not insert the operator-locked amount in that migration.

---

## 5. Minimum organisation model (not created here)

New tables only. Do not reshape `sbg_billing_accounts` into the organisation
row. Its unique customer and subscription indexes cannot store one
subscription against many hotels.

- `sbg_organisations` — the customer. Not a hotel and not a user.
- `sbg_organisation_members` — active `(organisation_id, user_id)`. `role` is an extensible token. `billing_authority` is the only billing capability. Users are access. Removal sets `removed_at` and does not delete the user or a licence.
- `hotels.organisation_id` — nullable foreign key. One property, one
  organisation. Null means not yet attached.
- `sbg_organisation_billing` — primary key `organisation_id`. Unique Stripe
  customer id. Unique Stripe subscription id. Status uses the existing billing
  status vocabulary. `licensed_quantity` integer `>= 0`. `stripe_price_id`.
  Nullable `price_version_id`. `current_period_end`. `cancel_at_period_end`.
  `last_stripe_event_created` + `last_stripe_event_id` with the same pair
  check as 0024.
- `sbg_property_licence_allocations` — one active allocation per hotel
  (partial unique index). `released_at` set on release. No delete of the
  hotel, bookings, or audit.

`available_licences` is derived. Do not store it.

Do not backfill organisations from `app_hotel_accounts`. One user with several
hotels is not proof they are one company, and several users on one hotel is
not proof who the billing customer is. Existing hotels stay
`organisation_id` null. Legacy hotel billing stays in place and dormant while
commerce is OFF. A later explicit attach action may link a hotel. It must not
run silently inside the migration.

Stripe customer and subscription ids must not appear on both
`sbg_billing_accounts` and `sbg_organisation_billing`. The new apply function
rejects that collision.

Runtime DML stays revoked. Mutations go through `SECURITY DEFINER` functions,
matching 0018–0026. This design does not add RLS. Isolation remains
application SQL, as in the rest of the schema. That is a recorded limitation,
not a new RLS project.

Tenant rule once attached: a member may see only that organisation's
properties and billing. A null `organisation_id` hotel stays on
`app_hotel_accounts`. Platform Owner catalogue access is not customer access.

---

## 6. Billing persistence and webhooks

Do **not** extend or replace the 10-argument `sbg_apply_billing_event`.

Argument 4 is a hotel id. Adding quantity, or reinterpreting that argument as
an organisation id, would let an old hotel-metadata event write the new
aggregate. 0024 already dropped the earlier 8-argument last-write-wins
function; repeat that pattern only by **adding** a new function.

New function, later: organisation id, quantity, and the same outcomes
`applied | duplicate | stale | ambiguous | rejected`. It inserts the same
`sbg_stripe_events` primary key so one Stripe event cannot be applied on both
paths. Add a nullable `organisation_id` on `sbg_stripe_events`. Keep `hotel_id`.

Webhook changes, later, still fail-closed:

- Require exactly one subscription item. More than one item is `rejected`.
- Read integer `quantity >= 0`. Missing quantity is `rejected`, not defaulted
  to 1.
- Persist status, price id, contracted price version when a verified mapping
  matches, period end, and `cancel_at_period_end`.
- An event with both hotel and organisation identity is `ambiguous`.
- Unknown price ids stay rejected. Do not accept the three env Price IDs as
  the permanent allowlist once the property-licence mapping exists.
- Ordering remains Stripe `event.created`, with equal-timestamp ambiguity.

Quantity reduction policy is **not** decided. The schema must keep operational
property state, allocation, history, and subscription quantity as separate
facts. A later checkpoint must not auto-delete bookings or auto-release
allocations to force `allocated <= licensed`. Local quantity decrease that
would breach is refused. A Stripe-originated quantity that is already below
the active allocation count is persisted and held as a breach; new allocations
stop. Which existing property loses commercial entitlement during a breach is
undecided and must not be invented by the schema migration.

---

## 7. Checkout, portal, and TEST isolation

Later, not now:

- First purchase creates the organisation subscription at the requested
  quantity (normally 1) against the single purchasable property-licence price.
- A spare licence does not call Stripe.
- A quantity increase is a Stripe subscription-item change. Stripe prorates.
- Metadata carries `organisation_id` and the acting user. It does not use
  `hotel_id` as the subscription owner.
- Billing portal stays payment method, invoices, and cancellation. Do not
  enable portal quantity editing until webhook quantity persistence and the
  breach hold exist. Otherwise a portal edit can bypass allocation checks.
- `SBG_SAAS_TEST_HOTEL_IDS` remains the gate for any leftover hotel-keyed
  path. Do not weaken it. Do not put Production UUIDs in git.
- Organisation Checkout, when it exists, needs its own fail-closed allowlist
  (`SBG_SAAS_TEST_ORGANISATION_IDS` or equivalent). Absence or malformation
  rejects every organisation. Commerce stays OFF until a checkpoint that is
  not this one, and not a resume of CP26C.3.

`assertCheckoutAllowed` today says the hotel already has a subscription. That
sentence becomes false for a second property on the same organisation. Replace
it with spare-licence versus quantity-increase. Do not do that in O3R.

---

## 8. Entitlement, publication, domains

Target entitlement question: is this organisation in an entitled billing
status, how many licences it has purchased, and is this property allocated to
one of them while `active_allocation_count <= licensed_quantity`?

No plan code participates.

Publication invariant: allocating, releasing, or paying a licence must not
write `hotels.status`. `0023` stays the no-write entitlement function. Guest
booking publication continues to use hotel publication state only. A paid
licence does not make a hotel public.

Domain A is the organisation subscription. Domain B stays hotel Stripe
Connect, guest transfer prices, and hotel money (`sbg_stripe_connections`,
guest Checkout, booking payments). The property-licence amount must never be
written as a destination price. No application fee or commission is added.

---

## 9. Owner and operator surfaces (not built here)

`/owner/plans` eventually shows one product, **SCAN BOOK GO Property Licence**:
canonical price version, TEST mapping, LIVE mapping, history, LIVE locks, and
a non-priced note that 50 or more properties is contact sales. The Owner still
creates a future price version without rewriting subscriptions. The three-card
tier UI is retired only after the catalogue migration, not by hiding it now.

Operator billing eventually shows organisation, purchased count, allocated
count, available count, monthly total from the contracted price version, the
property list, add property, and the billing portal. It does not show a tier
picker.

Owner overview MRR/ARR stay `pending_catalogue` until they can sum
`licensed_quantity × contracted price_version.amount_minor` for entitled
organisations. They must not multiply hotel rows by a constant.

---

## 10. Assumption inventory

| Assumption in source | Class |
|---|---|
| `sbg_saas_plans` / price versions / mappings / locks / owner audit | **KEEP** the mechanism; **REFACTOR** cardinality from three tiers to one product |
| `basic` / `pro` / `premium` rows and their create-audit | **HISTORICAL — DO NOT REWRITE**; later **DEPRECATE** (inactive, no new prices) |
| `StripePlan`, `SBG_SAAS_PLAN_CODES`, three env Price IDs | **DEPRECATE** after property-licence checkout exists; **REMOVE LATER** |
| `sbg_billing_accounts` hotel primary key and unique Stripe ids | **KEEP** as the dormant legacy aggregate; do not overload it |
| 10-arg `sbg_apply_billing_event` | **KEEP**; do not change its signature |
| Hotel Checkout quantity `"1"` and hotel metadata | **REFACTOR** to organisation quantity |
| `sbg_set_billing_price_for_user` | **DEPRECATE** for the new flow; legacy path stays while hotel checkout exists |
| `app_hotel_accounts` | **KEEP** as property access for unattached hotels; not an organisation |
| `sbg_create_hotel_for_user` | **REFACTOR** later so a new property is created under an organisation and consumes a licence |
| `isSaasEntitled(status)` | **REFACTOR** to organisation status plus allocation, still with no tier matrix |
| `sbg_sync_hotel_entitlement` (0023 no-write) | **KEEP** |
| `SBG_SAAS_TEST_HOTEL_IDS` | **KEEP** until hotel-keyed Checkout is gone; do not weaken |
| Owner MRR `pending_catalogue` | **KEEP** until contracted quantity math exists |
| Domain B Connect and guest Checkout | **KEEP** |
| CP26C-O3.1 / O3.2 / O3.3 tier contract text | **HISTORICAL — DO NOT REWRITE** |

---

## 11. Implementation sequence

No step below is authorised by O3R. 0027+ stays fail-closed until its own
checkpoint. Each Production apply, when it exists, uses a new single-use
controller, then reconciliation, then retirement. The generic migrator never
applies SQL.

1. **CP26C-O4.1 SOURCE COMPLETE** — `migrations/0027_cp26co41_organisation_property_licence.sql` and local tests. Not in the accepted ledger. Not applied. No amount. No backfill. No Stripe. Commerce stays OFF.
2. **CP26C-O4.2** — next. Single-use Production controller for that migration. Not started.
3. **CP26C-O4.3** — one Production apply.
4. **CP26C-O4.4** — Gate B reconcile and retire that controller.
5. **CP26C-O5.1** — source migration: `property_licence` identity, deactivate
   the three tier rows, block price creation on inactive plans. No amount.
6. **CP26C-O5.2 / O5.3 / O5.4** — controller, one apply, reconcile, retire.
7. **CP26C-O6** — Owner catalogue UI shows the one product. Still no price row.
8. **CP26C-O7** — application refactor: webhook quantity, organisation
   checkout and portal rules, operator licence UX, MRR from persisted
   versions. Commerce remains OFF. Hotel env Price IDs stay until this path
   is proven and then removed. Not CP26C.4.
9. **CP26C-O8** — human Owner creates the one canonical price version through
   the UI. This replaces former O3.4. The amount comes from the authorisation
   brief, not from source.
10. **CP26C-O9** — Stripe TEST product and one TEST price, then a verified
    test mapping. Not a resume of CP26C.3.
11. **CP26C-O10** — organisation TEST allowlist, commerce still OFF.
12. **CP26C-O11** — TEST commerce for allowlisted organisations only, including
    quantity greater than 1. Not LIVE.

Only **CP31** may enable LIVE commerce.

---

## 12. What O3R did not

These statements describe CP26C-O3R only. CP26C-O4.1 later added the unapplied
source migration named above. O3R itself did none of the following.

No Production database connection. No mutation. No migration file. No Stripe
call. No Product or Price. No webhook. No Vercel change. No price version. No
deletion of plan rows. No organisation table. No commerce flag change. No
hotel publication change. No Domain B change. No user or Owner grant change.
No runtime source change.
