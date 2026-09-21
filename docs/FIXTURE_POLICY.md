# SCAN / BOOK / GO — fixture policy

Canonical fixture classes for CP26A–CP30. Living status: `BUILD_STATE.md`.
Roadmap: `docs/ROADMAP.md`. Only **CP31** may activate real commerce.

Verification policy (not a database constraint): **one verification user owns
exactly one verification hotel.** Schema still allows many-to-many
`app_hotel_accounts`; do not add uniqueness to “fix” that.

Do not reuse CP25G.3 spent Better Auth users. Do not attach unknown
unconfigured Production hotels. Do not mutate `demo-kos` for SaaS tests.

---

## A. LOCAL / TEST

| Field | Rule |
|---|---|
| Email | `verify-*@sbg.test` |
| Hotel code | `sbg-test-*` |
| Name | must include `[TEST]` |
| Engine | fresh PGLite per test |
| Neon / Vercel / Production IDs | **never** |
| Lifecycle | disposable; reset by closing the test database |

Source harness: `src/lib/aether/cp26a4-fixture.ts` (tests only; not a runtime import).

---

## B. PRODUCTION VERIFICATION (future CP26A.5)

Create **only** in an authorised operator-supervised child. Not this checkpoint.

| Field | Rule |
|---|---|
| Count | exactly one declared operator identity; exactly one owned hotel |
| Persistence | through CP26–CP30 as required |
| Customer | **never** a real customer |
| Publication | **never `live` during CP26A**; never guest-bookable |
| Domain A money | **none** before CP31 |
| Email | operator-controlled real mailbox or plus-address (not created here) |
| Password | generated/stored by the human operator password manager |
| Grok | never receives, stores, logs, or pastes the password |
| Git / `.env` / Vercel env / chat | never hold the password |
| Signup | **exactly once**. Failed signup → **STOP**. No retry-user loop |
| Spent CP25G.3 users | **must not reuse** |
| Unknown unconfigured hotels | **must not reuse** |
| `demo-kos` | **must not reuse or mutate** |
| Commerce | `SBG_SAAS_COMMERCE` remains unset / fail-closed during CP26A.5 |

Allowed in CP26A.5/A.6: signup once; onboarding to **configured**; returning
sign-in / sign-out; ownership / IDOR; billing **GET**.  
Prohibited: `goLive`, Connect, Checkout, Stripe env, guest booking.

---

## C. OPERATIONAL DEMO

`demo-kos` is the public Production demo.

- Independent of SaaS verification.
- Not a Domain A billing tenant unless a later checkpoint separately authorises it.
- CP26 fixture work must not depend on mutating it.

Seeded `gate` / `harbor` are reserved demo codes, not SaaS fixtures.

---

## Credential / email (Production verification)

Identity will use an operator-controlled real mailbox or plus-address.

Password:

- generated and stored by the human operator
- never committed
- never pasted into chat/Grok
- never logged
- never placed in Vercel env
- never written to `.env`
- never stored in the repository
- retained through CP26A.5/A.6 so returning sign-in can actually be proven

Grok has no workspace secret store. GitHub Actions secrets are not a Grok-readable
password vault. Operator password manager is the system of record.

---

## CP26C forward risk (do not solve here)

`SBG_SAAS_COMMERCE=test` is **process-global**. Enabling it on public Production
would offer test Checkout to any `/login` signup and write test customers into
Production `sbg_billing_accounts`.

CP26C must not simply flip that flag. Candidate later solutions:

- tenant-scoped / allowlisted test-commerce gate
- staging app + database
- explicitly authorised time-boxed Production window

`main` auto-deploys Vercel Production. Source/docs changes here do not activate
commerce. Stripe test-mode remains a later, separately authorised problem.

---

## Next authorised execution

**CP26A.5** — operator-supervised creation of exactly one persistent Production
verification identity and exactly one owned hotel, with commerce **OFF**.
