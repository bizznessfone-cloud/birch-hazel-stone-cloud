# Checkout structure diagnostic

`CHECKOUT_DIAGNOSTIC_EXECUTION_GATE` is `"closed"`. A closed gate rejects every run. An open gate is also required to match `SBG_AUTHORISED_DIAGNOSTIC_SHA` to `GITHUB_SHA` on `test/stripe-gate2-runner` for workflow `SBG Stripe TEST checkout diagnostic`. The committed gate is not open.

The runner creates one €45 TEST Checkout Session on `acct_1UKEFuFHnHoOWAJE`, reads the hosted page with the existing structure probe, closes the browser, and expires the unpaid Session. It does not retry creation, enter card details, click, or refund. If expiry cannot be verified, the result is `blocked`.
