import { createFileRoute, Link } from "@tanstack/react-router";
import { getOnboardingState } from "@/lib/aether/onboarding-fns";
import { GuestBook } from "@/components/aether/guest-book";

export const Route = createFileRoute("/app/hotels/$hotelId/preview")({
  loader: () => getOnboardingState(),
  component: Preview,
});

function Preview() {
  const result = Route.useLoaderData();
  const { hotelId } = Route.useParams();

  if (!result.ok) return <p className="text-sm text-muted">{result.message}</p>;
  const item = result.hotels.find((entry) => entry.hotel.id === hotelId);
  if (!item) return <p className="text-sm text-muted">Hotel not found.</p>;
  if (!item.services[0] || !item.destinations[0]) {
    return (
      <div className="mx-auto max-w-xl space-y-4 px-6 py-10">
        <h1 className="text-2xl font-semibold">Preview is not ready</h1>
        <p className="text-sm text-muted">Add the first transfer service and destination before previewing the guest experience.</p>
        <Link to="/app/onboarding" className="text-sm underline underline-offset-4">Back to setup</Link>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-canvas">
      <div className="sticky top-0 z-10 border-b border-line bg-canvas/95 px-5 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between gap-4">
          <p className="text-xs font-semibold tracking-[0.18em] uppercase">Preview</p>
          <Link to="/app/hotels/$hotelId" params={{ hotelId }} className="text-xs font-medium underline underline-offset-4">
            Back to workspace
          </Link>
        </div>
      </div>
      <GuestBook
        hotelCode={item.hotel.code}
        hotelName={item.hotel.name}
        currency={item.hotel.currency}
        destinations={item.destinations.map((destination) => ({
          id: destination.id,
          kind: destination.kind as "airport" | "port" | "hotel" | "other",
          name: destination.name,
          amountMinor: Number(destination.amount_minor),
          sortOrder: 0,
        }))}
        preview
      />
    </div>
  );
}
