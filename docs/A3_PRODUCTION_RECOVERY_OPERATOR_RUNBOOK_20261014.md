# A3 production recovery — operator runbook (pre-execution)

Status: PREPARED, NOT EXECUTED. No production migration authorised.

## Scope and evidence

Backup-only workflow: `.github/workflows/a3-production-recovery-archive-manual.yml` on the A3 review branch. Its purpose is a PostgreSQL 18 `pg_dump` archive from the pinned production branch, local PostgreSQL 18 restore, ledger checks (34, no 0035/0036), encryption/decryption round-trip, and a seven-day encrypted GitHub Actions artifact.

Neon native snapshot creation was attempted on 2026-10-14 and rejected with HTTP 422 `snapshots limit exceeded`. Existing September snapshot was not deleted. Project has 10/10 branches. Production branch protection is disabled and no snapshot schedule was returned.

Read-only production baseline on 2026-10-14: 34 migrations, 8 hotels, 9 bookings, 1 organisation, 0 acceptances. These counts are time-sensitive: archive verifies ledger 34 but currently reports, rather than enforces, restored hotel/booking counts.

## Operator prerequisites (not yet satisfied)

1. Independently review the backup workflow, including secret handling, isolated restore and artifact retention. The workflow is on a review branch; GitHub manual dispatch normally requires workflow registration on the default branch. A separate, controlled **backup-workflow-only** promotion may be needed. Do not merge the A3 PR.
2. Create repository Actions secrets `A3_PRODUCTION_BACKUP_DATABASE_URL` (pinned unpooled production `neondb_owner` URL, `?sslmode=require` only) and `A3_PRODUCTION_BACKUP_PASSPHRASE` (unique high-entropy password stored in an external password manager). Never paste secrets into a chat, issue, commit or logs.
3. Only after review and workflow availability, manually dispatch with exact confirmation `ARCHIVE-A3-PRODUCTION`. This authorises backup/export **only**, not migration execution.
4. Verify the GitHub run conclusion, inspect `restore-verification.txt`, and download the encrypted artifact before its seven-day expiry. Verify SHA256 of the encrypted file and preserve both archive and decryption key in separate secure locations. A successful workflow alone does not establish off-platform custody.
5. Perform and record an independent restore from the **downloaded encrypted artifact** to a disposable isolated environment before certifying recovery readiness. The workflow's internal restore tests the plaintext dump and its round-trip encryption, but not the downloaded ZIP and later operator retrieval.

## Mandatory hold points

- No migration 0035/0036 production apply, no PR merge, no Stripe activation, no CP31.
- No Neon branch or snapshot deletion without separate explicit approval.
- No backup success claim until a real manual run and independent archive retrieval/restore are evidenced.
- Re-run read-only production identity, ledger and data preflight immediately before any later separately authorised admission.
