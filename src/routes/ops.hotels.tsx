import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { opsListHotels, opsUpsertHotel } from "@/lib/aether/ops-desk-fns";
import { csrfHeaders } from "@/lib/aether/csrf-client";
import { HotelMark } from "@/components/aether/hotel-mark";
import { OpsButton, OpsNotice, OpsSecondary, opsInputClass } from "@/components/aether/ops-shell";
import { EmptyState, PageHeader, compactButtonClass } from "@/components/aether/ui";

export const Route = createFileRoute("/ops/hotels")({
  loader: () => opsListHotels(),
  component: HotelsPage,
});

function HotelsPage() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  if (!result.ok) return <OpsNotice>{result.message}</OpsNotice>;

  function resetForm() {
    setEditingId(null);
    setName("");
    setCode("");
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await opsUpsertHotel({
        data: { id: editingId, name, code },
        headers: csrfHeaders(),
      });
      if (!response.ok) {
        setMessage(response.message);
        return;
      }
      resetForm();
      setMessage("Hotel saved.");
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  async function copyBookingUrl(bookingPath: string) {
    const absolute = `${window.location.origin}${bookingPath}`;
    await navigator.clipboard.writeText(absolute);
    setCopied(bookingPath);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Hotels"
        lead="Each hotel has a name, a booking code, and a guest booking page. Copy the URL for the reception QR."
      />
      {message ? <OpsNotice>{message}</OpsNotice> : null}
      {result.hotels.length === 0 ? (
        <EmptyState title="No hotels yet." />
      ) : (
        <ul className="flex flex-col gap-3">
          {result.hotels.map((item) => (
            <li key={item.id} className="border border-line bg-surface px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <HotelMark name={item.name} size="sm" />
                  <div className="min-w-0">
                    <p className="font-medium">{item.name}</p>
                    <p className="text-xs tracking-widest text-muted uppercase">{item.code}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={compactButtonClass}
                  disabled={busy}
                  onClick={() => {
                    setEditingId(item.id);
                    setName(item.name);
                    setCode(item.code);
                    setMessage(null);
                  }}
                >
                  Edit
                </button>
              </div>
              <p className="mt-4 text-xs tracking-widest text-muted uppercase">QR-ready booking URL</p>
              <p className="mt-1 font-medium">{item.bookingPath}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  to="/book/$hotelCode"
                  params={{ hotelCode: item.code }}
                  className={compactButtonClass}
                >
                  Open booking page
                </Link>
                <button
                  type="button"
                  className={compactButtonClass}
                  onClick={() => void copyBookingUrl(item.bookingPath)}
                >
                  {copied === item.bookingPath ? "Copied" : "Copy URL"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-xs tracking-widest text-muted uppercase">
          {editingId ? "Edit hotel" : "Add hotel"}
        </p>
        <input
          className={opsInputClass}
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className={opsInputClass}
          placeholder="Booking code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <OpsButton type="submit" disabled={busy || !name.trim() || !code.trim()}>
          Save hotel
        </OpsButton>
        {editingId ? (
          <OpsSecondary type="button" disabled={busy} onClick={resetForm}>
            Cancel edit
          </OpsSecondary>
        ) : null}
      </form>
    </div>
  );
}
