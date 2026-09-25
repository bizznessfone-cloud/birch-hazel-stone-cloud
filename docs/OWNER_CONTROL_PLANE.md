# SCAN / BOOK / GO — Owner Control Plane

Canonical architecture for the **SBG Owner** business surface. Implemented in
**CP26C-O2** (foundation, read-mostly) and **CP26C-O3** (commercial catalogue).
This document is design authority. It is **not** a migration and **not** a
runtime module.

Living execution: [`ROADMAP.md`](ROADMAP.md). Fixture policy:
[`FIXTURE_POLICY.md`](FIXTURE_POLICY.md). Domain A commerce remains **OFF**
until **CP31**.

| Field | Value |
|---|---|
| Defined | **CP26C-O1** |
| Foundation | **CP26C-O2 CLOSED** (Production-proven; 0025 applied) |
| 0025 controller | **CP26C-O2A/O2B PASS** |
| First Owner | **bootstrapped** — 1 active grant; workflow **RETIRED** (GHA 36116463589) |
| Next implementation | **CP26C-O3** |
| Catalogue implementation | **CP26C-O3** |
| Stripe TEST resources | **CP26C.3** (paused until O3) |
| LIVE commerce | **CP31 only** |

---

## 1. Purpose

The Owner Control Plane operates **SCAN BOOK GO as a business**.

It answers:

- who signed up, which hotels exist, where they sit in the operator journey
- which SaaS plans and price versions SBG currently sells
- what Domain A subscription revenue is doing
- whether Stripe TEST/LIVE configuration and commerce mode are healthy

It does **not** book transfers, dispatch vehicles, or configure a hotel’s
catalogue. Those remain Guest, Hotel/operator, and Ops concerns.

---

## 2. Role boundaries

Four operating surfaces. Do not merge them.

| Surface | Actor | Money | Route | Identity |
|---|---|---|---|---|
| **Guest** | hotel customer | Guest → Hotel (Domain B) | `/{hotelSlug}`, `/book/{hotelCode}`, `/confirmed/{token}` | none (public + confirmation token) |
| **Hotel/operator** | SaaS tenant | Hotel → SBG (Domain A) | `/app/*`, `/login` | Better Auth `"user"` + `app_hotel_accounts` |
| **Ops** | transfer desk / dispatcher | none (operations) | `/ops/*`, `/ops/login` | `operators` + `operator_memberships` (`hotel_desk` / `provider_dispatcher`) |
| **Owner** | SBG platform operator | observes Domain A SaaS | `/owner/*` | Better Auth `"user"` **and** a dedicated platform-owner grant |

Invariants:

- Owning a hotel does **not** grant Owner access.
- An Ops membership does **not** grant Owner access.
- An Owner grant does **not** impersonate a hotel or Ops desk.
- Email-address comparison is **not** permanent Owner authorization.
- Every operator is **not** an Owner.

Current source has Guest, Hotel/operator, Ops, and Owner (`/owner`).
O2 is Production-proven. 0025 is Production-applied. Exactly one platform Owner exists (OPERATOR CONTROLLED / REDACTED). The first-Owner bootstrap workflow is **RETIRED**.

---

## 3. V1 Owner scope

Six bounded capabilities. Keep the cockpit small.

| Capability | Route (target) | O2 | O3 |
|---|---|---|---|
| **Overview** | `/owner` | yes — metrics derivable from current tables | add plan/MRR once catalogue exists |
| **Hotels** | `/owner/hotels`, `/owner/hotels/$hotelId` | yes — registry + read detail | plan name from catalogue |
| **Plans & Pricing** | `/owner/plans` | shell / “not yet” only | yes — mutation + versions |
| **Revenue** | `/owner/revenue` | counts/status only | MRR/ARR from catalogue amounts |
| **Signup funnel** | on Overview | yes | refine subscribed-by-plan |
| **System** | `/owner/system` | read-only health | catalogue mapping status |

Desktop-first administration. Professionally responsive. Existing SBG
monochrome / Outfit / restrained premium language (`canvas`, `ink`, `line`,
`surface`, `muted`). Not a generic admin theme. Not Bootstrap.

---

## 4. Authorization design

### 4.1 Reuse Better Auth identity; add a grant

