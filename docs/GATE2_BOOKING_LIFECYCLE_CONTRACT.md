# Gate 2 — booking lifecycle contract

Status: CONTRACT AND TEST GATE. Not an implementation of checkout, not a migration, and not CP31 admission.

Baseline: `674b0b3e652818ad9b32d5dd46b96ea7110c1b79`. The executable decisions are in [src/lib/aether/booking-lifecycle.ts](../src/lib/aether/booking-lifecycle.ts). They are not called by the booking engine or Stripe webhook.

The guest occupancy duration remains the server-owned provisional value of 60 minutes. This contract does not change it.

## Three different facts

| Fact | Authority | Current storage |
|---|---|---|
| Booking lifecycle | Server transition below | Not stored. Insert is treated as a live booking |
| Payment disposition | Verified Stripe event bound to the prepared payment row | `sbg_booking_payments.status`: `pending`, `paid`, `failed`, `expired`, `canceled` |
| Dispatch eligibility | Derived: `confirmed_paid` and `paid` and the executing provider is still authorised | Vehicle or driver assignment, with no payment check |

A Checkout return URL, including `payment=success`, is not a transition. It must leave both lifecycle and payment unchanged.

## States and actors

Booking lifecycle: `draft`, `awaiting_payment`, `payment_processing`, `confirmed_paid`, `expired`, `failed`, `cancelled`, `refunded`.

`draft` is not a row. The guest browser holds the draft. The server creates `awaiting_payment`.

Payment disposition adds one required value that the current check constraint does not allow: `received_after_expiry`. Do not overload `paid` for that case.

| Actor | May do | Must not do |
|---|---|---|
| Guest | Submit draft inputs | Set paid, confirmed, expiry, or payee |
| Server | Open the hold and, only if admitted, the Checkout Session | Treat the return URL as payment |
| `stripe_webhook` | Apply a signature-verified event once | Confirm from an unbound, replayed, or late event |
| `expiry_worker` | Expire an unpaid hold after `hold_expires_at` | Expire a verified paid booking |
| Dispatch | Assign a vehicle or driver after operational admission | Assign during a hold |
| Reconciliation | Cancel or record a settled refund | Reinstate an expired hold because money arrived |

Forbidden transitions, all tested:

- Return URL to `confirmed_paid`.
- Confirmation email before `confirmed_paid` and `paid`.
- Resource assignment before operational admission.
- Expiry of a booking whose payment is already `paid`.
- A second application of the same Stripe event id.
- Confirmation onto the hotel connected account when the executing provider is an independent operator.
- Confirmation after provider revocation, an inactive agreement, a missing licence allocation, or an inactive subscription.
- Opening Checkout when Domain B commerce has not been explicitly admitted.

## Temporary hold

What exists today:

- `aether_bookings_occupies_tg` fills `occupies` from the hotel civil pickup time plus duration for every non-cancelled row. Application-supplied ranges are discarded.
- The GiST exclusions in [migrations/0003_occupancy.sql](../migrations/0003_occupancy.sql) apply only where `vehicle_id` or `driver_id` is not null, `cancelled_at` is null, and the range is non-empty.
- Guest create does not assign a vehicle or driver. Two unassigned bookings at the same time do not conflict.
- [src/lib/aether/guest-create.ts](../src/lib/aether/guest-create.ts) inserts the booking and then sends the confirmation email in the same request.

Minimum hold, without editing the GiST predicates or the civil-time trigger:

1. Persist the row as `awaiting_payment` with `hold_expires_at`.
2. Do not assign a vehicle or driver, so the existing GiST predicates still match nothing for that row.
3. Do not send confirmation email and do not show a confirmed guest state.
4. On expiry, set lifecycle `expired` and payment `expired` when it was still `pending`. Leave `occupies` to the current trigger. Because no resource is assigned, expiry releases no GiST slot. That is intentional.
5. Operational admission is the first point at which assignment may occur. The unchanged GiST constraint then remains the overlap authority. A `23P01` conflict at assignment does not unconfirm the payment; it becomes a reconciliation case.

