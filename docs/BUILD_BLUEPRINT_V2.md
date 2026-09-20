# CANONICAL PRIVATE TRANSFER APP — BUILD BLUEPRINT v2

**Status:** frozen historical MVP build contract. Not living current-state.

Living status: `BUILD_STATE.md`. Current source SHA `4c20e9b…`. CP25G.3 CLOSED.
Next numbered checkpoint: **UNDEFINED**. Payments were later layered in CP24/CP25
over this frozen base; do not rewrite this Blueprint to pretend otherwise.

**Provenance:** the original Blueprint v2 file was not present in the recovered
workspace. This document is reconstructed from the master recovery protocol
that was supplied as the rebuild brief. Fields the protocol marked UNKNOWN
remain UNKNOWN. Do not treat implementation decisions as recovered historical
facts — those live in `docs/RECOVERY_NOTES.md`.

Product: **Aether Transfer**

Guest lockup: **SCAN. BOOK. GO.**

---

## 1. Product

Aether Transfer is a private hotel-transfer booking system.

- Guests book a transfer from a hotel-scoped public URL, without an account.
- Operators run a global operations desk.
- PostgreSQL is the authority for booking integrity and vehicle/driver occupancy.
- Hotels are attribution (white-label name + code + generated HotelMark), not a multi-tenant IAM product.

## 2. Frozen tech stack

- TanStack Start
- React
- TypeScript
- Tailwind v4
- CSS variables
- Outfit
- Kysely
- pg
- PGLite
- PostgreSQL
- Neon intended for production
- TanStack `createServerFn`

Do not introduce Next.js, Prisma, or a standalone REST service.

## 3. Explicitly out of MVP

Next.js, Prisma, standalone REST API, microservices, RLS, hotel colour themes,
hotel logo upload, marketplace, guest accounts, driver application, driver
authentication, WhatsApp, SMS, push notifications, Stripe, deposits, payment
processing, hotel billing, multi-operator SaaS, booking holds, surge pricing,
dynamic pricing, multi-stop journeys, taxi-meter functionality, guest vehicle
SKUs, custom service worker, offline booking, complex IAM, analytics/CMS,
passkeys, unnecessary frameworks.

Do not add features because they seem commercially useful.

## 4. Occupancy engine (absolute requirement)

Canonical pipeline:

```
transfer_date
+ pickup_time
+ duration_minutes
        ↓
Europe/Athens civil-time validation
        ↓
aether_athens_instant()
        ↓
absolute timestamptz
        ↓
PostgreSQL trigger
        ↓
bookings.occupies
        ↓
tstzrange [instant, instant + duration)
        ↓
GiST EXCLUDE
```

The application must NOT be authoritative for `occupies`. The PostgreSQL
trigger maintains it.

Do not:

- replace the trigger with frontend logic
- replace it with a generated-column-only design
- use naive `tsrange`
- use browser timezone as authority
- use PostgreSQL session TimeZone as a workaround

### Occupancy rules

Vehicle occupancy applies when `vehicle_id IS NOT NULL` AND the booking is not
cancelled AND `occupies` is non-empty.

Driver occupancy applies when `driver_id IS NOT NULL` AND the booking is not
cancelled AND `occupies` is non-empty.

Vehicle and driver occupancy are independent.

Allowed: neither assigned, vehicle only, driver only, both.

Unassigning a vehicle releases the vehicle. Unassigning a driver releases the
driver. Cancelling a booking releases both resources.

Do not require vehicle + driver together.

### Database concurrency

The database is the final authority. Application availability queries are UX
only.

The database must enforce:

- `vehicle_id WITH =` and `occupies WITH &&`
- `driver_id WITH =` and `occupies WITH &&`

using partial GiST EXCLUDE constraints.

`[)` means:

- A ends exactly when B begins = allowed
- A one-minute overlap = rejected with PostgreSQL `23P01`

Concurrent overlapping assignments must result in exactly one successful
assignment.

## 5. Minimum canonical schema

Implement:

- hotels
- vehicles
- drivers
- operators
- sessions
- bookings
- audit_events
- idempotency storage

Implement:

- `btree_gist`
- `aether_athens_instant`
- occupancy trigger
- `tstzrange`
- `[)` semantics
- vehicle GiST EXCLUDE
- driver GiST EXCLUDE
- duration validation
- civil-time validation
- required foreign keys
- unique confirmation token
- unique human reference
- idempotency protection

Exact column lists, PK types, optional vehicle/driver fields, exact trigger
SQL, and exact status strings are **UNKNOWN**.

