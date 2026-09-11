# Architecture

Aether Transfer is a TanStack Start application. PostgreSQL is the system of
record. Occupancy is a database trigger plus GiST EXCLUDE. Operator auth is
application-level scrypt + server sessions, not Better Auth.

## Runtime

| Layer | Choice |
|---|---|
| UI | React 19 + TanStack Router file routes |
| Server functions | TanStack `createServerFn` |
| Query builder | Kysely (`getAetherDb()`) |
| SQL helper | platform `getSql()` from `@/lib/db` |
| Preview database | PGLite (embedded WASM PostgreSQL 18) with `btree_gist` contrib |
| Production database | Neon PostgreSQL via `DATABASE_URL` |
| CSS | Tailwind v4 + CSS variables + Outfit |
| Platform chrome | `PreviewHostBridge`, grok PWA injector, `AuthProvider` shell |

The Grok sandbox preview binds `0.0.0.0:8080` via `npm run dev`. `startup.sh`
is the revive contract.

## Occupancy engine (Phase 1)

See `migrations/0003_occupancy.sql`. Application code does not write `occupies`.


## Time domain (Phase 3)

Civil Athens `transfer_date + pickup_time` is converted only by
`aether_athens_instant()` in PostgreSQL. The application module
`src/lib/aether/time.ts` calls that function. It does not convert with
`Date`, `getTimezoneOffset`, or the PostgreSQL session `TimeZone`.

```
Athens transfer_date + pickup_time
        ↓
civil validation
        ↓
aether_athens_instant()
        ↓
absolute timestamptz
        ↓
elapsed duration (make_interval minutes)
        ↓
tstzrange [)  (trigger writes bookings.occupies)
```

Dashboard Today is `aether_athens_today()` — the Europe/Athens civil date of
`now()`. Instant → civil date is `aether_athens_date()`.

ICS is not implemented.

Helpers: `migrations/0005_time_domain.sql`, `src/lib/aether/time.ts`.
Tests: `time.test.ts`, `time-process-tz.test.ts` (`TZ=Pacific/Auckland`).


## Booking engine (Phase 4)

Public, unauthenticated, hotel-scoped create + token lookup.

- Human reference (`PT-…`) is display only.
- Confirmation token is the public credential. Reference-only lookup fails.
- INSERT never writes `occupies`, `vehicle_id`, or `driver_id`.
- Pricing is an unpriced stub (`quoteBooking`) until the formula is known.
- Idempotency: `idempotency_keys` scope `booking.create`.

Source: `src/lib/aether/booking.ts`, `booking.server.ts`, `booking-fns.ts`.


## Inventory assignment (Phase 5)

Operator-only. Vehicle and driver are independent. PostgreSQL GiST EXCLUDE
is the overlap authority. Application maps `23P01` to a readable
unavailable error.

Usable resources: `vehicles.active` / `drivers.active` (default true).

Cancel sets `cancelled_at`; the occupies trigger empties the range.

HTTP mutations call `requireOps({ csrf: true })`.

Source: `src/lib/aether/inventory.ts`, `inventory.server.ts`, `inventory-fns.ts`.

Verified on **PGLite**. Neon concurrency is not verified.


## Guest UX (Phase 6)

Public hotel-scoped wizard. No guest accounts.

- `/book/{hotelCode}` landing + journey
- `/confirmed/{token}` confirmation
- HotelMark generated from hotel name initials
- Uses `createPublicBooking` / `getPublicBooking` / `getPublicHotel`
- Token is the only credential

Source: `src/components/aether/guest-book.tsx`, `src/routes/book.$hotelCode.tsx`,
`src/routes/confirmed.$token.tsx`.

## Operations UX (Phase 7)

Reception/dispatch desk. Privileged. Does not write `occupies`.

- `/ops/login` — existing scrypt session
- `/ops` — Today = Athens civil date of `now()`
- Chronological feed, next remaining transfer, attention (no vehicle / no driver / cancelled)
- `/ops/bookings/` list + `/ops/bookings/$bookingId` detail
- Independent vehicle/driver assign via Phase 5 inventory; `23P01` → readable unavailable
- Status is an operational label; cancel sets `cancelled_at` (trigger empties occupies)
- Vehicles / drivers / hotels management (capacity, active, unique hotel code)

Client CSRF helper `src/lib/aether/csrf-client.ts` must not import `ops-auth`
(`node:crypto`). Session cookie stays HttpOnly.

Source: `src/lib/aether/ops-desk.ts`, `ops-desk.server.ts`, `ops-desk-fns.ts`,
`src/routes/ops*.tsx`, `src/components/aether/ops-shell.tsx`,
`migrations/0009_ops_desk.sql`.

## Operator authentication (Phase 2)