Hotel/operator already authenticates with Better Auth (`/login`, `authMiddleware`,
`getAppSession`, `"user"."id"` text). Owner **reuses that session**. It does not
reuse Ops `operators` / cookie sessions.

Authorization is a **second, fail-closed grant**:

```
Better Auth session userId
  → row in sbg_platform_owners
    where revoked_at is null
  → Owner
```

No email allowlist. No `VITE_` flag. No “if the user owns any hotel”. No
client-only gate.

### 4.2 Route and server enforcement

O2 must implement **both**:

1. `/owner` parent `beforeLoad` — no session → `/login`; session without grant →
   `403` Owner page (not an `/app` redirect that looks like a tenant bug).
2. Every Owner server function — `authMiddleware` plus
   `requirePlatformOwner(userId)` against the grant table **before** any query.

Loader-only protection is insufficient (same rule as `/app` children still using
`authMiddleware`).

Same-site / CSRF: keep `assertSameSiteRequest` on Owner mutations (already used
by `authMiddleware`). Cookie session is HttpOnly Better Auth. No new CSRF
protocol unless O2 finds a gap.

### 4.3 Bootstrap and revocation

Runtime (`aether_app`) **SELECT**s the grant table. It must **not** INSERT the
first Owner.

First grant is an **owner-plane** operation (schema owner /
`AETHER_DATABASE_OWNER_URL`), same class as `scripts/provision-hotel.mjs`:
narrow SECURITY DEFINER, never on Vercel, never in git with a user id of a real
person in a runnable default.

Subsequent grants/revokes (O2 or later): only an already-active Owner may call a
narrow function. Cannot revoke the last active Owner from runtime (prevents
lockout). Emergency recovery remains owner-plane SQL.

Do not auto-grant from hotel ownership, Ops membership, or a mailbox match.

### 4.4 Audit

Grant, revoke, and every commercial mutation write `sbg_owner_audit_events`.
Never store secrets, password hashes, or raw Stripe keys in audit payloads.

---

## 5. Proposed data model (O2 / O3)

No SQL in O1. O2 may ship owner-grant + audit if required for a protected
shell. Catalogue tables belong in **O3**. Future migrations need a dedicated
single-use controller; generic Production migrator stays fail-closed.

Existing tables **reused, not duplicated**:

| Table | Owner use |
|---|---|
| `"user"` | operator identity, signup time, email (Owner-visible; not public) |
| `app_hotel_accounts` | ownership |
| `hotels` | identity, `status`, `code`, `public_slug`, `created_at` |
| `hotel_services`, `hotel_destinations` | configuration summary |
| `sbg_billing_accounts` | Domain A subscription ledger |
| `sbg_stripe_events` | recent Domain A lifecycle events |
| `sbg_stripe_connections` | Connect presence (not SBG revenue) |

Seeded demo hotels (`demo-kos`, `gate`, `harbor`) remain **Ops/demo**, not SaaS
customers, unless a later checkpoint separately authorises them. Funnel counts
**exclude** hotels with no `app_hotel_accounts` row.

### 5.1 `sbg_platform_owners`

| | |
|---|---|
| Purpose | Canonical platform-Owner grant |
| PK | `user_id` text → `"user"."id"` |
| Columns | `user_id`, `granted_at`, `granted_by_user_id` (nullable for bootstrap), `revoked_at`, `revoked_by_user_id`, `note` (non-secret) |
| Uniqueness | one row per user |
| Lifecycle | insert on grant; `revoked_at` set on revoke (do not delete) |
| Canonical | yes |
| Read | `aether_app` SELECT; Owner UI |
| Write | owner-plane bootstrap; thereafter SECURITY DEFINER requiring an active Owner |

Active Owner ⇔ `revoked_at is null`.

### 5.2 `sbg_saas_plans`

| | |
|---|---|
| Purpose | Stable commercial plan catalogue (BASIC / PRO / PREMIUM) |
| PK | `id` uuid |
| Columns | `code` (`basic` \| `pro` \| `premium`), `name`, `active`, `sort_order`, `created_at`, `updated_at` |
| Uniqueness | `code` unique |
| Lifecycle | seeded once in O3; deactivate rather than delete |
| Canonical | yes — SBG commercial offer |
| Read | `aether_app` SELECT |
| Write | Owner SECURITY DEFINER (O3) |

V1: exactly these three codes. No add-on SKUs.

### 5.3 `sbg_saas_price_versions`

