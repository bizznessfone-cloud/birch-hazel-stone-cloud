# Restore

Canonical restore instructions: **`/RESTORE.md`** (repo root).
Living status: **`BUILD_STATE.md`**.
Machine-readable identity: **`AETHER_RECOVERY_MANIFEST.json`**.

## Current accepted baseline (POST-CP26A)

GitHub is authoritative for application source.

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Last application SHA | `b35ef2fc8bdddef81fcc84aa59d358dba4346a30` |
| CP25G.3 | **CLOSED** |
| **CP26A** | **CLOSED** |
| **Next execution checkpoint** | **CP26B — Domain A subscription lifecycle completion** |
| Forward roadmap | **[ROADMAP.md](ROADMAP.md)** |
| Fixture policy | **[FIXTURE_POLICY.md](FIXTURE_POLICY.md)** |
| Production | `scan-book-go` / last observed `dpl_7MFpVnCV4CbyoUjev1ZjcLVm2vtn` READY |
| Migrations | `0001`–`0023` |

`cp17-known-good` (`45e171a…`) is a historical CP16C/CP17 tag. It is **not** current `main`.

The Grok workspace is ephemeral and **never authoritative**. Recovery ZIPs are **secondary disaster-recovery artifacts**. The CP10 ZIP **MUST NOT** be extracted over a newer Git tree without explicit human approval.

## Primary restore (GitHub)

```
git clone https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud.git
cd birch-hazel-stone-cloud
git checkout main
# last application SHA: b35ef2fc8bdddef81fcc84aa59d358dba4346a30
```

Then:

1. Identify repository, branch, `HEAD` SHA before any edit.
2. Read `BUILD_STATE.md` first, then `RESTORE.md`, `docs/RECOVERY_MANIFEST.md`.
3. Inspect `migrations/` (must include through `0023`) and `src/lib/aether/`.
4. Do **not** restart the product from scratch.
5. Do **not** check out `cp17-known-good` unless a human has explicitly authorised a historical rollback.
6. Run `sh scripts/restore_aether.sh` as a sandbox helper after Git checkout if required by the workspace. If it fails, stop.
7. Do not call `init_or_update_app` or any provision/reset operation.
8. Do not create `.env` files with secrets.
9. Production runtime uses `DATABASE_URL` (`aether_app`). Owner URL stays off Vercel.
10. `npm run build` does not migrate.

## Disaster-recovery ZIP (secondary only)

A downloaded checkpoint zip is **not** the persistent primary backup. GitHub is.

Use a ZIP only if GitHub is unavailable **and** a human has approved that path.
Checkpoint 10 remains the immutable **historical** occupancy baseline only.