This does not create a hotel-wide seat quota. Adding one would be a new constraint, not a change to the vehicle or driver exclusions.

Checkout retry uses the existing reusable pending session. A second session must not be opened while that URL is still inside the hold. Abandoned checkout is the expiry path. A duplicate Stripe event id is a no-op, including when the replayed payload would otherwise fail a later check.

Expiry against settlement: if verified payment time is less than or equal to `hold_expires_at`, and every other precondition holds, the booking becomes `confirmed_paid`. If the worker has already expired the row, or verified time is later than the hold, the late-payment rule applies even when Stripe reports `paid`.

Provisional TTL: **30 minutes** (`PROVISIONAL_HOLD_TTL_STATUS = provisional_pending_approval`).

Rationale: Stripe Checkout's shortest session lifetime is 30 minutes. The session expiry and the hold expiry need the same absolute instant, so a normal session cannot complete after the hold, and an abandoned session does not reserve the row for Stripe's 24-hour default. The TTL is an absolute millisecond offset from server time. It is not a civil clock and it does not follow Europe/Athens DST. It is not approved for production.

## Executing-provider payee

`resolveLiveQuote` currently takes one active `hotel_provider_agreements` row. Payment preparation joins `sbg_stripe_connections` on `bookings.hotel_id`. That treats the hotel as the payee.

Required binding before Checkout and again before confirmation:

- One active agreement for the executing provider.
- An active property-licence allocation and an active organisation subscription for the organisation that owns that provider. SaaS activation remains separately closed: [commercial-activation-assessment.ts](../src/lib/aether/commercial-activation-assessment.ts) cannot admit operations.
- Hotel in-house: the payee account is the hotel organisation's connected account.
- Independent operator: an active property grant and an active provider authorisation are both required. The payee account is the operator account. An event or session on the hotel account is `hotel_account_not_payee` or `wrong_account` and must not call `sbg_apply_payment_event`.
- Domain B commerce admission is a separate explicit flag. A valid payee does not open Checkout while that flag is false.

## Late payment

A verified `paid` event after expiry or failure:

- Does not return the lifecycle to `awaiting_payment` or `confirmed_paid`.
- Sets payment disposition to `received_after_expiry`.
- Does not assign a vehicle or driver and does not send the confirmation email.
- Records the Stripe event id once.
- Leaves refund or manual rebooking to reconciliation. Automatic reinstatement is forbidden.

## Current gaps

These are still true of this tree, and the contract tests assert them so the gap cannot disappear unnoticed:

- Insert plus immediate confirmation email.
- Confirmation page copy "Confirmed" / "Your transfer is booked" before payment verification.
- Payee lookup by hotel connection.
- The running booking path still does not write `hold_expires_at` or stop the confirmation email. Stage A adds the columns in source only.
- `sbg_apply_payment_event` still writes the supplied status onto the payment row only. `received_after_expiry` is allowed by migration 0060 and is not confirmation.

## Stage A schema

Source migration [migrations/0060_gate2_booking_lifecycle_schema.sql](../migrations/0060_gate2_booking_lifecycle_schema.sql) is not in `ACCEPTED_LEDGER` or `AUTHORISED_PENDING`. It does not change GiST, the occupancy trigger, or the 60-minute duration rule.

`bookings.lifecycle_state` is separate from `bookings.status`. Existing rows, and any current insert that does not set the column, become `legacy_unreconciled` with null `hold_expires_at` and null `confirmed_paid_at`. That state keeps historical assignments. It is not `confirmed_paid` and it cannot store a confirmation timestamp. Stage B must set an open-hold state explicitly; the default stays unreconciled so today's insert path does not start failing and does not become paid.

The schema requires a finite `hold_expires_at` for `awaiting_payment` and `payment_processing`, and a finite `confirmed_paid_at` for `confirmed_paid`. It cannot see `sbg_booking_payments`. A `confirmed_paid` row without a payment row is still possible until the Stage D transition is the only writer. `aether_app` and `aether_runtime` still cannot write the three lifecycle columns; the guard trigger covers the table-level update grant from migration 0011. The Stage D function writes them only as a security definer, and only for `aether_webhook`.