Not Grok viewer accounts. Not Better Auth. `VITE_AUTH_ENABLED=false`.

Pipeline:

```
login + password
  → throttle check
  → scrypt verify
  → random session token + CSRF token
  → SHA-256 hashes stored on sessions
  → HttpOnly session cookie
  → non-HttpOnly CSRF cookie
        ↓
requireOps({ csrf })
  → lookup token hash
  → reject expired / revoked
  → mutations require x-aether-csrf == CSRF cookie == session.csrf_hash
```

| Cookie | HttpOnly | Secure | SameSite |
|---|---|---|---|
| `aether_ops_session` | yes | production / https | Lax |
| `aether_ops_csrf` | no | production / https | Lax |

The session credential is never returned in JSON and must never be written to
`localStorage` / `sessionStorage`. CSRF is readable by JS so ops mutations can
send the header; it is not the session credential.

`requireOps()` is the only ops enforcement boundary. Public guest routes
(`getFoundationStatus`, later `/book/{hotelCode}`) must not use it.

Logout sets `sessions.revoked_at` and clears both cookies. CSRF is required to
logout a live session.

Throttle: 5 failed attempts per normalized login in 15 minutes → 429.

Bootstrap (optional): `AETHER_OPS_LOGIN` + `AETHER_OPS_PASSWORD` upsert an
operator at login time. No credentials are seeded in SQL.

Source: `src/lib/aether/ops-auth.ts`, `ops-auth.server.ts`, `ops-fns.ts`,
`migrations/0004_ops_auth.sql`.

## Authoritative vs UX

| Concern | Authority |
|---|---|
| `occupies` range | PostgreSQL trigger |
| vehicle/driver overlap | GiST EXCLUDE, error `23P01` |
| civil time in Athens | `aether_athens_instant()` |
| operator session | HttpOnly cookie + `sessions` row |
| public booking credential | high-entropy confirmation token (Phase 4) |
| availability UI | application query, not a lock |

## Auth posture

Better Auth remains **disabled**. Do not wrap public booking in
`authMiddleware`. Ops mutations call `requireOps({ csrf: true })`.

## Project layout

```
migrations/0003_occupancy.sql    occupancy engine
migrations/0004_ops_auth.sql     csrf_hash + login_attempts
migrations/0005_time_domain.sql  aether_athens_date / aether_athens_today
src/lib/aether/ops-auth.ts       scrypt / sessions / requireOps engine
src/lib/aether/ops-auth.server.ts cookie adapter
src/lib/aether/ops-fns.ts        createServerFn login/logout/ping
src/lib/aether/ops-auth.test.ts  Phase 2 gate
src/lib/aether/time.ts           Athens instant helpers (SQL is authority)
src/lib/aether/time.test.ts      Phase 3 gate
src/lib/aether/booking.ts        public create + token lookup
src/lib/aether/booking.test.ts   Phase 4 gate
migrations/0006_booking_engine.sql schema_phase 4
src/lib/aether/inventory.ts      assign/unassign/cancel/status
src/lib/aether/inventory.test.ts Phase 5 gate (PGLite)
migrations/0007_inventory.sql    active flags, schema_phase 5
src/lib/aether/guest.ts          tourist copy, HotelMark, vehicle hint
src/lib/aether/guest.test.ts     Phase 6 gate
src/routes/book.$hotelCode.tsx   guest wizard
src/routes/confirmed.$token.tsx  confirmation
migrations/0008_guest_ux.sql     seed hotel gate, schema_phase 6
src/lib/aether/ops-desk.ts       Today / list / upserts
src/lib/aether/ops-desk.test.ts  Phase 7 gate
src/lib/aether/csrf-client.ts    browser-safe CSRF header
src/routes/ops.tsx               requireOps layout
src/routes/ops.bookings.index.tsx bookings list
src/routes/ops.bookings.$bookingId.tsx detail
migrations/0009_ops_desk.sql     capacity, seed fleet, schema_phase 7
src/lib/aether/hotel.ts          identity: code, name, HotelMark, QR-ready path
src/lib/aether/hotel.test.ts     Phase 8 gate
src/routes/ops.hotels.tsx        reception cards + QR-ready URL
migrations/0010_hotel_white_label.sql code format, seed harbor, schema_phase 8
src/lib/aether/matrix.test.ts    Phase 9 Blueprint matrix reconstruction
migrations/0011_production_hardening.sql aether_runtime DML role (NOLOGIN at create)
migrations/0012_cp12_tenancy.sql providers, agreements, memberships, executing_provider_id
migrations/0013_cp12b_runtime_login.sql aether_runtime LOGIN, public_booking_attempts
migrations/0014_cp13a_production_app_role.sql aether_app SQL-created production LOGIN
src/lib/aether/runtime-role.ts   preview role + production app role + owner URL env
src/lib/aether/runtime-config.ts production fail-closed + pool + preview-cred policy
src/lib/aether/hardening.test.ts privilege + security audit
src/lib/aether/cp12b.test.ts     CP12B production hardening
src/lib/aether/cp13a.test.ts     CP13A aether_app production LOGIN
```

