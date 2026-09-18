import { createFileRoute } from "@tanstack/react-router";
import { getPublicHotel } from "@/lib/aether/booking-fns";
import { touristMessage } from "@/lib/aether/guest";
import { GuestBook } from "@/components/aether/guest-book";
import { ThemeToggle } from "@/components/aether/theme-toggle";

export const Route = createFileRoute("/book/$hotelCode")({
  pendingComponent: HotelLoading,
  loader: async ({ params }) => {
    return getPublicHotel({ data: { hotelCode: params.hotelCode } });
  },
  component: BookHotel,
});

function BookHotel() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return <UnknownHotel message={result.message || touristMessage("hotel_not_found")} />;
  }
  return (
    <GuestBook
      hotelCode={result.hotel.code}
      hotelName={result.hotel.name}
      currency={result.hotel.currency}
      destinations={result.hotel.destinations}
    />
  );
}

function HotelLoading() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 text-center text-ink">
      <p className="text-xs tracking-widest text-muted uppercase">Loading</p>
      <p className="mt-4 text-lg">Preparing this hotel booking page…</p>
    </main>
  );
}

function UnknownHotel({ message }: { message: string }) {
  return (
    <main className="flex min-h-dvh flex-col bg-canvas text-ink">
      <div className="flex justify-end px-5 py-4">
        <ThemeToggle />
      </div>
      <section className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
        <p className="text-xs tracking-widest text-muted uppercase">SCAN. BOOK. GO.</p>
        <h1 className="mt-6 max-w-sm text-3xl font-semibold tracking-tight">{message}</h1>
        <p className="mt-4 max-w-sm text-base leading-relaxed text-muted">
          Please ask reception for the correct booking link.
        </p>
      </section>
    </main>
  );
}
