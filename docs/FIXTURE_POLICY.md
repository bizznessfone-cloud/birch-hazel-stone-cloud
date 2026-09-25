# SCAN / BOOK / GO — fixture policy

Canonical fixture classes for CP26–CP30. Living status: `BUILD_STATE.md`.
Roadmap: `docs/ROADMAP.md`. Owner architecture: `docs/OWNER_CONTROL_PLANE.md`.
**CP26B is CLOSED.** CP26C.3 is **paused**. CP26C-O2 is **CLOSED**. One Production platform Owner exists (OPERATOR CONTROLLED / REDACTED). First-Owner bootstrap workflow is **RETIRED**. Next product is **CP26C-O3**.
Only **CP31** may activate real commerce.

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

## B. PRODUCTION VERIFICATION (established CP26A.5)

**Exists.** Classification: **PERSISTENT PRODUCTION VERIFICATION TENANT — RETAIN**.

Created in authorised operator-supervised CP26A.5. Retained for authorised
CP26–CP30 work. Never a real customer. Do not delete casually.

| Field | Established value |
|---|---|
| Count | exactly one operator identity; exactly one owned hotel |
| Identity | operator-controlled real mailbox **REDACTED**; password in human password manager only |
| Hotel name | SBG Verification Hotel |
| Internal booking code | `sbg-verify-a5` |
| Public slug | `erification-otel` |
| Locality / timezone / currency | Verification Locality · Europe/Athens · EUR |
| Status | **configured** — **not live**; not guest-bookable |
| Catalogue | Verification Transfer · Verification Airport · EUR 10.00 (**Domain B** hotel transfer money, not a SaaS plan amount) |
| Publication | `/erification-otel` and `/book/sbg-verify-a5` are `hotel_not_live` |
| Billing | configured hotel is sufficient for Domain A billing GET; live and Connect are not required |
| Domain A money | **none** before CP31 |
| Grok / git / `.env` / Vercel / chat | never hold the password or full email |
| Spent CP25G.3 users | **must not reuse** |
| Unknown unconfigured hotels | **must not reuse** |
| `demo-kos` | **must not reuse or mutate** |
| Commerce | `SBG_SAAS_COMMERCE` remains unset / fail-closed unless a later checkpoint explicitly changes that |

Allowed on this tenant without a new identity/hotel: returning sign-in / sign-out;
ownership / IDOR; billing **GET**. CP26B source work with commerce **OFF** is
complete. Do not attach Stripe test billing here until CP26C.4/C.5 explicitly
authorise it. Isolation (`SBG_SAAS_TEST_HOTEL_IDS`) is in source; Production
commerce remains OFF. This tenant is not an automatic test-commerce allowlist.

Prohibited unless a later checkpoint **explicitly** changes fixture policy:
`goLive` / publication; Connect; Checkout; Stripe env; guest booking; second
signup; second hotel; password reset; deletion.

CP26C must **not** attach Stripe test billing state to this tenant until CP26C.4
authorises Production test commerce **and** CP26C.5 names this hotel in the
allowlist. This tenant is not an automatic test-commerce allowlist.

---

## C. OPERATIONAL DEMO

`demo-kos` is the public Production demo.

- Canonical live route: **`/book/demo-kos`**.
- Independent of SaaS verification.
- Not a Domain A billing tenant unless a later checkpoint separately authorises it.
- CP26 fixture work must not depend on mutating it.
- `/demo-kos` slug route currently returns `hotel_not_found` (pre-existing presentation/data inconsistency; do not “fix” by mutating the demo).

Seeded `gate` / `harbor` are reserved demo codes, not SaaS fixtures.

---

## Credential / email (Production verification)

Identity uses an operator-controlled real mailbox or plus-address. The address
is **REDACTED** in this repository.

Password:

- generated and stored by the human operator
- never committed
- never pasted into chat/Grok
- never logged
- never placed in Vercel env
- never written to `.env`
- never stored in the repository
- retained so returning sign-in remains usable through CP26–CP30

Grok has no workspace secret store. GitHub Actions secrets are not a Grok-readable
password vault. Operator password manager is the system of record.

---

## CP26C test isolation (source complete in CP26C.2)

`SBG_SAAS_COMMERCE=test` is **process-global**. CP26C.2 therefore requires a
non-empty `SBG_SAAS_TEST_HOTEL_IDS` hotel-UUID allowlist before any Domain A
Checkout, portal, or webhook persistence in test mode. Empty/malformed
allowlist fail-closes every hotel. Live mode ignores this allowlist.

Do **not** set `SBG_SAAS_COMMERCE=test` on public Production until CP26C.4.
Do **not** put a Production hotel UUID in git.

`main` auto-deploys Vercel Production. Source/docs changes here do not activate
commerce.

---

## Next authorised execution

**CP26C-O2** — Owner dashboard foundation. Do not resume CP26C.3 until O3.
Do not enable test commerce on public Production in this child. Only **CP31**
activates live commerce.
