import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import {
  attachHotelRecoveryFn,
  classifyHotelRecoveryFn,
  readHotelRecoveryFn,
  submitHotelRecoveryNameFn,
} from "@/lib/aether/hotel-recovery-fns";
import type { HotelRecoveryView } from "@/lib/aether/hotel-recovery";
import { getOnboardingState } from "@/lib/aether/onboarding-fns";

export const Route = createFileRoute("/app/hotels/$hotelId")({
  loader: async ({ params }) => {
    const result = await getOnboardingState();
    if (!result.ok || !result.hotels.some((entry) => entry.hotel.id === params.hotelId)) {
      return { result, recovery: null as HotelRecoveryView | null };
    }
    try {
      const recovery = await readHotelRecoveryFn({ data: { hotelId: params.hotelId } });
      return { result, recovery };
    } catch {
      return { result, recovery: null };
    }
  },
  component: HotelWorkspace,
});

function HotelWorkspace() {
  const { result, recovery } = Route.useLoaderData();
  const { hotelId } = Route.useParams();
  const [copied, setCopied] = useState(false);

  if (!result.ok) return <p className="text-sm text-muted">{result.message}</p>;
  const item = result.hotels.find((entry) => entry.hotel.id === hotelId);
  if (!item) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">Hotel not found.</p>
        <Link to="/app/onboarding" className="text-sm underline underline-offset-4">Back to setup</Link>
      </div>
    );
  }

  const hotel = item.hotel;
  const service = item.services[0];
  const destination = item.destinations[0];
  const bookingUrl =
    typeof window === "undefined"
      ? "/" + hotel.public_slug
      : window.location.origin + "/" + hotel.public_slug;

  async function copyBookingUrl() {
    await navigator.clipboard.writeText(bookingUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Hotel workspace</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">{hotel.name}</h1>
          <p className="mt-2 text-sm text-muted">{hotel.locality} · {hotel.iana_timezone} · {hotel.currency}</p>
        </div>
        <span className="border border-line px-3 py-2 text-xs font-medium tracking-widest uppercase">{hotel.status}</span>
      </div>

      {recovery && recovery.kind !== "attached" ? (
        <PropertyRecovery hotelId={hotelId} hotelName={hotel.name} recovery={recovery} />
      ) : null}

      <section className="border border-line bg-surface p-5">
        <p className="text-xs font-medium tracking-widest text-muted uppercase">Guest page / QR destination</p>
        <p className="mt-2 break-all text-sm font-medium">{bookingUrl}</p>
        <p className="mt-2 text-sm text-muted">This is the current QR-ready guest address. The public guest address uses the human-readable hotel slug.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={() => void copyBookingUrl()} className="min-h-11 border border-line px-4 text-sm font-semibold tracking-wide uppercase">
            {copied ? "Copied" : "Copy URL"}
          </button>
          {service && destination ? (
            <>
              <Link to="/app/hotels/$hotelId/preview" params={{ hotelId }} className="min-h-11 bg-ink px-4 py-3 text-sm font-semibold tracking-wide text-canvas uppercase">
                Preview guest page
              </Link>
              <Link to="/app/hotels/$hotelId/qr" params={{ hotelId }} className="min-h-11 border border-line px-4 py-3 text-sm font-semibold tracking-wide uppercase">
                QR / Print
              </Link>
            </>
          ) : null}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <article className="border border-line bg-surface p-5">
          <p className="text-xs font-medium tracking-widest text-muted uppercase">Service</p>
          <h2 className="mt-2 text-xl font-semibold">{service?.name ?? "Not configured"}</h2>
          <p className="mt-2 text-sm text-muted">{service ? "Transfer service enabled" : "Add the first service to continue."}</p>
        </article>
        <article className="border border-line bg-surface p-5">
          <p className="text-xs font-medium tracking-widest text-muted uppercase">Destination</p>
          <h2 className="mt-2 text-xl font-semibold">{destination?.name ?? "Not configured"}</h2>
          <p className="mt-2 text-sm text-muted">{destination ? hotel.currency + " " + (Number(destination.amount_minor) / 100).toFixed(2) : "Add a destination and price to continue."}</p>
        </article>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link to="/app/onboarding" className="min-h-12 border border-line px-4 py-3 text-sm font-semibold tracking-wide uppercase">Setup</Link><a href={"/app/billing?hotelId=" + hotelId} className="min-h-12 border border-line px-4 py-3 text-sm font-semibold tracking-wide uppercase">Plan & Stripe</a>
      </div>
    </div>
  );
}