| | |
|---|---|
| Purpose | Versioned commercial price; maps to Stripe TEST and LIVE Price IDs |
| PK | `id` uuid |
| Columns | `plan_id` → `sbg_saas_plans` |
| | `amount_minor` integer check `> 0` |
| | `currency` text check `= 'EUR'` (V1) |
| | `interval` text check `= 'month'` (V1) |
| | `stripe_test_price_id` text nullable, `^price_` when set |
| | `stripe_live_price_id` text nullable, `^price_` when set |
| | `is_current` boolean not null |
| | `created_at`, `created_by_user_id`, `retired_at`, `retired_by_user_id` |
| Uniqueness | at most one `is_current = true` per `plan_id` (partial unique index) |
| | unique `(plan_id, amount_minor, currency, interval, created_at)` not required; do not merge versions |
| | unique non-null `stripe_test_price_id`; unique non-null `stripe_live_price_id` |
| Lifecycle | insert new version; retire previous current; **never update `amount_minor`** |
| Canonical | yes — SBG price |
| Read | `aether_app` SELECT |
| Write | Owner SECURITY DEFINER (O3) |

Stripe Price IDs are identifiers, not credentials. LIVE IDs stay null until
**CP31**. TEST IDs stay null until **CP26C.3** (after O3).

### 5.4 `sbg_owner_audit_events`

| | |
|---|---|
| Purpose | Owner commercial / administrative audit |
| PK | `id` uuid |
| Columns | `at timestamptz`, `actor_user_id` text, `action` text, `target_type` text, `target_id` text, `metadata jsonb` |
| Uniqueness | none (append-only) |
| FK | `actor_user_id` → `"user"."id"` (do not cascade-delete history; restrict) |
| Lifecycle | insert only |
| Canonical | yes for Owner actions |
| Read | Owner |
| Write | SECURITY DEFINER on each audited action |

Do **not** reuse `audit_events` (booking/Ops occupancy log; `actor_id uuid`).

### 5.5 Billing account link (O3, additive)

`sbg_billing_accounts.stripe_price_id` remains the **Stripe execution** mirror
(webhook-applied). O3 may add nullable `price_version_id uuid` referencing
`sbg_saas_price_versions` as SBG’s resolved commercial version. Do not rewrite
historical `stripe_price_id` when a plan’s current price changes.

Resolution order for display:

1. `price_version_id` if set
2. else match `stripe_price_id` to any version’s TEST or LIVE mapping
3. else “unmapped Stripe price” (attention item)

### 5.6 What is derived, not stored

| Metric | Source |
|---|---|
| Operator accounts | distinct `app_hotel_accounts.user_id` |
| Hotels (SaaS) | `hotels` with ≥1 `app_hotel_accounts` |
| Unconfigured / configured / live | `hotels.status` |
| Subscribed / entitled | `sbg_billing_accounts.status ∈ {active, trialing, past_due}` (same as `isSaasEntitled`) |
| Past-due / cancelled | billing `status` |
| Signups 7d / 30d | `"user"."createdAt"` for users who own a hotel, or first `app_hotel_accounts.created_at` — **pick hotel-ownership creation as canonical** (an auth user with no hotel is not an operator signup) |
| MRR | sum `amount_minor` of entitled hotels’ **mapped** price versions (O3) |
| ARR | `MRR × 12` (projection, not accounting) |

Do not build a warehouse, snapshot fact table, or Domain B revenue cube.

---

## 6. Commercial catalogue model

**SBG owns the offer. Stripe executes payment. Vercel holds secrets.**

```
sbg_saas_plans
  └── sbg_saas_price_versions  (amount, EUR, month, current/retired)
        ├── stripe_test_price_id   → Stripe TEST Price
        └── stripe_live_price_id   → Stripe LIVE Price (CP31)
              └── sbg_billing_accounts.stripe_price_id  (Stripe subscription mirror)
```

Changing PRO €59 → €69:

1. Owner creates a new price version (5900 → 6900 minor).
2. New version becomes `is_current`.
3. Previous version `retired_at` set; `is_current = false`.
4. Existing `sbg_billing_accounts` rows **unchanged**.
5. New Checkouts use the current version’s Price ID for the commerce mode.
6. Grandfathered subscriptions stay on the old Stripe Price until the operator
   changes plan via Stripe billing portal (current portal-first policy).

