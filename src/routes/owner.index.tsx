import { Link, createFileRoute } from "@tanstack/react-router";
import { getOwnerOverviewFn } from "@/lib/aether/owner-fns";
import { Metric, Panel } from "@/components/aether/owner-shell";

export const Route = createFileRoute("/owner/")({
  loader: () => getOwnerOverviewFn(),
  component: OwnerOverviewPage,
});

function pct(value: number | null): string {
  return value == null ? "—" : `${value}%`;
}

function OwnerOverviewPage() {
  const data = Route.useLoaderData();
  const funnel: Array<{ label: string; value: number; rate?: number | null }> = [
    { label: "Account", value: data.funnel.account },
    { label: "Hotel created", value: data.funnel.hotelCreated, rate: data.funnel.rates.hotelFromAccount },
    { label: "Configured", value: data.funnel.configured, rate: data.funnel.rates.configuredFromHotel },
    { label: "Subscribed", value: data.funnel.subscribed, rate: data.funnel.rates.subscribedFromConfigured },
    { label: "Live", value: data.funnel.live, rate: data.funnel.rates.liveFromSubscribed },
  ];

  return (
    <div className="space-y-10">
      <header>
        <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Owner</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">SCAN BOOK GO</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Business cockpit for Domain A — hotel operators paying SCAN BOOK GO.
          Guest transfer payments are hotel money and are not shown here.
        </p>
      </header>

      <section>
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">Signup funnel</h2>
        <ol className="mt-4 grid gap-px bg-line sm:grid-cols-5">
          {funnel.map((stage) => (
            <li key={stage.label} className="bg-surface px-4 py-5">
              <p className="text-xs tracking-widest text-muted uppercase">{stage.label}</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums">{stage.value}</p>
              {stage.rate === undefined ? (
                <p className="mt-1 text-xs text-muted">Operators with a hotel</p>
              ) : (
                <p className="mt-1 text-xs text-muted tabular-nums">{pct(stage.rate)} of previous</p>
              )}
            </li>
          ))}
        </ol>
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Panel title="SBG SaaS">
          <div className="grid grid-cols-2 gap-x-8">
            <Metric label="Operator accounts" value={data.operatorAccounts} />
            <Metric label="SaaS hotels" value={data.saasHotels} />
            <Metric label="Signups · 7 days" value={data.signups7d} />
            <Metric label="Signups · 30 days" value={data.signups30d} />
            <Metric label="Unconfigured" value={data.unconfigured} />
            <Metric label="Configured" value={data.configured} />
            <Metric label="Live" value={data.live} />
            <Metric label="Subscribed" value={data.subscribed} />
          </div>
        </Panel>
        <Panel title="Subscriptions">
          <div className="grid grid-cols-2 gap-x-8">
            <Metric label="Active" value={data.activeSubscriptions} />
            <Metric label="Trialing" value={data.trialingSubscriptions} />
            <Metric label="Past due" value={data.pastDueSubscriptions} />
            <Metric label="Cancelled" value={data.canceledSubscriptions} />
            <Metric label="Incomplete" value={data.incompleteSubscriptions} />
            <Metric label="By plan" value="Pending catalogue" />
            <Metric label="MRR" value="Pending catalogue" />
            <Metric label="ARR" value="Pending catalogue" />
          </div>
        </Panel>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <Panel title="Needs attention">
          {data.attention.length === 0 ? (
            <p className="text-sm text-muted">Nothing requiring attention.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.attention.map((item) => (
                <li key={`${item.kind}-${item.hotelId}`} className="py-3">
                  <Link
                    to="/owner/hotels/$hotelId"
                    params={{ hotelId: item.hotelId }}
                    className="text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {item.hotelName}
                  </Link>
                  <p className="text-xs text-muted">
                    {item.hotelCode} · {item.detail}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Recent signups">
          {data.recentSignups.length === 0 ? (
            <p className="text-sm text-muted">No operator hotels yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.recentSignups.map((row) => (
                <li key={`${row.userId}-${row.hotelId}`} className="py-3">
                  <p className="text-sm font-medium">{row.name}</p>
                  <p className="text-xs text-muted">
                    {row.email} · {row.hotelName}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Recent subscription events">
        {data.recentEvents.length === 0 ? (
          <p className="text-sm text-muted">No Domain A billing events yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs tracking-widest text-muted uppercase">
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Hotel</th>
                  <th className="py-2 pr-4 font-medium">Outcome</th>
                  <th className="py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {data.recentEvents.map((event) => (
                  <tr key={event.eventId} className="border-b border-line">
                    <td className="py-2 pr-4">{event.eventType}</td>
                    <td className="py-2 pr-4">{event.hotelName ?? "—"}</td>
                    <td className="py-2 pr-4">{event.outcome ?? "—"}</td>
                    <td className="py-2 text-muted tabular-nums">{event.at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
