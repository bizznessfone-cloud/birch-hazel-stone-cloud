import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { getOnboardingState } from "@/lib/aether/onboarding-fns";

export const Route = createFileRoute("/app/hotels/$hotelId")({
  loader: () => getOnboardingState(),
  component: HotelWorkspace,
});

function HotelWorkspace() {
  const result = Route.useLoaderData();
  const { hotelId } = Route.useParams();
  const [copied, setCopied] = useState(false);

  if (!result.ok) return <p className="text-sm text-muted">{result.message}</p>;
  const item = result.hotels.find((entry) => entry.hotel.id === hotelId);
  if (!item) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">Hotel not found.</p>
        <Link to="/app/onboarding" className="text-sm underline underline-offset-4">Back to setup</Link>
      </div>
    );
  }

  const hotel = item.hotel;
  const service = item.services[0];
  const destination = item.destinations[0];
  const bookingUrl =
    typeof window === "undefined"
      ? "/book/" + hotel.code
      : window.location.origin + "/book/" + hotel.code;

  async function copyBookingUrl() {
    await navigator.clipboard.writeText(bookingUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Hotel workspace</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">{hotel.name}</h1>
          <p className="mt-2 text-sm text-muted">{hotel.locality} · {hotel.iana_timezone} · {hotel.currency}</p>
        </div>
        <span className="border border-line px-3 py-2 text-xs font-medium tracking-widest uppercase">{hotel.status}</span>
      </div>

      <section className="border border-line bg-surface p-5">
        <p className="text-xs font-medium tracking-widest text-muted uppercase">Guest page / QR destination</p>
        <p className="mt-2 break-all text-sm font-medium">{bookingUrl}</p>
        <p className="mt-2 text-sm text-muted">This is the current QR-ready guest address. The human-readable hotel slug is handled later in CP23.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={() => void copyBookingUrl()} className="min-h-11 border border-line px-4 text-sm font-semibold tracking-wide uppercase">
            {copied ? "Copied" : "Copy URL"}
          </button>
          {hotel.status === "configured" || hotel.status === "live" ? (
            <a href={"/book/" + hotel.code} target="_blank" rel="noreferrer" className="min-h-11 bg-ink px-4 py-3 text-sm font-semibold tracking-wide text-canvas uppercase">
              Preview guest page
            </a>
          ) : null}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <article className="border border-line bg-surface p-5">
          <p className="text-xs font-medium tracking-widest text-muted uppercase">Service</p>
          <h2 className="mt-2 text-xl font-semibold">{service?.name ?? "Not configured"}</h2>
          <p className="mt-2 text-sm text-muted">{service ? "Transfer service enabled" : "Add the first service to continue."}</p>
        </article>
        <article className="border border-line bg-surface p-5">
          <p className="text-xs font-medium tracking-widest text-muted uppercase">Destination</p>
          <h2 className="mt-2 text-xl font-semibold">{destination?.name ?? "Not configured"}</h2>
          <p className="mt-2 text-sm text-muted">{destination ? hotel.currency + " " + (Number(destination.amount_minor) / 100).toFixed(2) : "Add a destination and price to continue."}</p>
        </article>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link to="/app/onboarding" className="min-h-12 border border-line px-4 py-3 text-sm font-semibold tracking-wide uppercase">Setup</Link>
      </div>
    </div>
  );
}