## 6. Authentication

Operator authentication only. No guest accounts.

Required:

- scrypt password authentication
- server-side sessions
- HttpOnly cookie
- Secure production cookie
- SameSite
- finite session expiry
- session revocation
- logout
- `requireOps()`
- login throttling
- CSRF protection

Never expose the operator session credential to JavaScript. Never put it in
localStorage/sessionStorage.

Session TTL, login identifier, and CSRF mechanism are **UNKNOWN**.

This is application-level operator auth. It is not Grok viewer accounts and
not Better Auth. Guest booking remains public.

## 7. Time domain

Exact contract:

```
Athens transfer_date + pickup_time
        ↓
civil validation
        ↓
aether_athens_instant()
        ↓
absolute instant
        ↓
elapsed duration
        ↓
tstzrange [)
```

Reject:

- nonexistent spring-forward time
- ambiguous autumn time
- `24:00`
- invalid time
- invalid duration

Dashboard "Today" means the Europe/Athens business date.

If ICS is emitted, it must use the same absolute instant as the booking
occupancy start. Whether ICS is emitted is **UNKNOWN**.

Default duration is **UNKNOWN**.

## 8. Booking engine

- hotel-scoped booking
- public create
- validation
- server-side pricing abstraction
- idempotent creation
- human reference
- high-entropy confirmation token
- token lookup
- minimised public DTO
- confirmation

The human reference is NOT a credential. The token IS the public credential.
Reference-only lookup must fail.

Idempotency storage design is **UNKNOWN**.

## 9. Inventory assignment

Independently:

- assign vehicle
- unassign vehicle
- assign driver
- unassign driver
- cancellation
- status changes

Assignments must be transactional.

Map PostgreSQL `23P01` into a clean unavailable-resource error.

Status is an operational label. Do not build an elaborate state machine merely
because status values are UNKNOWN. Inventory integrity is based on resource
assignment + cancellation + `occupies`.

## 10. Guest UX

Route: `/book/{hotelCode}`

Journey:

Landing → Journey → When → Party → Contact → Review → Confirmation

Implement:

- HotelMark
- hotel name
- monochrome UI
- theme toggle
- BOOK TRANSFER
- VIEW MY BOOKING
- from hotel
- to hotel
- Airport / Port / Hotel / Other
- pickup
- destination
- Athens date
- Athens time
- passenger count
- luggage count
- name
- phone
- email
- room/flight → special_requirements
- informational vehicle recommendation
- server pricing abstraction
- idempotent submission
- token confirmation

No guest login. No guest account. No ops controls.

## 11. Operations UX

Route: `/ops`

Including:

- login
- Today
- chronological feed
- attention indicators
- bookings list
- booking detail
- vehicle assignment
- vehicle unassignment
- driver assignment
- driver unassignment
- status
- vehicle management
- driver management
- hotel management

Today = Athens business date.

## 12. Hotel white label

Hotel identity consists of:

- name
- code
- generated HotelMark

Strict monochrome. No hotel colour engine. No logo upload.

Multiple hotel codes must correctly attribute bookings. No RLS.

This MVP does not use RLS. Hotel isolation is attribution-level isolation.
Bookings contain the relevant hotel attribution. Guest access is scoped by
hotel URL. Operator has global operational access. Do not invent multi-tenant
IAM.

## 13. Pricing

Pricing must remain a server-side abstraction.

Implement `calculateTransferPrice(bookingInput)` behind a pricing engine.

The historical pricing formula is **UNKNOWN**. Currency is **UNKNOWN**.

Do not invent surge, deposits, commissions, dynamic pricing, complex hotel
rates, or marketplace economics.

A minimal placeholder/configuration is acceptable. Document the decision.

## 14. Public security

The public token is sensitive.

The public API must expose only the minimum guest-facing information.

Allowed information may include:

- reference
- Athens date/time
- pickup
- destination
- passengers
- guest-facing vehicle class
- guest-facing status
- guest-facing transfer-desk contact

Never expose through public confirmation:

- internal notes
- driver private information
- operator notes
- internal pricing metadata
- occupancy internals
- other bookings
- arbitrary guest records

Reference-only lookup MUST NOT reveal booking information.

## 15. Design system

- Outfit
- black, white, greyscale
- large CTAs
- generous whitespace
- quiet/muted badges
- mobile-first guest UI
- reception-friendly ops UI
- light/dark mode
- generated HotelMark

