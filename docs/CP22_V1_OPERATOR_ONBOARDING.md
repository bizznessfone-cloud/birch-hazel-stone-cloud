# CP22 — V1 OPERATOR ONBOARDING

**Status: implementation in progress**

## Current source

`65342b6ffef977ff34d7ec9ea05ae18c239cc1f6`

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

- `/app/*) is now the authenticated operator surface.
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

Actual QR image generation/print asset remains the next product-surface increment rather than being faked with an external QR service.

## Not implemented yet

- public human-readable hotel slug
- downloadable/generated QR asset
- subscription plan UI
- Stripe subscription activation
- Stripe Connect for hotel guest payments
- LIVE entitlement enforcement through subscription state
- final V1 end-to-end flow

Those belong to subsequent controlled checkpoints.

## Security boundary

No broad `aether_app` DML was restored.

The new onboarding mutation path is:

```
authenticated Better Auth user
        ↓
authMiddleware
        ↓
aether_app
        ↓
narrow SECURITY DEFINER onboarding function
        ↓
owner-owned hotel/service objects
```

The existing occupancy, booking, hotel/provider, and Ops security model remains intact.

## Next

Finish CP22 with the actual preview/QR presentation and onboarding regression coverage, then proceed to CP23 public hotel slug and the later subscription/Stripe checkpoints.
