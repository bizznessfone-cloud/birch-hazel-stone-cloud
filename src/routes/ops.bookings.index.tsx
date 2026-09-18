import { Link, createFileRoute } from "@tanstack/react-router";
import { opsListBookings } from "@/lib/aether/ops-desk-fns";
import { OpsNotice } from "@/components/aether/ops-shell";
import { EmptyState, PageHeader, StatusChip } from "@/components/aether/ui";

export const Route = createFileRoute("/ops/bookings/")({
  loader: () => opsListBookings(),
  component: BookingsList,
});

function BookingsList() {
  const result = Route.useLoaderData();
  if (!result.ok) return <OpsNotice>{result.message}</OpsNotice>;
  return (
    <div>
      <PageHeader
        title="Bookings"
        lead="Guest transfers for this desk. Open a booking to assign a vehicle or driver."
      />
      {result.bookings.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No bookings yet." note="Guest bookings from the hotel page will appear here." />
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-line border border-line bg-surface">
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
                  <div className="mt-2 flex flex-wrap gap-1">
                    {row.cancelled ? (
                      <StatusChip tone="cancelled">Cancelled</StatusChip>
                    ) : (
                      <StatusChip>{row.status}</StatusChip>
                    )}
                    {row.needsVehicle ? <StatusChip tone="attention">No vehicle</StatusChip> : null}
                    {row.needsDriver ? <StatusChip tone="attention">No driver</StatusChip> : null}
                  </div>
                </div>
                <p className="text-sm">{row.guestName}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
