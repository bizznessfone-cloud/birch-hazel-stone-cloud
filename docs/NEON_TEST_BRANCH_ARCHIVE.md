# Neon test-branch archive — preservation gate

This procedure is for **disposable test branches only**. Never use production credentials or target production. Deleting a Neon branch is a separate manual, explicitly authorised action.

## Archive identity

- Project: `quiet-sound-53513710`
- Candidate: `cp28-2c-race-gate` / `br-icy-shadow-b1fh96gk`
- Archive label: `SBG-ARCHIVE-CP28-RACE-GATE-20261014`
- Database: `neondb`
- Source branch is a **child** of production, and Neon snapshot creation returned `not allowed to snapshot non-root branch`.
- Snapshot is **not** a substitute for an independently retained PostgreSQL backup.
- At initial read-only inspection: 30 migrations, 23 bookings, 9 hotels. These are observations, not archive verification.

## Required archive package

1. `pg_dump --format=custom --no-owner --no-acl --file=... ` from the **explicit CP28 branch endpoint**. Prefer PostgreSQL client version 18 to match the Neon server.
2. SHA-256 digest of the dump, with immutable source project, branch, endpoint, database, UTC capture timestamp, Postgres client/server versions, and migration ledger.
3. An encrypted archive kept in **private external storage**, with encryption key stored separately. Test data can contain personal data. Never commit the dump, secrets, raw connection strings or decryption keys to GitHub.
4. `pg_restore --list` must succeed. This validates the archive TOC, **not** a complete restore.
5. **Mandatory full restore** into a separate disposable PostgreSQL 18 database, with schema, extension, functions, migration ledger, data counts, and relevant test assertions verified. A checksum and TOC check alone do not prove restorability.
6. Confirm the independently stored file is retrievable and decryptable. Record checksum and evidence of restore verification in a GitHub review document, without sensitive records.

## Deletion gate — all must pass

- Archive is complete and independently accessible.
- Restored database passes integrity checks; any ownership/role/extension differences are documented.
- No active CI workflow or application depends on the old branch.
- Exact target branch ID is confirmed immediately before deletion.
- User separately and explicitly authorises deleting that exact branch.
- Production branch and A3 evidence branches remain untouched.

## Restore later

Create a **new disposable target** (never production); install required extensions/roles; restore using `pg_restore --no-owner --no-acl --dbname=...` with an appropriately scoped credential. Verify migration ledger, row counts, schema, functions, constraints, and test fixtures. Restore does not preserve Neon branch lineage, historical WAL, compute settings, or Neon-specific metadata.

## Branch-limit constraint

At 10/10 branches, a new Neon branch cannot be created for restore verification. Use a disposable PostgreSQL instance outside Neon for the initial full restore, or obtain a temporary Neon slot without destroying unarchived evidence. **Do not delete CP28 simply because the branch limit blocks verification.**
