import { createFileRoute } from "@tanstack/react-router";
import { getOwnerRevenueFn } from "@/lib/aether/owner-fns";
import { Metric, Panel } from "@/components/aether/owner-shell";

export const Route = createFileRoute("/owner/revenue")({
  loader: () => getOwnerRevenueFn(),
  component: OwnerRevenuePage,
});

function OwnerRevenuePage() {
  const data = Route.useLoaderData();
  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">{data.caption}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Revenue</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Domain A subscription counts only. Guest transfer payment volume is hotel money and is
          never SBG SaaS revenue. MRR and ARR wait for the CP26C-O3 catalogue.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-2">
        <Panel title="SBG SaaS subscriptions">
          <div className="grid grid-cols-2 gap-x-8">
            <Metric label="Entitled" value={data.entitled} />
            <Metric label="Active" value={data.active} />
            <Metric label="Trialing" value={data.trialing} />
            <Metric label="Past due" value={data.pastDue} />
            <Metric label="Cancelled" value={data.canceled} />
            <Metric label="Incomplete" value={data.incomplete} />
            <Metric label="Unpaid" value={data.unpaid} />
            <Metric label="Paused" value={data.paused} />
          </div>
        </Panel>
        <Panel title="Money metrics">
          <div className="grid grid-cols-2 gap-x-8">
            <Metric label="MRR" value="Pending catalogue" />
            <Metric label="ARR" value="Pending catalogue" />
            <Metric label="New entitled · 30d" value={data.newEntitled30d} />
            <Metric label="Cancelled · 30d" value={data.canceled30d} />
          </div>
        </Panel>
      </div>

      <Panel title="Recent Domain A lifecycle">
        {data.recent.length === 0 ? (
          <p className="text-sm text-muted">No subscription ledger rows yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs tracking-widest text-muted uppercase">
                  <th className="py-2 pr-4 font-medium">Hotel</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((row) => (
                  <tr key={row.hotelId} className="border-b border-line">
                    <td className="py-2 pr-4">
                      {row.hotelName}
                      <span className="text-muted"> · {row.hotelCode}</span>
                    </td>
                    <td className="py-2 pr-4">{row.status}</td>
                    <td className="py-2 text-muted tabular-nums">{row.updatedAt}</td>
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
