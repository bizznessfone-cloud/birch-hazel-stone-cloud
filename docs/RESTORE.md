# Restore from a recovery snapshot

Canonical restore instructions for this workspace: **`/RESTORE.md`** (repo root).
Use **`scripts/restore_aether.sh`**. Machine-readable state: **`AETHER_RECOVERY_MANIFEST.json`**.
Live status: **`BUILD_STATE.md`**.

Checkpoint 10 is the immutable occupancy baseline. Current source is **CP12B**.
Do not overwrite Checkpoint 10. Do not call the platform app provisioner.
Do not connect Vercel until Neon verification PASSes.


---

The Grok workspace is ephemeral. A downloaded checkpoint zip is the
persistent backup.

## Could another agent restore from this snapshot without the original chat?

That is the completeness test. If any required knowledge lives only in chat,
the snapshot is incomplete.

## Steps

1. Start a new Grok Build workspace (TanStack Start sandbox).
2. Extract the snapshot over the workspace, preserving `node_modules` if the
   sandbox already has dependencies, otherwise run `npm install`.
3. Read, in order:
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
4. Inspect `migrations/` and `src/lib/aether/`.
5. Do **not** restart the product from scratch.
6. Continue from the recorded phase. Do not mark historical tests as current.
7. Run `sh scripts/restore_aether.sh`. If it fails, stop.
8. Ensure `/workspace/startup.sh` exists and start the app with it.
9. Do not call `init_or_update_app` or any provision/reset operation.
10. Do not create `.env` files with secrets.
11. `DATABASE_URL` is unset in preview (PGLite, labelled development substitute).
    Production injects it and it must be the `aether_runtime` role.
12. After Checkpoint 10 / 10A, the next phase is **11 — Deployment**. Do not
    start it until Neon credentials exist. Do not claim production readiness
    while Neon role-split and Neon concurrency remain unverified.

## Snapshot contents (required)

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

Do not use that command to overwrite Checkpoint 10. New state → new id (10A, 11, …).