`sbg_booking_payments.status` accepts `received_after_expiry` in addition to the existing statuses. Existing payment rows are not rewritten. The new status is not `paid` and does not change the booking lifecycle.

## Stage B holds

Source migration [migrations/0061_gate2_provisional_hold_operations.sql](../migrations/0061_gate2_provisional_hold_operations.sql) adds `sbg_open_provisional_hold` and `sbg_expire_provisional_holds`. Neither is scheduled, and the guest booking route does not call them. The 30-minute ceiling remains `provisional_pending_approval`.

A hold can be opened only for a `legacy_unreconciled` booking created within the last two minutes, with no vehicle, driver, cancellation, or payment row. The database clock sets `hold_expires_at`. The caller supplies a TTL of 60 to 1800 seconds and cannot supply the expiry timestamp. A second open is `duplicate_hold` and does not move the deadline. Older or assigned rows stay `legacy_unreconciled`.

Expiry locks due `awaiting_payment` or `payment_processing` rows with `for update skip locked`, then locks any payment row. It sets the booking lifecycle to `expired` only when payment status is not `paid` or `received_after_expiry`. It does not change the payment row, a Stripe session, or any vehicle or driver. A second call is a no-op. A past-due hold that already has verified payment evidence is left unchanged for reconciliation. Stage D locks the booking first, then the payment row, and does not confirm an expired lifecycle. Expiry will not wait on a booking another session has locked, because it uses `skip locked`. The payment transition waits. That overlap is covered by [verified-payment-concurrency.test.ts](../src/lib/aether/verified-payment-concurrency.test.ts) against a disposable local Postgres. It is not part of the default PGlite suite, and a PGlite run is not a concurrency pass.

`aether_app` may execute `sbg_open_provisional_hold`. Migration 0062 revokes `aether_app` execute on `sbg_expire_provisional_holds`. `aether_runtime` and `public` may not execute either function. Direct updates of the lifecycle columns remain denied for both application roles. No expiry worker role is created.

## Implementation sequence

No stage is authorised for production by this document. Stages A through E are source-only. Do not apply migrations 0060, 0061, 0062, 0063, or 0064 from this checkpoint.

A. Lifecycle schema and invariants. New migration only. Add booking lifecycle, `hold_expires_at`, and confirmed-at. Add the late-payment disposition without editing [0021](../migrations/0021_cp25_hotel_guest_payments.sql) or [0030](../migrations/0030_cp272_fix_prepare_booking_payment.sql) in place. Rollback drops only the new columns and constraint values; existing payment rows stay in the old status set.

B. Provisional hold and expiry. Server create writes `awaiting_payment`. An expiry worker flips unpaid holds. No GiST or DST-function edit.

C. Executing-provider payment binding. Resolve the payee from the provider's organisation. Reject the hotel account for an operator provider. Keep CP31 closed.

D. Verified payment-to-confirmation. Webhook confirms only inside the hold. Replay is a no-op. Late payment is recorded, not confirmed.

E. Confirmation email and dispatch admission. Send the email only after D. Assignment functions refuse every earlier state.

F. Guest interface. Replace premature confirmed copy after the server tests pass. No redesign in this checkpoint.

G. Isolated end-to-end acceptance on a disposable branch. Production, Stripe LIVE, and CP31 remain separate authorisations.

Recommended next stage, after separate authorisation: **F**. Do not start it from this checkpoint. Stage E admits a paid confirmation claim and blocks unpaid dispatch for the new lifecycle. It does not send email, change the confirmation page, or mount checkout.

## Stage C payment authority

Source migration [migrations/0062_gate2_executing_provider_payment_authority.sql](../migrations/0062_gate2_executing_provider_payment_authority.sql) is not in `ACCEPTED_LEDGER` or `AUTHORISED_PENDING`. It does not replace `sbg_prepare_booking_payment` or `sbg_apply_payment_event`, and it does not open Checkout.

