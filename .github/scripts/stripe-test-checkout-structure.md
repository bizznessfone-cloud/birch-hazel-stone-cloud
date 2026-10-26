# Checkout structure probe

The probe is disabled. `CHECKOUT_STRUCTURE_PROBE_GATE` is `"closed"` and is not the payment execution gate. `runCheckoutStructureProbe` does not open a browser, create a Checkout Session, or read a Stripe credential.

Inspection uses the main frame and each child frame separately. It does not use one `iframe` frame locator for every frame. Every browser read shares one deadline of `STRUCTURE_OBSERVATION_BUDGET_MS`. A stalled read ends as `timeout`. A detached, navigated, or inconsistent frame ends as `unexpected`. Neither result includes a raw browser error.

A later, separately authorised TEST run may do only the following:

1. Create one TEST Checkout Session on connected account `acct_1UKEFuFHnHoOWAJE` for 4500 EUR, with no application fee.
2. Open that hosted page in Playwright and call `observeCheckoutStructure`.
3. Keep the Checkout URL in memory. Do not log, store, or print it.
4. Publish only a `CheckoutStructureReport`.
5. Close the browser and cancel any outstanding read.
6. Expire that unpaid Session and verify `status=expired` and `payment_status=unpaid`.
7. If creation or expiry is ambiguous, stop. Do not retry, click, fill, or refund.

The probe must not submit payment or bypass a challenge. No such run is enabled by this file.
