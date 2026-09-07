import { Link, createFileRoute } from "@tanstack/react-router";
import { opsListBookings } from "@/lib/aether/ops-desk-fns";
import { OpsNotice } from "@/components/aether/ops-shell";

export const Route = createFileRoute("/ops/bookings/")({
  loader: () => opsListBookings(),
  component: BookingsList,
});

function BookingsList() {
  const result = Route.useLoaderData();
  if (!result.ok) return <OpsNotice>{result.message}</OpsNotice>;
  if (result.bookings.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Bookings</h1>
        <p className="mt-4 text-sm text-muted">No bookings yet.</p>
      </div>
    );
  }
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Bookings</h1>
      <ul className="mt-6 divide-y divide-line border border-line">
        {result.bookings.map((row) => (
          <li key={row.id}>
            <Link
              to="/ops/bookings/$bookingId"
              params={{ bookingId: row.id }}
              className="flex items-start justify-between gap-4 px-4 py-4"
            >
              <div>
                <p className="font-semibold">{row.humanReference}</p>
                <p className="mt-1 text-sm text-muted">
                  {row.transferDate} · {row.pickupTime} · {row.hotelName}
                </p>
                <p className="mt-1 text-xs tracking-widest uppercase">
                  {row.cancelled ? "Cancelled" : row.status}
                  {row.needsVehicle ? " · No vehicle" : ""}
                  {row.needsDriver ? " · No driver" : ""}
                </p>
              </div>
              <p className="text-sm">{row.guestName}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