ICS, payment, and Neon concurrency are not built. Occupancy SQL is unchanged.
`schema_phase` is **13**. `checkpoint` is **13a**.

## Hotel white label (Phase 8)

Hotel identity is attribution, not authorisation.

```
name + unique code + generated HotelMark
        ↓
QR-ready path /book/{code}
        ↓
guest books against that hotel_id
        ↓
ops sees every hotel (global desk, no RLS)
```

- Code is lowercase `[a-z0-9]` with optional internal dashes, 2–32 chars, unique.
- HotelMark is computed from the name. It is not stored and is not a logo.
- Guest `/book/{code}` is unauthenticated. Unknown codes do not disclose other hotels.
- Bookings carry `hotel_id`. Two codes cannot attribute onto each other.
- Operators manage hotels and see all bookings. No hotel accounts, no hotel-admin role.
- Palette stays black / white / grey. No per-hotel colour, no logo upload, no skins.

QR *image* generation is not implemented. The booking URL is QR-ready.

Source: `src/lib/aether/hotel.ts`, `migrations/0010_hotel_white_label.sql`.
Tests: `hotel.test.ts`.

## Full test reconstruction (Phase 9)

Audit only. No product features, no occupancy rewrite, no schema migration.

- Current-rebuild suite is **90** tests (83 Phase 0–8 re-run + 7 in `matrix.test.ts`).
- Historical "120 passed" is not current coverage.
- PGLite concurrent overlapping assign: exactly one winner.
- Neon concurrency remains **NOT VERIFIED**.
- ICS is not emitted, so "ICS instant if emitted" is N/A.
- Typecheck and production build verified this phase.

Tests: `src/lib/aether/matrix.test.ts` plus the Phase 0–8 files.
Results: `docs/TEST_RESULTS.md`.

## Environment variable names

| Name | When |
|---|---|
| `DATABASE_URL` | production runtime. Must authenticate as `aether_app` LOGIN (SQL-created), not the owner and not a Neon Console role. Production without this URL fails closed. |
| `AETHER_DATABASE_OWNER_URL` | required for production migrations. `scripts/migrate.mjs` uses this URL only. Never a runtime connection. |
| `AETHER_OPS_LOGIN` | optional operator bootstrap. Preview pair `desk` is refused in production. |
| `AETHER_OPS_PASSWORD` | optional operator bootstrap. Preview pair `desk-pass` is refused in production. |
| `AETHER_RESTORE_TARGET` | `preview` or `production` |

No `.env` files. No session HMAC secret: tokens are unguessable random values
hashed at rest.

## Production hardening (Phase 10 → CP12B)

PostgreSQL privilege split. Occupancy SQL is unchanged.

```
migration owner (applies 0011–0013, owns tables/functions/extensions)
        ↓
GRANT DML/EXECUTE to aether_runtime
        ↓
0013: ALTER ROLE aether_runtime LOGIN  (password out of band, never in SQL)
        ↓
production DATABASE_URL authenticates as aether_runtime
        (session_user = current_user = aether_runtime; no SET ROLE)
        ↓
DISABLE/DROP trigger, DROP EXCLUDE, DROP aether_athens_instant,
CREATE/DROP btree_gist  →  42501
```

- Role `aether_runtime`: `LOGIN` `NOSUPERUSER` after 0013. DML on domain tables,
  EXECUTE on functions, SELECT on `aether_meta`. No TRIGGER, TRUNCATE, schema
  CREATE. Must not own occupancy objects.
- 0011 still *creates* the role as NOLOGIN (frozen historical file). 0013
  enables LOGIN. The runtime role is not a schema owner and receives no extra
  DDL.
- Occupancy objects stay owned by the migrator (`postgres` on PGLite).
- Runtime **cannot** ALTER/DROP/DISABLE `bookings_occupies_before`, DROP/ALTER
  EXCLUDE constraints, DROP/replace `aether_athens_instant()`, or DROP
  `btree_gist`. Proven on PGLite (`42501`).
- Runtime **may** insert/assign/cancel; occupies stays trigger-maintained;
  overlap still `23P01`.
- The table owner **can** still disable the trigger. That is why production
  `DATABASE_URL` must not be the owner.
- Preview PGLite still RESET ROLE, applies migrations as owner, then
  `SET ROLE aether_runtime`. Production pools must **not** send a startup role
  option — RESET ROLE would otherwise restore a non-runtime login.
