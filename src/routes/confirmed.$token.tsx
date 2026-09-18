import { createFileRoute, Link } from "@tanstack/react-router";
import { getPublicBooking } from "@/lib/aether/booking-fns";
import { startGuestPayment } from "@/lib/aether/guest-payment-fns";
import { formatQuotedPrice, touristMessage } from "@/lib/aether/guest";
import { GuestHeader } from "@/components/aether/guest-header";
import { ThemeToggle } from "@/components/aether/theme-toggle";
import type { PublicBooking } from "@/lib/aether/booking";
import type { ConfirmationEmailStatus } from "@/lib/aether/confirmation-email";

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
        <p className="text-xs tracking-widest text-muted uppercase">SCAN / BOOK / GO</p>
        <h1 className="mt-6 max-w-sm text-3xl font-semibold tracking-tight">{message}</h1>
        <p className="mt-4 max-w-sm text-base leading-relaxed text-muted">
          Check the confirmation link. A booking reference on its own cannot open this page.
        </p>
      </section>
    </main>
  );
}

function priceLabel(booking: PublicBooking): string {
  if (!booking.pricing.priced) return "To be confirmed";
  return formatQuotedPrice(booking.pricing.currency, booking.pricing.amountMinor);
}

function emailStatusLabel(status: ConfirmationEmailStatus | undefined): string {
  if (status === "sent") return "Confirmation email sent";
  if (status === "not_configured") return "Confirmation email will be enabled when email delivery is configured";
  if (status === "failed") return "Your booking is confirmed. We could not send the confirmation email, so keep this page and your booking reference.";
  return "Keep this page and your booking reference.";
}

function ConfirmationCard({
  booking,
}: {
  booking: PublicBooking & { confirmationEmailStatus?: ConfirmationEmailStatus };
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <GuestHeader hotelName={booking.hotelName} />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-8">
        <p className="text-xs tracking-widest text-muted uppercase">
          {booking.cancelled ? "Cancelled" : "Confirmed"}
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Your transfer is booked</h1>
        <p className="mt-3 text-base leading-relaxed text-muted">
          {emailStatusLabel(booking.confirmationEmailStatus)}
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
          <Row label="Price" value={priceLabel(booking)} />
        </dl>
        {!booking.cancelled && booking.pricing.priced && booking.pricing.amountMinor > 0 ? (
          <button
            type="button"
            className="mt-6 flex min-h-14 w-full items-center justify-center bg-ink text-base font-semibold tracking-wide text-canvas uppercase disabled:opacity-40"
            onClick={async () => {
              try {
                const result = await startGuestPayment({ data: { token: window.location.pathname.split("/").pop() ?? "" } });
                if (result.status === "paid") return;
                if (result.url) window.location.assign(result.url);
              } catch {
                window.alert("Payment could not be started. Please try again.");
              }
            }}
          >
            Pay for transfer
          </button>
        ) : null}
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
