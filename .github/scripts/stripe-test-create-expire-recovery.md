# Stripe TEST create-and-expire recovery

Use this only after the drill reports `orphaned_session_possible` or an expiration failure that includes a recovery record. Do not search for or expire any other session.

The recovery record contains `runId`, `connectedAccount`, `githubRunId`, `githubRunAttempt`, `state`, and `sessionId` only when one was obtained. A failure may also contain sanitised `operationFailure` and `cleanupFailure` codes. It never contains a key or a Checkout URL. `state` remains a failure when cleanup was not verified.

## Identify one session

1. Open the SCAN BOOK GO sandbox `acct_1UKEDfFHnHXHuPOw` in TEST mode. Stop if the account or mode differs.
2. Open the connected account `acct_1UKEFuFHnHoOWAJE`. Stop if it differs from `connectedAccount` in the recovery record.
3. If `sessionId` is present, open that exact Checkout Session. Otherwise, locate a session only by the exact metadata value `sbg_drill_run_id` equal to `runId`.
4. Stop if zero sessions match, or if more than one session matches that run id. Do not use `sbg_drill=create_expire` by itself.

## Verify before expiring

Expire the session only when every item matches:

- Sandbox is TEST mode and the session `livemode` is false.
- Connected account is `acct_1UKEFuFHnHoOWAJE`.
- `sbg_drill_run_id` equals the recovery `runId`.
- `sbg_drill` is `create_expire`.
- `sbg_synthetic` is `true`.
- Amount is €45.00 EUR (`4500` minor units).
- `payment_status` is `unpaid`.
- `status` is `open`.
- If the record contains `sessionId`, it equals the open session id.

If any item differs, stop and leave the session unchanged.

## Expire

Expire that one open session from the Stripe dashboard. Do not call the paid payment harness and do not enter card details. Afterwards, confirm `status` is `expired`, `payment_status` remains `unpaid`, and `livemode` remains false.

Do not copy the restricted API key or the Checkout URL into logs, chat, or Git.
