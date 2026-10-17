import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { readFoundingOnboardingStateFn } from "@/lib/aether/founding-onboarding-fns";
import { checkOperatorWorkspacePropertyFn } from "@/lib/aether/operator-workspace-fns";

export const Route = createFileRoute("/app/operator")({
  loader: async () => {
    const state = await readFoundingOnboardingStateFn();
    if (state.status !== "ready" || state.organisationType !== "transfer_operator") {
      throw redirect({ to: "/app/founding" });
    }
    return { eligible: true as const };
  },
  component: OperatorWorkspace,
});

function OperatorWorkspace() {
  const [hotelId, setHotelId] = useState("");
  const [result, setResult] = useState<"granted" | "denied" | "unavailable" | null>(null);
  const [busy, setBusy] = useState(false);
  async function check(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const access = await checkOperatorWorkspacePropertyFn({ data: { hotelId: hotelId.trim() } });
      setResult(access.allowed ? "granted" : "denied");
    } catch {
      setResult("unavailable");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto max-w-lg">
      <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Independent transfer operator</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">Operator workspace</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        Activation is pending. You can check whether a hotel has explicitly granted your business property access.
        This check does not authorise bookings, payments or operations.
      </p>
      <form className="mt-8 space-y-4" onSubmit={(event) => void check(event)}>
        <label className="block text-sm font-medium" htmlFor="operator-hotel-id">Hotel identifier</label>
        <input id="operator-hotel-id" value={hotelId} onChange={(event) => { setHotelId(event.target.value); setResult(null); }}
          required placeholder="Hotel UUID" className="min-h-12 w-full border border-line bg-transparent px-3" />
        <button type="submit" disabled={busy || !hotelId.trim()}
          className="min-h-12 w-full bg-ink px-4 text-sm font-semibold text-canvas disabled:opacity-50">
          {busy ? "Checking…" : "Check property access"}
        </button>
      </form>
      {result && <p role="status" className="mt-5 text-sm">
        {result === "granted" ? "Property grant verified. Booking access and operator activation remain unavailable."
          : result === "denied" ? "Property access is not authorised for this account."
          : "Unable to verify property access. No permissions have changed."}
      </p>}
    </section>
  );
}
