# Aether Transfer — Master Recovery Protocol

This file is the permanent copy of the rebuild protocol used to reconstruct
Aether Transfer after the original implementation workspace was lost.

## Current accepted baseline (POST-CP25G.3)

GitHub is the authoritative source for application source code. Living status: **`BUILD_STATE.md`**.

| Field | Value |
|---|---|
| Repository | `bizznessfone-cloud/birch-hazel-stone-cloud` |
| Branch | `main` |
| Current source SHA | `4c20e9b9574309a0edbeb03f8675febdef38dede` |
| CP25G.3 | **CLOSED** |
| Next numbered checkpoint | **UNDEFINED** — **Do not invent CP26.** |
| Production | `scan-book-go` / `dpl_5XnaxYcqkrgWucD54TKgbmvHkfy1` READY |
| Migrations | `0001`–`0022` |

`cp17-known-good` (`45e171a23037b7c94005018cd2126033a449d6f0`) is an immutable **historical** tag. It is not current `main`.

Recovery ZIPs are secondary disaster-recovery artifacts. The CP10 ZIP must not be extracted over a newer Git tree without explicit human approval. A workspace is disposable and is never authoritative.

Every engineering checkpoint must identify an exact Git commit SHA. Source-code state and production database state must be reported separately.

Agents must never restore an older checkpoint over a newer repository state without explicit human approval.

### Source of truth order

1. GitHub repository + exact current `main` SHA
2. Living `BUILD_STATE.md`
3. Historical tag `cp17-known-good` (CP16C/CP17 only)
4. Recovery ZIP (disaster recovery only)
5. Grok workspace (disposable)
6. Chat (context only)

## Absolute priorities

1. Preserve occupancy / booking integrity (PostgreSQL is authoritative).
2. Build a genuinely functional application, not a visual prototype.
3. Security boundaries must be enforced server-side.
4. Database concurrency must be enforced by the database.
5. Timezone/DST behaviour must be explicitly tested.
6. Do not invent missing product requirements.
7. Do not expand MVP/V2-fenced scope without authorisation.
8. Maintain complete recovery documentation keyed to GitHub SHAs.
9. Recovery snapshots (ZIPs) are backups of a Git commit, not replacements for GitHub.
10. Never claim something is implemented, tested or verified unless it has been verified, and never treat a historical SHA as current `main`.

## Snapshot rule

A snapshot must contain the entire restorable project: source, migrations,
tests, configuration examples (no secrets), and recovery documentation. It is a
backup of a named Git commit.

Ask at every checkpoint: could another coding agent restore this application
from GitHub at the named SHA without access to the original conversation? If
no, the checkpoint documentation is not complete.

## Checkpoints

Historical rebuild gates (0–17) remain the original protocol. They are **not**
the current source SHA.

Later completed work (see living `BUILD_STATE.md`): CP19 production binding,
CP20 email architecture, CP21/CP21B, CP22 onboarding, CP23 public slug, CP24
Stripe Connect source, CP25 guest-payment source, CP25G.3 Production Better Auth
(CLOSED).

Next numbered checkpoint: **UNDEFINED**.

## If the workspace disappears

Restore from GitHub `main` at the current SHA in `BUILD_STATE.md`. Do not check
out `cp17-known-good` unless a human authorises a historical rollback.
