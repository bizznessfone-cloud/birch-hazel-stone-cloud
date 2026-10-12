# A3 admission — next gates (review only)

Date: 2026-10-12. No production migration authorisation.

## Certified evidence

- 0036 disposable concurrency: Actions run 38217959320 — PASS.
- 0035/0036 combined disposable rollback: Actions run 38281102758 — PASS.
- Independent read-only Neon verification: disposable and production both retain 34 ledger entries, latest 0034. No checked 0035/0036 objects remain.

## Outstanding controls

1. Review production admission design and offline failure tests.
2. Run a separate fresh-disposable committed-state rehearsal; rollback-only evidence does not prove persisted postconditions.
3. Execute the production preflight in read-only mode and independently verify its output.
4. Obtain explicit separate authorisation before any production migration.
5. Verify persisted state after any separately authorised deployment; ambiguous commit outcomes must stop and escalate, never automatically retry.
6. Do not seed provisional Terms, fabricate acceptance, merge this draft PR, enable Stripe commerce, or open CP31 as part of these gates.

## Scope

This file is evidence and planning only. It contains no executable migration or workflow.
