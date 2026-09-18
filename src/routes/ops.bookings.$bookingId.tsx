import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  opsAssignDriver,
  opsAssignVehicle,
  opsCancelBooking,
  opsSetBookingStatus,
  opsUnassignDriver,
  opsUnassignVehicle,
} from "@/lib/aether/inventory-fns";
import { opsGetBooking } from "@/lib/aether/ops-desk-fns";
import { csrfHeaders } from "@/lib/aether/csrf-client";
import { OpsButton, OpsNotice, OpsSecondary, opsInputClass } from "@/components/aether/ops-shell";
import { DefinitionRow, StatusChip } from "@/components/aether/ui";

export const Route = createFileRoute("/ops/bookings/$bookingId")({
  loader: ({ params }) => opsGetBooking({ data: { id: params.bookingId } }),
  component: BookingDetail,
});

function BookingDetail() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [status, setStatus] = useState(result.ok ? result.booking.status : "");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!result.ok) return <OpsNotice>{result.message}</OpsNotice>;
  const { booking, audit, vehicles, drivers } = result;

  async function run(label: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fn();
      if (!response.ok) {
        setMessage(response.message ?? "That change could not be saved.");
        return;
      }
      setMessage(label);
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  const headers = csrfHeaders();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs tracking-widest text-muted uppercase">{booking.hotelName}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{booking.humanReference}</h1>
        <p className="mt-2 text-sm text-muted">
          {booking.transferDate} · {booking.pickupTime} · {booking.durationMinutes} min
        </p>
        <div className="mt-3 flex flex-wrap gap-1">
          {booking.cancelled ? (
            <StatusChip tone="cancelled">Cancelled</StatusChip>
          ) : (
            <StatusChip>{booking.status}</StatusChip>
          )}
          {!booking.cancelled && !booking.vehicleId ? (
            <StatusChip tone="attention">No vehicle</StatusChip>
          ) : null}
          {!booking.cancelled && !booking.driverId ? (
            <StatusChip tone="attention">No driver</StatusChip>
          ) : null}
        </div>
      </div>
      {message ? <OpsNotice>{message}</OpsNotice> : null}
      <dl className="divide-y divide-line border border-line bg-surface">
        <DefinitionRow label="Guest" value={`${booking.guestName} · ${booking.guestPhone}`} />
        <DefinitionRow label="Email" value={booking.guestEmail} />
        <DefinitionRow label="Pickup" value={booking.pickupText} />
        <DefinitionRow label="Destination" value={booking.destinationText} />
        <DefinitionRow label="Party" value={`${booking.passengerCount} pax · ${booking.luggageCount} bags`} />
        <DefinitionRow label="Notes" value={booking.specialRequirements || "—"} />
        <DefinitionRow label="Internal" value={booking.internalNotes || "—"} />
      </dl>

      <section className="flex flex-col gap-3">
        <p className="text-xs tracking-widest text-muted uppercase">Vehicle</p>
        <p className="text-sm">{booking.vehicleName ?? "Unassigned"}</p>
        <select
          className={opsInputClass}
          disabled={busy || booking.cancelled}
          defaultValue=""
          onChange={(event) => {
            const vehicleId = event.target.value;
            event.target.value = "";
            if (!vehicleId) return;
            void run("Vehicle assigned.", () =>
              opsAssignVehicle({ data: { bookingId: booking.id, vehicleId }, headers }),
            );
          }}
        >
          <option value="">Assign vehicle</option>
          {vehicles
            .filter((item) => item.active)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.capacity}
              </option>
            ))}
        </select>
        {booking.vehicleId ? (
          <OpsSecondary
            type="button"
            disabled={busy || booking.cancelled}
            onClick={() =>
              void run("Vehicle unassigned.", () =>
                opsUnassignVehicle({ data: { bookingId: booking.id }, headers }),
              )
            }
          >
            Unassign vehicle
          </OpsSecondary>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <p className="text-xs tracking-widest text-muted uppercase">Driver</p>
        <p className="text-sm">{booking.driverName ?? "Unassigned"}</p>
        <select
          className={opsInputClass}
          disabled={busy || booking.cancelled}
          defaultValue=""
          onChange={(event) => {
            const driverId = event.target.value;
            event.target.value = "";
            if (!driverId) return;
            void run("Driver assigned.", () =>
              opsAssignDriver({ data: { bookingId: booking.id, driverId }, headers }),
            );
          }}
        >
          <option value="">Assign driver</option>
          {drivers
            .filter((item) => item.active)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
        {booking.driverId ? (
          <OpsSecondary
            type="button"
            disabled={busy || booking.cancelled}
            onClick={() =>
              void run("Driver unassigned.", () =>
                opsUnassignDriver({ data: { bookingId: booking.id }, headers }),
              )
            }
          >
            Unassign driver
          </OpsSecondary>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <p className="text-xs tracking-widest text-muted uppercase">Status</p>
        <input
          className={opsInputClass}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        />
        <OpsButton
          type="button"
          disabled={busy || !status.trim()}
          onClick={() =>
            void run("Status updated.", () =>
              opsSetBookingStatus({ data: { bookingId: booking.id, status }, headers }),
            )
          }
        >
          Save status
        </OpsButton>
        <OpsSecondary
          type="button"
          disabled={busy || booking.cancelled}
          onClick={() =>
            void run("Booking cancelled.", () =>
              opsCancelBooking({ data: { bookingId: booking.id }, headers }),
            )
          }
        >
          Cancel transfer
        </OpsSecondary>
      </section>

      <section>
        <p className="text-xs tracking-widest text-muted uppercase">Activity</p>
        {audit.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No events yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line border border-line bg-surface">
            {audit.map((event, index) => (
              <li key={`${event.at}-${index}`} className="px-4 py-3 text-sm">
                <p className="font-medium">{event.action}</p>
                <p className="text-muted">{event.actorType}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