function PropertyRecovery({
  hotelId,
  hotelName,
  recovery,
}: {
  hotelId: string;
  hotelName: string;
  recovery: Exclude<HotelRecoveryView, { kind: "attached" }>;
}) {
  const router = useRouter();
  const [businessName, setBusinessName] = useState(recovery.kind === "missing" ? recovery.suggestedName : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "That could not be saved. Nothing else was changed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitName(event: FormEvent) {
    event.preventDefault();
    await run(() => submitHotelRecoveryNameFn({ data: { hotelId, businessName } }));
  }

  return (
    <section className="border border-line bg-surface p-5" aria-busy={busy}>
      <p className="text-xs font-medium tracking-widest text-muted uppercase">Property link</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight">Link this property to your business</h2>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        This property is not linked to a business yet. Linking it does not create a new property.
      </p>

      {recovery.kind === "missing" ? (
        <form className="mt-6" onSubmit={(event) => void submitName(event)}>
          <p className="text-sm font-medium">What is your business called?</p>
          <p className="mt-2 text-sm text-muted">The property name is only a suggestion. Changing it here does not rename the property.</p>
          <label className="mt-4 block" htmlFor="recovery-business-name">
            <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Business name</span>
            <input
              id="recovery-business-name"
              name="businessName"
              autoComplete="organization"
              className="min-h-12 w-full border border-line bg-transparent px-3 outline-none focus:border-ink"
              value={businessName}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "recovery-error" : undefined}
              onChange={(event) => setBusinessName(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={busy || businessName.trim().length === 0}
            className="mt-4 min-h-12 bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50"
          >
            {busy ? "Saving…" : "Continue"}
          </button>
        </form>
      ) : null}

      {recovery.kind === "classify" ? (
        <div className="mt-6">
          <p className="text-sm font-medium">{recovery.businessName}</p>
          <p className="mt-3 text-sm font-medium">Is this business a hotel or other accommodation?</p>
          <p className="mt-2 text-sm text-muted">This is not selected for you.</p>
          <button
            type="button"
            disabled={busy}
            className="mt-4 min-h-12 bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50"
            onClick={() => void run(() => classifyHotelRecoveryFn({ data: { hotelId } }))}
          >
            {busy ? "Saving…" : "Hotel / accommodation"}
          </button>
        </div>
      ) : null}

      {recovery.kind === "attach" ? (
        <div className="mt-6">
          <p className="text-sm font-medium">Link {hotelName} to {recovery.businessName}.</p>
          <p className="mt-2 text-sm text-muted">This keeps the same property and the same business.</p>
          <button
            type="button"
            disabled={busy}
            className="mt-4 min-h-12 bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50"
            onClick={() => void run(() => attachHotelRecoveryFn({ data: { hotelId } }))}
          >
            {busy ? "Linking…" : "Link property"}
          </button>
        </div>
      ) : null}

      {recovery.kind === "operator" ? (
        <p className="mt-6 text-sm leading-relaxed">
          This business is an independent transfer operator, so this property cannot be linked. The business type was not changed.
        </p>
      ) : null}

      {recovery.kind === "support" ? (
        <p className="mt-6 text-sm leading-relaxed">
          We need to check this account before this property can be linked. Contact support. Nothing was changed.
        </p>
      ) : null}

      {error ? (
        <p id="recovery-error" role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
