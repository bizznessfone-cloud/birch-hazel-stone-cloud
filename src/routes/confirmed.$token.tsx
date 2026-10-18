import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { getPublicBooking } from "@/lib/aether/booking-fns";
import { formatQuotedPrice, touristMessage } from "@/lib/aether/guest";
import {
  shouldPollGuestStatus,
  GUEST_STATUS_POLL_INTERVAL_MS,
  type PublicGuestBooking,
} from "@/lib/aether/public-booking-status";
import { GuestHeader } from "@/components/aether/guest-header";
import { ThemeToggle } from "@/components/aether/theme-toggle";
import { DefinitionRow, StatusChip } from "@/components/aether/ui";

export const Route = createFileRoute("/confirmed/$token")({
  pendingComponent: BookingStatusLoading,
  loader: async ({ params }) => {
    return getPublicBooking({ data: { token: params.token } });
  },
  component: BookingStatusPage,
});

function BookingStatusPage() {
  const result = Route.useLoaderData();
  const { token } = Route.useParams();
  if (!result.ok) {
    return <MissingBooking message={result.message || touristMessage("not_found")} />;
  }
  return <BookingStatusCard initial={result.booking} token={token} />;
}

function BookingStatusLoading() {
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
        <p className="text-xs tracking-widest text-muted uppercase">SCAN. BOOK. GO.</p>
        <h1 className="mt-6 max-w-sm text-3xl font-semibold tracking-tight">{message}</h1>
        <p className="mt-4 max-w-sm text-base leading-relaxed text-muted">
          Check the confirmation link. A booking reference on its own cannot open this page.
        </p>
      </section>
    </main>
  );
}

function priceLabel(booking: PublicGuestBooking): string {
  if (!booking.pricing.priced) return "Quoted by hotel";
  return formatQuotedPrice(booking.pricing.currency, booking.pricing.amountMinor);
}

function BookingStatusCard({ initial, token }: { initial: PublicGuestBooking; token: string }) {
  const [booking, setBooking] = useState(initial);
  const [polls, setPolls] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const status = booking.guestStatus;

  useEffect(() => {
    if (!shouldPollGuestStatus(status, polls)) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await getPublicBooking({ data: { token } });
      if (cancelled) return;
      if (result.ok) setBooking(result.booking);
      setPolls((count) => count + 1);
    }, GUEST_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [status, polls, token]);

  async function refresh() {
    setRefreshing(true);
    try {
      const result = await getPublicBooking({ data: { token } });
      if (result.ok) setBooking(result.booking);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <GuestHeader hotelName={booking.hotelName} />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-8">
        <StatusChip tone={status.tone}>{status.chip}</StatusChip>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">{status.heading}</h1>
        <p className="mt-3 text-base leading-relaxed text-muted">{status.detail}</p>
        {status.paymentNote ? (
          <p className="mt-3 text-base leading-relaxed text-muted">{status.paymentNote}</p>
        ) : null}
        <p className="mt-8 text-4xl font-semibold tracking-tight">{booking.humanReference}</p>
        <dl className="mt-8 divide-y divide-line border border-line bg-surface">
          <DefinitionRow label="Hotel" value={booking.hotelName} />
          <DefinitionRow label="When" value={`${booking.transferDate} · ${booking.pickupTime}`} />
          <DefinitionRow label="Pickup" value={booking.pickupText} />
          <DefinitionRow label="Destination" value={booking.destinationText} />
          <DefinitionRow
            label="Party"
            value={`${booking.passengerCount} passengers · ${booking.luggageCount} bags`}
          />
          <DefinitionRow label="Guest" value={booking.guestName} />
          <DefinitionRow label="Price" value={priceLabel(booking)} />
        </dl>
        <button
          type="button"
          className="mt-6 flex min-h-14 w-full items-center justify-center border border-line bg-surface text-base font-medium disabled:opacity-40"
          onClick={() => {
            void refresh();
          }}
          disabled={refreshing}
        >
          Refresh status
        </button>
        <Link
          to="/book/$hotelCode"
          params={{ hotelCode: booking.hotelCode }}
          className="mt-10 flex min-h-14 items-center justify-center border border-line bg-surface text-base font-medium"
        >
          Back to hotel booking
        </Link>
      </main>
    </div>
  );
}
