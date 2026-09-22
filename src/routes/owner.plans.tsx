import { createFileRoute } from "@tanstack/react-router";
import { getOwnerPlansFn } from "@/lib/aether/owner-fns";

export const Route = createFileRoute("/owner/plans")({
  loader: () => getOwnerPlansFn(),
  component: OwnerPlansPage,
});

function OwnerPlansPage() {
  const data = Route.useLoaderData();
  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Catalogue</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Plans & Pricing</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Canonical commercial catalogue management arrives in CP26C-O3. This page is structural
          only. Amounts are not invented here. Stripe Prices are not created here.
        </p>
      </header>

      <div className="grid gap-px bg-line md:grid-cols-3">
        {data.plans.map((plan) => (
          <article key={plan.code} className="bg-surface p-6">
            <p className="text-xs tracking-widest text-muted uppercase">{plan.code}</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">{plan.name}</h2>
            <p className="mt-6 text-sm text-muted">Amount · pending catalogue</p>
            <p className="mt-1 text-sm text-muted">
              {plan.interval} · {plan.currency}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
