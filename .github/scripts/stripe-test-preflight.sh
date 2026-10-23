#!/bin/sh
# Manual Stripe TEST scaffolding. It does not create a Checkout Session.
# The execution phase is present but refused: a Checkout URL cannot be handed
# to a person without placing that URL in the Actions log.
set -eu

phase="${1:-preflight}"

if [ "${SBG_GUEST_PAYMENT_TEST:-}" != "true" ]; then
  echo "Guest payment test flag is not enabled." >&2
  exit 1
fi
if [ "${SBG_DOMAIN_B_LIVE_CHECKOUT:-}" = "true" ] || [ "${SBG_SAAS_COMMERCE:-}" = "live" ]; then
  echo "Live payment flag rejected." >&2
  exit 1
fi
if [ -n "${STRIPE_WEBHOOK_SECRET:-}" ]; then
  echo "SaaS webhook secret must not be present." >&2
  exit 1
fi

key="${STRIPE_SECRET_KEY:-}"
if [ -z "$key" ]; then
  echo "TEST credential absent." >&2
  exit 1
fi
case "$key" in
  sk_live_*|rk_live_*)
    echo "Live credential rejected." >&2
    exit 1
    ;;
  sk_test_*|rk_test_*)
    ;;
  *)
    echo "Unrecognised credential rejected." >&2
    exit 1
    ;;
esac
unset key

python3 - <<'PY'
import os
from urllib.parse import urlparse

blocked = ("neon.tech", "vercel.com", "stripe.com")
for name, value in os.environ.items():
    lower = value.lower()
    if "postgres://" in lower or "postgresql://" in lower:
        for part in value.replace(";", " ").split():
            if "://" not in part:
                continue
            host = (urlparse(part).hostname or "").lower()
            if host not in ("127.0.0.1", "localhost"):
                raise SystemExit(f"Remote database URL rejected in {name}.")
    for marker in blocked:
        if marker in lower and name.startswith(("DATABASE", "NEON", "POSTGRES", "STRIPE_WEBHOOK")):
            raise SystemExit(f"Blocked endpoint marker rejected in {name}.")
PY

node --experimental-strip-types --input-type=module -e 'import { assertGuestPaymentTestProcess } from "./src/lib/aether/guest-payment-test-isolation.ts"; assertGuestPaymentTestProcess(process.env);'

if [ "$phase" = "execute-test-payment" ]; then
  echo "Checkout execution is disabled." >&2
  echo "The Stripe CLI can authenticate with --api-key and forward Connect events only to 127.0.0.1." >&2
  echo "No secure Checkout URL handoff exists: the URL must not be logged, uploaded, or stored." >&2
  echo "A person would have to open the session from the Stripe Dashboard after a later authorisation." >&2
  exit 2
fi

if [ "$phase" != "preflight" ]; then
  echo "Unknown phase rejected." >&2
  exit 1
fi

sh .github/scripts/bootstrap-disposable-postgres.sh cleanup
echo "Preflight passed. No Stripe API call was made."
