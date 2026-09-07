import { createFileRoute, Link } from "@tanstack/react-router";
import { getPublicBooking } from "@/lib/aether/booking-fns";
import { touristMessage } from "@/lib/aether/guest";
import { GuestHeader } from "@/components/aether/guest-header";
import { ThemeToggle } from "@/components/aether/theme-toggle";
import type { PublicBooking } from "@/lib/aether/booking";

export const Route = createFileRoute("/confirmed/$token")({
  pendingComponent: ConfirmLoading,
  loader: async ({ params }) => {
    return getPublicBooking({ data: { token: params.token } });
  },
  component: Confirmed,
});

function Confirmed() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return <MissingBooking message={result.message || touristMessage("not_found")} />;
  }
  return <ConfirmationCard booking={result.booking} />;
}

function ConfirmLoading() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 text-center text-ink">
      <p className="text-xs tracking-widest text-muted uppercase">Loading</p>
      <p className="mt-4 text-lg">Finding your booking…</p>
    </main>
  );
}

function MissingBooking({ message }: { message: string }) {
  return (
    <main className="flex min-h-dvh flex-col bg-canvas text-ink">
      <div className="flex justify-end px-5 py-4">
        <ThemeToggle />
      </div>
      <section className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
        <p className="text-xs tracking-widest text-muted uppercase">Aether Transfer</p>
        <h1 className="mt-6 max-w-sm text-3xl font-semibold tracking-tight">{message}</h1>
        <p className="mt-4 max-w-sm text-base leading-relaxed text-muted">
          Check the confirmation link. A booking reference on its own cannot open this page.
        </p>
      </section>
    </main>
  );
}

function ConfirmationCard({ booking }: { booking: PublicBooking }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <GuestHeader hotelName={booking.hotelName} />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-8">
        <p className="text-xs tracking-widest text-muted uppercase">
          {booking.cancelled ? "Cancelled" : "Confirmed"}
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Your transfer is booked</h1>
        <p className="mt-3 text-base leading-relaxed text-muted">
          Keep this page. The hotel can find you by the reference below.
        </p>
        <p className="mt-8 text-4xl font-semibold tracking-tight">{booking.humanReference}</p>
        <dl className="mt-8 divide-y divide-line border border-line">
          <Row label="Hotel" value={booking.hotelName} />
          <Row label="When" value={`${booking.transferDate} · ${booking.pickupTime}`} />
          <Row label="Duration" value={`${booking.durationMinutes} min`} />
          <Row label="Pickup" value={booking.pickupText} />
          <Row label="Destination" value={booking.destinationText} />
          <Row label="Party" value={`${booking.passengerCount} passengers · ${booking.luggageCount} bags`} />
          <Row label="Guest" value={booking.guestName} />
          <Row
            label="Price"
            value={booking.pricing.priced ? "Confirmed" : "To be confirmed"}
          />
        </dl>
        <Link
          to="/book/$hotelCode"
          params={{ hotelCode: booking.hotelCode }}
          className="mt-10 flex min-h-14 items-center justify-center border border-line text-base font-medium"
        >
          Back to hotel booking
        </Link>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <dt className="text-xs tracking-widest text-muted uppercase">{label}</dt>
      <dd className="text-right text-sm font-medium">{value}</dd>
    </div>
  );
}
