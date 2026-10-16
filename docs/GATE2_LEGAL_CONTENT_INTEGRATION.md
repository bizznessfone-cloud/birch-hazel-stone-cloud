# Gate 2 — Legal content integration contract

Status: DEVELOPMENT POLICY. Not legal advice, an approved agreement, or permission to activate commerce.

## Scope and existing architecture
Preserve the existing founding organisation, hotel registration, acceptance-evidence, eligibility, subscription and workspace architecture. This document is a release constraint, **not** an invitation to redesign the system.

- `terms-v1` is a historical provisional token, never an approved customer contract.
- Migrations 0035–0038 are prepared on the Gate 2 branch, not authorised for production execution.
- The effective approved agreement version is the database authority. No version is seeded by these migrations.
- An authenticated, explicit user action must record acceptance of the **exact effective approved version**; merely viewing a page or creating an organisation must never count as acceptance.
- A backend write must independently recheck authorisation and effective agreement state. A previously successful UI eligibility check is insufficient.

## Development placeholders
The following are content slots only, **not legal text**:
1. `SAAS_TERMS` — business subscription / platform contract.
2. `PRIVACY_NOTICE` — personal-data notice.
3. `DATA_PROCESSING_ADDENDUM` — controller/processor allocation and processing schedule, where applicable.
4. `PAYMENT_AND_CANCELLATION_POLICY` — subscription and payment/cancellation disclosure, as applicable.

Show each unresolved slot as **Draft — not approved / unavailable for live acceptance**. Do not publish invented substantive clauses, mark a slot approved, or allow placeholder acceptance to grant access in production. A fixture-approved version may be used **only in an isolated test database**, never production.

## Engineering delivery
Continue building the founding journey, authenticated hotel workspace, hotel/operator flows, Stripe TEST integration, validation, and isolated end-to-end testing. Keep live subscription activation and real customer acceptance disabled.

## Release gates (before CP31)
- Final legal documents are reviewed and authorised by the business and appropriate qualified advisers.
- The actual contracting entity, contact details, jurisdiction and version identifiers are confirmed.
- Final document contents and immutable version references are published, accessible and auditable.
- The correct legal documents are presented before an explicit, unticked customer acceptance action.
- Version-specific acceptance evidence is persisted with authenticated identity and timestamp; failed/withdrawn approval must fail closed.
- Privacy and data-processing requirements are implemented as applicable; subscription disclosure and Stripe LIVE readiness are separately verified.
- Production migrations are explicitly authorised and independently verified before use.
- CP31 is separately and explicitly authorised. No earlier test or merge constitutes go-live approval.

## Change control
Do not replace, re-architect, or reinterpret settled commercial or technical decisions merely because final legal wording is outstanding. Any genuine legal requirement that would alter product behaviour must be raised as a focused change request, with affected components, migration risk, and a proposed minimal patch.
