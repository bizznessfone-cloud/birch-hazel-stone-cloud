import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  allocatePropertyLicenceFn,
  createBillingPortalFn,
  createSubscriptionCheckoutFn,
  ensureHotelOrganisationFn,
  getBillingState,
  startStripeConnectFn,
} from "@/lib/aether/stripe-fns";
import { billingViewModel } from "@/lib/aether/saas-lifecycle";

export const Route = createFileRoute("/app/billing")({
  validateSearch: z.object({ hotelId: z.string().uuid().catch("") }),
  component: Billing,
});

function Billing() {
  const { hotelId } = Route.useSearch();
  const [state, setState] = useState<Awaited<ReturnType<typeof getBillingState>> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
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

  async function subscribe() {
    setBusy(true); setMessage(null);
    try {
      let organisationId = state?.organisationId ?? null;
      if (!organisationId) {
        const created = await ensureHotelOrganisationFn({ data: { hotelId } });
        organisationId = created.organisationId;
      }
      const result = await createSubscriptionCheckoutFn({ data: { organisationId, quantity } });
      window.location.assign(result.url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Checkout could not be started.");
      setBusy(false);
    }
  }

  async function portal() {
    if (!state?.organisationId) return;
    setBusy(true); setMessage(null);
    try {
      const result = await createBillingPortalFn({ data: { organisationId: state.organisationId } });
      window.location.assign(result.url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Billing portal could not be opened.");
      setBusy(false);
    }
  }

  async function allocate() {
    if (!state?.organisationId) return;
    setBusy(true); setMessage(null);
    try {
      await allocatePropertyLicenceFn({ data: { organisationId: state.organisationId, hotelId } });
      setMessage("This property now uses one purchased licence. No extra subscription was created.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Licence could not be allocated.");
    } finally {
      setBusy(false);
    }
  }

  if (!hotelId) {
    return <div className="space-y-4"><h1 className="text-3xl font-semibold">Billing</h1><p className="text-sm text-muted">Select a hotel first.</p><Link to="/app/onboarding" className="text-sm underline">Back to setup</Link></div>;
  }

  const lifecycle = state?.lifecycle ?? billingViewModel(state?.billing ?? null);
  const connected = !!state?.connection && !state.connection.disconnected_at;

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

      {lifecycle.showPlanSelection ? (
        <section className="border border-line bg-surface p-5">
          <p className="text-xs font-medium tracking-widest text-muted uppercase">Property licence</p>
          <h2 className="mt-2 text-xl font-semibold">Purchase property licences</h2>
          <p className="mt-2 text-sm text-muted">
            One organisation. One subscription. Quantity is the number of property licences.
            Adding another property later uses a spare licence and does not start a second subscription.
          </p>
          <label className="mt-4 block text-sm">
            Licences
            <input
              type="number"
              min={1}
              max={49}
              step={1}
              value={quantity}
              onChange={(event) => setQuantity(Number(event.target.value))}
              className="mt-1 w-32 border border-line bg-canvas px-3 py-2"
            />
          </label>
          <button disabled={busy} onClick={() => void subscribe()} className="mt-5 min-h-11 border border-line px-4 text-sm font-semibold tracking-wide uppercase disabled:opacity-50">
            Continue to checkout
          </button>
        </section>
      ) : (
        <section className="border border-line bg-surface p-5">
          <p className="text-xs font-medium tracking-widest text-muted uppercase">Subscription</p>
          <p className="mt-2 text-sm text-muted">
            {state?.organisationId
              ? "This organisation already has a SCAN / BOOK / GO subscription. Use Manage billing to change licence quantity, payment details, or cancellation. A second subscription is not created."
              : "Property licences are purchased by the organisation. This property is not ready to check out."}
          </p>
        </section>
      )}

      <section className="border border-line bg-surface p-5">
        <p className="text-xs font-medium tracking-widest text-muted uppercase">Current subscription</p>
        <p className="mt-2 text-lg font-semibold uppercase">{lifecycle.displayStatus}</p>
        {state?.propertyEntitled ? (
          <p className="mt-1 text-sm text-muted">This property is using one allocated licence. That does not publish the hotel.</p>
        ) : (
          <p className="mt-1 text-sm text-muted">This property has no allocated licence. A subscription alone does not entitle a property.</p>
        )}
        {state?.organisationId ? (
          <p className="mt-1 text-sm text-muted">
            Licensed {state.licensedQuantity}. Allocated {state.activeAllocations}. Available {state.availableLicences}.
          </p>
        ) : null}
        {state?.billing?.current_period_end ? (
          <p className="mt-1 text-sm text-muted">Current period ends {new Date(state.billing.current_period_end).toLocaleDateString()}</p>
        ) : null}
        {lifecycle.shouldManageBilling ? (
          <button disabled={busy} onClick={() => void portal()} className="mt-4 min-h-11 border border-line px-4 text-sm font-semibold tracking-wide uppercase">
            Manage billing
          </button>
        ) : null}
        {state?.organisationId && !state.allocationActive && state.availableLicences > 0 ? (
          <button disabled={busy} onClick={() => void allocate()} className="mt-4 ml-3 min-h-11 border border-line px-4 text-sm font-semibold tracking-wide uppercase">
            Use one licence for this property
          </button>
        ) : null}
      </section>

      <Link to="/app/onboarding" className="text-sm underline underline-offset-4">Back to hotel setup</Link>
    </div>
  );
}