Do not introduce hotel-selected colours. Do not introduce unnecessary
glassmorphism. Do not clip HotelMark initials.

Vehicle image area must provide sufficient height and use `object-contain`.

## 16. Error handling

Guest errors must be understandable to tourists.

Never expose SQL, stack traces, internal database errors, internal IDs, or
implementation details.

Map `23P01` to an understandable resource-unavailable error.

DST errors must clearly distinguish:

- time does not exist
- time is ambiguous

Ops authentication failures return appropriate authentication responses.

## 17. UNKNOWN fields (do not invent)

- PK type
- session TTL
- login identifier
- CSRF mechanism
- idempotency storage
- exact status strings
- default duration
- pricing formula
- currency
- exact trigger SQL
- optional vehicle/driver fields
- whether ICS is emitted

## 18. Phase gates

### Phase 0 — Foundation

TanStack Start, React, TypeScript, Tailwind v4, CSS variables, PGLite/Postgres
integration, migrations, project structure, recovery documentation.

Do not create fake bookings. Do not use frontend mocks as the authoritative
backend.

Gate: application starts; TypeScript passes; database connectivity works;
migrations can execute; recovery documentation exists.

### Phase 1 — Database

Canonical schema + occupancy engine.

Gate: valid Athens time persists; invalid civil time rejects; spring gap
rejects; autumn fold rejects; 24:00 rejects; duration 0 rejects; duration
>1440 rejects; adjacent ranges succeed; overlapping ranges fail; vehicle
EXCLUDE works; driver EXCLUDE works; cancellation releases occupancy;
unassignment releases occupancy.

### Phase 2 — Authentication

Gate: unauthenticated ops mutation fails; authenticated ops mutation succeeds;
logout revokes session; HttpOnly cookie exists; CSRF works; throttle works.

### Phase 3 — Time domain

Gate: complete timezone matrix from this blueprint.

### Phase 4 — Booking engine

Gate: booking creation; duplicate idempotency request produces one booking;
token lookup succeeds; reference-only lookup fails; public DTO is minimised;
internal notes cannot leak; occupancy internals cannot leak.

### Phase 5 — Inventory assignment

Gate: vehicle assignment; driver assignment; vehicle-only booking; driver-only
booking; unassignment release; cancellation release; overlap rejection;
concurrent vehicle assignment → one winner; concurrent driver assignment →
one winner.

### Phase 6 — Guest UX

Gate: create a genuine database-backed guest booking and reach confirmation.

### Phase 7 — Operations UX

Gate: Guest booking → Ops sees booking → vehicle assignment → driver
assignment → status change → unassignment/cancellation → resource becomes
available.

### Phase 8 — Hotel white label

Gate: multiple hotel codes correctly attribute bookings.

### Phase 9 — Full test reconstruction

Re-run the full matrix. Do not rely on historical results. Historical
"120 Aether tests passed / 0 failed" must NEVER be represented as current
coverage. Until Neon concurrency is tested: **NEON CONCURRENCY NOT VERIFIED**.

### Phase 10 — Production hardening

The production runtime DB role MAY perform required operational DML and MUST
NOT be able to ALTER/DROP/DISABLE the occupancy trigger, ALTER/DROP EXCLUDE
constraints, DROP `aether_athens_instant`, or CREATE/DROP required extensions.

Migrations use a separate privileged owner/migration role.

The previous implementation's ability for the runtime application role to
disable the occupancy trigger was a known architectural defect. It MUST NOT
survive.

### Phase 11 — Deployment

Only after all mandatory gates pass. Preserve OG metadata. Do not claim
production readiness if a mandatory gate remains unresolved.

## 19. Full test matrix (Phase 9)

### TIME

winter; summer; DST gap; DST fold; nonexistent time; ambiguous time; DST
crossing; midnight crossing; browser TZ mismatch; session TZ independence;
24:00; duration 0; duration >1440

### INVENTORY

adjacency; one-minute overlap; concurrent vehicle; concurrent driver;
cancellation release; unassignment release; vehicle-only; driver-only

### SECURITY

reference-only failure; token lookup; DTO minimisation; unauthenticated ops;
HttpOnly cookie; CSRF; login throttle; token entropy

### RELIABILITY

idempotent create; typecheck; migrations; ICS instant if emitted

### PRODUCTION DATABASE

Test actual Neon concurrency before claiming production parity.

## 20. Build order

database correctness → domain logic → security → booking engine → inventory →
guest UI → ops UI → visual polish

Do not spend significant effort making a beautiful UI while the occupancy
engine is unproven.