No historical rewrite. No silent Stripe subscription update from the Owner UI
in V1.

---

## 7. Price versioning

- Amounts are integers **minor units** (cents). Never floating-point.
- V1 currency **EUR**. V1 interval **month**. Annual / multi-currency are
  exclusions until separately authorised.
- `is_current` is the offer shown on `/app/billing` after O3.
- Inactive plan (`sbg_saas_plans.active = false`): hidden from new Checkout;
  existing subscribers remain until they cancel or portal-change.
- TEST and LIVE mappings are independent columns on the **same** version so the
  commercial amount does not fork by Stripe mode.
- Creating a Stripe Price is **CP26C.3 / CP31**, not an Owner one-click in V1.
  Owner UI stores the returned Price ID after that controlled process.

---

## 8. Stripe / SBG / Vercel authority

| Concern | Authority |
|---|---|
| Which plans exist, amounts, current offer | SBG catalogue (O3) |
| Stripe Customer, Subscription, Invoice, Checkout Session | Stripe |
| Domain A lifecycle persistence | `sbg_apply_billing_event` (0024) |
| `hotels.status` / publication | hotel onboarding / `goLive` — **not** billing entitlement (0023) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Vercel (secrets) |
| `SBG_SAAS_COMMERCE`, `SBG_SAAS_TEST_HOTEL_IDS` | Vercel env; Owner **displays** mode/allowlist status; **does not** toggle LIVE |
| `STRIPE_BASIC_PRICE_ID` / `PRO` / `PREMIUM` | **transitional** env lookup (current source) |

### Env Price-ID retirement path (do not remove in O1)

Current source: `stripePriceId(plan)` → `STRIPE_${PLAN}_PRICE_ID`.

| Step | Behaviour |
|---|---|
| **O1** | document only; env lookup unchanged |
| **O3** | dual-read: current catalogue version Price ID for commerce mode if present; else env var; if neither, fail closed |
| **CP26C.3** | create Stripe TEST Prices from **canonical O3 amounts**; write TEST IDs onto current versions; may still copy IDs into Vercel env for compatibility |
| **After C.3 proven** | Checkout/webhook allowlist of Price IDs reads catalogue (plus still-grandfathered historical IDs) |
| **Later, explicit child** | stop requiring env Price IDs; env may remain as emergency override until deleted |
| **CP31** | LIVE Price IDs mapped on the same versions; `SBG_SAAS_COMMERCE=live` still only at CP31 |

Webhook `assertDomainAWebhookPriceId` must accept **current and retired**
mapped IDs (TEST and LIVE columns) so grandfathered events do not fail closed.

---

## 9. Information architecture

```
/owner                  Overview  (funnel + attention + headline metrics)
/owner/hotels           Hotel registry
/owner/hotels/$hotelId  Hotel detail (read)
/owner/plans            Plans & Pricing
/owner/revenue          SaaS revenue
/owner/system           Configuration / health (no secret values)
```

Five nav items. Funnel stays on Overview unless volume later justifies a page.

`/owner` is **not** nested under `/app`. An Owner who also owns a hotel uses
`/app` as a tenant and `/owner` as the platform. Distinct shells.

Visual: existing SBG header tracking, uppercase micro-labels, `border-line`
cards, Outfit, no rainbow charts. Tables first; sparse counts; attention list.
Mobile: stack, no horizontal overflow, 44px taps.

---

## 10. Overview metrics

30-second health. Prefer canonical transactional data.

| Metric | Definition | Available |
|---|---|---|
| Operator accounts | distinct `app_hotel_accounts.user_id` | O2 |
| Total SaaS hotels | hotels with ownership row | O2 |
| New signups 7d / 30d | first hotel-ownership `created_at` in window | O2 |
| Unconfigured / configured / live | `hotels.status` | O2 |
| Subscribed hotels | entitled billing status | O2 |
| Active subscriptions | `status = 'active'` | O2 |
| Past-due / cancelled | billing status | O2 |
| Subscriptions by BASIC / PRO / PREMIUM | map `stripe_price_id` → plan via catalogue | O3 |
| MRR | sum entitled mapped `amount_minor` | O3 |
| Projected ARR | `MRR × 12` | O3 |
| Recent signups | latest ownership rows | O2 |
| Recent subscription events | latest Domain A `sbg_stripe_events` | O2 |
| Attention | past-due; configured+not subscribed; unmapped price; incomplete | O2/O3 |

