# A3 admission — next gates (review only)

Updated: 2026-10-13. **Disposable committed-state rehearsal PASS; production migration NOT AUTHORISED.**

## Certified evidence

- 0036 disposable concurrency: Actions run [38217959320](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/38217959320) — PASS.
- 0035/0036 combined disposable rollback: Actions run [38281102758](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/38281102758) — PASS; rollback-only, not persistent admission.
- 0035/0036 **committed-state** disposable rehearsal: Actions run [38400678511](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/38400678511) — PASS. Workflow dispatched from `main`, checked out immutable commit `c598fff34bc660ff22c8f79ed0ac14c9fdec9b97`, and passed 11/11 offline tests.
- Controller final result: `{"verdict":"PASS — DISPOSABLE COMMIT VERIFIED","migrationCount":36,"productionModified":false}`. Controller validates pinned direct endpoint and live Neon project/branch identity, exact 34-entry preflight ledger, migration digests, and transaction postconditions; after COMMIT, a separate read-only session verified the durable 36-entry ledger, indexes, and **zero** approved agreement versions.
- **Disposable target only:** Neon project `quiet-sound-53513710`, branch `br-square-queen-b13qgjqq`, endpoint `ep-plain-queen-b1vbmyg1`. Branch exists and is distinct from production branch `br-green-darkness-b1k7wkue`. Its 36-entry state means it is **not a clean 34-entry rehearsal baseline** and the committed-state workflow must not be rerun against it.
- `productionModified:false` is the controller's isolation result, **not an independent post-run read-only audit of production**. Production's last independently recorded read-only baseline is 34 entries through 0034, dated 2026-10-12; it must be refreshed before any separately authorised production action.
- Prior unsuccessful runs: [38366031327](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/38366031327) blocked at connection-options validation, before database connection; [38398752884](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/actions/runs/38398752884) rejected by GitHub environment branch protection before any job step.

## Outstanding controls

1. Review the production admission controller, immutable source pin, identity checks, offline failure tests, and any gaps between disposable rehearsal assertions and the full production post-commit contract. Disposable PASS does **not** authorise production apply.
2. Independently refresh the production read-only ledger/schema preflight, including absence of 0035/0036, without modifying production.
3. Resolve draft [PR #1](https://github.com/bizznessfone-cloud/birch-hazel-stone-cloud/pull/1) review/mergeability state through read-only comparison and controlled source reconciliation. **Do not merge**, rebase, or change production through this documentation checkpoint.
4. Require a separately reviewed, explicitly authorised single-use production execution workflow and human approval **before** any production migrations. Do not infer permission from this rehearsal.
5. After any future separately authorised production deployment, verify durable state independently; ambiguous COMMIT outcomes stop and escalate without automatic retry. Retire the single-use workflow after verified use.
6. Keep the legal agreement catalogue empty until an independently approved legal version exists; no `terms-v1` seeding or invented customer acceptance.
7. No hotel/property creation, Stripe LIVE activation, PR merge, or CP31 opening in this checkpoint.

## Scope and source-of-truth distinction

This is evidence-only documentation on the A3 **review branch**. The review branch's `BUILD_STATE.md` correctly states that 0035/0036 are **not applied in production**; the new disposable PASS does not change that. No production SQL, legal seeding, or live commerce was authorised or performed by this documentation change.
