# Recovery notes

> **Living status:** `BUILD_STATE.md`. Notes below are historical implementation decisions.
> Current living roadmap: `docs/ROADMAP.md`. Next execution **CP26A**. CP25G.3 **CLOSED**.

Implementation decisions and unresolved UNKNOWNs **at the time of writing**.
Decisions are **not** recovered historical facts unless still true in current source.

## Provenance

- Original implementation workspace was lost.
- `docs/BUILD_BLUEPRINT_V2.md` is reconstructed from the master recovery
  protocol. UNKNOWN fields remain UNKNOWN unless a decision was required.

## Phase 0–9 decisions

See earlier tables. Unchanged. Occupancy trigger, EXCLUDE, `requireOps`,
booking engine, inventory, guest wizard, ops desk, and hotel identity were
not rewritten in Phase 10.

## Phase 10 decisions

| Topic | Decision | Why |
|---|---|---|
| Runtime role name | `aether_runtime` `NOLOGIN` `NOSUPERUSER` | DML/EXECUTE only. Must not own occupancy objects. |
| Owner role | the role that applies migrations (PGLite `postgres`) | Do not REASSIGN OWNED; owner must keep DDL for later migrations. |
| App connection | `SET ROLE aether_runtime` after migrate; Neon `options=-c role=aether_runtime` | current_user is restricted. Occupancy DDL → `42501`. |
| migrate.mjs | `AETHER_DATABASE_OWNER_URL` \|\| `DATABASE_URL`; never SET ROLE | Separate privileged owner/migration connection. |
| `aether_meta` writes | revoked from runtime | schema_phase/checkpoint stay migration-owned. |
| Owner can DISABLE TRIGGER | documented, not “fixed” by pretending otherwise | Superuser/owner bypass is real. Production `DATABASE_URL` must not be the owner. `RESET ROLE` restores the connecting owner. |
| Neon two-credential split | **BLOCKED / UNVERIFIED** | `DATABASE_URL` unset. Cannot create a LOGIN password in migrations. |
| Neon concurrency | still **NOT VERIFIED** | `DATABASE_URL` unset. |
| Occupancy SQL | unchanged | Hardening must not rewrite the trigger/EXCLUDE. |
| Auth cookies / CSRF / throttle | audited, not redesigned | Existing model already matches the Blueprint security items. |
| Schema phase | **10** | Real migration `0011_production_hardening.sql`. |

Phase 10 did not add product features, RLS, Better Auth, guest accounts, or
payment.

## Unresolved UNKNOWNs

exact status strings; recovered default duration; pricing formula; currency;
ICS; historical hotel list/branding; whether QR bitmaps were generated.

## Remaining production gaps (not UNKNOWNs — known, unverified)

- Neon concurrent assignment
- Neon production `DATABASE_URL` as a non-owner runtime login, with
  `AETHER_DATABASE_OWNER_URL` as the migrator

## Next exact development action

**Phase 11 — DEPLOYMENT** after Checkpoint 10 is stored externally.
Do not claim production readiness while Neon role-split and Neon concurrency
remain unverified.