`trialing` counts as entitled (existing lifecycle). `incomplete` is attention,
not subscribed. Publication (`live`) is **not** a revenue metric.

---

## 11. Hotel registry

Search: name, code, slug, operator email.

List columns: hotel name, code, public slug, operator email (first owner if
several — schema is many-to-many; show count + primary), ownership created,
`hotels.status`, SaaS plan (O3) / raw price id (O2), billing status,
`current_period_end`.

Detail (read):

- identity: name, code, slug, locality, timezone, currency
- owners: `app_hotel_accounts` + `"user"`
- configuration: status, service/destination counts (not a CMS editor)
- Domain A: billing row, Stripe customer/subscription **IDs** (not secrets)
- Connect: connected / disconnected / absent (Domain B, labelled as such)
- recent Domain A events for this hotel
- no guest PII dump (bookings are Ops)

V1 **must not**: impersonate `/app` as the operator, edit hotel rows, refund,
force-status, or goLive.

---

## 12. Revenue

Domain **A only**. Caption every number “SBG SaaS”. Never add
`sbg_booking_payments.amount_minor` or Connect volume into MRR/ARR.

O2: subscription counts and status mix. O3: MRR, ARR projection, MRR by plan,
new entitled mappings in-window as “new MRR” (best-effort from event
timestamps, not finance-grade). Churn: cancelled in-window / entitled at
window start if both computable; otherwise show cancelled count and do not
invent a rate.

Not accounting, tax, or payout software.

---

## 13. Lifecycle funnel

Operator journey already documented:

```
account → hotel → first service → preview → QR → plan → Stripe → LIVE
```

Owner funnel (counts, not a forced state machine):

| Stage | Canonical predicate |
|---|---|
| Account | Better Auth user with ≥1 `app_hotel_accounts` |
| Hotel created | that hotel row exists (`hotels`) |
| Configured | `hotels.status ∈ {configured, live}` |
| Subscribed | entitled Domain A billing |
| Live | `hotels.status = 'live'` |

0023: entitlement does **not** write `hotels.status`. **Subscribed ↛ live.**
Funnel is a conversion view, not a proof that billing publishes hotels.

Example presentation: `126 → 103 → 81 → 56 → 53` with rates vs previous stage
and vs accounts. Exclude unowned seeded hotels.

---

## 14. System / commercial controls

Read-only in V1:

- `SBG_SAAS_COMMERCE` parsed mode (`off` / `test` / `live` / absent→off)
- Stripe secret **classification** (`absent` / `test` / `live` / unrecognised)
  via existing `classifyStripeSecretKey` — never display the secret
- webhook secret: PRESENT / ABSENT
- Price env vars: PRESENT / ABSENT per name
- catalogue TEST/LIVE mapping completeness (O3)
- allowlist: empty vs non-empty; count; hotel names if IDs resolve — not a
  customer-authorization UI that edits Production env
- last Domain A webhook outcomes; 0024 function present (already gated)
- migration ledger display is **not** required (Gate B is GHA, not Owner)

**Forbidden on this page:** toggle `SBG_SAAS_COMMERCE=live`, one-click GO LIVE,
paste secrets, run migrations, edit Vercel, dispatch GHA.

Copy: “LIVE commerce is CP31. This dashboard cannot activate it.”

---

## 15. Audit events

Minimum `action` values:

- `owner.granted` / `owner.revoked`
- `plan.created` / `plan.enabled` / `plan.disabled`
- `price_version.created` / `price_version.made_current`
- `stripe_mapping.test_attached` / `stripe_mapping.live_attached`
- `subscription.migration` (future; not V1 UI)
- `hotel.admin_action` (future; none in V1)
- `commerce_mode.change` (future; not Owner-toggled in V1)

Payload: actor, target type/id, safe before/after (`amount_minor`, plan code,
price version id, Price ID **identifier**). Never `sk_`, `whsec_`, DATABASE_URL,
passwords, or allowlist raw env dumps beyond hotel UUIDs already in `hotels`.

---

## 16. Security boundary

