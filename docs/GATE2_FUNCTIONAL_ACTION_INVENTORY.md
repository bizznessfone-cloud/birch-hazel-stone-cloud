# Gate 2 — Functional inventory and action mapping (phase 1)

**Status:** evidence-based inventory, not UX design or permission to expose controls. Baseline: `2444421` CI PASS. This inventory distinguishes existing route controls, implemented server functions without controls, and blocked capabilities. **Do not mistake an imported function or draft screen for a production-admitted feature.**

## Inventory legend

- **Visible** — route contains a control or visible read state, subject to route authentication and existing guards.
- **Server-only** — source contract exists but no customer-facing CTA is wired.
- **Denied** — deliberately blocked by contract.
- **Deferred** — not established as a complete V1 function.

## Founding and hotel setup

| User intention / action | Current implementation | Surface evidence | Status / mapping requirement |
| --- | --- | --- | --- |
| Register business name | `ensureFoundingOrganisationFn` | `/app/founding` business-name form | Visible; record validation, pending, success, ambiguous and unavailable |
| Classify as hotel or transfer operator | `classifyFoundingOrganisationFn` | `/app/founding` classification step | Visible; classification is immutable/controlled, not a casual profile toggle |
| Read founding progress | `readFoundingOnboardingStateFn` | `/app/founding` loader | Visible derived state; no fabricated completion |
| Register first hotel property | `createFoundingPropertyFn`, eligibility reader | `/app/founding` hotel path | Visible conditional action; operator must not create a fake owned hotel |
| View hotel and property setup | `getOnboardingState` | `/app/hotels/$hotelId` | Visible; recovery and incomplete setup states |
| Recover/attach an existing hotel | `hotel-recovery-fns.ts` | Hotel workspace conditional recovery | Visible conditional; must retain ownership/authority guard |
| Copy guest URL, preview, print QR | Hotel workspace and preview/QR routes | `/app/hotels/$hotelId` | Visible; QR readiness is not commercial activation |
| Read operator-linked properties | `listOperatorWorkspacePropertiesFn` | `/app/operator` | Visible read-only; distinguish grant and provider-authorised states |

## Four source functional contracts — actions not yet mapped to UI

| Action / state | Source implementation | Visibility | Authority and denial requirement |
| --- | --- | --- | --- |
| Find exact operator identity | `operator-identity-lookup-fns.ts`, migration 0050 | Server-only | Exact identity, no fuzzy selection; lookup is not a grant |
| Confirm hotel → operator property grant | `operator-property-grant-confirm-fns.ts` | Server-only | Hotel authority and explicit confirmed operator identity |
| Revoke hotel → operator grant | Same confirmation module | Server-only | Hotel authority; subordinate provider access revoked |
| Authorise / revoke specific provider | `operator-provider-authorisation-fns.ts` | Server-only | Hotel authority; provider agreement and property grant required |
| Read provider activation eligibility | `operator-workspace-fns.ts`, migration 0049 | Partial visible read | Eligibility does not activate bookings |
| Read approved agreement document | `approved-founding-agreement-fns.ts` | Server-only | Only immutable approved published version; placeholder cannot be accepted |
| Accept approved agreement | `founding-approved-acceptance-fns.ts` | Server-only | Authenticated atomic acceptance; no fabricated legal version |
| Read commercial onboarding stage | `commercial-onboarding-fns.ts` | Server-only | `canActivate=false` across every state |
| Read purchased / allocated / available licence quantities | `commercial-billing-evidence.ts` and authenticated reader | Server-only | Count is not property-specific entitlement |
| Release an allocated property licence | `property-licence-release-fns.ts`, migration 0058/0059 | Server-only | Authenticated payer billing authority, explicit allocation ID; idempotent audit |
| Assess commercial activation evidence | `commercial-activation-assessment.ts` | Server-only | Never returns operational permission |

## Existing billing controls requiring reconciliation

The existing `/app/billing` route already contains Connect, subscription Checkout, billing portal and property allocation controls backed by legacy `stripe-fns.ts`. **These are not evidence that the new transfer-operator onboarding contract is connected to those controls.** In particular, the route is hotel-ID-centred and describes the connected account as the hotel's. Before CTA mapping, reconcile hotel and operator payer/provider contexts and preserve Domain A (SBG SaaS) vs Domain B (guest fares) separation. Do not enable or change payment paths in this phase.

