# CP22 — V1 OPERATOR ONBOARDING

**Status: historical checkpoint specification (source complete). Not the next task.**

Current living next execution checkpoint is **CP26B**. See `docs/ROADMAP.md`.
CP26 is not go-live; only CP31 activates commerce.

---

**Original status: complete; executable validation pending**

## Current source

`390a471e7fcdac87ec9bd9e77ec89b2aea82a73f`

## Baseline

CP21B reconciled the Grok workspace and preserved the historical record.

CP22 builds the first V1 SaaS product layer over the hardened booking/occupancy/tenancy foundation.

## Implemented in this checkpoint

### Operator account

- Better Auth API mounted at `/api/auth/*`
- Better Auth auth schema copied into the migration surface
- V1 operator authentication enabled through email/password
- `/login` supports:
  - work email
  - password
  - optional name on account creation
- guest authentication remains unchanged: guests do not create accounts.

### SaaS application surface

- `/app/*` is now the authenticated operator surface.
- `/ops/*` remains the internal operations desk.
- `/app/` routes a signed-in operator to onboarding or the first hotel workspace.
- `/app/onboarding` implements:
  1. hotel
  2. first transfer service
  3. first destination + price
  4. configuration preparation

### Product-layer data

Migration `0018_cp22_saas_onboarding.sql` adds:

- `app_hotel_accounts` — Better Auth user to hotel ownership mapping.
- `hotel_services` — V1 service seam; transfer is the first implemented kind.

Hotel/provider/service provisioning is exposed to the production runtime through narrow SECURITY DEFINER functions rather than broad table DML.

The in-house transfer provider is automatically created for a new hotel and attached through the existing hotel/provider agreement model.

### Preview / QR boundary

The hotel workspace exposes the canonical guest URL as the QR destination and provides copy functionality.

The public guest route remains `/book/{hotelCode}` until CP23 introduces the human-readable hotel slug.

Actual QR image generation is offline and dependency-free. The hotel workspace exposes `/app/hotels/{hotelId}/qr` with SVG download and browser print support. CP23 now targets the human-readable hotel slug.

## Follow-on V1 checkpoints

CP23 adds the public human-readable hotel slug.

CP24 adds the SBG subscription activation surface and Stripe Connect account boundary.

The remaining controlled payment step is guest transfer Checkout/PaymentIntent execution against the connected hotel Stripe account.
