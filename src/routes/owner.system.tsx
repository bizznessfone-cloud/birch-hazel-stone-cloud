import { createFileRoute } from "@tanstack/react-router";
import { getOwnerSystemFn } from "@/lib/aether/owner-fns";

export const Route = createFileRoute("/owner/system")({
  loader: () => getOwnerSystemFn(),
  component: OwnerSystemPage,
});

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-t border-line py-3 sm:grid-cols-[14rem_1fr] sm:gap-6">
      <dt className="text-xs tracking-widest text-muted uppercase">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

function OwnerSystemPage() {
  const data = Route.useLoaderData();
  const allowlist =
    data.testAllowlist.status === "configured"
      ? `${data.testAllowlist.count} hotel${data.testAllowlist.count === 1 ? "" : "s"}`
      : data.testAllowlist.status.toUpperCase();

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Configuration</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">System</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          LIVE commerce is CP31. This dashboard cannot activate it.
        </p>
      </header>

      <section className="border border-line bg-surface p-5">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">Domain A commerce</h2>
        <dl className="mt-2">
          <Row label="SBG_SAAS_COMMERCE" value={data.commerceMode.toUpperCase()} />
          <Row label="Mode env" value={data.commerceConfigured} />
          <Row label="Stripe secret" value={data.stripeSecret.toUpperCase()} />
          <Row label="Webhook secret" value={data.webhookSecret} />
          <Row label="TEST allowlist" value={allowlist} />
        </dl>
        {data.allowlistNames.length > 0 ? (
          <p className="mt-4 text-sm text-muted">
            Allowlisted hotels: {data.allowlistNames.join(", ")}
          </p>
        ) : null}
      </section>

      <section className="border border-line bg-surface p-5">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">
          Retired tier price env
        </h2>
        <dl className="mt-2">
          <Row label="BASIC" value={data.priceEnv.STRIPE_BASIC_PRICE_ID} />
          <Row label="PRO" value={data.priceEnv.STRIPE_PRO_PRICE_ID} />
          <Row label="PREMIUM" value={data.priceEnv.STRIPE_PREMIUM_PRICE_ID} />
        </dl>
        <p className="mt-4 text-sm text-muted">
          These environment prices are not the property-licence offer. Checkout uses the catalogue
          mapping only. This dashboard does not write Vercel env or Stripe.
        </p>
      </section>
    </div>
  );
}
