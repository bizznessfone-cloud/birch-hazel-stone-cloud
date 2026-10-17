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
- No hold expiry column.
- No `received_after_expiry` disposition. `sbg_apply_payment_event` writes the supplied status onto the payment row only.

## Implementation sequence

No stage is authorised by this document. Do not apply a migration from this checkpoint.

A. Lifecycle schema and invariants. New migration only. Add booking lifecycle, `hold_expires_at`, and confirmed-at. Add the late-payment disposition without editing [0021](../migrations/0021_cp25_hotel_guest_payments.sql) or [0030](../migrations/0030_cp272_fix_prepare_booking_payment.sql) in place. Rollback drops only the new columns and constraint values; existing payment rows stay in the old status set.

B. Provisional hold and expiry. Server create writes `awaiting_payment`. An expiry worker flips unpaid holds. No GiST or DST-function edit.

C. Executing-provider payment binding. Resolve the payee from the provider's organisation. Reject the hotel account for an operator provider. Keep CP31 closed.

D. Verified payment-to-confirmation. Webhook confirms only inside the hold. Replay is a no-op. Late payment is recorded, not confirmed.

E. Confirmation email and dispatch admission. Send the email only after D. Assignment functions refuse every earlier state.

F. Guest interface. Replace premature confirmed copy after the server tests pass. No redesign in this checkpoint.

G. Isolated end-to-end acceptance on a disposable branch. Production, Stripe LIVE, and CP31 remain separate authorisations.

Recommended first stage: **A**. The later stages are unsafe while confirmation is still an insert side-effect and the payee is still the hotel row.
