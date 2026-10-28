# Gate 2 — Four functional contracts: source closeout evidence

**Scope:** source-only functional contracts and isolated test gates. This is not CP31 admission, production migration approval, UX/UI signoff, or live-commerce activation.

## Contract status

| Contract | Source verdict | Evidence |
| --- | --- | --- |
| 1. Operator identity and confirmed hotel grant | PASS | Exact-ID identity lookup; hotel-authorised grant confirmation and revocation; isolated tests |
| 2. Provider authorisation | PASS | Explicit hotel-owner provider approval and revocation; provider-scoped permission checks; isolated tests |
| 3. Approved founding agreement | PASS | Immutable approved-document evidence and atomic organisation acceptance; hotel/operator shared agreement; placeholder legal text cannot be accepted |
| 4. Commercial onboarding and licence allocation | PASS — **source-contract scope only** | Read-only onboarding/billing evidence; operator allocation permission and quantity guard; auditable billing-authority release; inactive and revoked state tests; separate non-activating commercial assessment |

**Last verified CI baseline:** `d6a2755b3e298d6efd8a53c0a08aaaffe1d05352` — successful GitHub Actions run. Update this field only after new commits pass CI.

## Commercial invariants

- Hotel and transfer-operator organisations share one licence model. An operator's hotel grant is not ownership or a purchased licence.
- Hotel owner authorisation, provider authorisation, legal acceptance, subscription status, and property allocation are independent requirements. None alone activates transfer operations.
- The allocation trigger accepts a recorded positive licence quantity, even with inactive subscription status, as **non-operational bookkeeping**. The commercial activation assessment requires `active` and valid allocation integrity; it **always** denies operational activation pending a separate authorised gate.
- A revoked provider or hotel grant invalidates operator allocation integrity without silently deleting allocation history. The payer's billing-authorised member may explicitly release an allocation; repeated release preserves the original actor/time.
- The release function is executable by `aether_app` only after source migration 0059; the authenticated POST boundary supplies session identity. The database re-checks billing authority. No UI CTA has been wired.
- Guest fare money and SBG SaaS subscription money remain separate payment domains.

## Explicit exclusions and remaining acceptance gates

1. **Migrations 0035–0059 remain source only.** Do not apply them to Production or amend the accepted migration ledger without dedicated authorisation.
2. No PR merge, public onboarding launch, live subscription Checkout, Stripe LIVE keys, guest payment activation, or transfer-operation activation.
3. No published legal document text or production acceptance: final approved Terms/Privacy and legal publication remain separately gated.
4. **No UX/UI or CTA mapping yet.** After contract acceptance, map every supported action, read state, denial and lifecycle transition to a discoverable UI function, including hotel/operator variants, before visual design.
5. The contract tests use isolated database fixtures; they do not prove production migration admission, full browser flows, webhook reconciliation, or end-to-end hotel acceptance.
6. Allocation release currently preserves history but is not a cancellation, refund, subscription quantity update, or provider-authorisation revocation. Those are separate actions with separate authority.
7. A subscription status of `past_due`, `unpaid`, `canceled` or `inactive` must not grant operations. Active subscription alone is also insufficient.
8. Multi-property licence quantity and billing evidence are aggregate. Future per-property operational entitlement must verify that **specific** property, its allocation, provider grant and payment context—not just an aggregate count.

**Closeout decision:** The four **source functional contracts** can be treated as tested, subject to latest CI remaining green. Gate 2 production admission and CP31 are **not** closed. Do not interpret source closeout as authority to deploy or operate.