## Operational and guest surfaces to inventory next

- Guest: public QR/slug landing, transfer choices, date/time, passengers/luggage, contact, review/confirmation and token lookup.
- Operations: bookings list/detail, assignment, status transitions, drivers, vehicles, hotel controls, occupancy and conflict denials.
- Owner: hotels, plans, revenue, system and commercial publication boundaries.
- Security: login/recovery, expired sessions, authorisation denial, timezone/DST and concurrency conflict messages.

## Non-negotiable mapping rules

1. Each **implemented** action requires a discoverable CTA or intentionally documented non-UI trigger; every status requires a visible interpretation, including pending, denied, revoked and unavailable.
2. A control must be disabled/absent if the server contract is not authorised; UI is never the security boundary.
3. Distinguish `grant`, `provider authorisation`, `licence allocation`, `active subscription` and `operational activation` in copy and state; do not collapse them into one “active” switch.
4. Reuse existing screens, routes and functions. Do not invent new application roles, fake hotel records, duplicate billing systems or parallel operator apps.
5. Inventory and reconcile all capabilities before component layout, visual redesign or CTA implementation.
6. Every mapping row must eventually include actor, prerequisite, data source, CTA/read state, confirmation, success, failure, revocation and audit implications.

**Next:** inspect guest, operations, owner and auth routes, then produce the full action-to-surface coverage matrix and identify real gaps. This is documentation only.


## Mandatory Grok frontend/backend separation rule — non-negotiable

**Functional completeness is not indiscriminate visibility.** Every platform capability must be inventoried, but only authorised, relevant, human-readable actions may be surfaced to the correct actor. Grok must never render database terminology, RPC names, migration identifiers, internal entitlement states, raw IDs/tokens, test fixtures, debug controls, infrastructure status, internal audit actions, or backend-only CTA/buttons on public guest pages or ordinary hotel/operator screens.

| Surface | Permitted presentation | Prohibited presentation |
| --- | --- | --- |
| Public marketing and guest booking | Human-readable service, booking, payment and confirmation actions with relevant user states | SQL/RPC names, migrations, allocation guards, developer actions, diagnostics, internal provider/entitlement machinery |
| Authenticated hotel workspace | Plain-language hotel-authorised business operations and relevant account/billing states | Internal DB controls, privileged owner administration, operator-only actions without hotel authority, raw technical errors |
| Authenticated transfer-operator workspace | Plain-language operator-authorised property, licence and business actions | Hotel-owner-only authorisation controls, raw internal permission flags, booking/payment actions while denied |
| SBG owner/internal administration | Explicitly authorised operational controls in a segregated owner-only surface | Any accidental reuse or exposure of those controls in public or customer routes |

**Required enforcement for Grok and review:**

1. Map each backend capability to an **actor, authorisation rule, and intended surface** before proposing a visible CTA. Mark non-user-facing capabilities as **internal/no CTA**; this still counts as accounted-for functionality.
2. Public copy must use customer terminology, not implementation identifiers. Example: `sbg_release_property_licence_for_user` is never a label; a permitted billing-authority action could be **Release licence** with a clear confirmation and consequences.
3. Never automatically generate a button from a function, API route, DB migration, enum or test name. Never expose developer-only controls simply to achieve full functional coverage.
4. Internal state codes must be translated to plain-language statuses. Show safe, actionable failure messages; do not reveal SQL, stack traces, database constraints, credentials, personal tokens or debug payloads.
5. The UI must hide or disable actions outside the actor's scope **and** the server must enforce authority independently. No client-side-only security.
6. Preserve separation between public guest routes, authenticated business routes and privileged SBG owner/internal routes. Do not conflate hotel-owner permission with transfer-operator permission.
7. No operational activation, guest money collection, live billing or production admission may be implied by a visible CTA until its separate release gate is explicitly approved.
8. During UX mapping, require a **public-surface contamination check** for every guest and marketing route, plus a **role/authority matrix** for every hotel, operator and owner action. Any leaked internal CTA or raw backend terminology is a **release-blocking defect**.
9. Any internal-only function without a CTA is documented as intentionally invisible, not treated as an omission requiring a UI control.

**Grok instruction:** Audit and map first. Do not design, create, expose or rename controls until their actor, permission, surface and customer-language label are approved. This rule takes precedence over the general requirement that all functions be represented.
