import { createFileRoute, Link } from "@tanstack/react-router";
import { getOnboardingState } from "@/lib/aether/onboarding-fns";
import { QrCodeCard } from "@/components/aether/qr-code-card";

export const Route = createFileRoute("/app/hotels/$hotelId/qr")({
  loader: () => getOnboardingState(),
  component: HotelQr,
});

function HotelQr() {
  const result = Route.useLoaderData();
  const { hotelId } = Route.useParams();

  if (!result.ok) return <p className="text-sm text-muted">{result.message}</p>;
  const item = result.hotels.find((entry) => entry.hotel.id === hotelId);
  if (!item) return <p className="text-sm text-muted">Hotel not found.</p>;

  const bookingUrl =
    typeof window === "undefined"
      ? "/book/" + item.hotel.code
      : window.location.origin + "/book/" + item.hotel.code;

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div className="print:hidden">
        <Link
          to="/app/hotels/$hotelId"
          params={{ hotelId }}
          className="text-xs font-medium underline underline-offset-4"
        >
          ← Back to workspace
        </Link>
      </div>
      <QrCodeCard hotelName={item.hotel.name} bookingUrl={bookingUrl} />
    </div>
  );
}