| Threat | Control |
|---|---|
| Hotel operator opens `/owner` | grant table fail-closed; 403 |
| Client-only hide of nav | server `beforeLoad` + every server function |
| IDOR on `/owner/hotels/$id` | Owner grant required; then read any SaaS hotel (platform scope is intentional). Non-owners never hit this path |
| Accidental Owner assignment | owner-plane first grant; later grants audited; no email magic |
| Privilege escalation via hotel ownership | ownership is a different table; never consulted for Owner |
| Stripe secrets in UI | classify/presence only |
| DATABASE_URL / owner URL | never read into Owner responses; owner URL never on Vercel |
| Arbitrary hotel mutation | no write APIs in O2; O3 writes catalogue only |
| Unsafe subscription manipulation | portal-first remains; Owner does not call Stripe to change subscriptions in V1 |
| CSRF | existing `assertSameSiteRequest` + cookie session |
| Audit bypass | write audit in the same SECURITY DEFINER as the mutation |
| Stolen Owner session | Better Auth session expiry; revoke grant; no impersonation helpers |
| Ops cookie used as Owner | different auth stack; `/ops` sessions are not Better Auth |

Runtime role `aether_app` keeps least privilege: SELECT on Owner tables;
mutation only through SECURITY DEFINER. No RLS project (standing V1 fence).

---

## 17. Explicit V1 exclusions

Out of O1–O3 unless a later checkpoint reopens them:

- CRM, email campaigns, helpdesk, marketing automation
- accounting, tax engine, coupon/promo engine
- arbitrary SQL editor, unrestricted impersonation
- manual card processing
- BI warehouse / complex dashboards
- annual or multi-currency pricing
- staff RBAC beyond a single Owner grant class
- Domain B revenue as SBG revenue
- one-click CP31
- SMS / WhatsApp / chatbot / custom domains (standing V2 fence)

---

## 18. CP26C-O2 — Owner dashboard foundation

**Implement:**

- migration: `sbg_platform_owners` (+ audit table if needed for grants)
- `requirePlatformOwner`
- `/owner` protected shell (SBG visual language)
- Overview: funnel + metrics available without catalogue amounts
- Hotels registry + read-only detail
- Revenue page: subscription counts / status only; Domain A caption
- System page: mode / credential **presence** / allowlist emptiness; no secrets
- Plans nav may render “available in O3”
- tests: non-Owner 403; operator with hotel cannot access; unauthenticated
  redirect; no Domain B amounts in metrics; `demo-kos` not a SaaS customer
  unless owned; no `src` commerce-mode writes

**Do not:** pricing mutation, Stripe API, Vercel env mutation, Neon ad-hoc,
`SBG_SAAS_COMMERCE=test|live`, hotel writes, impersonation.

---

## 19. CP26C-O3 — Commercial catalogue

**Implement:**

- `sbg_saas_plans` + `sbg_saas_price_versions` + audit actions
- seed BASIC / PRO / PREMIUM (**amounts are an operator decision recorded in
  O3, not invented here**)
- Owner Plans & Pricing UI: current vs retired, create version, make current
- TEST/LIVE Price ID fields (nullable)
- dual-read Checkout/webhook Price IDs (catalogue then env)
- fail closed if no Price ID for the active commerce mode
- tests: grandfathering; env fallback; inactive plan hidden from new Checkout;
  LIVE mapping unused while mode is not live; no amount rewrite in place

**Do not:** create Stripe TEST/LIVE Prices (that is CP26C.3 / CP31); set
commerce mode; allowlist the verification hotel; charge anyone.

O3 **unblocks** CP26C.3: TEST Prices are created from canonical version
amounts, then mapped onto those versions.

---

## 20. CP26C.3 pause / resume

CP26C.3 ran preflight, derived the Stripe contract, and **stopped** because
canonical BASIC / PRO / PREMIUM amounts are not in source or living docs, and
because Vercel Price IDs must not remain the permanent catalogue.

| | |
|---|---|
| Status | **PAUSED AFTER SAFE PREFLIGHT** |
| Stripe objects created | **none** |
| Vercel Stripe env installed | **none** |
| Commerce | **OFF** / ABSENT |
| Allowlist | **ABSENT** |

Resume **after O3**:

```
CP26C.2 PASS
  → CP26C-O1 (this document)
  → CP26C-O2
  → CP26C-O3
  → resume CP26C.3
  → CP26C.4
```

Only **CP31** activates LIVE commerce.
