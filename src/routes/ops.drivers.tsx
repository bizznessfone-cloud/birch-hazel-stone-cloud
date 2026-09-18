import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { opsListDrivers, opsUpsertDriver } from "@/lib/aether/ops-desk-fns";
import { csrfHeaders } from "@/lib/aether/csrf-client";
import { OpsButton, OpsNotice, OpsSecondary, opsInputClass } from "@/components/aether/ops-shell";
import { EmptyState, PageHeader, StatusChip, compactButtonClass } from "@/components/aether/ui";

export const Route = createFileRoute("/ops/drivers")({
  loader: () => opsListDrivers(),
  component: DriversPage,
});

function DriversPage() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [active, setActive] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!result.ok) return <OpsNotice>{result.message}</OpsNotice>;

  function resetForm() {
    setEditingId(null);
    setName("");
    setActive(true);
  }

  async function save(input: { id?: string; name: string; active: boolean }) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await opsUpsertDriver({ data: input, headers: csrfHeaders() });
      if (!response.ok) {
        setMessage(response.message);
        return;
      }
      resetForm();
      setMessage("Driver saved.");
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Drivers" lead="Drivers available for assignment. Overlapping times cannot be assigned." />
      {message ? <OpsNotice>{message}</OpsNotice> : null}
      {result.drivers.length === 0 ? (
        <EmptyState title="No drivers yet." />
      ) : (
        <ul className="divide-y divide-line border border-line bg-surface">
          {result.drivers.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-medium">{item.name}</p>
                <div className="mt-2">
                  <StatusChip tone={item.active ? "neutral" : "cancelled"}>
                    {item.active ? "Active" : "Inactive"}
                  </StatusChip>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={compactButtonClass}
                  disabled={busy}
                  onClick={() => {
                    setEditingId(item.id);
                    setName(item.name);
                    setActive(item.active);
                    setMessage(null);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={compactButtonClass}
                  disabled={busy}
                  onClick={() => void save({ id: item.id, name: item.name, active: !item.active })}
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
          void save({ id: editingId ?? undefined, name, active });
        }}
      >
        <p className="text-xs tracking-widest text-muted uppercase">
          {editingId ? "Edit driver" : "Add driver"}
        </p>
        <input
          className={opsInputClass}
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <OpsButton type="submit" disabled={busy || !name.trim()}>
          Save driver
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
