# CP23 — PUBLIC HUMAN-READABLE HOTEL SLUG

**Status: historical checkpoint specification (source complete). Not the next task.**

Current accepted baseline is POST-CP25G.3 at
`4c20e9b9574309a0edbeb03f8675febdef38dede`. See `BUILD_STATE.md`.
Next numbered checkpoint: **UNDEFINED**. Do not invent CP26.

---

**Original status: source implementation complete; executable validation pending**

## Objective

Move the public hotel booking presentation from the technical:

`/book/{hotelCode}`

to the human-readable V1 format:

`/{hotelSlug}`

Example:

`https://scan-book-go.vercel.app/blue-lagoon`

The hotel UUID remains the database identity. The existing hotel code remains an internal compatibility identifier.

## Implemented

- `migrations/0019_cp23_public_hotel_slug.sql`
  - adds `hotels.public_slug`
  - generates a readable slug from hotel name
  - resolves collisions deterministically with numeric suffixes
  - protects reserved system paths
  - enforces uniqueness
  - keeps slug assignment owner-triggered rather than application-owned
- `getPublicHotelBySlug()` resolves the public hotel surface without changing booking identity.
- Root-level `/$hotelSlug` serves the normal GuestBook.
- Operator workspace now presents the slug as the guest address.
- QR generation now targets the human-readable slug.
- Existing `/book/{hotelCode}` remains available for compatibility.
- CP23 source regression tests cover the slug migration, route, and QR/operator URL transition.

## Security boundary

The slug is presentation-only.

It does not replace:

- hotel UUID identity
- booking hotel_id
- provider ownership
- occupancy constraints
- booking authorization
- operator authentication

System paths such as `/app`, `/ops`, `/login`, `/api`, `/book`, and `/confirmed` are reserved from slug generation.

## Validation state

The CP23 source changes have been inspected through GitHub. Full `npm run test:aether`, `npm run build`, and live route verification have not been executed in this environment.

Therefore executable validation remains pending and must not be represented as passed.

## External systems

- Neon: no contact
- Vercel: no contact
- Secrets: unchanged
- Deployment: none
- Commit/push: source writes through GitHub necessarily created commits; no manual local commit/push was performed.
