import { Link, createFileRoute } from "@tanstack/react-router";
import { opsTodayBoard } from "@/lib/aether/ops-desk-fns";
import { OpsNotice } from "@/components/aether/ops-shell";
import { EmptyState, PageHeader, StatusChip } from "@/components/aether/ui";
import type { OpsBookingRow } from "@/lib/aether/ops-desk";

export const Route = createFileRoute("/ops/")({
  loader: () => opsTodayBoard(),
  component: TodayBoard,
});

function TodayBoard() {
  const result = Route.useLoaderData();
  if (!result.ok) return <OpsNotice>{result.message}</OpsNotice>;
  const { board } = result;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Today" title={board.boardDate} lead="Transfers scheduled for this hotel’s local date." />
      <div className="grid grid-cols-3 gap-2">
        <Attention label="No vehicle" value={board.attention.unassignedVehicle} />
        <Attention label="No driver" value={board.attention.unassignedDriver} />
        <Attention label="Cancelled" value={board.attention.cancelled} />
      </div>
      <section>
        <p className="text-xs tracking-widest text-muted uppercase">Next transfer</p>
        {board.next ? (
          <div className="mt-2 border border-line bg-surface">
            <BookingLine row={board.next} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No remaining transfers today.</p>
        )}
      </section>
      <section>
        <p className="text-xs tracking-widest text-muted uppercase">Feed</p>
        {board.feed.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No transfers on the board today." note="New bookings will appear here." />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-line border border-line bg-surface">
            {board.feed.map((row) => (
              <li key={row.id}>
                <BookingLine row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Attention({ label, value }: { label: string; value: number }) {
  return (
    <div className={`border bg-surface px-3 py-3 ${value > 0 ? "border-ink" : "border-line"}`}>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs tracking-widest text-muted uppercase">{label}</p>
    </div>
  );
}

function BookingLine({ row }: { row: OpsBookingRow }) {
  return (
    <Link
      to="/ops/bookings/$bookingId"
      params={{ bookingId: row.id }}
      className="flex items-start justify-between gap-4 px-4 py-4"
    >
      <div>
        <p className="text-lg font-semibold tabular-nums">{row.pickupTime}</p>
        <p className="text-sm">
          {row.humanReference} · {row.hotelName}
        </p>
        <p className="mt-1 text-sm text-muted">
          {row.pickupText} → {row.destinationText}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {row.cancelled ? <StatusChip tone="cancelled">Cancelled</StatusChip> : null}
          {row.needsVehicle ? <StatusChip tone="attention">No vehicle</StatusChip> : null}
          {row.needsDriver ? <StatusChip tone="attention">No driver</StatusChip> : null}
        </div>
      </div>
      <p className="text-sm text-muted">{row.guestName}</p>
    </Link>
  );
}
