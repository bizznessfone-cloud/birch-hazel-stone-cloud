# SCAN / BOOK / GO — CURRENT PROJECT STATE

**CP21B reconciliation state**

## Source

Repository: `bizznessfone-cloud/birch-hazel-stone-cloud`
Branch: `main`
CP21B audit baseline: `fa823186a548a2009bbb3dc1e7453c75cf94b919`
CP15 frozen checkpoint: `96947e6c1840d5c04bc118c8abf93b2fa802469c`

GitHub `main` is authoritative. Grok workspace state is disposable.

## Current hardened foundation

Source already contains:

- CP13A SQL-created production LOGIN architecture
- CP14 hotel configuration, quote/destination protections and timezone architecture
- CP15 hotel-scoped Ops identity/authentication
- CP16C/CP17 runtime privilege hardening and hotel-local Ops Today
- CP19 recovery/control-plane hardening
- CP20 centralized transactional confirmation-email architecture

Do not restart or redesign these foundations.

CP22 is currently implementing the authenticated /app onboarding layer.

## CP20 email

Booking confirmation email is a post-commit notification layer:

```
successful booking commit
        ↓
confirmation email
        ↓
Resend
```

Email failure is isolated from booking success.

The guest receives a secure View My Booking URL using the confirmation token. The raw token is not separately displayed.

Resend/domain/production credential activation is a later controlled checkpoint.

## CP21 product-surface audit

Core booking, occupancy, tenancy, hotel provisioning and internal Ops foundations are substantially built.

Current route reality:

- `/book/{hotelCode}` exists.
- `/confirmed/{token}` exists.
- `/ops/*` exists and remains internal operations.
- `/app/*` does not yet exist.

The remaining V1 product layer includes:

- operator onboarding
- hotel setup
- first service
- preview
- QR presentation
- subscription/activation
- Stripe integration
- final public hotel slug presentation
- controlled V1 end-to-end testing
- final security, production and load gates

## V1 operator journey

```
account
  ↓
hotel
  ↓
first service
  ↓
preview
  ↓
QR
  ↓
plan
  ↓
Stripe activation
  ↓
LIVE
```

This belongs under `/app/*`.

Do not repurpose `/ops/*`.

## Payment boundary

Stripe is now a V1 product-layer concern. It was intentionally outside the original frozen Blueprint v2 and is being layered over the hardened base now.

The platform should not become the hotel's payment custodian or commission layer merely to process hotel/operator payments. Exact account/payment routing is a later controlled Stripe implementation decision.

## Guest journey

V1 remains:

```
hotel QR
  ↓
human-readable hotel page
  ↓
service
  ↓
guest booking
  ↓
confirmation
```

No guest account.

Confirmation remains token-based.

## Public URL

Current guest route: `/book/{hotelCode}`.

Target V1 presentation: human-readable hotel slug such as `/{hotel-slug}`.

That presentation change is CP23 and must not alter database identity or booking ownership.

## V2 fence

Keep SMS, WhatsApp, chatbot, custom domains, hotel-local Ops Today enhancements, new booking concepts, marketplace features and unrelated feature expansion out of the current V1 build.

## Next checkpoint

**CP22 — V1 Operator Onboarding**

Build on the hardened base:

1. account
2. hotel
3. first service
4. preview
5. QR
6. handoff to plan/activation

Do not reopen CP15, CP16 or CP19 architecture.

## Reconciliation rule

Historical checkpoint documents are preserved.

Stale current-state claims are not authoritative when they conflict with current GitHub source and this file.

`.grok/status` remains untracked and must never be committed.

No Neon, Vercel, secret or deployment action belongs to CP21B.