`sbg_resolve_executing_payee(booking_id)` reads the booking's recorded `executing_provider_id`. The caller cannot supply a Stripe account, a provider, or a recipient. Hotel in-house (`providers.kind = in_house`, no active operator authorisation) pays the hotel organisation. An independent operator (`external`, exactly one active provider authorisation, and an active property grant) pays that operator organisation. Both require one active agreement. The property's one active licence allocation stays on `hotels.organisation_id`, because migration 0027 rejects any other holder. The payee's own `sbg_organisation_billing.status` must be `active` with `licensed_quantity >= 1`. `trialing` and `past_due` are not payment authority. The current account is `sbg_organisation_stripe_connections`, not `sbg_stripe_connections` joined from `bookings.hotel_id`. An operator account that equals the hotel's connected account is `hotel_account_not_payee`. Anything ambiguous fails closed.

`sbg_bind_payment_authority(booking_id)` writes that result once onto the existing `sbg_booking_payments` row: organisation, executing provider, kind, account, and `authority_bound_at`. It does not change amount, currency, session, payment intent, or status, and it does not insert a payment row. A second call returns `immutable` and does not follow a later account or payee change. `sbg_payment_authority_drift` reports the difference and does not rewrite the attempt.

`sbg_assess_payment_authority_event` compares a webhook claim with that frozen attempt: booking, payment, executing provider, account, session, amount, and currency. A hotel account presented for an operator attempt is `hotel_account_not_payee`. The function does not insert `sbg_stripe_events`. A mismatch therefore cannot consume a legitimate event id. `aether_app` may execute these four functions. `aether_runtime` and `public` may not. Direct writes of the authority columns are denied to both application roles by `sbg_booking_payment_authority_guard`.

## Stage D verified payment

Source migration [migrations/0063_gate2_verified_payment_transition.sql](../migrations/0063_gate2_verified_payment_transition.sql) is not in `ACCEPTED_LEDGER` or `AUTHORISED_PENDING`. It does not replace `sbg_prepare_booking_payment` or `sbg_apply_payment_event`. It does not open Checkout, send email, admit dispatch, or change the public webhook.

`sbg_accept_verified_payment_event` is executable only by `aether_webhook`. That role is `nologin`, has no table DML, and is not granted to `aether_app`. `aether_app`, `aether_runtime`, and `public` cannot execute the function. The function is security definer. It does not verify a Stripe signature. `p_signature_verified` is the caller's attestation, not a signature. The only cryptographic check remains `verifyStripeSignature` in [stripe.server.ts](../src/lib/aether/stripe.server.ts). [verified-payment.ts](../src/lib/aether/verified-payment.ts) calls this function and nothing else. It is not imported by the webhook, guest checkout, or Domain B.

Lock order is the booking row, then the payment row. The Stripe event id is inserted only after `sbg_assess_payment_authority_event` returns `matched`, in the same transaction as the payment disposition and the lifecycle write. A mismatch, a false attestation, a bad event id, an unsupported event, an ineligible lifecycle, a refund that is not yet confirmed and paid, or authority drift does not insert the event id. The same event id is a no-op. A second distinct event after settlement is `ignored_after_settlement` and does not confirm again. `confirmed_paid_at` and `paid_at` come from `clock_timestamp()`. The caller cannot supply them. The success URL is not a parameter.

A success can confirm only when the lifecycle is `awaiting_payment` or `payment_processing`, the hold is finite and still at or after the database clock, and the payment status is `pending`, `expired`, or `canceled`. `expired` and `canceled` here are Checkout Session dispositions, not an expired booking hold. The same predicate runs the live payee check: `sbg_resolve_executing_payee` must still return the frozen organisation and the account on the event. A revoked authorisation, a changed account, or a changed payee is `authority_drift`. Drift does not confirm, does not insert the event id, and does not retarget the attempt. An expired booking hold is never confirmable, including when the Checkout Session status is already `expired` or `canceled`. That path records `received_after_expiry`, moves a still-open `awaiting_payment` or `payment_processing` row to `expired`, and does not set `confirmed_paid_at`. `failed` is terminal for confirmation. A later success after `failed` is late reconciliation and does not resurrect the hold. A later failure, cancellation, or refund does not overwrite `paid`, `received_after_expiry`, `confirmed_paid`, or `refunded`. A refund is applied only when the lifecycle is already `confirmed_paid` and the payment is `paid`; the payment stays `paid` and the lifecycle becomes `refunded`. `checkout.session.completed` without `paid` is `processing`: the event is recorded and nothing is confirmed, so a later distinct paid event can still confirm. `checkout.session.expired` marks a pending payment `expired` and does not change the booking lifecycle, so a later paid event can still confirm while the hold is open.

