import { Link, createFileRoute } from "@tanstack/react-router";
import { getOwnerHotelFn } from "@/lib/aether/owner-fns";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/owner/hotels/$hotelId")({
  loader: async ({ params }) => {
    if (!UUID_RE.test(params.hotelId)) return { ok: false as const, code: "not_found" as const };
    return getOwnerHotelFn({ data: { hotelId: params.hotelId } });
  },
  component: OwnerHotelDetailPage,
});

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-t border-line py-3 sm:grid-cols-[10rem_1fr] sm:gap-6">
      <dt className="text-xs tracking-widest text-muted uppercase">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function OwnerHotelDetailPage() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">Hotel not found</h1>
        <p className="text-sm text-muted">
          No operator-owned hotel matches this id. Unowned demo properties are not SaaS customers.
        </p>
        <Link to="/owner/hotels" className="text-sm underline-offset-4 hover:underline">
          Back to hotels
        </Link>
      </div>
    );
  }
  const hotel = result.hotel;
  return (
    <div className="space-y-10">
      <header>
        <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Hotel</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{hotel.name}</h1>
        <p className="mt-2 text-sm text-muted">
          Read-only Owner visibility. This surface cannot impersonate the operator or force LIVE.
        </p>
      </header>

      <section className="border border-line bg-surface p-5">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">Identity</h2>
        <dl className="mt-2">
          <Row label="Code" value={hotel.code} />
          <Row label="Public slug" value={hotel.publicSlug || "—"} />
          <Row label="Status" value={hotel.status} />
          <Row label="Locality" value={hotel.locality} />
          <Row label="Timezone" value={hotel.timezone} />
          <Row label="Currency" value={hotel.currency} />
          <Row label="Created" value={hotel.createdAt} />
          <Row label="Services" value={String(hotel.services)} />
          <Row label="Destinations" value={String(hotel.destinations)} />
        </dl>
      </section>

      <section className="border border-line bg-surface p-5">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">Ownership</h2>
        <ul className="mt-4 divide-y divide-line">
          {hotel.owners.map((owner) => (
            <li key={owner.userId} className="py-3">
              <p className="text-sm font-medium">{owner.name}</p>
              <p className="text-xs text-muted">
                {owner.email} · {owner.ownedAt}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="border border-line bg-surface p-5">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">SBG SaaS billing</h2>
        <dl className="mt-2">
          <Row label="Status" value={hotel.billing.status ?? "none"} />
          <Row label="Entitled" value={hotel.billing.entitled ? "yes" : "no"} />
          <Row label="Customer" value={hotel.billing.stripeCustomerId ?? "—"} />
          <Row label="Subscription" value={hotel.billing.stripeSubscriptionId ?? "—"} />
          <Row label="Price id" value={hotel.billing.stripePriceId ?? "—"} />
          <Row label="Period end" value={hotel.billing.currentPeriodEnd ?? "—"} />
          <Row
            label="Cancel at period end"
            value={
              hotel.billing.cancelAtPeriodEnd == null
                ? "—"
                : hotel.billing.cancelAtPeriodEnd
                  ? "yes"
                  : "no"
            }
          />
        </dl>
      </section>

      <section className="border border-line bg-surface p-5">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">
          Guest payments · Domain B
        </h2>
        <p className="mt-3 text-sm text-muted">
          Connect state is hotel money infrastructure, not SBG revenue. Current state:{" "}
          <span className="text-ink">{hotel.connect.state}</span>
          {hotel.connect.livemode == null ? "" : hotel.connect.livemode ? " · live" : " · test"}.
        </p>
      </section>

      <section className="border border-line bg-surface p-5">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">
          Domain A events
        </h2>
        {hotel.recentEvents.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No billing events for this hotel.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {hotel.recentEvents.map((event) => (
              <li key={event.eventId} className="py-3 text-sm">
                <p>{event.eventType}</p>
                <p className="text-xs text-muted">
                  {event.outcome ?? "—"} · {event.at}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
