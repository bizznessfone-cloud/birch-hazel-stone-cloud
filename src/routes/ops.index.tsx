import { Link, createFileRoute } from "@tanstack/react-router";
import { opsTodayBoard } from "@/lib/aether/ops-desk-fns";
import { OpsNotice } from "@/components/aether/ops-shell";
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
      <div>
        <p className="text-xs tracking-widest text-muted uppercase">Athens today</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{board.athensDate}</h1>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Attention label="No vehicle" value={board.attention.unassignedVehicle} />
        <Attention label="No driver" value={board.attention.unassignedDriver} />
        <Attention label="Cancelled" value={board.attention.cancelled} />
      </div>
      <section>
        <p className="text-xs tracking-widest text-muted uppercase">Next transfer</p>
        {board.next ? <BookingLine row={board.next} /> : <p className="mt-2 text-sm text-muted">No remaining transfers today.</p>}
      </section>
      <section>
        <p className="text-xs tracking-widest text-muted uppercase">Feed</p>
        {board.feed.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No transfers on the board today.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line border border-line">
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
    <div className={`border px-3 py-3 ${value > 0 ? "border-ink" : "border-line"}`}>
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
        <p className="text-sm">{row.humanReference} · {row.hotelName}</p>
        <p className="mt-1 text-sm text-muted">
          {row.pickupText} → {row.destinationText}
        </p>
        <p className="mt-2 text-xs tracking-widest uppercase">
          {row.cancelled ? "Cancelled" : null}
          {row.needsVehicle ? " No vehicle" : null}
          {row.needsDriver ? " No driver" : null}
        </p>
      </div>
      <p className="text-sm text-muted">{row.guestName}</p>
    </Link>
  );
}