- migrate.mjs uses `AETHER_DATABASE_OWNER_URL` only. Production without that
  URL fails (no silent skip, no `DATABASE_URL` fallback).
- Production without `DATABASE_URL` fails closed. PGLite is never a production
  substitute.
- Serverless: one shared `pg.Pool` per isolate (`max: 2`, idle 10s, connect 8s).
- **Neon production-role split is BLOCKED / UNVERIFIED** in this environment
  (`DATABASE_URL` unset). Neon concurrency remains **NOT VERIFIED**.

Source: `migrations/0011_production_hardening.sql`,
`migrations/0013_cp12b_runtime_login.sql`, `src/lib/db.ts`,
`scripts/migrate.mjs`, `scripts/migrate-policy.mjs`.
Tests: `src/lib/aether/hardening.test.ts`, `src/lib/aether/cp12b.test.ts`.

## CP13A production application role

Neon Console-created roles inherit `neon_superuser`. The existing Neon
`aether_runtime` namesake is therefore unsuitable as the production login.
CP13A introduces a SQL-created LOGIN that never receives that membership.

```
neondb_owner          migration/schema owner (AETHER_DATABASE_OWNER_URL)
aether_runtime        PGLite/preview SET ROLE identity (unchanged; 0011–0013)
aether_app            SQL-created production LOGIN (0014; DATABASE_URL)
```

- `CREATE ROLE aether_app` `LOGIN` `NOSUPERUSER` `NOCREATEDB` `NOCREATEROLE`
  `NOREPLICATION` `NOBYPASSRLS` `INHERIT`. Password is out of band, never in SQL.
- Never `GRANT neon_superuser`. Never `ALTER` `aether_runtime`. SQL does not
  manipulate `neon_superuser` membership. The production verifier still denies it.
- `GRANT CONNECT` is issued on both `postgres` (PGLite preview) and `neondb` (Neon).
  Static names keep 0014 parser-safe. Do not use `current_database()` (that needs a `DO` block).
- DML on application tables including `providers`, `hotel_provider_agreements`,
  `operator_memberships`. `public_booking_attempts` is SELECT/INSERT/DELETE
  (no UPDATE). `aether_meta` is SELECT only. `_migrations` has zero privileges.
- No schema CREATE, TRUNCATE, REFERENCES, TRIGGER, ownership, or migration rights.
- Default privileges are implicit `FOR` the migration/schema owner, `TO aether_app`.
- 0014 is Neon-parser-safe: no `DO` blocks, no dollar quoting, no `COMMENT ON ROLE`.
  Neon migration-preparation splits on raw semicolons and does not track quotes.
- Production authenticates as `aether_app` (`session_user` = `current_user`).
  Application pools must not SET ROLE. Preview still SET ROLE `aether_runtime`.
- Occupancy objects stay owned by the migrator. `aether_app` must never own them.

Source: `migrations/0014_cp13a_production_app_role.sql`,
`src/lib/aether/runtime-config.ts`, `scripts/verify-neon-production.mjs`.
Tests: `src/lib/aether/cp13a.test.ts`.

## CP12 / CP12A / CP12B / CP13A

| Checkpoint | Meaning |
|---|---|
| CP11 | Historical Neon verifier. Not the current product phase. |
| CP12 | Multi-tenant hotel/provider foundation (`0012`). |
| CP12A | Resource ownership administration boundaries (operate AND own / dispatch AND employ). |
| CP12B | Pre-Vercel production hardening (`aether_runtime LOGIN`, fail-closed, pool cap). |
| CP13A | SQL-created production LOGIN `aether_app` (this document's current source). |

Vercel is not connected at CP13A.

## V1 geographic / timezone constraint

V1 operational timezone is **Europe/Athens**. This is a deliberate V1 operating
constraint, not the intended long-term global architecture.

Future architecture (not implemented):

```
hotel/location-specific IANA timezone
        ↓
local civil time validation
        ↓
absolute instant
        ↓
timestamptz / tstzrange
```

ONE GLOBAL BOOKING ENGINE + LOCALLY CONFIGURED OPERATIONAL ENVIRONMENTS.

Future local configuration may include operational location, IANA timezone,
currency, country, city, transport hubs, local pricing, and fleet
configuration. None of that is implemented in CP12B.

## 100-hotel strategic data (document only)

Build the transfer platform now. Capture legitimate operational intelligence
correctly from day one. At 100 hotels, evaluate additional commercial
opportunities using appropriately aggregated/anonymised data.

Do not build a mobility marketplace, fleet procurement, leasing, OEM
relationships, EV/charging/supplier marketplaces, or commercial data products
in this checkpoint.