### Integration contract

Do not activate this handler in the public checkout route. When a later authorisation does, the order is fixed:

1. `verifyStripeSignature` must return true. Do not call the transition when it does not.
2. Call `sbg_accept_verified_payment_event` only on a connection whose role is `aether_webhook`. Do not grant that role to `aether_app` or accept the call from a guest request.
3. Stop calling `sbg_apply_payment_event` for these Checkout events in the same activation. That function remains in place for the current production path. It can set `sbg_booking_payments.status` to `paid` without `confirmed_paid`, and it inserts `sbg_stripe_events` before its account check. A row it has already marked `paid` is `ignored_after_settlement` here and will not be confirmed afterwards.
4. Do not treat `/confirmed/{token}?payment=success` as evidence.
5. Do not confirm an expired, failed, cancelled, refunded, or `legacy_unreconciled` lifecycle.
6. Do not retarget a bound attempt when the current payee or account has drifted.

Stage E, confirmation email and dispatch, does not run from the payment transition. The claim is a separate operation.

## Stage E paid confirmation and dispatch

Source migration [migrations/0064_gate2_paid_confirmation_admission.sql](../migrations/0064_gate2_paid_confirmation_admission.sql) is not in `ACCEPTED_LEDGER` or `AUTHORISED_PENDING`. It does not send email and does not change GiST.

`legacy_unreconciled` is not converted. Those rows do not receive a paid confirmation email. An assignment on a legacy row is still allowed when `cancelled_at` is null and the vehicle or driver belongs to the booking's executing provider. That is the existing operator path. It is not the paid-confirmation path.

`sbg_claim_confirmation_email(booking_id)` is executable only by `aether_mailer`. The role is `nologin`, has no table DML, and is not granted to `aether_app`. The function locks the booking, then the payment. It admits only `confirmed_paid` with a finite `confirmed_paid_at`, a payment in `paid` with `paid_at`, and a frozen executing-provider binding that matches the booking. It refuses legacy, pending, processing, expired, failed, cancelled, and refunded rows. It returns no guest fields.

One outbox row exists per booking. The first call inserts `claimed` for five minutes. A second call while that claim is live returns `claim_held` and does not issue another token. Recording `sent` with the live token is terminal (`already_sent`). Recording `failed` with a short provider code keeps the row retryable. An expired claim can be reclaimed. Attempt 5 is the last. A claim is not delivery. [confirmation-admission.ts](../src/lib/aether/confirmation-admission.ts) calls the sender only after the claim transaction has finished, and guest creation does not call it. [guest-create.ts](../src/lib/aether/guest-create.ts) no longer calls `sendConfirmationEmail`. The confirmation page copy is unchanged.

`sbg_bookings_dispatch_admission_guard` runs before insert or update. Clearing a vehicle or driver is allowed. Setting one is refused unless the resource belongs to the executing provider and either the row stays `legacy_unreconciled`, or the lifecycle is already `confirmed_paid`, the payment is `paid`, and `sbg_resolve_executing_payee` still succeeds. Revocation, cancellation, and every earlier new lifecycle are `dispatch_not_admitted`. The occupancy exclusion constraint is unchanged. Direct `aether_app` updates of `vehicle_id` or `driver_id` hit the same trigger. `inventory.ts` maps that error and does not widen operator scope.

Stage F, the guest confirmation copy, stays unauthorised.
