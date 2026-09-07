import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { opsListVehicles, opsUpsertVehicle } from "@/lib/aether/ops-desk-fns";
import { csrfHeaders } from "@/lib/aether/csrf-client";
import { OpsButton, OpsNotice, OpsSecondary, opsInputClass } from "@/components/aether/ops-shell";

export const Route = createFileRoute("/ops/vehicles")({
  loader: () => opsListVehicles(),
  component: VehiclesPage,
});

function VehiclesPage() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState(4);
  const [active, setActive] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!result.ok) return <OpsNotice>{result.message}</OpsNotice>;

  function resetForm() {
    setEditingId(null);
    setName("");
    setCapacity(4);
    setActive(true);
  }

  async function save(input: { id?: string; name: string; capacity: number; active: boolean }) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await opsUpsertVehicle({ data: input, headers: csrfHeaders() });
      if (!response.ok) {
        setMessage(response.message);
        return;
      }
      resetForm();
      setMessage("Vehicle saved.");
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Vehicles</h1>
      {message ? <OpsNotice>{message}</OpsNotice> : null}
      {result.vehicles.length === 0 ? (
        <p className="text-sm text-muted">No vehicles yet.</p>
      ) : (
        <ul className="divide-y divide-line border border-line">
          {result.vehicles.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-medium">{item.name}</p>
                <p className="text-sm text-muted">
                  {item.capacity} seats · {item.active ? "Active" : "Inactive"}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="min-h-11 border border-line px-3 text-sm"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(item.id);
                    setName(item.name);
                    setCapacity(item.capacity);
                    setActive(item.active);
                    setMessage(null);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="min-h-11 border border-line px-3 text-sm"
                  disabled={busy}
                  onClick={() =>
                    void save({
                      id: item.id,
                      name: item.name,
                      capacity: item.capacity,
                      active: !item.active,
                    })
                  }
                >
                  {item.active ? "Deactivate" : "Activate"}
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
          void save({
            id: editingId ?? undefined,
            name,
            capacity,
            active,
          });
        }}
      >
        <p className="text-xs tracking-widest text-muted uppercase">
          {editingId ? "Edit vehicle" : "Add vehicle"}
        </p>
        <input className={opsInputClass} placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <label className="block">
          <span className="mb-2 block text-xs tracking-widest text-muted uppercase">Seats</span>
          <input
            className={opsInputClass}
            type="number"
            min={1}
            max={20}
            value={capacity}
            onChange={(event) => setCapacity(Number(event.target.value))}
          />
        </label>
        <OpsButton type="submit" disabled={busy || !name.trim()}>
          Save vehicle
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
