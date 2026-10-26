# Checkout structure probe

The probe is disabled. `CHECKOUT_STRUCTURE_PROBE_GATE` is `"closed"` and is not the payment execution gate. `runCheckoutStructureProbe` does not open a browser, create a Checkout Session, or read a Stripe credential.

A later, separately authorised TEST run may do only the following:

1. Create one TEST Checkout Session on connected account `acct_1UKEFuFHnHoOWAJE` for 4500 EUR, with no application fee.
2. Open that hosted page in Playwright and call `observeCheckoutStructure`.
3. Keep the Checkout URL in memory. Do not log, store, or print it.
4. Publish only a `CheckoutStructureReport`.
5. Close the browser.
6. Expire that unpaid Session and verify `status=expired` and `payment_status=unpaid`.
7. If creation or expiry is ambiguous, stop. Do not retry, click, fill, or refund.

The probe must not submit payment or bypass a challenge. No such run is enabled by this file.
