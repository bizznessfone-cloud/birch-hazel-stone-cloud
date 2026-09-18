import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  createBillingPortalFn,
  createSubscriptionCheckoutFn,
  getBillingState,
  startStripeConnectFn,
} from "@/lib/aether/stripe-fns";

export const Route = createFileRoute("/app/billing")({
  component: Billing,
});

function Billing() {
  const search = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const hotelId = search.get("hotelId") ?? "";
  const [state, setState] = useState<Awaited<ReturnType<typeof getBillingState>> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!hotelId) return;
    setState(await getBillingState({ data: { hotelId } }));
  }

  useEffect(() => { void refresh(); }, [hotelId]);

  async function connectStripe() {
    setBusy(true); setMessage(null);
    try {
      const result = await startStripeConnectFn({ data: { hotelId } });
      window.location.assign(result.url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Stripe connection failed.");
      setBusy(false);
    }
  }

  async function subscribe(plan: "basic" | "pro" | "premium") {
    setBusy(true); setMessage(null);
    try {
      const result = await createSubscriptionCheckoutFn({ data: { hotelId, plan } });
      window.location.assign(result.url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Checkout could not be started.");
      setBusy(false);
    }
  }

  async function portal() {
    setBusy(true); setMessage(null);
    try {
      const result = await createBillingPortalFn({ data: { hotelId } });
      window.location.assign(result.url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Billing portal could not be opened.");
      setBusy(false);
    }
  }

  if (!hotelId) {
    return <div className="space-y-4"><h1 className="text-3xl font-semibold">Billing</h1><p className="text-sm text-muted">Select a hotel first.</p><Link to="/app/onboarding" className="text-sm underline">Back to setup</Link></div>;
  }

  const billingState = state?.billing;
  const connected = !!state?.connection && !state.connection.disconnected_at;
  const active = billingState?.status === "active" || billingState?.status === "trialing";

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Plan & activation</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Activate SCAN / BOOK / GO</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          Your SCAN / BOOK / GO subscription is billed separately from guest transfer payments.
          Hotel guest payments remain on the hotel’s connected Stripe account.
        </p>
      </div>

      {message ? <p className="border border-line px-4 py-3 text-sm">{message}</p> : null}

      <section className="border border-line bg-surface p-5">
        <p className="text-xs font-medium tracking-widest text-muted uppercase">Hotel payments</p>
        <h2 className="mt-2 text-xl font-semibold">{connected ? "Stripe account connected" : "Connect your Stripe account"}</h2>
        <p className="mt-2 text-sm text-muted">
          Connect the hotel’s own Stripe account. SCAN / BOOK / GO does not receive or hold the hotel’s guest payment funds.
        </p>
        <button disabled={busy || connected} onClick={() => void connectStripe()} className="mt-4 min-h-12 bg-ink px-4 py-3 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50">
          {connected ? "Connected" : "Connect with Stripe"}
        </button>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {(["basic", "pro", "premium"] as const).map((plan) => (
          <article key={plan} className="border border-line bg-surface p-5">
            <p className="text-xs font-medium tracking-widest text-muted uppercase">{plan}</p>
            <p className="mt-3 text-sm text-muted">Subscription plan</p>
            <button disabled={busy} onClick={() => void subscribe(plan)} className="mt-5 min-h-11 w-full border border-line px-4 text-sm font-semibold tracking-wide uppercase disabled:opacity-50">
              {active && billingState?.stripe_price_id ? "Change / activate" : "Choose plan"}
            </button>
          </article>
        ))}
      </section>

      {billingState ? (
        <section className="border border-line bg-surface p-5">
          <p className="text-xs font-medium tracking-widest text-muted uppercase">Current subscription</p>
          <p className="mt-2 text-lg font-semibold uppercase">{billingState.status}</p>
          {billingState.current_period_end ? <p className="mt-1 text-sm text-muted">Current period ends {new Date(billingState.current_period_end).toLocaleDateString()}</p> : null}
          {billingState.stripe_customer_id ? <button disabled={busy} onClick={() => void portal()} className="mt-4 min-h-11 border border-line px-4 text-sm font-semibold tracking-wide uppercase">Manage billing</button> : null}
        </section>
      ) : null}

      <Link to="/app/onboarding" className="text-sm underline underline-offset-4">Back to hotel setup</Link>
    </div>
  );
}
