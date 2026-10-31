# A3 production migration decision package — 2026-10-14

**Status: PREPARED FOR REVIEW ONLY — NOT AUTHORISED FOR PRODUCTION EXECUTION.**

## Scope and isolation
- Target Neon project `quiet-sound-53513710`, production branch `br-green-darkness-b1k7wkue`, endpoint `ep-withered-haze-b1fd9hse`, database `neondb`, owner `neondb_owner`.
- Proposed changes only: `0035_cp3005e2d2d_founding_property.sql` and `0036_cp3005e2d2d_founding_integrity.sql` in one transaction. No changes to 0001–0034.
- A3 draft executor remains unconditionally blocked (`executor-not-certified-or-authorised`) and has no CLI entry point. Do **not** remove the block or create an execution workflow under this review-only task.
- Draft PR #1 remains open/unmerged. No CP31, live commerce, or Stripe activation.

## Evidence inspected
1. Disposable rehearsal GitHub Actions run [38590972498](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/38590972498): successful, ledger 36 on disposable `br-crimson-cherry-b1zd1gay`, production unchanged.
2. Draft executor offline regression GitHub Actions run [38596389611](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/38596389611): 10 tests passed; unconditional hard-stop covered.
3. Production backup-only run [38604539676](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/38604539676): success, PostgreSQL 18 export, isolated restore of plaintext dump, ledger 34 and no 0035/0036, AES encryption/decryption round-trip, encrypted artifact `SBG-A3-PRODUCTION-ENCRYPTED-BACKUP` (artifact ID 11914697988), GitHub expiry 2026-10-21. Operator reports downloaded archive saved; downloaded ZIP integrity reported verified. Independent **restore from downloaded encrypted artifact** deliberately deferred by operator, **not certified**.
4. Read-only live production check on 2026-10-14: branch `br-green-darkness-b1k7wkue`, migration ledger 34, hotels 8, bookings 9; no duplicate founding creators, no organisation acceptances, approval-version table absent as expected, no disabled relevant user triggers, no PUBLIC EXECUTE on protected functions. Existing protected SECURITY DEFINER functions: 2; post-0036 expectation: 3.
5. SQL migration SHA256 pins:
   - 0035: `80d1d3ec68eebfba0bcfbe07ac3c3dd1ade11d7d0466be9264cf0f28d27def67`
   - 0036: `fb300bb17c8e9758700cf2fd09aa355b0293b5cd84c692e2913835876ece18fc`

## Current risks / limits
- Neon production branch `protected=false`; this is a governance weakness, not a database preflight failure. Do not change branch settings without separate approval.
- Neon Free project was previously at 10/10 branches; native snapshot attempt returned HTTP 422 (snapshot limit exceeded); existing September snapshot was left intact. Six-hour history retention was previously reported. No branch/snapshot deletion authorised.
- Independent decrypt and restore of the **downloaded** encrypted ZIP remains deferred by explicit operator decision. Do not describe recovery as independently restore-certified.
- Preflight evidence is time-sensitive; redo immediately before any separately authorised production operation.
- Production-specific **post-migration** privilege/index/trigger state cannot be established by read-only queries against the pre-migration schema. Disposable rehearsal and draft offline tests provide evidence but are not a substitute for post-commit verification.
- Legal approval table remains empty after migrations; no agreement version, terms acceptance, billing or Stripe activation is authorised by these SQL changes.

## Required separate production admission decision (not given)
Before any production execution, require an explicit, scoped approval identifying the exact two migration files/digests, production branch, current code SHA, recovery evidence and accepted residual risks. Independently review execution workflow and executor implementation; maintain fail-closed checks for target identity, ledger baseline, transaction locking, rollback before COMMIT, privilege/index/trigger postconditions, and durable verification in a fresh session. An ambiguous COMMIT result must be escalated, never automatically retried.

No approval in this document, and no implicit approval from “proceed” to review work, removes the executor hard-stop or authorises deployment.

## Decision
**REVIEW PACKAGE PREPARED; PRODUCTION APPLY WITHHELD.** Continue controlled review only until a new, explicit production migration authorisation is received.
