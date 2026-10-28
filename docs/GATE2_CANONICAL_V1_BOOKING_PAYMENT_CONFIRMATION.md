# Gate 2 — Canonical V1 Booking, Payment and Confirmation Contract

Status: APPROVED PRODUCT INTENT; SOURCE RECONCILIATION REQUIRED. Documentation only. Not permission for CP31, production migration, live Stripe, payment collection or UI rollout.

## Guest promise

Scan hotel QR → Select transfer → Review details and full fare → Pay securely → Receive confirmed booking.

The guest chooses journey, date, pickup time, passengers, luggage and contact details. The guest does not select or override vehicle/driver occupancy duration, access internal scheduling settings, or see technical terms such as SQL, migration, RPC or entitlement.

## Transactional states

1. DRAFT: guest inputs only, no booked capacity or confirmation.
2. AWAITING_PAYMENT: server validates live hotel, authorised executing provider, quote, availability and payment eligibility; creates a time-limited provisional booking/hold with an expiry. This is NOT a confirmed transfer.
3. PAYMENT_PROCESSING: Stripe Checkout opened on the responsible executing provider's connected account. Return URL is informational, never proof of payment.
4. CONFIRMED_PAID: only after authenticated, idempotent server-side payment verification and successful booking-state transition. Send confirmation and include transfer in operational schedule.
5. EXPIRED_OR_FAILED: safely release unpaid provisional hold; do not confirm or send a final confirmation.
6. CANCELLED_OR_REFUNDED: explicit authorised transitions, audit and financial reconciliation. No silent reversal.

A checkout expiry, retry, late webhook, duplicate webhook, asynchronous payment, cancellation or provider revocation must not cause double allocation or an unearned confirmation. Define and test hold TTL, atomicity, webhook idempotency and reconciliation before activation. The existing GiST exclusion and Athens civil-time/DST safeguards must be preserved.

## Duration authority

Guest must not see or edit occupancy duration. The server must determine duration from an approved operational rule (existing client default is 60 minutes; earlier design assumption was 90 minutes; resolve the authoritative default explicitly before implementation). Public API must reject or ignore client-supplied duration safely and cannot trust the browser. An authorised hotel or operator may amend duration only through a separately admitted server-authorised operation with conflict checks and audit. Occupancy duration is not a promise of journey length.

## Payment and ownership

Guest fare belongs to the responsible hotel or transfer operator, not SBG. The server resolves the executing provider and corresponding connected Stripe account; never assume the hotel is the payee when an independent operator provides the transfer. SBG's separate EUR 179/property SaaS subscription is not the guest fare. Payment initiation and CTA eligibility must fail closed until CP31 admission, provider authority, connected-account readiness, licence/subscription policy and live commerce approval are verified.

## Guest-facing copy

Before payment: 'Review and pay' / 'Complete payment'; after checkout return while verification pending: 'Checking your payment'; after verified payment: 'Your transfer is confirmed'. Retrieval should use a friendly confirmation-link description, preserving high-entropy token-only access. No 'confirmed' label or confirmation email before payment verification. Internal occupancy duration should not be shown as a promised travel time.

## Evidence from current repository (not yet compliant)

- guest.ts DEFAULT_DURATION_MINUTES is 60; guest-book.tsx exposes a 1–1440 minute duration stepper and passes duration to createPublicBooking; booking-fns.ts validates client-supplied duration; booking.ts stores that value.
- guest-create.ts sends a confirmation email immediately after booking insert, before guest payment.
- confirmed.$token.tsx now shows the server lifecycle projection. It no longer says the transfer is booked before payment, and it does not start checkout. `guest-payment-fns.ts` still contains the unmounted legacy prepare path.
- guest-payment-fns.ts invokes sbg_prepare_booking_payment and creates Stripe Checkout on a connected account; an explicit CP31 admission guard has not been established by this review.
- domain-b-payment.ts currently binds payment events through a hotel-associated Stripe connection. Reconcile this with the independent executing-provider model.
- Booking insertion and occupancy are already implemented; do not replace working exclusion, idempotency, time-zone or audit protections without tests.

## Implementation order and acceptance gates

A. Establish payment/booking state machine, authoritative server duration and provisional hold lifecycle; identify DB migration and backward compatibility implications.
B. Write failing tests for guest duration override, premature confirmation/email, unpaid expiry/release, webhook idempotency, async payment, wrong provider account, revoked provider, stale subscription, concurrent checkout and DST/conflict cases.
C. Implement minimal server and database changes behind fail-closed flags. No production migrations.
D. Update guest-facing actions and plain-language statuses only after server contract tests pass; no developer/backend controls on public surfaces.
E. Verify hotel-managed and operator-managed end-to-end flows in disposable/test environments. CP31 and live payments require separate explicit authorisation.

This contract supersedes any interpretation of 'create booking' as immediate paid confirmation. It does not assert that provisional holds or confirmed-paid transitions already exist.
