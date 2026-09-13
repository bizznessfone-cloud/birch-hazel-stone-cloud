# Restore

Canonical restore instructions: **`/RESTORE.md`** (repo root).
Machine-readable state: **`AETHER_RECOVERY_MANIFEST.json`**.
Live status: **`BUILD_STATE.md`**.

## Source of truth

GitHub is authoritative for application source.

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Known-good application source | `45e171a23037b7c94005018cd2126033a449d6f0` |
| Tag | `cp17-known-good` |

When `cp17-known-good` was created, `main` pointed at that commit. The tag is
immutable and identifies the CP16C/CP17 application baseline even if later
documentation-only commits advance `main`.

The Grok workspace is ephemeral and **never authoritative**.

Recovery ZIPs are **secondary disaster-recovery artifacts**, not current source.
The CP10 ZIP is historical and **MUST NOT** be extracted over a newer Git tree
without explicit human approval.

Source-code state and production database state must be reported separately.
Every production-readiness audit must name the exact Git commit audited. Do not
claim Neon production readiness merely because the repository is current.

**CP19** is production Neon binding/verification. It is not a completed
production checkpoint and is not a source-code commit.

Checkpoint 10 remains the immutable **historical** occupancy baseline. Current
**source** is CP16C/CP17 at `45e171a` / `cp17-known-good`. Do not overwrite
Checkpoint 10. Do not call the platform app provisioner. Do not connect Vercel
until Neon verification PASSes.

## Primary restore (GitHub)

```
git clone https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud.git
cd birch-hazel-stone-cloud
git checkout cp17-known-good
```

Equivalent: check out `45e171a23037b7c94005018cd2126033a449d6f0`.

Then:

1. Identify repository, branch, `HEAD` SHA, and checkpoint before any edit.
2. Read, in order:
   - `BUILD_STATE.md`
   - `AETHER_RECOVERY_MANIFEST.json`
   - `RESTORE.md` (repo root)
   - `docs/RECOVERY_MANIFEST.md`
   - `docs/IMPLEMENTATION_STATUS.md`
   - `docs/ARCHITECTURE.md`
   - `docs/TEST_RESULTS.md`
   - `docs/RECOVERY_NOTES.md`
   - `docs/BUILD_BLUEPRINT_V2.md`
   - `docs/MASTER_RECOVERY_PROTOCOL.md`
3. Inspect `migrations/` and `src/lib/aether/`.
4. Do **not** restart the product from scratch.
5. Continue from the recorded **source** phase. Do not mark historical tests as current.
6. Run `sh scripts/restore_aether.sh` as a sandbox helper after Git checkout. If it fails, stop.
7. Ensure `/workspace/startup.sh` exists and start the app with it.
8. Do not call `init_or_update_app` or any provision/reset operation.
9. Do not create `.env` files with secrets.
10. `DATABASE_URL` is unset in preview (PGLite, labelled development substitute).
    Production injects it and it must be the `aether_app` role (SQL-created LOGIN).
11. Do not claim production readiness while Neon role-split and Neon concurrency
    remain unverified. Current GitHub source is not Neon proof.

## Disaster-recovery ZIP (secondary only)

A downloaded checkpoint zip is **not** the persistent primary backup. GitHub is.

Use a ZIP only if GitHub is unavailable **and** a human has approved that path.
Never extract `attachments/AETHER_TRANSFER_CP010_DATABASE_2026-09-05.zip` over a
tree that is at or based on `45e171a` / `cp17-known-good`.

## Completeness test

Could another agent restore this application from GitHub at the named SHA
without the original chat? If any required knowledge lives only in chat, the
checkpoint documentation is incomplete.

## Snapshot contents (required for a ZIP *backup*, not for source of truth)

- application source
- migrations
- tests
- recovery documentation
- configuration examples without secrets
- `startup.sh`
- `package.json` / lockfile
- `AETHER_RECOVERY_MANIFEST.json`
- `RESTORE.md`
- `BUILD_STATE.md`

## Snapshot command

```
node scripts/make-recovery-snapshot.mjs <checkpoint> <phase-slug> <test-status>
```

Do not use that command to overwrite Checkpoint 10. New state → new id. A new
ZIP is a backup of a Git commit, never a replacement for GitHub.
